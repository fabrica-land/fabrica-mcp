import { describe, it, expect, vi } from "vitest";

/** ENG-4995: search by county, groupBy, and links to the fabrica.land location pages. */

const tokens = [
  { tokenId: "1", name: "Lot 1", region: "Colorado", regionCode: "CO", district: "Costilla County", place: "San Luis", acres: "5", marketplacePrice: "10000", supplyUnderLoan: "0", score: 75342, estimatedValue: "9000", coordinates: null, majorityOwnerAddress: null, propertyLink: null },
  { tokenId: "2", name: "Lot 2", region: "Colorado", regionCode: "CO", district: "Costilla County", place: "Fort Garland", acres: "35.5", marketplacePrice: null, supplyUnderLoan: "0", score: 75342, estimatedValue: "20000", coordinates: null, majorityOwnerAddress: null, propertyLink: null },
  { tokenId: "3", name: "Lot 3", region: "Colorado", regionCode: "CO", district: "Huerfano County", place: null, acres: "40", marketplacePrice: "50000", supplyUnderLoan: "0", score: 75342, estimatedValue: "45000", coordinates: null, majorityOwnerAddress: null, propertyLink: null },
  { tokenId: "4", name: "Lot 4", region: "Arizona", regionCode: "AZ", district: "Mohave County", place: "Kingman", acres: "1", marketplacePrice: null, supplyUnderLoan: "0", score: 75342, estimatedValue: "5000", coordinates: null, majorityOwnerAddress: null, propertyLink: null },
];

vi.mock("../clients/graphql.js", () => ({
  getTokens: vi.fn(async () => tokens),
  getToken: vi.fn(),
  getAllLoans: vi.fn().mockResolvedValue([]),
  getCountyBounds: vi.fn(),
  DEFAULT_MIN_SCORE: 72032,
  filterSpamTokens: vi.fn((t: unknown[]) => t),
}));

vi.mock("../clients/subgraph.js", () => ({
  getFabricaPools: vi.fn().mockResolvedValue([]),
  aggregatePoolStats: vi.fn().mockReturnValue(null),
}));

import { getTokens } from "../clients/graphql.js";
import { searchProperties, normalizeCounty, groupTokens } from "../tools/properties.js";
import { getProtocolStats } from "../tools/protocol.js";
import { locationLink, slugifyPlaceName, PLATFORM_URL } from "../links.js";

describe("location links", () => {
  it("follows the fabrica.land slug rule", () => {
    expect(slugifyPlaceName("Los Angeles County")).toBe("los-angeles-county");
    expect(slugifyPlaceName("Doña Ana County")).toBe("dona-ana-county");
    expect(locationLink({ state: "Colorado", county: "Costilla County", place: "San Luis" })).toBe(`${PLATFORM_URL}/us/colorado/costilla-county/san-luis`);
    expect(locationLink({ state: "Colorado", county: null, place: "San Luis" })).toBe(`${PLATFORM_URL}/us/colorado`);
    expect(locationLink({ state: null, county: "Costilla County" })).toBeNull();
  });

  it("normalizes county names", () => {
    expect(normalizeCounty("Costilla")).toBe("costilla");
    expect(normalizeCounty(" mohave  COUNTY ")).toBe("mohave");
  });
});

describe("search_properties by county", () => {
  it("returns the rows and the county page for 'for sale in Costilla County, Colorado'", async () => {
    const result = await searchProperties({ region: "CO", county: "costilla", hasListings: true }) as Record<string, unknown>;
    // hasListings is applied by the API; the mock returns every token, so both Costilla rows come back.
    expect(result.total).toBe(2);
    expect(result.locationLink).toBe(`${PLATFORM_URL}/us/colorado/costilla-county`);
  });

  it("links the state page for a state filter", async () => {
    const result = await searchProperties({ region: "co" }) as Record<string, unknown>;
    expect(result.total).toBe(3);
    expect(result.locationLink).toBe(`${PLATFORM_URL}/us/colorado`);
  });

  it("adds no link without a location filter", async () => {
    const result = await searchProperties({}) as Record<string, unknown>;
    expect(result).not.toHaveProperty("locationLink");
  });

  it("groups a state by county with counts, for-sale counts, acres and links", async () => {
    const result = await searchProperties({ region: "CO", groupBy: "county" }) as { groups: unknown[]; properties?: unknown };
    expect(result.properties).toBeUndefined();
    expect(result.groups).toEqual([
      { state: "CO", county: "Costilla County", properties: 2, forSale: 1, totalAcres: 40.5, locationLink: `${PLATFORM_URL}/us/colorado/costilla-county` },
      { state: "CO", county: "Huerfano County", properties: 1, forSale: 1, totalAcres: 40, locationLink: `${PLATFORM_URL}/us/colorado/huerfano-county` },
    ]);
  });

  it("groups by state", async () => {
    const result = await searchProperties({ groupBy: "state" }) as { groups: Array<Record<string, unknown>> };
    expect(result.groups.map(g => [g.state, g.properties, g.locationLink])).toEqual([
      ["CO", 3, `${PLATFORM_URL}/us/colorado`],
      ["AZ", 1, `${PLATFORM_URL}/us/arizona`],
    ]);
  });
});

describe("get_protocol_stats top counties", () => {
  it("lists counties by property count with links", async () => {
    const result = await getProtocolStats() as { properties: { topCounties: Array<Record<string, unknown>> } };
    expect(result.properties.topCounties[0]).toMatchObject({ county: "Costilla County", properties: 2 });
    expect(result.properties.topCounties).toHaveLength(3);
  });
});

describe("location link with no matches", () => {
  it("still links the county page asked about", async () => {
    const result = await searchProperties({ region: "CO", county: "Saguache" }) as Record<string, unknown>;
    expect(result.total).toBe(0);
    expect(result.locationLink).toBe(`${PLATFORM_URL}/us/colorado/saguache-county`);
  });
});

describe("grouped search review fixes", () => {
  const noCounty = { ...tokens[0], tokenId: "5", district: null };

  it("pages through the groups with limit and offset", async () => {
    const result = await searchProperties({ groupBy: "county", limit: 1, offset: 1 }) as Record<string, unknown>;
    expect(result.totalGroups).toBe(3);
    expect(result.showing).toBe("2-2 of 3");
    expect(result.groups).toHaveLength(1);
  });

  it("leaves tokens with no county out of county groups and counts them", async () => {
    vi.mocked(getTokens).mockResolvedValueOnce([...tokens, noCounty] as never);
    const result = await searchProperties({ region: "CO", groupBy: "county" }) as { groups: Array<Record<string, unknown>>; ungroupedCount?: number };
    expect(result.groups.map(g => g.county)).toEqual(["Costilla County", "Huerfano County"]);
    expect(result.ungroupedCount).toBe(1);
    expect(groupTokens([noCounty] as never, "county")).toEqual([]);
  });

  it("leaves tokens with no state out of state and county groups", async () => {
    const noState = { ...tokens[0], tokenId: "6", regionCode: null };
    vi.mocked(getTokens).mockResolvedValueOnce([...tokens, noState] as never);
    const result = await searchProperties({ groupBy: "state" }) as { groups: Array<Record<string, unknown>>; ungroupedCount?: number };
    expect(result.groups.map(g => g.state)).toEqual(["CO", "AZ"]);
    expect(result.ungroupedCount).toBe(1);
    expect(groupTokens([noState] as never, "county")).toEqual([]);
  });

  it("links the state page from the state code when the state name is blank", () => {
    const noName = { ...tokens[0], region: null };
    expect(groupTokens([noName] as never, "county")[0].locationLink).toBe(`${PLATFORM_URL}/us/colorado/costilla-county`);
  });

  it("keeps the county page link when another filter removes every match", async () => {
    const result = await searchProperties({ county: "Costilla", minAcres: 1000 }) as Record<string, unknown>;
    expect(result.total).toBe(0);
    expect(result.locationLink).toBe(`${PLATFORM_URL}/us/colorado/costilla-county`);
  });

  it("ignores a non-string county and an unknown groupBy", async () => {
    const result = await searchProperties({ region: "CO", county: 42, groupBy: "city" }) as Record<string, unknown>;
    expect(result.total).toBe(3);
    expect(result).not.toHaveProperty("groups");
  });
});
