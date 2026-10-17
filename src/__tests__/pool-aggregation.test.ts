import { describe, it, expect } from "vitest";
import { aggregatePoolStats, MAX_TICKS, withTickTotals } from "../clients/subgraph.js";
import type { SubgraphPool } from "../types/index.js";
import { loan } from "./fixtures.js";

function makePool(overrides: Partial<SubgraphPool> = {}): SubgraphPool {
  return {
    id: "0xpool1",
    implementation: "0ximpl",
    collateralToken: { id: "0xtoken" },
    currencyToken: { id: "0xusdc", symbol: "USDC", decimals: 6 },
    totalValueLocked: "1000000000000000000000", // 1000 * 10^18
    totalValueUsed: "500000000000000000000",    // 500 * 10^18
    totalValueAvailable: "500000000000000000000",
    durations: ["86400", "604800"],
    rates: ["50000", "100000"],
    maxBorrows: ["100000000000000000000"],
    loansOriginated: "10",
    loansActive: "3",
    loansRepaid: "5",
    loansLiquidated: "2",
    adminFeeRate: "500",
    ...overrides,
  };
}

describe("aggregatePoolStats", () => {
  it("returns null for empty pool array", () => {
    expect(aggregatePoolStats([])).toBeNull();
  });

  it("returns single pool stats directly", () => {
    const result = aggregatePoolStats([makePool()]);
    expect(result).not.toBeNull();
    expect(result!.poolCount).toBe(1);
    expect(result!.loansOriginated).toBe(10);
    expect(result!.loansActive).toBe(3);
    expect(result!.loansRepaid).toBe(5);
    expect(result!.loansLiquidated).toBe(2);
  });

  it("aggregates multiple pools correctly", () => {
    const pool1 = makePool({
      id: "0xpool1",
      totalValueLocked: "1000000000000000000000",
      totalValueUsed: "500000000000000000000",
      totalValueAvailable: "500000000000000000000",
      loansOriginated: "10",
      loansActive: "3",
      loansRepaid: "5",
      loansLiquidated: "2",
    });
    const pool2 = makePool({
      id: "0xpool2",
      totalValueLocked: "2000000000000000000000",
      totalValueUsed: "1000000000000000000000",
      totalValueAvailable: "1000000000000000000000",
      loansOriginated: "20",
      loansActive: "7",
      loansRepaid: "10",
      loansLiquidated: "3",
    });
    const result = aggregatePoolStats([pool1, pool2]);
    expect(result).not.toBeNull();
    expect(result!.poolCount).toBe(2);
    expect(result!.loansOriginated).toBe(30);
    expect(result!.loansActive).toBe(10);
    expect(result!.loansRepaid).toBe(15);
    expect(result!.loansLiquidated).toBe(5);
    // TVL should sum
    expect(parseFloat(result!.totalValueLocked)).toBeCloseTo(3000000000000000000000);
  });
});

describe("withTickTotals", () => {
  const E18 = 10n ** 18n;
  const zeroTotals = { totalValueLocked: "0", totalValueUsed: "0", totalValueAvailable: "0" };

  it("derives totals from the ticks when the pool totals read zero", () => {
    // Shape of the mainnet pool on 2026-10-17: 1,395.25 deposited, 966.25 available, one 429 loan.
    const pool = makePool({
      ...zeroTotals,
      ticks: [
        { value: (1000n * E18).toString(), available: (571n * E18).toString() },
        { value: (39525n * E18 / 100n).toString(), available: (39525n * E18 / 100n).toString() },
      ],
    });
    const result = withTickTotals(pool);
    expect(result.totalsFromTicks).toBe(true);
    expect(result.totalValueLocked).toBe((139525n * E18 / 100n).toString());
    expect(result.totalValueAvailable).toBe((96625n * E18 / 100n).toString());
    expect(result.totalValueUsed).toBe((429n * E18).toString());
    expect(aggregatePoolStats([result])!.totalsFromTicks).toBe(true);
  });

  it("keeps populated pool totals as they are", () => {
    const pool = makePool({ ticks: [{ value: "1", available: "1" }] });
    expect(withTickTotals(pool)).toBe(pool);
    expect(aggregatePoolStats([pool])!.totalsFromTicks).toBe(false);
  });

  it("keeps zero when the ticks are empty too", () => {
    const pool = makePool({ ...zeroTotals, ticks: [{ value: "0", available: "0" }] });
    expect(withTickTotals(pool)).toBe(pool);
    expect(withTickTotals(makePool({ ...zeroTotals }))).toEqual(makePool({ ...zeroTotals }));
  });

  it("keeps the subgraph totals when a full page of ticks may be partial", () => {
    const ticks = Array.from({ length: MAX_TICKS }, () => ({ value: "1", available: "1" }));
    const pool = makePool({ ...zeroTotals, ticks });
    expect(withTickTotals(pool)).toBe(pool);
  });
});

describe("buildPoolStats with the API's loan records", () => {
  const subgraphPool = (overrides: Record<string, string> = {}) => ({
    id: "0x842ffbf1ad5314503904626122376f71603a3cf9", implementation: "0ximpl", collateralToken: { id: "0xtoken" },
    currencyToken: { id: "0xusdc", symbol: "USDC", decimals: 6 },
    totalValueLocked: "1000000000000000000000", totalValueUsed: "0", totalValueAvailable: "1000000000000000000000",
    durations: [], rates: [], maxBorrows: [], loansOriginated: "95", loansActive: "1", loansRepaid: "84", loansLiquidated: "0", adminFeeRate: "0",
    ...overrides,
  });
  const liquidated = (loanContract: string) => loan({ loanStatus: "Liquidated", loanContract });

  it("reports the records' liquidation count when the subgraph's lags, and says so", async () => {
    const { buildPoolStats } = await import("../tools/pool-stats.js");
    const loans = [...Array.from({ length: 10 }, () => liquidated("0x842FFBF1AD5314503904626122376f71603a3cf9")), liquidated("0xnftfi")];
    const stats = buildPoolStats([subgraphPool()], loans);
    expect(stats).toMatchObject({ loansLiquidated: 10, countsNote: expect.stringContaining("the pool data source counts 0") });
  });

  it("keeps the subgraph's count when it is not behind", async () => {
    const { buildPoolStats } = await import("../tools/pool-stats.js");
    const stats = buildPoolStats([subgraphPool({ loansLiquidated: "2" })], [liquidated("0x842ffbf1ad5314503904626122376f71603a3cf9")]);
    expect(stats).toMatchObject({ loansLiquidated: 2 });
    expect(stats).not.toHaveProperty("countsNote");
  });
});
