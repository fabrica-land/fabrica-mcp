import { afterEach, describe, expect, it, vi } from "vitest";
import { getSignedValuations } from "../clients/graphql.js";

const entry = { source: "All US Land", version: "1.0", signer: "0xC888", signature: "0xsig", quote: { price: "1", currency: "0xA0b8", timestamp: 1, duration: 1200 } };

function respond(body: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getSignedValuations", () => {
  it("returns a well-formed panel", async () => {
    respond({ networkName: "ethereum", asOf: "2026-10-17T00:00:00Z", valuations: [entry, { ...entry, signature: null, quote: null, reason: "valuation_unavailable" }] });
    expect((await getSignedValuations("1"))?.valuations).toHaveLength(2);
  });

  it.each([
    ["a null entry", [null]],
    ["an incomplete quote", [{ ...entry, quote: { price: "1" } }]],
    ["a missing source", [{ ...entry, source: undefined }]],
  ])("returns null for %s", async (_label, valuations) => {
    respond({ networkName: "ethereum", asOf: "2026-10-17T00:00:00Z", valuations });
    expect(await getSignedValuations("1")).toBeNull();
  });

  it("returns null on an HTTP error or a network failure", async () => {
    respond({ message: "Not Found" }, 404);
    expect(await getSignedValuations("1")).toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await getSignedValuations("1")).toBeNull();
  });
});
