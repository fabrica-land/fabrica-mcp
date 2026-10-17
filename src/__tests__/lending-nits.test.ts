import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * ENG-4993: the seven things the 2026-09-27 live run showed an agent could relay as wrong.
 * One fixture per item.
 */

vi.mock("../clients/graphql.js", () => ({
  getTokens: vi.fn().mockResolvedValue([]),
  getToken: vi.fn(),
  getAllLoans: vi.fn(),
  getWallet: vi.fn(),
  getCountyBounds: vi.fn(),
  DEFAULT_MIN_SCORE: 72032,
  filterSpamTokens: vi.fn((tokens: unknown[]) => tokens),
}));

vi.mock("../clients/subgraph.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../clients/subgraph.js")>();
  return { ...actual, getFabricaPools: vi.fn() };
});

import { getAllLoans, getToken, getTokens, getWallet, getCountyBounds } from "../clients/graphql.js";
import { getFabricaPools } from "../clients/subgraph.js";
import { getLendingMarket } from "../tools/lending.js";
import { getProtocolStats } from "../tools/protocol.js";
import { getBorrowQuote } from "../tools/borrowing.js";
import { getPortfolio } from "../tools/portfolio.js";
import { getProperty, getPropertyMap, searchProperties } from "../tools/properties.js";
import { estimateFields, formatDurationDays, formatRawTokenAmount, sortLoans } from "../format.js";
import type { SubgraphPool } from "../types/index.js";

function pool(overrides: Partial<SubgraphPool> = {}): SubgraphPool {
  return {
    id: "0xpool1",
    implementation: "0ximpl",
    collateralToken: { id: "0xtoken" },
    currencyToken: { id: "0xusdc", symbol: "USDC", decimals: 6 },
    totalValueLocked: "0",
    totalValueUsed: "0",
    totalValueAvailable: "0",
    durations: [],
    rates: [],
    maxBorrows: [],
    loansOriginated: "4",
    loansActive: "1",
    loansRepaid: "3",
    loansLiquidated: "0",
    adminFeeRate: "0",
    ...overrides,
  };
}

const loans = [
  { loanId: "old-repaid", loanProvider: "NFTfi", loanStatus: "Repaid", principalScaled: "500", currencySymbol: "USDC", aprPercent: 10, startTime: "2023-11-15T00:00:00Z", loanRepaidDate: "2023-12-01T00:00:00Z", amountPaidToLenderScaled: "517.568494", loanLiquidationDate: null, collateralId: "1", borrower: { address: "0x1111111111111111111111111111111111111111" }, lender: null, token: null },
  { loanId: "active-old", loanProvider: "PoolLending", loanStatus: "Active", principalScaled: "429", currencySymbol: "USDC", aprPercent: 13.5, startTime: "2026-01-01T00:00:00Z", loanRepaidDate: null, amountPaidToLenderScaled: null, loanLiquidationDate: null, collateralId: "2", borrower: { address: "0x2222222222222222222222222222222222222222" }, lender: null, token: null },
  { loanId: "liquidated", loanProvider: "NFTfi", loanStatus: "Liquidated", principalScaled: "0.25", currencySymbol: "WETH", aprPercent: 20, startTime: "2024-01-01T00:00:00Z", loanRepaidDate: null, amountPaidToLenderScaled: null, loanLiquidationDate: "2024-03-01T00:00:00Z", collateralId: "3", borrower: { address: "0x3333333333333333333333333333333333333333" }, lender: null, token: null },
  { loanId: "active-new", loanProvider: "PoolLending", loanStatus: "Active", principalScaled: "1000", currencySymbol: "USDC", aprPercent: 12, startTime: "2026-08-17T00:00:00Z", loanRepaidDate: null, amountPaidToLenderScaled: null, loanLiquidationDate: null, collateralId: "4", borrower: { address: "0x4444444444444444444444444444444444444444" }, lender: null, token: { tokenId: "4", name: "Lot 4", estimatedValue: "0.00" } },
];

const token = {
  tokenId: "3775392155688387140",
  network: "ethereum",
  contractAddress: "0x5cbeb7a0df7ed85d82a472fd56d81ed550f3ea95",
  name: "157 Madrone Way, Felton, CA",
  vanityName: null,
  propertyLink: "https://fabrica.land/us/california/santa-cruz-county/felton/zayante/147-madrone-way",
  estimatedValue: "0.00",
  cardDisplayValuation: "25000.00",
  pricing: [{ source: "FabricaAvm", value: "9000", currency: "USD", confidence: 0.2 }],
  score: 75342,
  scoringCheckResults: [],
  acres: "0.2896",
  supply: "1",
  supplyUnderLoan: "1",
  supplyLiquidating: "0",
  supplyInDefault: "0",
  coordinates: { lat: 37.05, lon: -122.07 },
  geoJson: { type: "Point", coordinates: [-122.07, 37.05] },
  definition: { offchainRegistrar: { propertyId: "06087-123" } },
  district: "Santa Cruz County",
  loans: [],
  poolLendingLiquidity: {
    maxPrincipalScaled: "325.684574",
    maxPrincipalUsdc: "325684574",
    durations: [7776000, 2592000],
    activeLoan: { principal: "429000000", repayment: "543223339", duration: "62208000", maturity: "1849207487" },
  },
};

beforeEach(() => {
  vi.mocked(getAllLoans).mockResolvedValue(loans as never);
  vi.mocked(getToken).mockResolvedValue(token as never);
  vi.mocked(getFabricaPools).mockResolvedValue([pool()]);
});

describe("1. pool with no deposits next to a borrow quote", () => {
  it("names the pools read and points to get_borrow_quote when deposits are zero", async () => {
    const result = await getLendingMarket({}) as { poolStats: Record<string, unknown> };
    expect(result.poolStats.totalValueAvailable).toBe("$0");
    expect(result.poolStats.utilization).toBeNull();
    expect(String(result.poolStats.note)).toContain("0xpool1");
    expect(String(result.poolStats.note)).toContain("get_borrow_quote");
    expect(String(result.poolStats.note)).not.toContain("—");
  });

  it("reports a subgraph failure as unavailable, not zero", async () => {
    vi.mocked(getFabricaPools).mockResolvedValue(null);
    const market = await getLendingMarket({}) as { poolStats: Record<string, unknown> };
    expect(market.poolStats.poolDataUnavailable).toBe(true);
    expect(market.poolStats).not.toHaveProperty("totalValueLocked");
    const stats = await getProtocolStats() as { lending: { lendingPools: Record<string, unknown> } };
    expect(stats.lending.lendingPools.poolDataUnavailable).toBe(true);
  });

  it("formats pool values and keeps the raw values under raw", async () => {
    vi.mocked(getFabricaPools).mockResolvedValue([pool({ totalValueLocked: "2000000000000000000000", totalValueUsed: "500000000000000000000", totalValueAvailable: "1500000000000000000000" })]);
    const result = await getLendingMarket({}) as { poolStats: Record<string, unknown> };
    expect(result.poolStats.totalValueLocked).toBe("$2,000");
    expect(result.poolStats.utilization).toBe("25.0%");
    expect(result.poolStats.currency).toBe("USDC");
    expect(result.poolStats.raw).toMatchObject({ decimals: 18, totalValueLocked: "2000000000000000000000" });
  });
});

describe("2. liquidation counts carry their scope", () => {
  it("labels pool counts as lifetime and recent events as the latest window", async () => {
    const result = await getLendingMarket({}) as { poolStats: Record<string, unknown>; recentEventsScope: string; recentEvents: Array<{ type: string; date: string }> };
    expect(result.poolStats.countsScope).toContain("Lifetime");
    expect(result.recentEventsScope).toContain("most recent");
    // Newest first, derived from the loan records (the API event lists return the oldest first).
    expect(result.recentEvents[0]).toMatchObject({ type: "loan_started", date: "2026-08-17T00:00:00Z" });
    expect(result.recentEvents.map(e => e.type)).toContain("loan_liquidated");
  });
});

describe("3. name and slug are passed through as the API returns them", () => {
  it("does not rewrite the name or the property link (the mismatch is API data, ENG-5012)", async () => {
    const result = await getProperty({ tokenId: token.tokenId }) as Record<string, unknown>;
    expect(result.name).toBe("157 Madrone Way, Felton, CA");
    expect(result.propertyLink).toBe(token.propertyLink);
  });
});

describe("4. no estimate is never $0", () => {
  it("explains a missing estimate on get_property", async () => {
    const result = await getProperty({ tokenId: token.tokenId }) as { valuation: Record<string, unknown> };
    expect(result.valuation.estimatedValue).toBeNull();
    expect(String(result.valuation.estimateNote)).toContain("confidence threshold");
    expect(result.valuation.displayValuation).toBe("$25,000");
  });

  it("explains a missing estimate on search rows and loan collateral", async () => {
    vi.mocked(getTokens).mockResolvedValue([{ ...token, marketplacePrice: null, majorityOwnerAddress: null }] as never);
    const search = await searchProperties({}) as { properties: Array<Record<string, unknown>> };
    expect(search.properties[0].estimatedValue).toBeNull();
    expect(search.properties[0].estimateNote).toMatch(/^No estimate/);
    const market = await getLendingMarket({ status: "active" }) as { loans: Array<{ collateral: Record<string, unknown> }> };
    expect(market.loans[0].collateral.estimatedValue).toBeNull();
  });

  it("distinguishes no sources from sources under the threshold", () => {
    expect(estimateFields("0.00", [{ value: null }])).toMatchObject({ estimatedValue: null, estimateNote: expect.stringContaining("no valuation source has a value") });
    expect(estimateFields("0.00", [])).toMatchObject({ estimatedValue: null, estimateNote: expect.stringContaining("no valuation source has a value") });
    expect(estimateFields("396647.43")).toEqual({ estimatedValue: "$396,647" });
  });
});

describe("5. county polygon is opt-in", () => {
  it("does not fetch the county outline by default", async () => {
    const result = await getPropertyMap({ tokenId: token.tokenId }) as Record<string, unknown>;
    expect(getCountyBounds).not.toHaveBeenCalled();
    expect(result.features).toHaveLength(1);
    expect(result.features).toMatchObject([{ properties: { type: "property" } }]);
  });
});

describe("6. amounts with symbols, durations in days", () => {
  it("formats the borrow quote's pool durations and existing loan", async () => {
    const result = await getBorrowQuote({ tokenId: token.tokenId }) as { lendingPool: Record<string, unknown> };
    expect(result.lendingPool.durations).toEqual(["90 days", "30 days"]);
    expect(result.lendingPool.existingLoan).toEqual({
      principal: "429 USDC",
      repayment: "543.22 USDC",
      duration: "720 days",
      maturity: "2028-08-06T20:44:47.000Z",
    });
    expect(result.lendingPool.raw).toMatchObject({ durationsSeconds: [7776000, 2592000], existingLoan: { principal: "429000000" } });
  });

  it("formats loan principals in their own currency", async () => {
    const result = await getLendingMarket({ status: "liquidated" }) as { loans: Array<Record<string, unknown>> };
    expect(result.loans[0].principal).toBe("0.25 WETH");
    expect(formatRawTokenAmount("250000000000000000", 18, "WETH")).toBe("0.25 WETH");
    expect(formatDurationDays("86400")).toBe("1 day");
  });
});

describe("7. loans sorted active first, then newest", () => {
  it("orders get_lending_market loans", async () => {
    const result = await getLendingMarket({}) as { loans: Array<{ loanId: string }> };
    expect(result.loans.map(l => l.loanId)).toEqual(["active-new", "active-old", "liquidated", "old-repaid"]);
  });

  it("orders get_portfolio loans", async () => {
    vi.mocked(getWallet).mockResolvedValue({
      address: "0xabc",
      tokens: [],
      loansTaken: [loans[1], loans[3]],
      loansMade: [],
      creditHistory: null,
      marketplaceOffersMade: [],
    } as never);
    const result = await getPortfolio({ address: "0xabc" }) as { lending: { asBorrower: { loans: Array<{ loanId: string }> } } };
    expect(result.lending.asBorrower.loans.map(l => l.loanId)).toEqual(["active-new", "active-old"]);
  });

  it("sortLoans keeps undated loans last within their group", () => {
    const sorted = sortLoans([
      { loanStatus: "Repaid", startTime: null },
      { loanStatus: "Repaid", startTime: "2025-01-01T00:00:00Z" },
    ]);
    expect(sorted[0].startTime).toBe("2025-01-01T00:00:00Z");
  });
});

describe("display valuation", () => {
  it("formats a decimal and keeps an already formatted value", async () => {
    vi.mocked(getToken).mockResolvedValue({ ...token, cardDisplayValuation: "$396,647" } as never);
    const result = await getProperty({ tokenId: token.tokenId }) as { valuation: Record<string, unknown> };
    expect(result.valuation.displayValuation).toBe("$396,647");
  });
});

describe("ENG-4462: bounded responses", () => {
  it("pages a wallet's properties and keeps the counts whole", async () => {
    const tokens = Array.from({ length: 7 }, (_, i) => ({ tokenId: String(i), name: `Lot ${i}`, estimatedValue: "1000", supplyUnderLoan: "0", marketplacePrice: null }));
    vi.mocked(getWallet).mockResolvedValue({ address: "0xabc", tokenCount: "7", tokens, loansTaken: [], loansMade: [], creditHistory: null, marketplaceOffersMade: [] } as never);
    const first = await getPortfolio({ address: "0xabc", limit: 3 });
    expect(first).toMatchObject({ propertyCount: 7, propertiesPage: { offset: 0, limit: 3, returned: 3, total: 7, nextOffset: 3 } });
    const last = await getPortfolio({ address: "0xabc", limit: 3, offset: 6 });
    expect(last).toMatchObject({ properties: [{ tokenId: "6" }], propertiesPage: { returned: 1, total: 7 } });
    expect(last).not.toHaveProperty("propertiesPage.nextOffset");
  });

  it("caps holders and orders on get_property, with the totals", async () => {
    const balances = Array.from({ length: 30 }, (_, i) => ({ balance: "1", holder: { address: `0x${String(i).padStart(40, "0")}` } }));
    const order = (side: string) => ({ side, status: "active", price: "1", usdPrice: "1", symbol: "USDC", makerAddress: "0x1234567890123456789012345678901234567890", endTime: null });
    vi.mocked(getToken).mockResolvedValue({
      ...token,
      balances,
      marketplaceListings: Array.from({ length: 25 }, () => order("sell")),
      marketplaceBids: Array.from({ length: 3 }, () => order("buy")),
    } as never);
    const result = await getProperty({ tokenId: "1" });
    expect(result).toMatchObject({
      ownership: { holdersNote: "The first 25 of 30 holders." },
      marketplace: { note: expect.stringContaining("25 active listings and 3 active offers") },
    });
    const text = JSON.stringify(result);
    expect(JSON.parse(text).ownership.holders).toHaveLength(25);
    expect(JSON.parse(text).marketplace.listings).toHaveLength(20);
  });
});
