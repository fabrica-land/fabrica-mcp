import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

/**
 * Origin policy: this public server serves only public, read-only data and holds no
 * credentials or session state, so any browser origin may call it (wildcard CORS below).
 * DNS rebinding targets local servers with privileged access, which this is not. Revisit
 * when authenticated tools exist.
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
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version",
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
  const server = createServer();
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
