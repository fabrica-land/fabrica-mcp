import { afterEach, describe, expect, it, vi } from "vitest";
import { importListing, parseListingImport } from "../clients/listing-import.js";

const ANSWER = {
  attemptId: "a1",
  source: { url: "https://www.landwatch.com/lot/1", host: "www.landwatch.com", fetchedAt: "2026-11-04T00:00:00Z" },
  listing: { title: "5 acres", priceUsd: 12000, acres: 5, description: "Quiet.", apn: "70310050", county: "Costilla", state: "CO", stateOptions: [], address: null, coordinates: { lat: 37.1, lon: -105.4 }, photos: [{ url: "https://i/2.jpg", width: null, height: null, order: 1 }, { url: "https://i/1.jpg", width: 10, height: 10, order: 0 }], videos: ["https://youtu.be/x"] },
  extraction: { method: "mixed", confidence: 0.8, warnings: ["no-price"] },
  status: "ok",
  match: { verdict: "match", reason: "match", parcel: { regridUuid: "u", path: "/us/co/costilla/1", apn: "70310050", county: "Costilla", state: "CO", adminId: "08023", centroid: { lat: 37.1, lon: -105.4 } }, onFabrica: { kind: "premint-mine", tokenId: "11", slug: "s" } },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the listing import answer", () => {
  it("keeps the draft, the photos in order, and the verdict", () => {
    const parsed = parseListingImport(ANSWER);
    expect(parsed?.ok).toBe(true);
    if (!parsed?.ok) return;
    expect(parsed.draft).toMatchObject({ title: "5 acres", priceUsd: 12000, apn: "70310050", method: "mixed", warnings: ["no-price"], status: "ok" });
    expect(parsed.draft.photos.map((p) => p.url)).toEqual(["https://i/1.jpg", "https://i/2.jpg"]);
    expect(parsed.match).toEqual({ verdict: "match", reason: "match", parcel: { regridUuid: "u", path: "/us/co/costilla/1", apn: "70310050", county: "Costilla", state: "CO", adminId: "08023", centroid: { lat: 37.1, lon: -105.4 } }, onFabrica: { kind: "premint-mine", tokenId: "11", slug: "s" } });
  });

  it("passes a refusal through and rejects anything else", () => {
    expect(parseListingImport({ code: "INVALID_URL", error: "That link does not look like a public https web page." })).toEqual({ ok: false, code: "INVALID_URL", error: "That link does not look like a public https web page." });
    expect(parseListingImport({ attemptId: "a" })).toBeNull();
    expect(parseListingImport("nope")).toBeNull();
    expect(parseListingImport({ ...ANSWER, match: { verdict: "maybe" } })).toMatchObject({ ok: true, match: null });
  });

  it("posts to the web app with the server's key and the person's wallet, and never throws on a refusal", async () => {
    vi.stubEnv("FABRICA_LISTING_IMPORT_KEY", "k-1");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(ANSWER), { status: 200, headers: { "Content-Type": "application/json" } }));
    const result = await importListing("https://www.landwatch.com/lot/1", "0xabc", fetchImpl as unknown as typeof fetch);
    expect(result.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/import-listing$/);
    expect(new Headers(init.headers).get("x-listing-import-key")).toBe("k-1");
    expect(JSON.parse(String(init.body))).toEqual({ url: "https://www.landwatch.com/lot/1", account: "0xabc" });
    const refusing = vi.fn(async () => new Response(JSON.stringify({ code: "RATE_LIMITED", error: "Too many." }), { status: 429 }));
    expect(await importListing("https://x.example/1", null, refusing as unknown as typeof fetch)).toEqual({ ok: false, code: "RATE_LIMITED", error: "Too many." });
  });

  it("still posts without the key header when no server key is set (the web app's own budget applies)", async () => {
    vi.stubEnv("FABRICA_LISTING_IMPORT_KEY", "  ");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(ANSWER), { status: 200, headers: { "Content-Type": "application/json" } }));
    expect((await importListing("https://www.landwatch.com/lot/1", null, fetchImpl as unknown as typeof fetch)).ok).toBe(true);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).has("x-listing-import-key")).toBe(false);
    expect(JSON.parse(String(init.body))).toEqual({ url: "https://www.landwatch.com/lot/1" });
  });

  it("refuses anything but an https page before any request, key or not", async () => {
    const fetchImpl = vi.fn();
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "ftp://x.example/1", "http://x.example/1", `https://x.example/${"a".repeat(2048)}`]) {
      await expect(importListing(bad, null, fetchImpl as unknown as typeof fetch)).rejects.toThrow(/https:\/\/ page address/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("explains an unreachable web app or a reply it does not understand", async () => {
    const down = vi.fn(async () => { throw new TypeError("fetch failed"); });
    await expect(importListing("https://x.example/1", null, down as unknown as typeof fetch)).rejects.toThrow(/could not be reached/);
    const odd = vi.fn(async () => new Response("<html>", { status: 502 }));
    await expect(importListing("https://x.example/1", null, odd as unknown as typeof fetch)).rejects.toThrow(/HTTP 502/);
  });
});
