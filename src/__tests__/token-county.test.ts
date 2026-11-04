import { describe, it, expect, vi } from "vitest";
import { tokenListItem } from "./fixtures.js";

/**
 * A consolidated city-county (San Francisco) has no Mapbox county, so the API's district is empty.
 * Every tool names the county from the token's registrar instead, worded like fabrica.land.
 */

const jones = tokenListItem({
  tokenId: "4737315677965897536",
  name: "1707 Jones Street, San Francisco, CA",
  region: "California",
  regionCode: "CA",
  district: null,
  place: "San Francisco",
  definition: { offchainRegistrar: { admin: "San Francisco", adminId: "06075" } },
});
const costilla = tokenListItem({ tokenId: "2", region: "Colorado", regionCode: "CO", district: "Costilla County" });

vi.mock("../clients/graphql.js", () => ({
  getTokens: vi.fn(async () => [jones, costilla]),
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

import { tokenCounty, countyDisplayName } from "../county.js";
import { searchProperties, groupTokens } from "../tools/properties.js";
import { PLATFORM_URL } from "../links.js";

describe("tokenCounty", () => {
  it("uses district when the API has one", () => {
    expect(tokenCounty({ district: "Costilla County", regionCode: "CO", definition: { offchainRegistrar: { admin: "Other", adminId: "08023" } } })).toBe("Costilla County");
  });

  it("falls back to the registrar county for a consolidated city-county", () => {
    expect(tokenCounty({ district: null, regionCode: "CA", definition: { offchainRegistrar: { admin: "San Francisco" } } })).toBe("San Francisco County");
    expect(tokenCounty({ district: "  ", regionCode: "CA", definition: { offchainRegistrar: { admin: "San Francisco", adminId: "06075" } } })).toBe("San Francisco County");
  });

  it("names the county from a FIPS admin", () => {
    expect(tokenCounty({ district: null, regionCode: "CA", definition: { offchainRegistrar: { admin: "06075", adminId: "" } } })).toBe("San Francisco County");
  });

  it("is null when neither is known", () => {
    expect(tokenCounty({ district: null, regionCode: "CA", definition: null })).toBeNull();
    expect(tokenCounty({ district: null, regionCode: "CA", definition: { offchainRegistrar: { admin: "99999", adminId: "" } } })).toBeNull();
    expect(tokenCounty(null)).toBeNull();
  });

  it("words jurisdictions like fabrica.land", () => {
    expect(countyDisplayName("Kenai Peninsula Borough", "AK")).toBe("Kenai Peninsula Borough");
    expect(countyDisplayName("Juneau", "AK")).toBe("Juneau");
    expect(countyDisplayName("Acadia", "LA")).toBe("Acadia Parish");
    expect(countyDisplayName("Carson City", "NV")).toBe("Carson City");
    expect(countyDisplayName("Mohave County", "AZ")).toBe("Mohave County");
  });
});

describe("search_land for 1707 Jones", () => {
  it("returns the county", async () => {
    const result = await searchProperties({ region: "CA" }) as { properties: Array<{ tokenId: string; location: { county: string | null } }> };
    expect(result.properties.find(p => p.tokenId === jones.tokenId)?.location.county).toBe("San Francisco County");
  });

  it("filters and links by that county", async () => {
    const result = await searchProperties({ region: "CA", county: "San Francisco" }) as Record<string, unknown>;
    expect(result.total).toBe(1);
    expect(result.locationLink).toBe(`${PLATFORM_URL}/us/california/san-francisco-county`);
  });

  it("groups it under its county", () => {
    const groups = groupTokens([jones], "county");
    expect(groups).toEqual([expect.objectContaining({ state: "CA", county: "San Francisco County", locationLink: `${PLATFORM_URL}/us/california/san-francisco-county` })]);
  });
});
