import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tool output is read by agents and repeated to people, so it follows Fabrica's
 * public wording: the in-app pool is the Fabrica lending pool, the peer-to-peer
 * integration is labeled as retired, and no platform-wide repayment rate is
 * published.
 */

const loans = [
  { loanId: "1", loanProvider: "PoolLending", loanStatus: "Active", principalScaled: "1000", aprPercent: 12, startTime: "2026-09-01T00:00:00Z" },
  { loanId: "2", loanProvider: "PoolLending", loanStatus: "Repaid", principalScaled: "500", aprPercent: 10, startTime: "2026-08-01T00:00:00Z" },
  { loanId: "3", loanProvider: "NFTfi", loanStatus: "Liquidated", principalScaled: "700", aprPercent: 20, startTime: "2024-01-01T00:00:00Z" },
];

vi.mock("../clients/graphql.js", () => ({
  getTokens: vi.fn().mockResolvedValue([]),
  getToken: vi.fn(),
  getAllLoans: vi.fn(),
  getLoanStartedEvents: vi.fn().mockResolvedValue([]),
  getLoanRepaidEvents: vi.fn().mockResolvedValue([]),
  getLoanLiquidatedEvents: vi.fn().mockResolvedValue([]),
  DEFAULT_MIN_SCORE: 72032,
  filterSpamTokens: vi.fn((tokens: unknown[]) => tokens),
}));

vi.mock("../clients/subgraph.js", () => ({
  getFabricaPools: vi.fn().mockResolvedValue([{ id: "0xpool" }]),
  aggregatePoolStats: vi.fn().mockReturnValue({
    poolCount: 1,
    totalValueLocked: "1000000000000000000000",
    totalValueUsed: "500000000000000000000",
    totalValueAvailable: "500000000000000000000",
    loansOriginated: 10,
    loansActive: 3,
    loansRepaid: 5,
    loansLiquidated: 2,
  }),
}));

import { getAllLoans, getToken } from "../clients/graphql.js";
import { getProtocolStats } from "../tools/protocol.js";
import { getLendingMarket } from "../tools/lending.js";
import { getBorrowQuote } from "../tools/borrowing.js";
import { formatLoanProvider, formatActivitySource, LENDING_POOL_NAME } from "../labels.js";
import { IS_MAINNET } from "../config.js";

beforeEach(() => {
  vi.mocked(getAllLoans).mockResolvedValue(loans as never);
});

describe("formatLoanProvider", () => {
  it("labels pool loans as pool-based lending", () => {
    expect(formatLoanProvider("PoolLending")).toBe("Pool-based lending");
    expect(formatLoanProvider("MetaStreet")).toBe("Pool-based lending");
  });

  it("labels peer-to-peer loans as a retired integration", () => {
    expect(formatLoanProvider("NFTfi")).toContain("retired");
  });

  it("passes through unknown providers and nulls", () => {
    expect(formatLoanProvider("Other")).toBe("Other");
    expect(formatLoanProvider(null)).toBeNull();
  });
});

describe("formatActivitySource", () => {
  it("labels lending sources like loan providers", () => {
    expect(formatActivitySource("PoolLending")).toBe("Pool-based lending");
    expect(formatActivitySource("NftFi")).toBe("Peer-to-peer (NFTfi, retired integration)");
  });

  it("passes marketplace sources through", () => {
    expect(formatActivitySource("Fabrica")).toBe("Fabrica");
    expect(formatActivitySource("Seaport")).toBe("Seaport");
  });
});

describe("get_protocol_stats wording", () => {
  it("publishes no repayment rate and names the Fabrica lending pool", async () => {
    const result = await getProtocolStats() as Record<string, unknown>;
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/repaymentRate/i);
    expect(text).not.toMatch(/metaStreet/i);
    const lending = result.lending as Record<string, unknown>;
    expect(lending.repaidLoans).toBe(1);
    expect(lending.liquidatedLoans).toBe(1);
    expect((lending.lendingPools as Record<string, unknown>).name).toBe(LENDING_POOL_NAME);
  });

  it("lists NFTfi contracts only as labeled history", async () => {
    const result = await getProtocolStats() as Record<string, unknown>;
    const contracts = result.contracts as Record<string, unknown>;
    expect(contracts.nftfiV2).toBeUndefined();
    const historical = result.historicalContracts as Record<string, unknown> | undefined;
    if (IS_MAINNET) {
      expect(historical?.note).toMatch(/retired/);
      expect(historical?.nftfiV2).toBeTruthy();
    } else {
      expect(historical).toBeUndefined();
    }
  });
});

describe("get_lending_market wording", () => {
  it("publishes no repayment rate and labels loan providers", async () => {
    const result = await getLendingMarket({}) as Record<string, unknown>;
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/repaymentRate/i);
    expect(text).not.toMatch(/"(MetaStreet|PoolLending)"/);
    const summary = result.summary as Record<string, unknown>;
    expect(summary.repaidLoans).toBe(1);
    const providers = (result.loans as Array<Record<string, unknown>>).map(l => l.provider);
    expect(providers).toContain("Pool-based lending");
    expect(providers).toContain("Peer-to-peer (NFTfi, retired integration)");
    expect((result.poolStats as Record<string, unknown>).name).toBe(LENDING_POOL_NAME);
  });
});

describe("get_borrow_quote wording", () => {
  it("reports Fabrica lending pool liquidity", async () => {
    vi.mocked(getToken).mockResolvedValue({
      tokenId: "1",
      name: "Test Ranch",
      estimatedValue: "10000",
      supplyUnderLoan: "0",
      loans: [],
      poolLendingLiquidity: { maxPrincipalUsdc: "2500000000", maxPrincipalScaled: "2500", durations: [30, 60], activeLoan: null },
    } as never);
    const result = await getBorrowQuote({ tokenId: "1" }) as Record<string, unknown>;
    expect(result.metaStreet).toBeUndefined();
    const pool = result.lendingPool as Record<string, unknown>;
    expect(pool.name).toBe(LENDING_POOL_NAME);
    expect(pool.available).toBe(true);
    expect(pool.maxBorrow).toBe("2,500 USDC");
    expect(result.summary).toContain("Up to 2,500 USDC");
    expect(result.summary).toContain(LENDING_POOL_NAME);
    expect(JSON.stringify(result)).not.toMatch(/metastreet/i);
  });

  it("explains when the pool has no liquidity for a property", async () => {
    vi.mocked(getToken).mockResolvedValue({
      tokenId: "2",
      name: "Dry Lot",
      estimatedValue: "1000",
      supplyUnderLoan: "0",
      loans: [],
      poolLendingLiquidity: null,
    } as never);
    const result = await getBorrowQuote({ tokenId: "2" }) as Record<string, unknown>;
    const pool = result.lendingPool as Record<string, unknown>;
    expect(pool.available).toBe(false);
    expect(pool.reason).toContain(LENDING_POOL_NAME);
  });

  it("treats zero pool capacity as unavailable", async () => {
    vi.mocked(getToken).mockResolvedValue({
      tokenId: "3",
      name: "Zero Lot",
      estimatedValue: "1000",
      supplyUnderLoan: "0",
      loans: [],
      poolLendingLiquidity: { maxPrincipalUsdc: "0", maxPrincipalScaled: "0", durations: [30], activeLoan: null },
    } as never);
    const result = await getBorrowQuote({ tokenId: "3" }) as Record<string, unknown>;
    const pool = result.lendingPool as Record<string, unknown>;
    expect(pool.available).toBe(false);
    expect(result.summary).not.toContain("Up to");
  });
});
