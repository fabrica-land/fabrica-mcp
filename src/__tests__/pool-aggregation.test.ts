import { describe, it, expect } from "vitest";
import { aggregatePoolStats } from "../clients/subgraph.js";
import type { SubgraphPool } from "../types/index.js";

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
