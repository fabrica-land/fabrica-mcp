import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PayloadTooLargeError, readJsonBody } from "../http.js";

function preParsedRequest(body: unknown): IncomingMessage & { body?: unknown } {
  return Object.assign(new IncomingMessage(new Socket()), { body });
}

describe("request body limit", () => {
  it("rejects an oversized pre-parsed body sent without Content-Length", async () => {
    const request = preParsedRequest({ jsonrpc: "2.0", method: "ping", params: { padding: "x".repeat(1_100_000) } });
    await expect(readJsonBody(request)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("measures string bodies in bytes, not characters", async () => {
    const request = preParsedRequest(JSON.stringify({ padding: "é".repeat(600_000) }));
    await expect(readJsonBody(request)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("accepts a normal pre-parsed body", async () => {
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    await expect(readJsonBody(preParsedRequest(body))).resolves.toEqual(body);
  });
});

describe("property card image origins", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("follows FABRICA_MEDIA_URL so custom media services are not blocked by the card CSP", async () => {
    vi.stubEnv("FABRICA_MEDIA_URL", "https://media.example.test/base");
    vi.resetModules();
    const { WIDGET_IMAGE_ORIGINS } = await import("../tools/media.js");
    expect(WIDGET_IMAGE_ORIGINS).toContain("https://media.example.test");
    expect(WIDGET_IMAGE_ORIGINS).toContain("https://ipfs.fabrica.land");
  });
});

describe("find_us_parcel per-client limit", () => {
  it("counts find_us_parcel calls in a message or batch, nothing else", async () => {
    const { countFindParcelCalls } = await import("../http.js");
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "find_us_parcel", arguments: { query: "x" } } };
    expect(countFindParcelCalls(call)).toBe(1);
    expect(countFindParcelCalls([call, { ...call, id: 2 }, { jsonrpc: "2.0", id: 3, method: "tools/list" }])).toBe(2);
    expect(countFindParcelCalls({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_land_property" } })).toBe(0);
    expect(countFindParcelCalls(undefined)).toBe(0);
    // A list counts one lookup per query, capped at the most a call may carry.
    expect(countFindParcelCalls({ ...call, params: { name: "find_us_parcel", arguments: { queries: ["a", "b", "c"] } } })).toBe(3);
    expect(countFindParcelCalls({ ...call, params: { name: "find_us_parcel", arguments: { queries: Array.from({ length: 50 }, () => "a") } } })).toBe(10);
    expect(countFindParcelCalls({ ...call, params: { name: "find_us_parcel", arguments: { queries: [] } } })).toBe(1);
  });

  it("answers 429 with a clear JSON-RPC error once the limit is spent", async () => {
    const { createServer: createHttpServer } = await import("node:http");
    const { handleMcpHttpRequest } = await import("../http.js");
    const { allowFindParcel, FIND_PARCEL_LIMIT_PER_MINUTE } = await import("../tools/parcels.js");
    allowFindParcel("203.0.113.9", FIND_PARCEL_LIMIT_PER_MINUTE);
    const server = createHttpServer((req, res) => void handleMcpHttpRequest(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-Forwarded-For": "203.0.113.9, 10.0.0.1" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "find_us_parcel", arguments: { query: "1 Main St" } } }),
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(response.status).toBe(429);
    const body: unknown = await response.json();
    expect(JSON.stringify(body)).toContain("lookups per minute");
  });
});
