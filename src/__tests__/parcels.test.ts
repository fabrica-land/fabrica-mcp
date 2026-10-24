import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParcelIndexToken } from "../types/index.js";

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

/** A parcel index row with every selected field present, so a fixture needs no cast. */
function parcelToken(overrides: Partial<ParcelIndexToken> & Pick<ParcelIndexToken, "tokenId">): ParcelIndexToken {
  return {
    name: null, vanityName: null, slug: `token-${overrides.tokenId}`, propertyLink: `https://fabrica.land/token-${overrides.tokenId}`,
    regionCode: null, district: null, place: null, coordinates: { lat: 0, lon: 0 }, definition: null,
    ...overrides,
  };
}
const { allowFindParcel, findParcel, interiorPoint, matchByApn, matchIndexByQuery, queryLocality, streetKey, typeAheadText, parseParcelPoint, parseTypeAhead, pointInPolygons, polygonsOf, resolveCounty, stateRetryText, FIND_PARCEL_LIMIT_PER_MINUTE } = await import("../tools/parcels.js");

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

function sfParcel(coordinates: number[][][]) {
  return {
    parcels: {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        geometry: { type: "Polygon", coordinates },
        properties: { path: SF_HIT.path, fields: { ll_uuid: "sf-uuid", geoid: "06075", lat: String(coordinates[0]?.[0]?.[1]), lon: String(coordinates[0]?.[0]?.[0]) } },
      }],
    },
  };
}

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("find_us_parcel helpers", () => {
  it("drops owner names from type-ahead rows", () => {
    const hits = parseTypeAhead([SF_HIT, { headline: "no path" }, "junk"]);
    expect(hits).toEqual([{ headline: "1707 Jones St", context: "San Francisco, CA", apn: "0151010", path: SF_HIT.path, score: 85 }]);
    expect(JSON.stringify(hits)).not.toContain("PRIVATE");
  });

  it("matches a token by state, county and APN, ignoring punctuation", () => {
    const [hit] = parseTypeAhead([SF_HIT]);
    if (!hit) throw new Error("no hit");
    const token = parcelToken({ tokenId: "1", regionCode: "CA", definition: { offchainRegistrar: { admin: "San Francisco", propertyId: "015-1010" } } });
    expect(matchByApn(hit, [token])?.tokenId).toBe("1");
    expect(matchByApn(hit, [{ ...token, regionCode: "NV" }])).toBeNull();
    expect(matchByApn(hit, [{ ...token, definition: { offchainRegistrar: { admin: "Kern", propertyId: "0151010" } } }])).toBeNull();
  });

  it("matches a FIPS-prefixed registrar parcel number, and never confuses a county with a same-named city", () => {
    const stLouisCity = { headline: "1 Main St", context: "St. Louis, MO", apn: "12-345", path: "/us/mo/st-louis/downtown/1", score: 90 };
    const stLouisCounty = { ...stLouisCity, path: "/us/mo/st-louis-county/clayton/1" };
    const countyToken = parcelToken({ tokenId: "7", regionCode: "MO", definition: { offchainRegistrar: { admin: "St. Louis", propertyId: "29189-12-345" } } });
    expect(matchByApn(stLouisCounty, [countyToken])?.tokenId).toBe("7");
    expect(matchByApn(stLouisCity, [countyToken])).toBeNull();
    expect(matchByApn(stLouisCity, [{ ...countyToken, definition: { offchainRegistrar: { admin: "St. Louis City", propertyId: "12-345" } } }])?.tokenId).toBe("7");
  });

  it("strips a five-digit prefix only when it is the parcel's county FIPS", () => {
    const hit = { headline: "1 Main St", context: "Clayton, MO", apn: "678", path: "/us/mo/st-louis-county/clayton/1", score: 90 };
    const bare = parcelToken({ tokenId: "8", regionCode: "MO", definition: { offchainRegistrar: { admin: "St. Louis", propertyId: "12345-678" } } });
    expect(matchByApn(hit, [bare])).toBeNull();
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

  it("retries with the state in the text only when there is a state, no county, and the query does not name it", () => {
    expect(stateRetryText("123-45 67th Ave", "ny", false)).toBe("123-45 67th Ave, NY");
    expect(stateRetryText("1707 Jones St, Greenville TX", "TX", false)).toBeNull();
    expect(stateRetryText("1707 Jones St", "TX", true)).toBeNull();
    expect(stateRetryText("1707 Jones St", undefined, false)).toBeNull();
  });

  it("tests points against polygons with holes", () => {
    const polygons = polygonsOf({ type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]] });
    expect(pointInPolygons(1, 1, polygons)).toBe(true);
    expect(pointInPolygons(5, 5, polygons)).toBe(false);
    expect(pointInPolygons(20, 20, polygons)).toBe(false);
  });

  it("picks a point inside concave parcels and around holes when Regrid gives none", () => {
    // A U shape: the vertex average (5, ~3.6) sits in the notch, outside the parcel.
    const u = polygonsOf({ type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [7, 10], [7, 2], [3, 2], [3, 10], [0, 10], [0, 0]]] });
    const ring = { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]]] };
    for (const polygons of [u, polygonsOf(ring)]) {
      const [first] = polygons;
      const point = first ? interiorPoint(first) : null;
      expect(point).not.toBeNull();
      if (point) expect(pointInPolygons(point.lat, point.lon, polygons)).toBe(true);
    }
    const parsed = parseParcelPoint({ parcels: { features: [{ geometry: ring, properties: { path: "/p", fields: {} } }] } }, "/p");
    expect(parsed && pointInPolygons(parsed.lat, parsed.lon, polygonsOf(ring))).toBe(true);
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

  it("limits find_us_parcel calls per client per minute", () => {
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

  it("returns the token for a parcel on Fabrica when the outline cannot be loaded", async () => {
    fetchMock.mockResolvedValueOnce(respond([SF_HIT])).mockRejectedValueOnce(new Error("outline down"));
    const result = await findParcel({ query: "1707 Jones St, San Francisco" });
    expect(result).toMatchObject({ match: "single", parcel: { apn: "0151010", county: "San Francisco", onFabrica: { tokenId: "4737315677965897536" } } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveProperty("network");
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("keeps a parcel-number match whose token sits inside the parcel's outline", async () => {
    fetchMock.mockResolvedValueOnce(respond([SF_HIT])).mockResolvedValueOnce(respond(sfParcel([[[-122.42, 37.79], [-122.41, 37.79], [-122.41, 37.80], [-122.42, 37.80], [-122.42, 37.79]]])));
    const result = await findParcel({ query: "1707 Jones St, San Francisco" });
    expect(result).toMatchObject({ match: "single", parcel: { onFabrica: { tokenId: "4737315677965897536" } } });
  });

  it("drops a parcel-number match when the token lies outside the parcel's outline (a repeated number)", async () => {
    fetchMock.mockResolvedValueOnce(respond([SF_HIT])).mockResolvedValueOnce(respond(sfParcel([[[-122.50, 37.70], [-122.49, 37.70], [-122.49, 37.71], [-122.50, 37.71], [-122.50, 37.70]]])));
    const result = await findParcel({ query: "1707 Jones St, San Francisco" });
    expect(result).toMatchObject({ match: "single", parcel: { onFabrica: null } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    expect(result).toMatchObject({ coverage: { status: "supported" } });
    expect(raw).toContain("Adding property is set up for this county");
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
    // The San Francisco hit matches a token by number, so its outline is checked; Hunt's is not.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain("OWNER");
  });

  it("drops a number-matched token from an ambiguous candidate whose outline does not contain it", async () => {
    fetchMock.mockResolvedValueOnce(respond([SF_HIT, HUNT_HIT])).mockResolvedValueOnce(respond(sfParcel([[[-122.50, 37.70], [-122.49, 37.70], [-122.49, 37.71], [-122.50, 37.71], [-122.50, 37.70]]])));
    const result = await findParcel({ query: "1707 Jones St" });
    expect(result).toMatchObject({ match: "ambiguous" });
    expect("candidates" in result ? result.candidates?.map((c) => c.onFabrica) : undefined).toEqual([null, null]);
    expect("note" in result ? result.note : "").toContain("narrows to one parcel");
  });

  it("prefers the state-ranked search over a stray in-state hit from the nationwide one", async () => {
    const stray = { ...HUNT_HIT, headline: "Main St", parcelnumb: "1", path: "/us/tx/hunt/greenville/1", score: 40 };
    const intended = { ...HUNT_HIT, headline: "100 Main St", parcelnumb: "2", path: "/us/tx/hunt/greenville/2", score: 90 };
    fetchMock.mockResolvedValueOnce(respond([SF_HIT, stray])).mockResolvedValueOnce(respond([intended]));
    const result = await findParcel({ query: "100 Main St", state: "TX" });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("100+Main+St+TX");
    expect(result).toMatchObject({ match: "single", parcel: { apn: "2" } });
  });

  it("keeps several exact parcel-number hits ambiguous, whatever their scores", async () => {
    const first = { ...HUNT_HIT, headline: "A", parcelnumb: "71359", score: 95 };
    const second = { ...HUNT_HIT, headline: "B", parcelnumb: "71-359", path: "/us/tx/hunt/greenville/99999", score: 60 };
    const other = { ...HUNT_HIT, headline: "C", parcelnumb: "12345", path: "/us/tx/hunt/greenville/11111", score: 99 };
    fetchMock.mockResolvedValueOnce(respond([other, first, second]));
    const result = await findParcel({ query: "71359", state: "TX", county: "Hunt" });
    expect(result).toMatchObject({ match: "ambiguous" });
    expect("candidates" in result ? (result.candidates ?? []).map((c) => c.apn) : []).toEqual(["71359", "71-359"]);
    expect("links" in result).toBe(false);
  });

  it("sends the query as typed first, then retries with the state in the text", async () => {
    fetchMock.mockResolvedValueOnce(respond([SF_HIT])).mockResolvedValueOnce(respond([HUNT_HIT])).mockResolvedValueOnce(respond(HUNT_PARCEL));
    const result = await findParcel({ query: "1707 Jones St", state: "TX" });
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get("query")).toBe("1707 Jones St");
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get("query")).toBe("1707 Jones St TX");
    expect(result).toMatchObject({ match: "single", parcel: { state: "TX" } });
  });

  it("gives a token to neither of two parcels that share its county and parcel number", async () => {
    const a = { ...SF_HIT, headline: "Unit A", path: "/us/ca/san-francisco/downtown/1" };
    const b = { ...SF_HIT, headline: "Unit B", path: "/us/ca/san-francisco/downtown/2" };
    fetchMock.mockResolvedValueOnce(respond([a, b]));
    const result = await findParcel({ query: "0151010", state: "CA", county: "San Francisco" });
    expect(result).toMatchObject({ match: "ambiguous" });
    expect("candidates" in result ? (result.candidates ?? []).map((c) => c.onFabrica) : []).toEqual([null, null]);
  });

  it("reports a search failure as an error, not a throw, when Fabrica's records do not know the address", async () => {
    fetchMock.mockResolvedValueOnce(respond({ message: "Error fetching type-ahead result from Regrid" }, 502));
    expect(await findParcel({ query: "9 Nowhere Lane" })).toMatchObject({ error: expect.stringContaining("HTTP 502") });
  });

  it("strips commas before the type-ahead (the upstream search refuses them)", async () => {
    fetchMock.mockResolvedValueOnce(respond([SF_HIT])).mockResolvedValueOnce(respond(sfParcel([[[-122.416, 37.796], [-122.414, 37.796], [-122.414, 37.798], [-122.416, 37.798], [-122.416, 37.796]]])));
    await findParcel({ query: "1707 Jones St, San Francisco, CA" });
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get("query")).toBe("1707 Jones St San Francisco CA");
  });

  it("falls back to Fabrica's own records when the parcel search is down", async () => {
    fetchMock.mockResolvedValueOnce(respond({ message: "Error fetching type-ahead result from Regrid" }, 502));
    const result = await findParcel({ query: "1707 Jones Street, San Francisco, CA", state: "CA" });
    expect(result).toMatchObject({
      match: "unconfirmed",
      matchSource: "fabrica-index",
      candidates: [{ apn: "015-1010", state: "CA", regridPath: null, onFabrica: { tokenId: "4737315677965897536" } }],
      note: expect.stringContaining("HTTP 502"),
    });
    expect(result).toMatchObject({ note: expect.stringContaining("not confirmed") });
  });

  it("falls back by parcel number too, and never across states", async () => {
    fetchMock.mockResolvedValue(respond({ message: "unavailable" }, 502));
    expect(await findParcel({ query: "015-1010", state: "CA" })).toMatchObject({ match: "unconfirmed", candidates: [{ onFabrica: { tokenId: "4737315677965897536" } }] });
    expect(await findParcel({ query: "1707 Jones St", state: "NV" })).toMatchObject({ error: expect.stringContaining("does not confirm") });
  });

  it("rejects a county it cannot place", async () => {
    expect(await findParcel({ query: "1 Main St", county: "Nowhere Such" })).toMatchObject({ error: expect.stringContaining("No single US county") });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("type-ahead fallback helpers", () => {
  it("drops commas and keeps the words", () => {
    expect(typeAheadText(" 37497 Palo Colorado Road,  Carmel, CA ")).toBe("37497 Palo Colorado Road Carmel CA");
  });

  it("reads the house number and street, abbreviating suffixes and dropping directions", () => {
    expect(streetKey("37497 Palo Colorado Road, Carmel, CA")).toEqual({ number: "37497", direction: null, street: ["palo", "colorado", "rd"] });
    expect(streetKey("29078 West Stagecoach Lane")).toEqual({ number: "29078", direction: "w", street: ["stagecoach", "ln"] });
    expect(streetKey("Somewhere in Hunt")).toBeNull();
  });

  it("matches the same street, not a neighbour or a different street with the same number", () => {
    const tokens = [
      parcelToken({ tokenId: "1", name: "37497 Palo Colorado Road, Carmel, CA", regionCode: "CA" }),
      parcelToken({ tokenId: "2", name: "37709 Palo Colorado Road, Carmel, CA", regionCode: "CA" }),
      parcelToken({ tokenId: "3", name: "37497 Palo Alto Road, Somewhere, CA", regionCode: "CA" }),
    ];
    expect(matchIndexByQuery("37497 Palo Colorado Rd, Carmel, CA", { state: "CA" }, tokens).map((t) => t.tokenId)).toEqual(["1"]);
    expect(matchIndexByQuery("37497 Palo Colorado Rd", { state: "AZ" }, tokens)).toEqual([]);
  });

  it("keeps East and West apart, and honours the county", () => {
    const tokens = [
      parcelToken({ tokenId: "w", name: "29078 West Stagecoach Lane, Seligman, AZ", regionCode: "AZ", district: "Yavapai County" }),
      parcelToken({ tokenId: "x", name: "29078 Stagecoach Lane, Elsewhere, AZ", regionCode: "AZ", district: "Mohave County" }),
    ];
    expect(matchIndexByQuery("29078 E Stagecoach Ln", { state: "AZ" }, tokens).map((t) => t.tokenId)).toEqual(["x"]);
    expect(matchIndexByQuery("29078 W Stagecoach Ln", { state: "AZ" }, tokens).map((t) => t.tokenId)).toEqual(["w", "x"]);
    expect(matchIndexByQuery("29078 W Stagecoach Ln", { state: "AZ", county: "Yavapai" }, tokens).map((t) => t.tokenId)).toEqual(["w"]);
  });

  it("holds the city and state written in the address", () => {
    expect(queryLocality("123 Main St, Reno, NV 89501")).toEqual({ city: "Reno", state: "NV" });
    expect(queryLocality("123 Main St, Reno")).toEqual({ city: "Reno", state: null });
    expect(queryLocality("123 Oak Ct")).toEqual({ city: null, state: null });
    const tokens = [parcelToken({ tokenId: "tx", name: "123 Main St, Austin, TX", regionCode: "TX", place: "Austin" })];
    expect(matchIndexByQuery("123 Main St, Reno, NV", {}, tokens)).toEqual([]);
    expect(matchIndexByQuery("123 Main St, Reno, TX", {}, tokens)).toEqual([]);
    expect(matchIndexByQuery("123 Main St, Austin, Texas", {}, tokens).map((t) => t.tokenId)).toEqual(["tx"]);
  });

  it("matches a registrar APN with or without its own county FIPS prefix", () => {
    const tokens = [parcelToken({ tokenId: "la", name: "1 Elm St, Los Angeles, CA", regionCode: "CA", definition: { offchainRegistrar: { admin: "06037", propertyId: "06037-018-007" } } })];
    expect(matchIndexByQuery("018-007", {}, tokens).map((t) => t.tokenId)).toEqual(["la"]);
    expect(matchIndexByQuery("06037-018-007", {}, tokens).map((t) => t.tokenId)).toEqual(["la"]);
    expect(matchIndexByQuery("018-007", { state: "CA", county: "Los Angeles" }, tokens).map((t) => t.tokenId)).toEqual(["la"]);
    expect(matchIndexByQuery("018-007", { state: "CA", county: "Orange" }, tokens)).toEqual([]);
  });

  it("needs the whole street, with or without its suffix", () => {
    const tokens = [parcelToken({ tokenId: "e", name: "123 Main Street Extension, Town, TX", regionCode: "TX" })];
    expect(matchIndexByQuery("123 Main Street", { state: "TX" }, tokens)).toEqual([]);
    const plain = [parcelToken({ tokenId: "p", name: "37497 Palo Colorado Road, Carmel, CA", regionCode: "CA" })];
    expect(matchIndexByQuery("37497 Palo Colorado", { state: "CA" }, plain).map((t) => t.tokenId)).toEqual(["p"]);
    expect(matchIndexByQuery("37497 Palo Colorado Ln", { state: "CA" }, plain)).toEqual([]);
  });
});

describe("find_us_parcel with a list", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const sfOutline = sfParcel([[[-122.42, 37.79], [-122.41, 37.79], [-122.41, 37.80], [-122.42, 37.80], [-122.42, 37.79]]]);
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(getParcelIndex).mockClear();
    // Answers by URL: the list runs several lookups at once, so call order is not fixed.
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      const query = url.searchParams.get("query") ?? "";
      if (url.pathname.endsWith("/regrid-apn")) return respond(url.searchParams.get("parcelnumb") === "71359" ? HUNT_PARCEL : sfOutline);
      if (query === "1707 Jones St San Francisco") return respond([SF_HIT]);
      if (query === "71359") return respond([HUNT_HIT]);
      if (query === "1707 Jones St") return respond([SF_HIT, HUNT_HIT]);
      return respond([]);
    });
  });
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("returns one row per resolved query and the rest unresolved with the reason, reading Fabrica's records once", async () => {
    const { findParcelWithUsage } = await import("../tools/parcels.js");
    const { result, onFabrica } = await findParcelWithUsage({ queries: ["1707 Jones St, San Francisco", "71359", "1707 Jones St", "nowhere at all"] });
    expect(getParcelIndex).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      network: expect.any(String),
      queries: 4,
      rows: [
        { query: "1707 Jones St, San Francisco", onFabrica: true, tokenId: "4737315677965897536", county: "San Francisco" },
        { query: "71359", onFabrica: false, apn: "71359", county: "Hunt", coverage: "supported", addToFabrica: expect.stringContaining("/go?") },
      ],
      unresolved: [
        { query: "1707 Jones St", reason: expect.stringContaining("2 parcels match"), candidates: expect.any(Array) },
        { query: "nowhere at all", reason: expect.stringContaining("No US parcel matched") },
      ],
    });
    // The ambiguous row names a Fabrica token by parcel number, so it counts as on Fabrica; the empty one settles nothing.
    expect(onFabrica).toEqual([true, false, true]);
    const raw = JSON.stringify(result);
    expect(raw).not.toContain("OWNER");
    expect(raw).not.toContain("PRIVATE");
  });

  it("flags a single query for the usage log, and nothing when it settles nothing", async () => {
    const { findParcelWithUsage } = await import("../tools/parcels.js");
    expect((await findParcelWithUsage({ query: "71359" })).onFabrica).toEqual([false]);
    expect((await findParcelWithUsage({ query: "nowhere at all" })).onFabrica).toEqual([]);
  });

  it("refuses query and queries together, and neither", async () => {
    expect(await findParcel({ query: "71359", queries: ["71359"] })).toMatchObject({ error: expect.stringContaining("not both") });
    expect(await findParcel({})).toMatchObject({ error: expect.stringContaining("Give query") });
  });

  it("takes 10 queries in one call and refuses an 11th with the limit in the message", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createServer } = await import("../server.js");
    const seen: boolean[][] = [];
    const server = createServer({ onFindParcel: (flags) => seen.push([...flags]) });
    const client = new Client({ name: "batch-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const ten = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? "71359" : "1707 Jones St, San Francisco"));
    const ok = await client.callTool({ name: "find_us_parcel", arguments: { queries: ten } });
    expect(ok.isError).toBeFalsy();
    const [first] = Array.isArray(ok.content) ? ok.content : [];
    const text = typeof first === "object" && first !== null && "text" in first && typeof first.text === "string" ? first.text : "{}";
    expect(JSON.parse(text).rows).toHaveLength(10);
    expect(seen).toEqual([[false, true, false, true, false, true, false, true, false, true]]);
    const eleven = await client.callTool({ name: "find_us_parcel", arguments: { queries: [...ten, "71359"] } }).catch((error: unknown) => ({ isError: true, content: [{ type: "text", text: String(error) }] }));
    expect(eleven.isError).toBe(true);
    expect(JSON.stringify(eleven.content)).toContain("at most 10 queries per call");
    await client.close();
  }, 30_000);
});
