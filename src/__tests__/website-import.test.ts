import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../clients/listing-import.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../clients/listing-import.js")>()), scanWebsite: vi.fn() }));

import { ListingImportError, parseWebsiteScan, scanWebsite } from "../clients/listing-import.js";
import { findListingsOnWebsite } from "../tools/website-import.js";
import { accountToolNames } from "../server.js";
import { needsAccount } from "../http.js";
import type { AccountAuth } from "../auth/token.js";

/** A fetch mock with fetch's own signature, so its calls are typed. */
function fetchMock(answer: () => Response = () => new Response("{}", { status: 200 })) {
  return vi.fn<typeof fetch>(async () => answer());
}

const AUTH: AccountAuth = { token: "t", subject: "5f0c4f1e-1111-4222-8333-944455556666", clientId: "c", scopes: ["profile:read"], expiresAt: 4102444800 };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(scanWebsite).mockReset();
});

describe("the website scan answer", () => {
  it("keeps the site and its https listing links, and reads every outcome", () => {
    expect(parseWebsiteScan({ status: "ok", site: "land.example", listings: ["https://land.example/lot-1", "http://land.example/lot-2", 3], truncated: true, partial: false, source: "sitemap" }))
      .toEqual({ status: "ok", site: "land.example", listings: ["https://land.example/lot-1"], truncated: true, partial: false, source: "sitemap" });
    expect(parseWebsiteScan({ status: "none", site: "land.example" })).toEqual({ status: "none", site: "land.example" });
    expect(parseWebsiteScan({ status: "blocked" })).toEqual({ status: "blocked" });
    expect(parseWebsiteScan({ code: "invalid-url" })).toEqual({ status: "invalid-url" });
    expect(parseWebsiteScan({ code: "rate-limited" })).toEqual({ status: "rate-limited" });
    expect(parseWebsiteScan({ status: "ok" })).toBeNull();
    expect(parseWebsiteScan("x")).toBeNull();
  });
});

describe("scanWebsite", () => {
  it("posts the site with the server's key and the signed-in person", async () => {
    const real = (await vi.importActual<typeof import("../clients/listing-import.js")>("../clients/listing-import.js")).scanWebsite;
    vi.stubEnv("FABRICA_LISTING_IMPORT_KEY", "k-1");
    const fetchImpl = fetchMock(() => new Response(JSON.stringify({ status: "none", site: "land.example" }), { status: 200 }));
    expect(await real("land.example", "acct-1", fetchImpl)).toEqual({ status: "none", site: "land.example" });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/api\/site-import\/scan$/);
    const headers = new Headers(init?.headers);
    expect(headers.get("x-listing-import-key")).toBe("k-1");
    expect(headers.get("x-listing-import-subject")).toBe("acct-1");
    expect(JSON.parse(String(init?.body))).toEqual({ url: "land.example" });
  });

  it("does not call without a server key, and says when the web app refuses this server", async () => {
    const real = (await vi.importActual<typeof import("../clients/listing-import.js")>("../clients/listing-import.js")).scanWebsite;
    vi.stubEnv("FABRICA_LISTING_IMPORT_KEY", "");
    const fetchImpl = fetchMock();
    await expect(real("land.example", "acct-1", fetchImpl)).rejects.toThrow(/not set up/);
    expect(fetchImpl).not.toHaveBeenCalled();
    vi.stubEnv("FABRICA_LISTING_IMPORT_KEY", "k-1");
    const refusing = fetchMock(() => new Response(JSON.stringify({ code: "sign-in" }), { status: 401 }));
    await expect(real("land.example", "acct-1", refusing)).rejects.toThrow(/not available/);
  });
});

describe("find_listings_on_website", () => {
  it("lists the links found, adds nothing, and points at add_land", async () => {
    vi.mocked(scanWebsite).mockResolvedValue({ status: "ok", site: "land.example", listings: ["https://land.example/lot-1", "https://land.example/lot-2"], truncated: false, partial: true, source: "sitemap" });
    const result = await findListingsOnWebsite(AUTH, { url: " land.example " });
    expect(scanWebsite).toHaveBeenCalledWith("land.example", AUTH.subject);
    expect(result).toMatchObject({ site: "land.example", found: 2, readFrom: "the site's sitemap", listings: [{ listingUrl: "https://land.example/lot-1" }, { listingUrl: "https://land.example/lot-2" }] });
    const notes = "notes" in result ? result.notes.join(" ") : "";
    expect(notes).toContain("Nothing was added yet. add_land with a listingUrl adds one listing");
    expect(notes).toContain("read in part");
  });

  it("says plainly when a site has no listings, refuses reading, or cannot be reached", async () => {
    vi.mocked(scanWebsite).mockResolvedValue({ status: "none", site: "land.example" });
    expect(await findListingsOnWebsite(AUTH, { url: "land.example" })).toMatchObject({ found: 0, listings: [] });
    vi.mocked(scanWebsite).mockResolvedValue({ status: "blocked" });
    expect(await findListingsOnWebsite(AUTH, { url: "land.example" })).toMatchObject({ error: expect.stringContaining("refuses automated reading") });
    vi.mocked(scanWebsite).mockRejectedValue(new ListingImportError("The website reader could not be reached. Try again shortly."));
    expect(await findListingsOnWebsite(AUTH, { url: "land.example" })).toEqual({ error: "The website reader could not be reached. Try again shortly." });
  });

  it("is for signed-in people only", () => {
    expect(accountToolNames()).toContain("find_listings_on_website");
    expect(needsAccount({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "find_listings_on_website", arguments: { url: "land.example" } } })).toBe(true);
  });
});
