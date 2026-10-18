import { describe, it, expect, vi, beforeEach } from "vitest";
import { loan, loanToken } from "./fixtures.js";
import type { SubgraphPool } from "../types/index.js";

const POOL = "0x842ffbf1ad5314503904626122376f71603a3cf9";

vi.mock("../clients/graphql.js", () => ({
  getAllLoans: vi.fn(),
}));

vi.mock("../clients/subgraph.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../clients/subgraph.js")>();
  return { ...actual, getFabricaPools: vi.fn() };
});

import { getAllLoans } from "../clients/graphql.js";
import { IS_MAINNET } from "../config.js";
import { getFabricaPools } from "../clients/subgraph.js";
import { acreBand, chosenName, getLoanBook, ltvBand, originationsByMonth } from "../tools/loan-book.js";

function pool(overrides: Partial<SubgraphPool> = {}): SubgraphPool {
  return {
    id: POOL,
    implementation: "0x0",
    collateralToken: { id: "0x5cbeb7a0df7ed85d82a472fd56d81ed550f3ea95" },
    currencyToken: { id: "0xa0b8", symbol: "USDC", decimals: 6 },
    totalValueLocked: "0",
    totalValueUsed: "0",
    totalValueAvailable: "0",
    durations: [],
    rates: [],
    maxBorrows: [],
    loansOriginated: "3",
    loansActive: "1",
    loansRepaid: "1",
    loansLiquidated: "0",
    adminFeeRate: "0",
    ...overrides,
  };
}

const loans = [
  loan({ loanId: "1", loanStatus: "Active", principalScaled: "429", collateralId: "10", startTime: "2026-08-17T20:44:47Z", maturityDate: "2026-11-15T20:44:47Z", token: loanToken({ tokenId: "10", estimatedValue: "10000", regionCode: "AZ", acres: "2.5" }), borrower: { address: "0x7f0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa7749", user: { displayName: "0x7f0…7749" } } }),
  loan({ loanId: "2", loanStatus: "Repaid", principalScaled: "50000", collateralId: "20", aprPercent: 15, startTime: "2025-11-28T15:53:23Z", token: loanToken({ tokenId: "20", estimatedValue: "100000", regionCode: "CA", acres: "0.2" }), borrower: { address: "0x94deaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad49b", user: { displayName: "tonyherrera" } } }),
  loan({ loanId: "3", loanStatus: "Liquidated", principalScaled: "12780", collateralId: "30", startTime: "2026-05-12T17:15:47Z", loanLiquidationDate: "2026-08-14T01:14:47Z", token: loanToken({ tokenId: "30", estimatedValue: "0.00", regionCode: "GA", acres: "40" }) }),
  loan({ loanId: "4", loanProvider: "NFTfi", loanContract: "0xd0a40eb7fd94ee97102ba8e9342243a2b2e22207", loanStatus: "Liquidated", principalScaled: "2500", collateralId: "40", startTime: "2025-01-15T20:13:11Z", token: loanToken({ tokenId: "40", estimatedValue: "2000", regionCode: "GA", acres: "1" }) }),
  loan({ loanId: "5", loanProvider: "NFTfi", loanContract: "0xd0a40eb7fd94ee97102ba8e9342243a2b2e22207", loanStatus: "Repaid", principalScaled: "0.25", currencySymbol: "WETH", collateralId: "50", startTime: "2024-03-01T00:00:00Z", token: null }),
];

beforeEach(() => {
  vi.mocked(getAllLoans).mockResolvedValue(loans);
  vi.mocked(getFabricaPools).mockResolvedValue([pool()]);
});

describe("get_loan_book", () => {
  it("puts every loan in its status and provider bucket", async () => {
    const result = await getLoanBook({});
    if ("error" in result) throw new Error(result.error);
    expect(result.scope.loans).toBe(5);
    expect(result.byStatus.map(r => [r.status, r.loans])).toEqual([["Active", 1], ["Repaid", 2], ["Liquidated", 2]]);
    expect(result.byProvider.map(r => r.loans)).toEqual([3, 2]);
    expect(result.principalByCurrency).toEqual({ USDC: "65,709 USDC", WETH: "0.25 WETH" });
  });

  it("reports both counts when the pool data source disagrees with the loan records", async () => {
    const result = await getLoanBook({});
    if ("error" in result) throw new Error(result.error);
    expect(result.poolCounts.countsSource).toBe("loan records");
    expect(result.poolCounts.loanRecords).toEqual({ originated: 3, active: 1, repaid: 1, liquidated: 1 });
    expect(result.poolCounts.poolDataSource).toEqual({ originated: 3, active: 1, repaid: 1, liquidated: 0 });
    expect(result.poolCounts).toHaveProperty("note", expect.stringContaining("liquidated"));
  });

  it("leaves the note out when the counts agree", async () => {
    vi.mocked(getFabricaPools).mockResolvedValue([pool({ loansLiquidated: "1" })]);
    const result = await getLoanBook({});
    if ("error" in result) throw new Error(result.error);
    expect(result.poolCounts).not.toHaveProperty("note");
  });

  it("reports no auction proceeds or per-loan liquidation rows", async () => {
    const result = await getLoanBook({});
    expect(result).not.toHaveProperty("recovery");
    expect(JSON.stringify(result)).not.toMatch(/proceeds/i);
  });

  it("filters by provider, status and start date", async () => {
    const pool = await getLoanBook({ provider: "pool" });
    const p2p = await getLoanBook({ provider: "peer-to-peer", status: "liquidated" });
    if ("error" in pool || "error" in p2p) throw new Error("unexpected error");
    expect(pool.scope.loans).toBe(3);
    expect(p2p.scope.loans).toBe(1);
    vi.useFakeTimers({ now: new Date("2026-10-17T00:00:00Z") });
    const recent = await getLoanBook({ sinceDays: 90 });
    vi.useRealTimers();
    if ("error" in recent) throw new Error(recent.error);
    expect(recent.scope.loans).toBe(1);
  });

  it("adds a groups table only when asked", async () => {
    const plain = await getLoanBook({});
    const grouped = await getLoanBook({ groupBy: "state" });
    if ("error" in plain || "error" in grouped) throw new Error("unexpected error");
    expect(plain).not.toHaveProperty("groups");
    expect(grouped.groups?.rows[0]).toMatchObject({ state: "CA", loans: 1 });
  });

  it("shows only names the wallet owner chose, and shortened addresses", async () => {
    const result = await getLoanBook({});
    if ("error" in result) throw new Error(result.error);
    const byId = new Map(result.largestLoans.map(l => [l.loanId, l]));
    expect(byId.get("2")?.borrower).toEqual({ address: "0x94de...d49b", name: "tonyherrera" });
    expect(byId.get("1")?.borrower).toEqual({ address: "0x7f0a...7749" });
    expect(result.largestLoans[0].loanId).toBe("2");
    expect(result.largestLoans[0].collateral.propertyLink).toMatch(/\/property\/\w+\/20$/);
  });

  it("ranks only digital-dollar loans and shows no $0 estimate", async () => {
    const result = await getLoanBook({});
    if ("error" in result) throw new Error(result.error);
    expect(result.largestLoans.map(l => l.loanId)).not.toContain("5");
    expect(result.largestLoansScope).toContain("1 loan in other currencies");
    expect(result.largestLoans.find(l => l.loanId === "3")?.collateral.estimatedValueToday).toBeNull();
  });

  it("carries the legal notice on mainnet", async () => {
    const result = await getLoanBook({});
    if ("error" in result) throw new Error(result.error);
    if (IS_MAINNET) expect(result.legalNotice).toBeTruthy();
  });

  it("promises nothing about future returns", async () => {
    const text = JSON.stringify(await getLoanBook({}));
    expect(text).not.toMatch(/\byield|guarantee|expected return|you will earn|safe investment/i);
    expect(text).not.toMatch(/repayment rate|default rate/i);
    expect(text).not.toContain("—");
  });

  it("returns an error message when the loan records cannot be read", async () => {
    vi.mocked(getAllLoans).mockRejectedValue(new Error("down"));
    const result = await getLoanBook({});
    expect(result).toEqual({ error: "Failed to get the loan book: down" });
  });
});

describe("loan book helpers", () => {
  it("bands loan-to-value against today's estimate", () => {
    expect(ltvBand(loans[0])).toBe("under 25%");
    expect(ltvBand(loans[1])).toBe("50% to 75%");
    expect(ltvBand(loans[2])).toBe("no estimate today");
    expect(ltvBand(loans[3])).toBe("100% or more");
    expect(ltvBand(loans[4])).toBe("principal not in digital dollars");
  });

  it("bands acreage", () => {
    expect(acreBand(loans[1])).toBe("under 1 acre");
    expect(acreBand(loans[3])).toBe("1 to 5 acres");
    expect(acreBand(loans[2])).toBe("20 to 100 acres");
    expect(acreBand(loans[4])).toBe("acreage not recorded");
  });

  it("treats a shortened address as no name", () => {
    expect(chosenName({ address: "0xA75aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0B4f", user: { displayName: "0xA75…0B4f" } })).toBeNull();
    expect(chosenName({ address: "0x1", user: { displayName: "" } })).toBeNull();
    expect(chosenName({ address: "0x1", user: { displayName: "fedepo.eth" } })).toBe("fedepo.eth");
    expect(chosenName(null)).toBeNull();
  });

  it("lists the last 12 months, empty ones included", () => {
    const months = originationsByMonth(loans, new Date("2026-10-17T00:00:00Z"));
    expect(months).toHaveLength(12);
    expect(months[0].month).toBe("2025-11");
    expect(months[11]).toEqual({ month: "2026-10", loans: 0, principal: {} });
    expect(months.find(m => m.month === "2026-08")?.loans).toBe(1);
  });
});
