import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

/**
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

/** Vercel's Node runtime pre-parses JSON bodies onto `req.body`; plain Node does not. */
export type McpHttpRequest = IncomingMessage & { body?: unknown };

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

async function readJsonBody(req: McpHttpRequest): Promise<unknown> {
  if (req.body !== undefined && typeof req.body !== "string" && !Buffer.isBuffer(req.body)) return req.body;
  const chunks: Buffer[] = [];
  if (typeof req.body === "string") chunks.push(Buffer.from(req.body));
  else if (Buffer.isBuffer(req.body)) chunks.push(req.body);
  else for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  const raw = Buffer.concat(chunks).toString("utf8");
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
  } catch {
    sendJsonRpcError(res, 400, -32700, "Parse error: request body must be JSON.");
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
    if (!res.headersSent) sendJsonRpcError(res, 500, -32603, "Internal server error.");
  }
}
