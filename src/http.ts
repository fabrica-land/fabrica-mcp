import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { describeRequest, trackUsage } from "./usage-log.js";
import { allowFindParcel, FIND_PARCEL_LIMIT_PER_MINUTE, MAX_BATCH_QUERIES } from "./tools/parcels.js";
import { ACCOUNT_PATH, oauthEnabled, resourceMetadataUrl } from "./auth/config.js";
import { checkAccessToken, type AccountAuth } from "./auth/token.js";

/**
 * Origin policy: the anonymous endpoint serves only public, read-only data and holds no
 * credentials or session state, so any browser origin may call it (wildcard CORS below).
 * DNS rebinding targets local servers with privileged access, which this is not. The
 * signed-in endpoint (/mcp/account) takes a bearer token in the Authorization header, never
 * a cookie, so a browser cannot attach it on a cross-site request: wildcard CORS stays safe.
 *
 * Stateless Streamable HTTP entrypoint. Every POST gets a fresh server and
 * transport, so the same handler runs on serverless platforms (Vercel) and
 * behind any plain Node HTTP server. Network is fixed per deployment by
 * FABRICA_NETWORK, exactly as for stdio.
 */

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate",
};

const MAX_BODY_BYTES = 1024 * 1024;

export class PayloadTooLargeError extends Error {}

/** Vercel's Node runtime pre-parses JSON bodies onto `req.body`; plain Node does not. */
export type McpHttpRequest = IncomingMessage & { body?: unknown };

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function assertWithinLimit(bytes: number): void {
  if (bytes > MAX_BODY_BYTES) throw new PayloadTooLargeError();
}

export async function readJsonBody(req: McpHttpRequest): Promise<unknown> {
  assertWithinLimit(Number(req.headers["content-length"] ?? 0));
  if (req.body !== undefined && typeof req.body !== "string" && !Buffer.isBuffer(req.body)) {
    // Pre-parsed (Vercel): the request may have been chunked with no Content-Length,
    // so measure the parsed body itself.
    assertWithinLimit(Buffer.byteLength(JSON.stringify(req.body) ?? ""));
    return req.body;
  }
  const chunks: Buffer[] = [];
  if (typeof req.body === "string") chunks.push(Buffer.from(req.body));
  else if (Buffer.isBuffer(req.body)) chunks.push(req.body);
  else {
    let size = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > MAX_BODY_BYTES) throw new PayloadTooLargeError();
      chunks.push(buffer);
    }
  }
  const body = Buffer.concat(chunks);
  assertWithinLimit(body.byteLength);
  const raw = body.toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

/** The calling client for per-client limits: the first forwarded address, else the socket's. Never logged. */
export function clientKey(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

/** How many find_us_parcel lookups a JSON-RPC message or batch carries: one per call, or one per query in a list. */
export function countFindParcelCalls(body: unknown): number {
  const messages: unknown[] = Array.isArray(body) ? body : [body];
  return messages.reduce<number>((total, message) => {
    if (typeof message !== "object" || message === null
      || !("method" in message) || message.method !== "tools/call"
      || !("params" in message) || typeof message.params !== "object" || message.params === null
      || !("name" in message.params) || message.params.name !== "find_us_parcel") return total;
    const args = "arguments" in message.params ? message.params.arguments : undefined;
    const queries = typeof args === "object" && args !== null && "queries" in args && Array.isArray(args.queries) ? args.queries.length : 0;
    // A list longer than the cap is refused by the input check, so it is counted at the cap.
    return total + Math.max(1, Math.min(queries, MAX_BATCH_QUERIES));
  }, 0);
}

/** Whether the request is for the signed-in endpoint: its path, or the query the Vercel rewrite adds. */
export function isAccountRequest(url: string | undefined): boolean {
  const parsed = new URL(url ?? "/", "http://localhost");
  return parsed.pathname.replace(/\/+$/, "") === ACCOUNT_PATH || parsed.searchParams.get("endpoint") === "account";
}

/** The RFC 6750 challenge that points the client at the protected resource metadata (RFC 9728). */
function challenge(error?: { code: string; description: string }): string {
  const parts = [`resource_metadata="${resourceMetadataUrl()}"`];
  if (error) parts.unshift(`error="${error.code}"`, `error_description="${error.description.replace(/["\\]/g, "")}"`);
  return `Bearer ${parts.join(", ")}`;
}

/**
 * The signed-in endpoint's gate: the verified caller, or a response already sent (404 while
 * Connect Fabrica is off, 401 with the challenge without a valid token, 503 when the issuer's
 * keys cannot be read).
 */
async function authenticate(req: McpHttpRequest, res: ServerResponse): Promise<AccountAuth | null> {
  if (!oauthEnabled()) {
    sendJsonRpcError(res, 404, -32000, "Not found. The anonymous Fabrica MCP endpoint is /mcp.");
    return null;
  }
  const check = await checkAccessToken(req.headers.authorization);
  if (check.ok) return check.auth;
  if (check.reason === "unavailable") {
    sendJsonRpcError(res, 503, -32000, "Fabrica sign-in is temporarily unavailable. Retry shortly; the anonymous endpoint /mcp keeps working.");
    return null;
  }
  res.setHeader("WWW-Authenticate", challenge(check.reason === "invalid" ? { code: "invalid_token", description: check.description } : undefined));
  sendJsonRpcError(res, 401, -32001, check.reason === "invalid" ? `${check.description} Reconnect Fabrica to get a new one.` : "This endpoint needs a Fabrica connection: authorize this client with Fabrica (OAuth), or use the anonymous endpoint /mcp.");
  return null;
}

export async function handleMcpHttpRequest(req: McpHttpRequest, res: ServerResponse): Promise<void> {
  for (const [name, value] of Object.entries(CORS_HEADERS)) res.setHeader(name, value);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  let account: AccountAuth | undefined;
  if (isAccountRequest(req.url)) {
    // Personal responses must never be shared by a cache.
    res.setHeader("Cache-Control", "no-store");
    const auth = await authenticate(req, res);
    if (!auth) return;
    account = auth;
  }
  if (req.method !== "POST") {
    sendJsonRpcError(res, 405, -32000, "Method not allowed. This server is stateless: send MCP JSON-RPC messages with POST.");
    return;
  }
  const usage = trackUsage(res, req.headers["user-agent"]);
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      sendJsonRpcError(res, 413, -32600, "Request body is larger than 1 MB.");
    } else {
      sendJsonRpcError(res, 400, -32700, "Parse error: request body must be JSON.");
    }
    return;
  }
  usage.recordCalls(describeRequest(body));
  if (!allowFindParcel(clientKey(req), countFindParcelCalls(body))) {
    sendJsonRpcError(res, 429, -32000, `find_us_parcel is limited to ${FIND_PARCEL_LIMIT_PER_MINUTE} lookups per minute per client. Wait a minute and retry.`);
    return;
  }
  const server = createServer({ onFindParcel: usage.noteOnFabrica, account });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    console.error("MCP HTTP request failed:", error);
    if (!res.headersSent) sendJsonRpcError(res, 500, -32603, "The Fabrica MCP server failed to handle this request. Retry; if it keeps failing, contact questions@fabrica.land.");
  }
}
