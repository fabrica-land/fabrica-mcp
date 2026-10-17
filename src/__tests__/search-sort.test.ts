import { describe, it, expect, vi } from "vitest";
import { tokenListItem } from "./fixtures.js";

/** ENG-5067: price range, price per acre, sort order and distance to a point on search_properties. */

// Four parcels around Flagstaff, AZ (35.198, -111.651): Kingman is ~150 mi west, Williams ~30 mi west, Sedona ~25 mi south, Phoenix ~120 mi south.
const tokens = [
  tokenListItem({ tokenId: "kingman", name: "Kingman lot", regionCode: "AZ", district: "Mohave County", acres: "10", marketplacePrice: "20000", estimatedValue: "18000", score: 75342, mintedAt: "2025-03-01T00:00:00Z", coordinates: { lat: 35.189, lon: -114.053 } }),
  tokenListItem({ tokenId: "williams", name: "Williams lot", regionCode: "AZ", district: "Coconino County", acres: "40", marketplacePrice: "60000", estimatedValue: "55000", score: 75342, mintedAt: "2025-06-01T00:00:00Z", coordinates: { lat: 35.249, lon: -112.191 } }),
  tokenListItem({ tokenId: "sedona", name: "Sedona lot", regionCode: "AZ", district: "Yavapai County", acres: "2", marketplacePrice: null, estimatedValue: "90000", score: 73242, mintedAt: "2024-01-01T00:00:00Z", coordinates: { lat: 34.870, lon: -111.761 } }),
  tokenListItem({ tokenId: "phoenix", name: "Phoenix lot", regionCode: "AZ", district: "Maricopa County", acres: "1", marketplacePrice: "5000", estimatedValue: null as unknown as string, score: 75342, mintedAt: null, coordinates: null as unknown as { lat: number; lon: number } }),
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

type Row = Record<string, unknown>;
type Result = { properties: Row[]; total: number; sortedBy?: string; sortDir?: string; sortNote?: string; distanceNote?: string; message?: string };

const ids = (r: Result) => r.properties.map(p => p.tokenId);
const flagstaff = { lat: 35.198, lon: -111.651 };

describe("haversine", () => {
  it("measures Flagstaff to Kingman at about 136 miles", () => {
    expect(haversineMiles(flagstaff, { lat: 35.189, lon: -114.053 })).toBeCloseTo(135.4, 0);
    expect(haversineMiles(flagstaff, flagstaff)).toBe(0);
  });
});

describe("price per acre", () => {
  it("uses the listing price when listed, the estimate otherwise, and says which", () => {
    expect(pricePerAcre(tokens[0]!)).toEqual({ pricePerAcre: 2000, basis: "listing" });
    expect(pricePerAcre(tokens[2]!)).toEqual({ pricePerAcre: 45000, basis: "estimate" });
    expect(pricePerAcre(tokenListItem({ acres: null, marketplacePrice: "1" }))).toBeNull();
    expect(pricePerAcre(tokenListItem({ acres: "0", marketplacePrice: "1" }))).toBeNull();
  });

  it("is on every row with its basis", async () => {
    const result = await searchProperties({}) as Result;
    const kingman = result.properties.find(p => p.tokenId === "kingman")!;
    const sedona = result.properties.find(p => p.tokenId === "sedona")!;
    expect(kingman.pricePerAcre).toBe("$2,000");
    expect(kingman.pricePerAcreBasis).toBe("listing");
    expect(sedona.pricePerAcre).toBe("$45,000");
    expect(sedona.pricePerAcreBasis).toBe("estimate");
    expect(kingman.distanceMiles).toBeUndefined();
  });
});

describe("price filters", () => {
  it("match listed properties only", async () => {
    const result = await searchProperties({ maxPrice: 25000 }) as Result;
    expect(ids(result).sort()).toEqual(["kingman", "phoenix"]);
    const perAcre = await searchProperties({ maxPricePerAcre: 2000 }) as Result;
    expect(ids(perAcre).sort()).toEqual(["kingman", "williams"]);
    const band = await searchProperties({ minPrice: 10000, maxPrice: 30000, minPricePerAcre: 1000 }) as Result;
    expect(ids(band)).toEqual(["kingman"]);
  });

  it("says why nothing matched when a price filter emptied the list", async () => {
    const result = await searchProperties({ minPrice: 1_000_000 }) as Result;
    expect(result.total).toBe(0);
    expect(result.message).toContain("listed properties only");
  });
});

describe("sorting", () => {
  it("by listing price puts unlisted properties last in either direction", async () => {
    const asc = await searchProperties({ sortBy: "price" }) as Result;
    expect(ids(asc)).toEqual(["phoenix", "kingman", "williams", "sedona"]);
    expect(asc.sortedBy).toBe("price");
    expect(asc.sortNote).toContain("no listing come last");
    const desc = await searchProperties({ sortBy: "price", sortDir: "desc" }) as Result;
    expect(ids(desc)).toEqual(["williams", "kingman", "phoenix", "sedona"]);
  });

  it("by price per acre reads the listing only", async () => {
    const result = await searchProperties({ sortBy: "pricePerAcre" }) as Result;
    expect(ids(result)).toEqual(["williams", "kingman", "phoenix", "sedona"]);
  });

  it("by acres, estimated value and score", async () => {
    expect(ids(await searchProperties({ sortBy: "acres", sortDir: "desc" }) as Result)).toEqual(["williams", "kingman", "sedona", "phoenix"]);
    expect(ids(await searchProperties({ sortBy: "estimatedValue" }) as Result)).toEqual(["kingman", "williams", "sedona", "phoenix"]);
    expect(ids(await searchProperties({ sortBy: "score" }) as Result)[0]).toBe("sedona");
  });

  it("newest is most recent first whatever sortDir says, unknown dates last", async () => {
    const result = await searchProperties({ sortBy: "newest", sortDir: "asc" }) as Result;
    expect(ids(result)).toEqual(["williams", "kingman", "sedona", "phoenix"]);
    expect(result.sortDir).toBe("desc");
  });

  it("is stable: ties keep the API's order", () => {
    const sorted = sortTokens(tokens, "score", "desc");
    expect(sorted.map(t => t.tokenId)).toEqual(["kingman", "williams", "phoenix", "sedona"]);
  });

  it("distance without near falls back to the API's order with a note", async () => {
    const result = await searchProperties({ sortBy: "distance" }) as Result;
    expect(ids(result)).toEqual(["kingman", "williams", "sedona", "phoenix"]);
    expect(result.sortNote).toContain("needs near");
    expect(result.sortedBy).toBeUndefined();
  });
});

describe("distance to a point", () => {
  it("sorts by distance by default and puts the distance on each row", async () => {
    const result = await searchProperties({ near: flagstaff }) as Result;
    expect(ids(result)).toEqual(["sedona", "williams", "kingman", "phoenix"]);
    expect(result.sortedBy).toBe("distance");
    expect(result.distanceNote).toContain("straight-line");
    const sedona = result.properties[0]!;
    expect(sedona.distanceMiles).toBeCloseTo(23.5, 0);
    expect(result.properties[3]!.distanceMiles).toBeNull();
  });

  it("radiusMiles keeps only the parcels within it, and drops rows with no coordinates", async () => {
    const result = await searchProperties({ near: { ...flagstaff, radiusMiles: 50 } }) as Result;
    expect(ids(result)).toEqual(["sedona", "williams"]);
    expect(result.total).toBe(2);
  });

  it("the cheapest listings per acre within 150 miles of Flagstaff is one call", async () => {
    const result = await searchProperties({ near: { ...flagstaff, radiusMiles: 150 }, hasListings: true, sortBy: "pricePerAcre" }) as Result;
    expect(ids(result)).toEqual(["williams", "kingman", "sedona"]);
    expect(result.properties.every(p => typeof p.distanceMiles === "number")).toBe(true);
  });

  it("does not reorder groupBy rows", async () => {
    const result = await searchProperties({ near: flagstaff, groupBy: "county" }) as { groups: Row[]; sortedBy?: string };
    expect(result.groups.length).toBe(4);
    expect(result.sortedBy).toBeUndefined();
  });
});
