import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../clients/graphql.js", async () => {
  class FabricaApiError extends Error {
    readonly graphQLErrors: readonly string[];
    constructor(messages: readonly string[]) {
      super(messages.join("; "));
      this.graphQLErrors = messages;
    }
  }
  return {
    getToken: vi.fn(),
    getTokens: vi.fn(),
    getCountyBounds: vi.fn(),
    getPremintSuccessor: vi.fn(),
    DEFAULT_MIN_SCORE: 72032,
    filterSpamTokens: vi.fn((tokens: unknown[]) => tokens),
    FabricaApiError,
    isTokenNotFound: (e: unknown) => e instanceof FabricaApiError && e.graphQLErrors.some(m => m.includes("No token or premint found")),
    propertyLookupError: (e: unknown, lookup: { tokenId?: string; slug?: string }, action: string) =>
      e instanceof FabricaApiError && e.graphQLErrors.some(m => m.includes("No token or premint found"))
        ? `No property found with ${lookup.tokenId ? `token ID ${lookup.tokenId}` : `slug ${lookup.slug ?? ""}`}`
        : `Failed to ${action}: ${e instanceof Error ? e.message : String(e)}`,
  };
});

import { getToken } from "../clients/graphql.js";
import { getProperty } from "../tools/properties.js";
import { countyRecordOf } from "../tools/county-record.js";
import { tokenDetail } from "./fixtures.js";

type Assessor = Parameters<typeof countyRecordOf>[0] & object;

function assessor(overrides: Partial<Assessor> = {}): Assessor {
  return {
    status: "checked",
    source: "regrid-assessor",
    fetchedAt: null,
    zoning: "A-1",
    zoningDescription: "Agricultural",
    landUse: "Agricultural",
    landUseCode: "A4",
    assessedLand: 208152,
    assessedImprovements: 0,
    assessedTotal: 208152,
    assessmentType: "MARKET",
    assessmentYear: null,
    lastSaleDate: "2024-08-05",
    lastSalePrice: 0,
    opportunityZone: "No",
    censusTract: "13015960105",
    structure: { present: null, count: null, yearBuilt: null },
    ...overrides,
  };
}

beforeEach(() => vi.mocked(getToken).mockReset());

describe("countyRecordOf", () => {
  it("returns null when the API has no parcel facts", () => {
    expect(countyRecordOf(null)).toBeNull();
    expect(countyRecordOf(undefined)).toBeNull();
  });

  it("says not-checked when no assessor record is cached", () => {
    expect(countyRecordOf(assessor({ status: "not-checked" }))).toEqual({
      status: "not-checked",
      source: "regrid-assessor",
      about: expect.stringContaining("No county assessor record"),
    });
  });

  it("maps zoning, land use, assessed values, sale and opportunity zone", () => {
    const record = countyRecordOf(assessor());
    expect(record).toMatchObject({
      status: "checked",
      source: "regrid-assessor",
      zoning: { code: "A-1", description: "Agricultural" },
      landUse: { code: "A4", description: "Agricultural" },
      assessedValue: { land: "$208,152", improvements: "$0", total: "$208,152", type: "MARKET", year: null },
      lastSale: { date: "2024-08-05", price: null },
      opportunityZone: false,
      censusTract: "13015960105",
    });
    // A $0 sale is explained, never shown as a price.
    expect(record).toHaveProperty("lastSale.priceNote");
    // No structure facts at all: the block is left out.
    expect(record).not.toHaveProperty("structure");
  });

  it("shows a real sale price and the structure when the record has them", () => {
    const record = countyRecordOf(assessor({ lastSalePrice: 410000, opportunityZone: "Yes", structure: { present: null, count: null, yearBuilt: 1922 } }));
    expect(record).toMatchObject({
      lastSale: { date: "2024-08-05", price: "$410,000" },
      opportunityZone: true,
      structure: { present: null, count: null, yearBuilt: 1922 },
    });
    expect(record).not.toHaveProperty("lastSale.priceNote");
  });

  it("leaves out empty groups", () => {
    const record = countyRecordOf(assessor({
      zoning: null, zoningDescription: null, landUse: null, landUseCode: null,
      assessedLand: null, assessedImprovements: null, assessedTotal: null,
      lastSaleDate: null, lastSalePrice: null, opportunityZone: null, structure: null,
    }));
    expect(record).toMatchObject({ zoning: null, landUse: null, assessedValue: null, lastSale: null, opportunityZone: null });
  });

  it("keeps an opportunity zone value it does not recognise as given", () => {
    expect(countyRecordOf(assessor({ opportunityZone: "Partial" }))).toMatchObject({ opportunityZone: "Partial" });
  });
});

describe("get_land_property countyRecord", () => {
  it("carries the county record from parcelFacts", async () => {
    vi.mocked(getToken).mockResolvedValueOnce(tokenDetail({ parcelFacts: { assessor: assessor() } }));
    const result = await getProperty({ tokenId: "12345" });
    expect(result).toMatchObject({ countyRecord: { zoning: { code: "A-1" }, assessedValue: { total: "$208,152" } } });
  });

  it("is null when the API returns no parcel facts", async () => {
    vi.mocked(getToken).mockResolvedValueOnce(tokenDetail());
    const result = await getProperty({ tokenId: "12345" });
    expect(result).toHaveProperty("countyRecord", null);
  });
});
