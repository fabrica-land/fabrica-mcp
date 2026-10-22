import { describe, it, expect, vi } from "vitest";
import { tokenListItem } from "./fixtures.js";

/** Price range, price per acre, sort order and distance to a point on search_land. */

// Four parcels around Flagstaff, AZ (35.198, -111.651): Kingman is ~135 mi west, Williams ~30 mi west, Sedona ~25 mi south, Phoenix ~120 mi south.
// Phoenix has no usable estimate ("0") and no mint date, so it exercises the "no value for this key" path.
const tokens = [
  tokenListItem({ tokenId: "kingman", name: "Kingman lot", regionCode: "AZ", district: "Mohave County", acres: "10", marketplacePrice: "20000", estimatedValue: "18000", score: 75342, mintedAt: "2025-03-01T00:00:00Z", coordinates: { lat: 35.189, lon: -114.053 } }),
  tokenListItem({ tokenId: "williams", name: "Williams lot", regionCode: "AZ", district: "Coconino County", acres: "40", marketplacePrice: "60000", estimatedValue: "55000", score: 75342, mintedAt: "2025-06-01T00:00:00Z", coordinates: { lat: 35.249, lon: -112.191 } }),
  tokenListItem({ tokenId: "sedona", name: "Sedona lot", regionCode: "AZ", district: "Yavapai County", acres: "2", marketplacePrice: null, estimatedValue: "90000", score: 73242, mintedAt: "2024-01-01T00:00:00Z", coordinates: { lat: 34.870, lon: -111.761 } }),
  tokenListItem({ tokenId: "phoenix", name: "Phoenix lot", regionCode: "AZ", district: "Maricopa County", acres: "1", marketplacePrice: "5000", estimatedValue: "0", score: 75342, mintedAt: null, coordinates: { lat: 33.448, lon: -112.074 } }),
];

vi.mock("../clients/graphql.js", () => ({
  getTokens: vi.fn(async () => tokens),
  getToken: vi.fn(),
  getAllLoans: vi.fn().mockResolvedValue([]),
  getCountyBounds: vi.fn(),
  DEFAULT_MIN_SCORE: 72032,
  filterSpamTokens: vi.fn((t: unknown[]) => t),
}));

import { searchProperties, sortTokens, pricePerAcre } from "../tools/properties.js";
import { haversineMiles } from "../geo.js";

type SearchResult = Awaited<ReturnType<typeof searchProperties>>;

/** The property-rows shape of a search result; a grouped or failed result fails the test. */
function rows(result: SearchResult) {
  if (!("properties" in result)) throw new Error(`expected property rows, got ${JSON.stringify(result)}`);
  return result;
}

const search = async (args: Parameters<typeof searchProperties>[0]) => rows(await searchProperties(args));
const ids = (r: ReturnType<typeof rows>) => r.properties.map(p => p.tokenId);
const flagstaff = { lat: 35.198, lon: -111.651 };

describe("haversine", () => {
  it("measures Flagstaff to Kingman at about 136 miles", () => {
    expect(haversineMiles(flagstaff, { lat: 35.189, lon: -114.053 })).toBeCloseTo(135.4, 0);
    expect(haversineMiles(flagstaff, flagstaff)).toBe(0);
  });
});

describe("price per acre", () => {
  it("uses the listing price when listed, the estimate otherwise, and says which", () => {
    expect(pricePerAcre(tokenListItem({ acres: "10", marketplacePrice: "20000", estimatedValue: "18000" }))).toEqual({ pricePerAcre: 2000, basis: "listing" });
    expect(pricePerAcre(tokenListItem({ acres: "2", marketplacePrice: null, estimatedValue: "90000" }))).toEqual({ pricePerAcre: 45000, basis: "estimate" });
    expect(pricePerAcre(tokenListItem({ acres: "2", marketplacePrice: null, estimatedValue: "0" }))).toBeNull();
    expect(pricePerAcre(tokenListItem({ acres: null, marketplacePrice: "1" }))).toBeNull();
    expect(pricePerAcre(tokenListItem({ acres: "0", marketplacePrice: "1" }))).toBeNull();
  });

  it("is on every row with its basis", async () => {
    const result = await search({});
    const kingman = result.properties.find(p => p.tokenId === "kingman");
    const sedona = result.properties.find(p => p.tokenId === "sedona");
    expect(kingman?.pricePerAcre).toBe("$2,000");
    expect(kingman?.pricePerAcreBasis).toBe("listing");
    expect(sedona?.pricePerAcre).toBe("$45,000");
    expect(sedona?.pricePerAcreBasis).toBe("estimate");
    expect(kingman && "distanceMiles" in kingman).toBe(false);
  });
});

describe("price filters", () => {
  it("match listed properties only", async () => {
    const result = await search({ maxPrice: 25000 });
    expect(ids(result).sort()).toEqual(["kingman", "phoenix"]);
    const perAcre = await search({ maxPricePerAcre: 2000 });
    expect(ids(perAcre).sort()).toEqual(["kingman", "williams"]);
    const band = await search({ minPrice: 10000, maxPrice: 30000, minPricePerAcre: 1000 });
    expect(ids(band)).toEqual(["kingman"]);
  });

  it("says why nothing matched when a price filter emptied the list", async () => {
    const result = await search({ minPrice: 1_000_000 });
    expect(result.total).toBe(0);
    expect("message" in result ? result.message : "").toContain("listed properties only");
  });
});

describe("sorting", () => {
  it("by listing price puts unlisted properties last in either direction", async () => {
    const asc = await search({ sortBy: "price" });
    expect(ids(asc)).toEqual(["phoenix", "kingman", "williams", "sedona"]);
    expect(asc.sortedBy).toBe("price");
    expect(asc.sortNote).toContain("no listing come last");
    const desc = await search({ sortBy: "price", sortDir: "desc" });
    expect(ids(desc)).toEqual(["williams", "kingman", "phoenix", "sedona"]);
  });

  it("by price per acre reads the listing only", async () => {
    const result = await search({ sortBy: "pricePerAcre" });
    expect(ids(result)).toEqual(["williams", "kingman", "phoenix", "sedona"]);
  });

  it("by acres, estimated value and score", async () => {
    expect(ids(await search({ sortBy: "acres", sortDir: "desc" }))).toEqual(["williams", "kingman", "sedona", "phoenix"]);
    expect(ids(await search({ sortBy: "estimatedValue" }))).toEqual(["kingman", "williams", "sedona", "phoenix"]);
    expect(ids(await search({ sortBy: "estimatedValue", sortDir: "desc" }))).toEqual(["sedona", "williams", "kingman", "phoenix"]);
    expect(ids(await search({ sortBy: "score" }))[0]).toBe("sedona");
  });

  it("newest is most recent first whatever sortDir says, unknown dates last", async () => {
    const result = await search({ sortBy: "newest", sortDir: "asc" });
    expect(ids(result)).toEqual(["williams", "kingman", "sedona", "phoenix"]);
    expect(result.sortDir).toBe("desc");
  });

  it("is stable: ties keep the API's order", () => {
    const sorted = sortTokens(tokens, "score", "desc");
    expect(sorted.map(t => t.tokenId)).toEqual(["kingman", "williams", "phoenix", "sedona"]);
  });

  it("distance without near falls back to the API's order with a note", async () => {
    const result = await search({ sortBy: "distance" });
    expect(ids(result)).toEqual(["kingman", "williams", "sedona", "phoenix"]);
    expect(result.sortNote).toContain("needs near");
    expect(result.sortedBy).toBeUndefined();
  });
});

describe("distance to a point", () => {
  it("sorts by distance by default and puts the distance on each row", async () => {
    const result = await search({ near: flagstaff });
    expect(ids(result)).toEqual(["sedona", "williams", "phoenix", "kingman"]);
    expect(result.sortedBy).toBe("distance");
    expect(result.distanceNote).toContain("straight-line");
    expect(result.properties[0]?.distanceMiles).toBeCloseTo(23.5, 0);
    expect(result.properties[3]?.distanceMiles).toBeCloseTo(135.4, 0);
  });

  it("radiusMiles keeps only the parcels within it", async () => {
    const result = await search({ near: { ...flagstaff, radiusMiles: 50 } });
    expect(ids(result)).toEqual(["sedona", "williams"]);
    expect(result.total).toBe(2);
  });

  it("the cheapest listings per acre within 150 miles of Flagstaff is one call", async () => {
    const result = await search({ near: { ...flagstaff, radiusMiles: 150 }, minPrice: 1, sortBy: "pricePerAcre" });
    expect(ids(result)).toEqual(["williams", "kingman", "phoenix"]);
    expect(result.properties.every(p => typeof p.distanceMiles === "number")).toBe(true);
  });

  it("does not reorder groupBy rows", async () => {
    const result = await searchProperties({ near: flagstaff, groupBy: "county" });
    if (!("groups" in result)) throw new Error("expected groups");
    expect(result.groups.length).toBe(4);
    expect("sortedBy" in result).toBe(false);
  });
});
