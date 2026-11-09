import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { accountToolNames, createServer } from "./server.js";
import { describeRequest, trackUsage } from "./usage-log.js";
import { allowFindParcel, FIND_PARCEL_LIMIT_PER_MINUTE, MAX_BATCH_QUERIES } from "./tools/parcels.js";
import { oauthScopes, oauthEnabled, resourceMetadataUrl, type OAuthScope } from "./auth/config.js";
import { checkAccessToken, type AccountAuth } from "./auth/token.js";

/**
 * Origin policy: without a token the server serves only public, read-only data and holds no
 * credentials or session state, so any browser origin may call it (wildcard CORS below).
 * DNS rebinding targets local servers with privileged access, which this is not. Sign-in is a
 * bearer token in the Authorization header, never a cookie, so a browser cannot attach it on a
 * cross-site request: wildcard CORS stays safe.
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

/**
 * How many metered parcel lookups a JSON-RPC message or batch carries: one per find_us_parcel call,
 * or one per query in a list, and one per add_land call that names a parcel number or an address
 * (those run the same lookup; a listing link is read by the web app instead).
 */
export function countFindParcelCalls(body: unknown): number {
  const messages: unknown[] = Array.isArray(body) ? body : [body];
  return messages.reduce<number>((total, message) => {
    if (typeof message !== "object" || message === null
      || !("method" in message) || message.method !== "tools/call"
      || !("params" in message) || typeof message.params !== "object" || message.params === null
      || !("name" in message.params)) return total;
    const args = "arguments" in message.params ? message.params.arguments : undefined;
    if (message.params.name === "add_land") {
      const looksUp = typeof args === "object" && args !== null && !("listingUrl" in args && typeof args.listingUrl === "string")
        && (("parcelNumber" in args && typeof args.parcelNumber === "string") || ("address" in args && typeof args.address === "string"));
      return total + (looksUp ? 1 : 0);
    }
    if (message.params.name !== "find_us_parcel") return total;
    const queries = typeof args === "object" && args !== null && "queries" in args && Array.isArray(args.queries) ? args.queries.length : 0;
    // A list longer than the cap is refused by the input check, so it is counted at the cap.
    return total + Math.max(1, Math.min(queries, MAX_BATCH_QUERIES));
  }, 0);
}

/** The RFC 6750 challenge: the protected resource metadata (RFC 9728) and the scopes the server accepts. */
function challenge(error?: { code: string; description: string }): string {
  const parts = [`resource_metadata="${resourceMetadataUrl()}"`, `scope="${oauthScopes().join(" ")}"`];
  if (error) parts.unshift(`error="${error.code}"`, `error_description="${error.description.replace(/["\\]/g, "")}"`);
  return `Bearer ${parts.join(", ")}`;
}

/** The wallet arguments that take "me" for the connected person's own wallet once signed in. */
const OWN_WALLET_KEYS = ["address", "wallet", "ownedBy"];

/** Whether a message or batch calls a tool that reads the person's own account: a personal tool, or a wallet-scoped tool with "me" as the wallet. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const accountTools = (): ReadonlySet<string> => new Set(accountToolNames());

export function needsAccount(body: unknown): boolean {
  const messages: unknown[] = Array.isArray(body) ? body : [body];
  return messages.some((message) => {
    if (!isRecord(message) || message.method !== "tools/call" || !isRecord(message.params)) return false;
    const { name, arguments: args } = message.params;
    if (typeof name === "string" && accountTools().has(name)) return true;
    if (!isRecord(args)) return false;
    // Reading a listing spends the server's own import budget, so it is for signed-in people only.
    if (name === "add_land" && typeof args.listingUrl === "string") return true;
    return OWN_WALLET_KEYS.some((key) => {
      const value = args[key];
      return typeof value === "string" && value.trim().toLowerCase() === "me";
    });
  });
}

/** The grant each write tool needs. A signed-in call without it is refused with 403 insufficient_scope (RFC 6750), which MCP clients answer by asking the person to approve the wider grant; a 401 would make them treat the token as invalid and sign in again instead. */
const WRITE_TOOL_SCOPES: ReadonlyMap<string, readonly OAuthScope[]> = new Map([
  ["add_land", ["onramp:write"]],
  ["answer_adding_questions", ["onramp:write"]],
]);

/** The scopes a message or batch needs that the token does not carry, in the server's scope order. */
export function missingScopes(body: unknown, auth: AccountAuth): OAuthScope[] {
  const messages: unknown[] = Array.isArray(body) ? body : [body];
  const needed = new Set<OAuthScope>();
  for (const message of messages) {
    if (!isRecord(message) || message.method !== "tools/call" || !isRecord(message.params) || typeof message.params.name !== "string") continue;
    for (const scope of WRITE_TOOL_SCOPES.get(message.params.name) ?? []) if (!auth.scopes.includes(scope)) needed.add(scope);
  }
  return oauthScopes().filter((scope) => needed.has(scope));
}

type Gate = { ok: true; account?: AccountAuth } | { ok: false };

/**
 * Sign-in, lazily: a valid token makes the session the person's own. Without one, public reads
 * go through, and a call that needs the person's account (needsAccount) is refused with 401 and
 * the challenge, which makes the client ask the person to sign in and retry the same call. An
 * invalid token is refused the same way with invalid_token, and 503 says the issuer's keys could
 * not be read. While Connect Fabrica is off, tokens are ignored. The refusal is sent here, before
 * the MCP SDK runs: a tool error inside a 200 would not start a sign-in.
 */
async function gate(req: McpHttpRequest, res: ServerResponse, body: unknown): Promise<Gate> {
  if (!oauthEnabled()) return { ok: true };
  const check = await checkAccessToken(req.headers.authorization);
  // A refusal depends on the Authorization header, so no cache may keep it.
  res.setHeader("Cache-Control", "no-store");
  if (check.ok) {
    const missing = missingScopes(body, check.auth);
    if (missing.length === 0) {
      res.removeHeader("Cache-Control");
      return { ok: true, account: check.auth };
    }
    // RFC 6750 step-up: the grant is real but too narrow, so the client asks the person to approve the rest.
    res.setHeader("WWW-Authenticate", challenge({ code: "insufficient_scope", description: `This call needs the ${missing.join(" ")} grant.` }));
    sendJsonRpcError(res, 403, -32001, `This call needs a grant the connected Fabrica account has not approved (${missing.join(", ")}): have the person reconnect Fabrica in this client and approve adding a property, then call it again.`);
    return { ok: false };
  }
  if (check.reason === "unavailable") {
    sendJsonRpcError(res, 503, -32000, "Fabrica sign-in is temporarily unavailable. Retry shortly; public reads keep working without it.");
    return { ok: false };
  }
  if (check.reason === "missing" && !needsAccount(body)) {
    res.removeHeader("Cache-Control");
    return { ok: true };
  }
  res.setHeader("WWW-Authenticate", challenge(check.reason === "invalid" ? { code: "invalid_token", description: check.description } : undefined));
  sendJsonRpcError(res, 401, -32001, check.reason === "invalid"
    ? `${check.description} Reconnect Fabrica to get a new one.`
    : "This call reads the person's own Fabrica account: have the person connect Fabrica in this client (sign in on fabrica.land and approve read-only access), then call it again. Public reads need no sign-in.");
  return { ok: false };
}

/** The read-only profile: /mcp/read, or the query the Vercel rewrite adds. */
export function isReadOnlyProfile(url: string | undefined): boolean {
  const parsed = new URL(url ?? "/", "http://localhost");
  return /^\/mcp\/read\/?$/.test(parsed.pathname) || parsed.searchParams.get("profile") === "read";
}

export async function handleMcpHttpRequest(req: McpHttpRequest, res: ServerResponse): Promise<void> {
  for (const [name, value] of Object.entries(CORS_HEADERS)) res.setHeader(name, value);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
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
  // The read-only profile has no personal tools, so it never asks for or reads a token.
  const readOnly = isReadOnlyProfile(req.url);
  const signIn: Gate = readOnly ? { ok: true } : await gate(req, res, body);
  if (!signIn.ok) return;
  const account = signIn.account;
  // Personal responses must never be shared by a cache.
  if (account) res.setHeader("Cache-Control", "no-store");
  usage.recordCalls(describeRequest(body));
  if (!allowFindParcel(clientKey(req), countFindParcelCalls(body))) {
    sendJsonRpcError(res, 429, -32000, `find_us_parcel is limited to ${FIND_PARCEL_LIMIT_PER_MINUTE} lookups per minute per client. Wait a minute and retry.`);
    return;
  }
  const server = createServer({ onFindParcel: usage.noteOnFabrica, account, readOnly });
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
