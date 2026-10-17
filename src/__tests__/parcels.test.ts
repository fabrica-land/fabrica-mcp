import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../clients/graphql.js", () => ({
  getParcelIndex: vi.fn(async () => [
    {
      tokenId: "4737315677965897536",
      name: "1707 Jones Street, San Francisco, CA",
      slug: "us/california/san-francisco/russian-hill/1707-jones-st",
      propertyLink: "https://fabrica.land/us/california/san-francisco/russian-hill/1707-jones-st",
      regionCode: "CA",
      coordinates: { lat: 37.79697, lon: -122.415428 },
      definition: { offchainRegistrar: { admin: "San Francisco", propertyId: "015-1010" } },
    },
    {
      tokenId: "42",
      name: "Somewhere in Hunt",
      regionCode: "TX",
      coordinates: { lat: 33.5, lon: -96.5 },
      definition: { offchainRegistrar: { admin: "Hunt", propertyId: "99999" } },
    },
  ]),
}));

const { getParcelIndex } = await import("../clients/graphql.js");
const { allowFindParcel, findParcel, matchByApn, parseParcelPoint, parseTypeAhead, pointInPolygons, polygonsOf, resolveCounty, searchText, FIND_PARCEL_LIMIT_PER_MINUTE } = await import("../tools/parcels.js");

const SF_HIT = { category: "parcel", context: "San Francisco, CA", headline: "1707 Jones St", owner: "SOMEONE PRIVATE", parcelnumb: "0151010", path: "/us/ca/san-francisco/downtown/12801", score: 85, type: "Parcel" };
const HUNT_HIT = { category: "parcel", context: "Greenville, TX", headline: "1707 Jones St", owner: "ANOTHER OWNER", parcelnumb: "71359", path: "/us/tx/hunt/greenville/20283", score: 80, type: "Parcel" };
const HUNT_PARCEL = {
  parcels: {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [[[-96.11, 33.13], [-96.09, 33.13], [-96.09, 33.14], [-96.11, 33.14], [-96.11, 33.13]]] },
      properties: { path: "/us/tx/hunt/greenville/20283", fields: { ll_uuid: "f89e-uuid", geoid: "48231", lat: "33.132262", lon: "-96.100462", owner: "ANOTHER OWNER", mailadd: "1 PRIVATE RD" } },
    }],
  },
};

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("find_parcel helpers", () => {
  it("drops owner names from type-ahead rows", () => {
    const hits = parseTypeAhead([SF_HIT, { headline: "no path" }, "junk"]);
    expect(hits).toEqual([{ headline: "1707 Jones St", context: "San Francisco, CA", apn: "0151010", path: SF_HIT.path, score: 85 }]);
    expect(JSON.stringify(hits)).not.toContain("PRIVATE");
  });

  it("matches a token by state, county and APN, ignoring punctuation", () => {
    const [hit] = parseTypeAhead([SF_HIT]);
    if (!hit) throw new Error("no hit");
    const token = { tokenId: "1", regionCode: "CA", definition: { offchainRegistrar: { admin: "San Francisco", propertyId: "015-1010" } } };
    expect(matchByApn(hit, [token])?.tokenId).toBe("1");
    expect(matchByApn(hit, [{ ...token, regionCode: "NV" }])).toBeNull();
    expect(matchByApn(hit, [{ ...token, definition: { offchainRegistrar: { admin: "Kern", propertyId: "0151010" } } }])).toBeNull();
  });

  it("matches a FIPS-prefixed registrar parcel number, and never confuses a county with a same-named city", () => {
    const stLouisCity = { headline: "1 Main St", context: "St. Louis, MO", apn: "12-345", path: "/us/mo/st-louis/downtown/1", score: 90 };
    const stLouisCounty = { ...stLouisCity, path: "/us/mo/st-louis-county/clayton/1" };
    const countyToken = { tokenId: "7", regionCode: "MO", definition: { offchainRegistrar: { admin: "St. Louis", propertyId: "29189-12-345" } } };
    expect(matchByApn(stLouisCounty, [countyToken])?.tokenId).toBe("7");
    expect(matchByApn(stLouisCity, [countyToken])).toBeNull();
    expect(matchByApn(stLouisCity, [{ ...countyToken, definition: { offchainRegistrar: { admin: "St. Louis City", propertyId: "12-345" } } }])?.tokenId).toBe("7");
  });

  it("reads only the point, Regrid id and outline from the parcel lookup", () => {
    const point = parseParcelPoint(HUNT_PARCEL, HUNT_HIT.path);
    expect(point).toMatchObject({ lat: 33.132262, lon: -96.100462, regridId: "f89e-uuid" });
    expect(JSON.stringify(point)).not.toContain("OWNER");
    expect(JSON.stringify(point)).not.toContain("PRIVATE");
  });

  it("falls back to the outline's average when the parcel has no point", () => {
    const withoutPoint = { parcels: { features: [{ ...HUNT_PARCEL.parcels.features[0], properties: { path: HUNT_HIT.path, fields: {} } }] } };
    const point = parseParcelPoint(withoutPoint, HUNT_HIT.path);
    expect(point?.lat).toBeCloseTo(33.134, 2);
    expect(point?.lon).toBeCloseTo(-96.102, 2);
  });

  it("never picks an unrelated feature when several come back and none has the hit's path", () => {
    const feature = HUNT_PARCEL.parcels.features[0];
    const other = { ...feature, properties: { ...feature.properties, path: "/us/tx/hunt/other/1" } };
    const stale = { ...feature, properties: { ...feature.properties, path: "/us/tx/hunt/other/2" } };
    expect(parseParcelPoint({ parcels: { features: [other, stale] } }, HUNT_HIT.path)).toBeNull();
    expect(parseParcelPoint({ parcels: { features: [other] } }, HUNT_HIT.path)).not.toBeNull();
  });

  it("puts a state given without a county into an address search, never into a parcel number", () => {
    expect(searchText("1707 Jones St", "tx", false)).toBe("1707 Jones St, TX");
    expect(searchText("1707 Jones St, Greenville TX", "TX", false)).toBe("1707 Jones St, Greenville TX");
    expect(searchText("1707 Jones St", "TX", true)).toBe("1707 Jones St");
    expect(searchText("015-1010", "CA", false)).toBe("015-1010");
    expect(searchText("1707 Jones St", undefined, false)).toBe("1707 Jones St");
  });

  it("tests points against polygons with holes", () => {
    const polygons = polygonsOf({ type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]] });
    expect(pointInPolygons(1, 1, polygons)).toBe(true);
    expect(pointInPolygons(5, 5, polygons)).toBe(false);
    expect(pointInPolygons(20, 20, polygons)).toBe(false);
  });

  it("resolves a county only when exactly one fits", () => {
    expect(resolveCounty("Navajo", "AZ")?.county.fips).toBe("04017");
    expect(resolveCounty("Kern County", "CA")?.county.fips).toBe("06029");
    expect(resolveCounty("Washington", undefined)).toBeNull();
    expect(resolveCounty("St. Louis County", "MO")?.county.fips).toBe("29189");
    expect(resolveCounty("St. Louis City", "MO")?.county.fips).toBe("29510");
    expect(resolveCounty("Baltimore County", "MD")?.county.fips).toBe("24005");
    expect(resolveCounty("Juneau City and Borough", "AK")?.county.fips).toBe("02110");
    expect(resolveCounty("Anchorage Municipality", "AK")?.county.fips).toBe("02020");
  });

  it("limits find_parcel calls per client per minute", () => {
    const now = 1_000_000;
    expect(allowFindParcel("limit-test", FIND_PARCEL_LIMIT_PER_MINUTE, now)).toBe(true);
    expect(allowFindParcel("limit-test", 1, now + 1000)).toBe(false);
    expect(allowFindParcel("other-client", 1, now + 1000)).toBe(true);
    expect(allowFindParcel("limit-test", 1, now + 61_000)).toBe(true);
  });
});

describe("findParcel", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("returns the token for a parcel on Fabrica, with no second lookup", async () => {
    fetchMock.mockResolvedValueOnce(respond([SF_HIT]));
    const result = await findParcel({ query: "1707 Jones St, San Francisco" });
    expect(result).toMatchObject({ match: "single", parcel: { apn: "0151010", county: "San Francisco", onFabrica: { tokenId: "4737315677965897536" } } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("returns the on-ramp link with coordinates and APN for a parcel not on Fabrica", async () => {
    fetchMock.mockResolvedValueOnce(respond([HUNT_HIT])).mockResolvedValueOnce(respond(HUNT_PARCEL));
    const result = await findParcel({ query: "1707 Jones St", state: "TX", county: "Hunt" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("adminId=48231");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/api/regrid-apn?parcelnumb=71359");
    expect(result).toMatchObject({ match: "single", parcel: { onFabrica: null } });
    const link = "links" in result && result.links ? result.links.addToFabrica : "";
    const url = new URL(link);
    expect(url.pathname).toBe("/go");
    expect(url.searchParams.get("lat")).toBe("33.132262");
    expect(url.searchParams.get("lon")).toBe("-96.100462");
    expect(url.searchParams.get("apn")).toBe("71359");
    expect(url.searchParams.get("parcel")).toBe("f89e-uuid");
    expect(url.searchParams.get("path")).toBe(HUNT_HIT.path);
    const raw = JSON.stringify(result);
    expect(raw).not.toContain("OWNER");
    expect(raw).not.toContain("PRIVATE RD");
    expect(raw).toContain("Fabrica operates in all 50 states");
  });

  it("finds a token inside the parcel outline when the APN differs", async () => {
    const parcel = { parcels: { features: [{ ...HUNT_PARCEL.parcels.features[0], geometry: { type: "Polygon", coordinates: [[[-96.6, 33.4], [-96.4, 33.4], [-96.4, 33.6], [-96.6, 33.6], [-96.6, 33.4]]] } }] } };
    fetchMock.mockResolvedValueOnce(respond([HUNT_HIT])).mockResolvedValueOnce(respond(parcel));
    const result = await findParcel({ query: "1707 Jones St", state: "TX", county: "Hunt" });
    expect(result).toMatchObject({ match: "single", parcel: { onFabrica: { tokenId: "42" } } });
  });

  it("withholds the on-ramp when the Fabrica token check fails", async () => {
    vi.mocked(getParcelIndex).mockRejectedValueOnce(new Error("GraphQL down"));
    fetchMock.mockResolvedValueOnce(respond([HUNT_HIT]));
    const result = await findParcel({ query: "1707 Jones St", state: "TX", county: "Hunt" });
    expect(result).toMatchObject({ match: "single", parcel: { onFabrica: null }, note: expect.stringContaining("Could not check") });
    expect("links" in result).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns candidates and no link for an ambiguous query", async () => {
    fetchMock.mockResolvedValueOnce(respond([SF_HIT, HUNT_HIT]));
    const result = await findParcel({ query: "1707 Jones St" });
    expect(result).toMatchObject({ match: "ambiguous" });
    expect("candidates" in result ? result.candidates : []).toHaveLength(2);
    expect("links" in result).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("OWNER");
  });

  it("reports a search failure as an error, not a throw", async () => {
    fetchMock.mockResolvedValueOnce(respond({ message: "Error fetching type-ahead result from Regrid" }, 502));
    expect(await findParcel({ query: "1707 Jones St" })).toMatchObject({ error: expect.stringContaining("HTTP 502") });
  });

  it("rejects a county it cannot place", async () => {
    expect(await findParcel({ query: "1 Main St", county: "Nowhere Such" })).toMatchObject({ error: expect.stringContaining("No single US county") });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
