import { describe, it, expect, vi } from "vitest";

// Mock graphql client
vi.mock("../clients/graphql.js", () => ({
  getToken: vi.fn(),
  getTokens: vi.fn().mockResolvedValue([]),
  getCountyBounds: vi.fn(),
  getScoreRecord: vi.fn().mockResolvedValue({ checks: { propertyTaxesCurrent: 1 }, updatedAt: "2026-10-17T00:32:12.498Z", expiresAt: "2999-01-01T00:00:00.000Z" }),
  DEFAULT_MIN_SCORE: 72032,
  filterSpamTokens: vi.fn((tokens: unknown[]) => tokens),
}));

import { getToken } from "../clients/graphql.js";
import { getProperty } from "../tools/properties.js";
import type { MarketplaceOrderModel, TokenModel, WalletModel } from "../types/index.js";

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
    operatingAgreementName: "Fabrica US Trust v4.4",
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
    poolLendingLiquidity: null,
    marketplaceListings: [],
    marketplaceBids: [],
    activity: [],
    transfers: [],
    ...overrides,
  } as unknown as TokenModel;
}

const emptyLoans = { loanCount: "0", totalPrincipalValue: "0", totalPaidValue: "0", averageDurationDays: "0" };
const maker: WalletModel = {
  address: "0x1234567890abcdef1234567890abcdef12345678",
  user: { displayName: "Seller", profilePath: null, profileUrl: null, avatarUrl: null },
  tokens: [], tokenCount: "0", totalValue: "0", totalAcres: "0", totalCollateralValue: "0",
  totalOutstandingLoansUSDC: null, propertyCountUnderLoan: "0",
  activity: [], loansTaken: [], loansMade: [], marketplaceOffersMade: [],
  creditHistory: {
    activeLoans: emptyLoans, defaultedLoans: emptyLoans, liquidatedLoans: emptyLoans,
    repaidLoans: emptyLoans, totalLoans: emptyLoans, tokens: { tokenCount: "0", totalEstimatedValue: "0" },
  },
};

function makeOrder(overrides: Partial<MarketplaceOrderModel>): MarketplaceOrderModel {
  return {
    marketplaceId: "m", tokenId: "12345", contractAddress: "0x5cbeb7A0df7Ed85D82a472FD56d81ed550f3Ea95",
    network: "ethereum", side: "sell", status: "active", price: "100", usdPrice: "100", symbol: "USDC",
    supply: "1", maker, makerAddress: maker.address, startTime: "2026-01-01T00:00:00Z", endTime: null,
    ...overrides,
  };
}

describe("getProperty formatting", () => {
  it("counts live and encumbered orders, drops ended ones, and lists a blocked listing after the buyable ones", async () => {
    vi.mocked(getToken).mockResolvedValueOnce(makeDetailToken({
      marketplaceListings: [
        makeOrder({ status: "encumbered", encumbrance: { buyable: false } }),
        makeOrder({ status: "active", endTime: "2020-01-01T00:00:00Z" }),
        makeOrder({ status: "active", usdPrice: "120" }),
      ],
      marketplaceBids: [makeOrder({ side: "buy", status: "pending" }), makeOrder({ side: "buy", status: "canceled" })],
    }));
    expect(await getProperty({ tokenId: "12345" })).toMatchObject({
      marketplace: { listingCount: 2, offerCount: 1, listings: [{ buyable: true }, { buyable: false }] },
    });
  });

  it("formats estimated value as USD", async () => {
    vi.mocked(getToken).mockResolvedValueOnce(makeDetailToken());
    const result = await getProperty({ tokenId: "12345" }) as Record<string, unknown>;
    const valuation = result.valuation as Record<string, unknown>;
    expect(valuation.estimatedValue).toBe("$396,647");
  });

  it("preserves the numeric encoding of Property checks as a raw integer", async () => {
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

  it("returns Property checks at the top level with pass counts", async () => {
    vi.mocked(getToken).mockResolvedValueOnce(makeDetailToken());
    const result = await getProperty({ tokenId: "12345" }) as Record<string, unknown>;
    const checks = result.propertyChecks as Record<string, unknown>;
    expect(checks.encoding).toBe(73242);
    expect(checks.passed).toBe(1);
    expect(checks.total).toBe(1);
    expect(checks.about).toContain("not a title search or title insurance");
    expect(result.recoveryStatus).toEqual({ value: 7, label: "Normal" });
  });

  it("warns with the API's recovery label when the status is not Normal", async () => {
    vi.mocked(getToken).mockResolvedValueOnce(makeDetailToken({ score: 43242 }));
    const result = await getProperty({ tokenId: "12345" }) as Record<string, unknown>;
    expect((result.warnings as string[])[0]).toContain("Tax sale or foreclosure");
  });

  it("shows a one-line taxes summary", async () => {
    vi.mocked(getToken).mockResolvedValueOnce(makeDetailToken());
    const result = await getProperty({ tokenId: "12345" }) as Record<string, unknown>;
    const taxes = result.taxes as Record<string, unknown>;
    expect(taxes.status).toBe("current");
    expect(taxes.summary).toBe("Fabrica's checks found the property taxes current as of 2026-10-17.");
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
