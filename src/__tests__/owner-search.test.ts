import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../clients/owner-search.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../clients/owner-search.js")>()), searchOwnerParcels: vi.fn() }));

import { OwnerSearchError, parseOwnerSearch, searchOwnerParcels } from "../clients/owner-search.js";
import { findLandByOwner } from "../tools/owner-search.js";
import { accountToolNames } from "../server.js";
import type { AccountAuth } from "../auth/token.js";
import { parcelIndexToken } from "./fixtures.js";

function fetchMock(answer: () => Response = () => new Response("{}", { status: 200 })) {
  return vi.fn<typeof fetch>(async () => answer());
}

const AUTH: AccountAuth = { token: "t", subject: "5f0c4f1e-1111-4222-8333-944455556666", clientId: "c", scopes: ["profile:read"], expiresAt: 4102444800 };

const PARCEL = { apn: "123-45-678", owner: "SMITH JOHN", address: "1 Ranch Rd", acres: 40.1234, lat: 33.4, lon: -112.1, path: "/us/az/maricopa/phoenix/9", regridId: "uuid-1" };

const real = async () => (await vi.importActual<typeof import("../clients/owner-search.js")>("../clients/owner-search.js")).searchOwnerParcels;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(searchOwnerParcels).mockReset();
});

describe("the owner search answer", () => {
  it("keeps readable parcels and the more flag", () => {
    expect(parseOwnerSearch({ parcels: [{ apn: "1", owner: "A", address: null, acres: 2, lat: 1, lon: 2, path: "/us/az/x", llUuid: "u", geometry: {} }, { apn: "2" }], more: true }))
      .toEqual({ parcels: [{ apn: "1", owner: "A", address: null, acres: 2, lat: 1, lon: 2, path: "/us/az/x", regridId: "u" }], more: true });
    expect(parseOwnerSearch({ parcels: [] })).toEqual({ parcels: [], more: false });
    expect(parseOwnerSearch({ error: "x" })).toBeNull();
  });
});

describe("searchOwnerParcels", () => {
  it("posts the owner and county with the server's key and the signed-in person", async () => {
    vi.stubEnv("FABRICA_LISTING_IMPORT_KEY", "k-1");
    const fetchImpl = fetchMock(() => new Response(JSON.stringify({ parcels: [], more: false }), { status: 200 }));
    expect(await (await real())("Smith John", "/us/az/maricopa", "acct-1", fetchImpl)).toEqual({ status: "ok", parcels: [], more: false });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/api\/regrid-owner$/);
    expect(String(url)).not.toContain("Smith");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-listing-import-key")).toBe("k-1");
    expect(headers.get("x-listing-import-subject")).toBe("acct-1");
    expect(JSON.parse(String(init?.body))).toEqual({ owner: "Smith John", path: "/us/az/maricopa" });
  });

  it("does not call without a key, and reads refusals", async () => {
    const search = await real();
    vi.stubEnv("FABRICA_LISTING_IMPORT_KEY", "");
    const unused = fetchMock();
    await expect(search("Smith John", "/us/az/maricopa", "a", unused)).rejects.toThrow(/not set up/);
    expect(unused).not.toHaveBeenCalled();
    vi.stubEnv("FABRICA_LISTING_IMPORT_KEY", "k-1");
    await expect(search("Smith John", "/us/az/maricopa", "a", fetchMock(() => new Response("{}", { status: 401 })))).rejects.toThrow(/not available/);
    await expect(search("Smith John", "/us/az/maricopa", "a", fetchMock(() => new Response("{}", { status: 400 })))).rejects.toThrow(OwnerSearchError);
    expect(await search("Smith John", "/us/az/maricopa", "a", fetchMock(() => new Response("{}", { status: 429 })))).toEqual({ status: "rate-limited" });
    expect(await search("Smith John", "/us/az/maricopa", "a", fetchMock(() => new Response("{}", { status: 502 })))).toEqual({ status: "failed" });
    await expect(search("Smith John", "/us/az/maricopa", "a", fetchMock(() => new Response("nope", { status: 200 })))).rejects.toThrow(/does not understand/);
  });
});

describe("find_land_by_owner", () => {
  it("searches the named county for the signed-in person and links each parcel to add_land", async () => {
    vi.mocked(searchOwnerParcels).mockResolvedValue({ status: "ok", parcels: [PARCEL], more: true });
    const result = await findLandByOwner(AUTH, { owner: "  Smith   John ", state: "az", county: "Maricopa" }, async () => []);
    expect(vi.mocked(searchOwnerParcels)).toHaveBeenCalledWith("Smith John", "/us/az/maricopa", AUTH.subject);
    if (!result.parcels || !result.notes) throw new Error(JSON.stringify(result));
    expect(result.county).toBe("Maricopa County");
    expect(result.parcels[0]).toMatchObject({ parcelNumber: "123-45-678", owner: "SMITH JOHN", acres: 40.12, onFabrica: null });
    expect(result.parcels[0]?.links.addToFabrica).toContain("/go?");
    expect(result.notes.join(" ")).toMatch(/more parcels/);
  });

  it("says when a parcel is already on Fabrica", async () => {
    vi.mocked(searchOwnerParcels).mockResolvedValue({ status: "ok", parcels: [PARCEL], more: false });
    const token = parcelIndexToken({ tokenId: "42", name: "Ranch", slug: "ranch", regionCode: "AZ", definition: { offchainRegistrar: { admin: "Maricopa", adminId: "04013", propertyId: "12345678" } } });
    const result = await findLandByOwner(AUTH, { owner: "Smith John", state: "AZ", county: "Maricopa" }, async () => [token]);
    if (!result.parcels || !result.notes) throw new Error(JSON.stringify(result));
    expect(result.parcels[0]?.onFabrica?.tokenId).toBe("42");
    expect(result.parcels[0]?.links.addToFabrica).toBeNull();
  });

  it("refuses an unknown county without searching, and words empty and refused answers", async () => {
    expect(await findLandByOwner(AUTH, { owner: "Smith John", state: "AZ", county: "Nowhere" })).toHaveProperty("error");
    expect(vi.mocked(searchOwnerParcels)).not.toHaveBeenCalled();
    vi.mocked(searchOwnerParcels).mockResolvedValue({ status: "ok", parcels: [], more: false });
    const empty = await findLandByOwner(AUTH, { owner: "Smith John", state: "AZ", county: "Maricopa" }, async () => []);
    expect(empty).toMatchObject({ found: 0 });
    vi.mocked(searchOwnerParcels).mockResolvedValue({ status: "rate-limited" });
    expect(await findLandByOwner(AUTH, { owner: "Smith John", state: "AZ", county: "Maricopa" })).toMatchObject({ error: expect.stringMatching(/Too many/) });
    vi.mocked(searchOwnerParcels).mockRejectedValue(new OwnerSearchError("not available"));
    expect(await findLandByOwner(AUTH, { owner: "Smith John", state: "AZ", county: "Maricopa" })).toEqual({ error: "not available" });
  });

  it("is a signed-in tool", () => {
    expect(accountToolNames()).toContain("find_land_by_owner");
  });
});
