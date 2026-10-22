import type { ServerResponse } from "node:http";
import { type McpHttpRequest, PayloadTooLargeError, readJsonBody } from "../http.js";
import { signPageView, signResultSchema, verifyResult } from "../tools/sign-requests.js";
import { getSignRequestStore, isExpired, isSignRequestId } from "./store.js";

/**
 * The sign page's side of a sign request:
 *   GET  /sign-requests/{id}         the request, for the page to prefill and check the wallet (410 once expired)
 *   POST /sign-requests/{id}/result  { orderHash } or { transactionHash }, checked before it is recorded
 * Public by design: ids are 128-bit random, links expire after 15 minutes (records are kept a day
 * so an expired link answers 410) and hold no secret.
 * On Vercel the route rewrites to ?id=…&op=…; a plain Node server passes the path.
 */

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function send(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/** The id and operation from the query (Vercel rewrite) or the path. */
export function parseSignRequestUrl(url: string | undefined): { id: string; op: "get" | "result" } | null {
  const parsed = new URL(url ?? "/", "http://localhost");
  const fromQuery = parsed.searchParams.get("id");
  const opQuery = parsed.searchParams.get("op");
  const match = /^\/sign-requests\/([^/]+)(\/result)?\/?$/.exec(parsed.pathname);
  const id = fromQuery ?? match?.[1];
  if (!id) return null;
  const op = (opQuery ?? (match?.[2] ? "result" : "")) === "result" ? "result" : "get";
  return { id, op };
}

export async function handleSignRequestHttp(req: McpHttpRequest, res: ServerResponse): Promise<void> {
  for (const [name, value] of Object.entries(CORS_HEADERS)) res.setHeader(name, value);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const target = parseSignRequestUrl(req.url);
  if (!target || !isSignRequestId(target.id)) {
    send(res, 404, { error: "not_found" });
    return;
  }
  const expected = target.op === "result" ? "POST" : "GET";
  if (req.method !== expected) {
    send(res, 405, { error: "method_not_allowed", message: `Use ${expected} for this path.` });
    return;
  }
  const store = getSignRequestStore();
  if (!store) {
    send(res, 503, { error: "not_configured", message: "Sign requests are not configured on this server." });
    return;
  }
  try {
    const record = await store.get(target.id);
    if (!record) {
      send(res, 404, { error: "not_found" });
      return;
    }
    if (record.status === "pending" && isExpired(record)) {
      send(res, 410, { error: "expired", expiresAt: record.expiresAt });
      return;
    }
    if (target.op === "get") {
      send(res, 200, signPageView(record));
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      send(res, error instanceof PayloadTooLargeError ? 413 : 400, { error: "bad_request", message: "The body must be JSON: { orderHash } or { transactionHash }." });
      return;
    }
    const result = signResultSchema.safeParse(body);
    if (!result.success) {
      send(res, 400, { error: "bad_request", message: "The body must be { orderHash: 0x… } or { transactionHash: 0x… }." });
      return;
    }
    if (record.status === "completed") {
      send(res, 200, signPageView(record));
      return;
    }
    const verdict = await verifyResult(record, result.data);
    if (!verdict.ok) {
      send(res, 409, { error: "does_not_match", message: verdict.reason });
      return;
    }
    send(res, 200, signPageView(await store.complete(record, result.data)));
  } catch (error) {
    console.error("Sign request request failed:", error);
    send(res, 502, { error: "upstream_failed", message: "The sign request could not be checked right now. Retry shortly." });
  }
}
