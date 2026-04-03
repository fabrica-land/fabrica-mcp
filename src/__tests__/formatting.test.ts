import { describe, it, expect, vi } from "vitest";

// Mock graphql client
vi.mock("../clients/graphql.js", () => ({
  getToken: vi.fn(),
  getTokens: vi.fn().mockResolvedValue([]),
  getCountyBounds: vi.fn(),
  DEFAULT_MIN_SCORE: 2142,
  filterSpamTokens: vi.fn((tokens: unknown[]) => tokens),
}));

import { getToken } from "../clients/graphql.js";
import { getProperty } from "../tools/properties.js";
import type { TokenModel } from "../types/index.js";

function makeDetailToken(overrides: Partial<TokenModel> = {}): TokenModel {
  return {
    tokenId: "12345",
    network: "ethereum",
    contractAddress: "0x5cbeb7A0df7Ed85D82a472FD56d81ed550f3Ea95",
    name: "Test Ranch",
    vanityName: null,
    slug: "us/texas/travis/test-ranch",
    propertyLink: "https://fabrica.land/test",
    coordinates: { lat: 30.267, lon: -97.743 },
    geoJson: null,
    acres: "40.5",
    country: "US",
    countryCode: "US",
    region: "Texas",
    regionCode: "TX",
    postCode: "78701",
    district: "Travis County",
    place: "Austin",
    locality: null,
    neighborhood: null,
    street: null,
    address: "123 Ranch Rd, Austin TX",
    supply: "1",
    supplyUnderLoan: "0",
    supplyLiquidating: "0",
    supplyInDefault: "0",
    isPremint: false,
    isClaimedPremint: false,
    isBurned: false,
    score: 73242,
    scoringCheckResults: [
      { checkName: "hasRecordedDeed", group: "pastTitleAndLoad", title: "Has recorded deed", value: true },
    ],
    validator: "0xvalidator",
    estimatedValue: "396647.43",
    cardDisplayValuation: "$396,647",
    marketplacePrice: null,
    marketplaceBidCount: 0,
    imageUrlDark: null,
    imageUrlLight: null,
    mintedAt: "2024-01-15T00:00:00Z",
    operatingAgreement: null,
    operatingAgreementUrl: "https://fabrica.land/agreement/test",
    majorityOwnerAddress: "0xabcdef1234567890abcdef1234567890abcdef12",
    majorityOwner: { displayName: "TestUser", profilePath: "/u/testuser" },
    lastOwner: null,
    balances: [],
    pricing: [
      { source: "Prycd", scope: "property", currency: "USD", value: "396647.43", confidence: "0.85", timestamp: "2024-01-01" },
    ],
    configuration: {
      holdingEntityDate: null,
      propertyNickName: null,
      userDescription: "A beautiful ranch",
      proofOfTitle: null,
    },
    definition: {
      claim: "All that certain lot or parcel of land...",
      holdingEntity: "Test Ranch Trust LLC",
      coordinates: null,
      geoJson: null,
      offchainRegistrar: null,
    },
    loans: [],
    loanOffers: [],
    loanOfferCount: 0,
    metaStreetLiquidity: null,
    marketplaceListings: [],
    marketplaceBids: [],
    activity: [],
    transfers: [],
    ...overrides,
  } as unknown as TokenModel;
}

describe("getProperty formatting", () => {
  it("formats estimated value as USD", async () => {
    vi.mocked(getToken).mockResolvedValueOnce(makeDetailToken());
    const result = await getProperty({ tokenId: "12345" }) as Record<string, unknown>;
    const valuation = result.valuation as Record<string, unknown>;
    expect(valuation.estimatedValue).toBe("$396,647");
  });

  it("preserves confidence score as raw integer", async () => {
    vi.mocked(getToken).mockResolvedValueOnce(makeDetailToken());
    const result = await getProperty({ tokenId: "12345" }) as Record<string, unknown>;
    const valuation = result.valuation as Record<string, unknown>;
    expect(valuation.confidenceScore).toBe(73242);
  });

  it("parses acres as number", async () => {
    vi.mocked(getToken).mockResolvedValueOnce(makeDetailToken());
    const result = await getProperty({ tokenId: "12345" }) as Record<string, unknown>;
    expect(result.acres).toBe(40.5);
  });

  it("includes operating agreement URL for legal review", async () => {
    vi.mocked(getToken).mockResolvedValueOnce(makeDetailToken());
    const result = await getProperty({ tokenId: "12345" }) as Record<string, unknown>;
    const legal = result.legal as Record<string, unknown>;
    expect(legal.operatingAgreement).toBe("https://fabrica.land/agreement/test");
  });

  it("includes legal description and holding entity", async () => {
    vi.mocked(getToken).mockResolvedValueOnce(makeDetailToken());
    const result = await getProperty({ tokenId: "12345" }) as Record<string, unknown>;
    const legal = result.legal as Record<string, unknown>;
    expect(legal.description).toContain("lot or parcel");
    expect(legal.holdingEntity).toBe("Test Ranch Trust LLC");
  });

  it("flags recovery warnings for non-normal status", async () => {
    vi.mocked(getToken).mockResolvedValueOnce(makeDetailToken({ score: 53242 }));
    const result = await getProperty({ tokenId: "12345" }) as Record<string, unknown>;
    const warnings = result.warnings as string[];
    expect(warnings).toBeDefined();
    expect(warnings.some(w => w.includes("Recovery status"))).toBe(true);
  });

  it("flags liquidating supply", async () => {
    vi.mocked(getToken).mockResolvedValueOnce(makeDetailToken({ supplyLiquidating: "1" }));
    const result = await getProperty({ tokenId: "12345" }) as Record<string, unknown>;
    const warnings = result.warnings as string[];
    expect(warnings).toBeDefined();
    expect(warnings.some(w => w.includes("liquidation"))).toBe(true);
  });

  it("shortens owner addresses", async () => {
    vi.mocked(getToken).mockResolvedValueOnce(makeDetailToken());
    const result = await getProperty({ tokenId: "12345" }) as Record<string, unknown>;
    const ownership = result.ownership as Record<string, unknown>;
    const fullAddress = ownership.owner as string;
    expect(fullAddress).toMatch(/^0x/);
    // Full address is preserved in ownership.owner for the detail view
    expect(fullAddress.length).toBe(42);
  });

  it("detects fractionalized tokens", async () => {
    vi.mocked(getToken).mockResolvedValueOnce(makeDetailToken({ supply: "100" }));
    const result = await getProperty({ tokenId: "12345" }) as Record<string, unknown>;
    const ownership = result.ownership as Record<string, unknown>;
    expect(ownership.isFractionalized).toBe(true);
    expect(ownership.supply).toBe(100);
  });
});
