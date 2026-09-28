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
