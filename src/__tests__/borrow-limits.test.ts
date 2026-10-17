import { describe, expect, it } from "vitest";
import { bindingConstraint, decodeTick, describeAppraisalDerivation, poolCapacity } from "../tools/borrow-limits.js";
import { oraclePool } from "./fixtures.js";

/** A tick as the pool encodes it: limit << 8 | duration index << 5 | rate index << 2 | limit type. */
function tick(limit: number, type: 0 | 1, availableUsd: number, durationIndex = 0, rateIndex = 0) {
  const raw = (BigInt(limit) << 8n) | (BigInt(durationIndex) << 5n) | (BigInt(rateIndex) << 2n) | BigInt(type);
  return { raw: raw.toString(), available: (BigInt(Math.round(availableUsd * 1e6)) * 10n ** 12n).toString() };
}

// The mainnet pool on 2026-10-17 as get_borrow_quote read it for token 10748409388257357967.
const LIVE_POOL = oraclePool({
  oracleValuation: { signature: "0xsig", quote: { price: "642305810000", currency: "0xusdc", timestamp: 1, duration: 1200 } },
  ticks: [tick(1000, 1, 636.929173), tick(2000, 1, 289.172322, 0, 5), tick(2000, 1, 19.452335, 4, 3), tick(5000, 1, 20.691295, 5, 5), tick(8000, 1, 0.000001, 5, 7)],
});

describe("decodeTick", () => {
  it("reads the limit, duration and rate indexes and limit type", () => {
    expect(decodeTick(tick(5000, 1, 0, 5, 5).raw)).toEqual({ limit: 5000n, durationIndex: 5, rateIndex: 5, limitType: "ratio" });
    expect(decodeTick("not a number")).toBeNull();
  });
});

describe("poolCapacity", () => {
  it("sums the free ticks up to each one's limit and ignores dust", () => {
    const capacity = poolCapacity(LIVE_POOL, 642305.81);
    expect(capacity.capacityUsd).toBeCloseTo(966.245, 2);
    expect(capacity.freeLiquidityUsd).toBeCloseTo(966.245, 2);
    expect(capacity.maxLtv).toBe(0.5);
    expect(capacity.limitAmountUsd).toBeCloseTo(321152.9, 0);
  });

  it("stops at a tick's limit when the price is low", () => {
    const pool = oraclePool({ ticks: [tick(1000, 1, 500), tick(2000, 1, 500)] });
    // 10% of $2,000 is $200 and 20% is $400: the second tick only tops up to its own limit.
    expect(poolCapacity(pool, 2000).capacityUsd).toBe(400);
  });
});

describe("bindingConstraint", () => {
  const base: { hasActiveLoan: boolean; taxBlocked: boolean; oracleReasons: string[] } = { hasActiveLoan: false, taxBlocked: false, oracleReasons: [] };

  it("says the pool's liquidity binds, with the amount the LTV alone would allow", () => {
    const result = bindingConstraint({ ...base, maxBorrowUsd: 966.245127, pools: [LIVE_POOL] });
    expect(result).toMatchObject({ limitedBy: "pool_liquidity", collateralPrice: "$642,305", poolFreeLiquidity: "$966", maxLtv: "50%", ltvLimitedAmount: "$321,152" });
    expect(result.explanation).toContain("says nothing about the property's value");
  });

  it("says the LTV binds when the pool has more than the limits allow", () => {
    const pool = oraclePool({ oracleValuation: { signature: "0x", quote: { price: "2000000000", currency: "0x", timestamp: 1, duration: 1 } }, ticks: [tick(1000, 1, 500), tick(2000, 1, 500)] });
    expect(bindingConstraint({ ...base, maxBorrowUsd: 400, pools: [pool] })).toMatchObject({ limitedBy: "ltv", maxLtv: "20%" });
  });

  it("withholds the reading when the ticks do not reproduce the API's amount", () => {
    expect(bindingConstraint({ ...base, maxBorrowUsd: 5000, pools: [LIVE_POOL] })).toMatchObject({ limitedBy: "unknown" });
  });

  it("names tax status, the oracle, or an existing loan when there is no capacity", () => {
    expect(bindingConstraint({ ...base, taxBlocked: true, maxBorrowUsd: 0, pools: [LIVE_POOL] })).toMatchObject({ limitedBy: "tax_status" });
    expect(bindingConstraint({ ...base, maxBorrowUsd: 0, pools: [oraclePool()] })).toMatchObject({ limitedBy: "oracle" });
    expect(bindingConstraint({ ...base, hasActiveLoan: true, maxBorrowUsd: 100, pools: [LIVE_POOL] })).toMatchObject({ limitedBy: "existing_loan" });
  });
});

describe("describeAppraisalDerivation", () => {
  const pricing = [
    { source: "prycd", scope: "land", value: "771075", confidence: "83.300" },
    { source: "fabrica-avm", scope: "land", value: null, confidence: "0.000" },
    { source: "regrid-county-assessor", scope: "parcel", value: "357000", confidence: null },
  ];

  it("shows the Prycd value times its confidence when that is the price", () => {
    expect(describeAppraisalDerivation(642305.81, pricing)).toMatchObject({ derivation: "Prycd land value $771,075 x its confidence 83.3% = $642,305" });
  });

  it("states the rule without a derivation when no row reproduces the price", () => {
    expect(describeAppraisalDerivation(1234, pricing)).toMatchObject({ derivation: null, rule: expect.stringContaining("lower of the Prycd and Fabrica AVM") });
    expect(describeAppraisalDerivation(0, pricing)).toBeNull();
  });
});

describe("pools that cannot lend and fixed-dollar limits", () => {
  const base: { hasActiveLoan: boolean; taxBlocked: boolean; oracleReasons: string[] } = { hasActiveLoan: false, taxBlocked: false, oracleReasons: [] };
  const quote = (price: string) => ({ quote: { price, currency: "0x", timestamp: 1, duration: 1 } });

  it("leaves out an unsigned quote even when its ticks would lend the most", () => {
    const unsigned = oraclePool({ address: "0xunsigned", oracleValuation: { signature: null, ...quote("2000000000") }, ticks: [tick(5000, 1, 5000)] });
    const signed = oraclePool({ address: "0xsigned", oracleValuation: { signature: "0x", ...quote("2000000000") }, ticks: [tick(1000, 1, 500), tick(2000, 1, 500)] });
    expect(bindingConstraint({ ...base, maxBorrowUsd: 400, pools: [unsigned, signed] })).toMatchObject({ limitedBy: "ltv", maxLtv: "20%" });
  });

  it("says a fixed dollar ceiling binds, not the loan-to-value", () => {
    const pool = oraclePool({ oracleValuation: { signature: "0x", ...quote("100000000000") }, ticks: [{ raw: ((300n * 10n ** 18n) << 8n).toString(), available: (1000n * 10n ** 18n).toString() }] });
    const result = bindingConstraint({ ...base, maxBorrowUsd: 300, pools: [pool] });
    expect(result).toMatchObject({ limitedBy: "pool_limit", maxLtv: null, ltvLimitedAmount: null, tickLimitAmount: "$300" });
  });
});

describe("describeAppraisalDerivation follows the rule", () => {
  it("does not credit the higher model value or the assessment beside a Prycd value", () => {
    const pricing = [
      { source: "prycd", scope: "land", value: "100000", confidence: "50" },
      { source: "fabrica-avm", scope: "land", value: "200000", confidence: "50" },
      { source: "regrid-county-assessor", scope: "parcel", value: "100000", confidence: null },
    ];
    expect(describeAppraisalDerivation(100000, pricing)).toMatchObject({ derivation: null });
    expect(describeAppraisalDerivation(30000, pricing)).toMatchObject({ derivation: null });
    expect(describeAppraisalDerivation(50000, pricing)).toMatchObject({ derivation: expect.stringContaining("Prycd") });
  });

  it("credits the assessment only when there is no Prycd value", () => {
    const pricing = [{ source: "regrid-county-assessor", scope: "parcel", value: "100000", confidence: null }];
    expect(describeAppraisalDerivation(30000, pricing)).toMatchObject({ derivation: expect.stringContaining("county assessment") });
  });
});

describe("binding limits across several ticks", () => {
  const base: { hasActiveLoan: boolean; taxBlocked: boolean; oracleReasons: string[] } = { hasActiveLoan: false, taxBlocked: false, oracleReasons: [] };
  const dollars = (limit: bigint, available: bigint) => ({ raw: ((limit * 10n ** 18n) << 8n).toString(), available: (available * 10n ** 18n).toString() });

  it("remembers an earlier capped tick when a later one adds all it has", () => {
    const pool = oraclePool({ oracleValuation: { signature: "0x", quote: { price: "100000000000", currency: "0x", timestamp: 1, duration: 1 } }, ticks: [dollars(100n, 200n), dollars(300n, 50n)] });
    expect(poolCapacity(pool, 100000).capacityUsd).toBe(150);
    expect(bindingConstraint({ ...base, maxBorrowUsd: 150, pools: [pool] })).toMatchObject({ limitedBy: "pool_limit" });
  });

  it("names both kinds when fixed and loan-to-value limits each hold liquidity back", () => {
    const pool = oraclePool({ oracleValuation: { signature: "0x", quote: { price: "2000000000", currency: "0x", timestamp: 1, duration: 1 } }, ticks: [dollars(100n, 200n), tick(1000, 1, 500)] });
    const result = bindingConstraint({ ...base, maxBorrowUsd: 200, pools: [pool] });
    expect(result).toMatchObject({ limitedBy: "pool_limit" });
    expect(result.explanation).toContain("fixed dollar ceilings and some are loan-to-value limits");
  });
});

describe("describeAppraisalDerivation names the rule it matched", () => {
  const pricing = [
    { source: "prycd", scope: "land", value: "200000", confidence: "50" },
    { source: "fabrica-avm", scope: "land", value: "100000", confidence: "50" },
  ];

  it("gives the Prycd-only rule for a Prycd price beside a lower AVM, and the lower-of rule for the AVM", () => {
    expect(describeAppraisalDerivation(100000, pricing)).toMatchObject({ rule: expect.stringContaining("Prycd-only"), derivation: expect.stringContaining("Prycd") });
    expect(describeAppraisalDerivation(50000, pricing)).toMatchObject({ rule: expect.stringContaining("lower of the Prycd and Fabrica AVM"), derivation: expect.stringContaining("Fabrica AVM") });
  });
});

describe("zero capacity across pools", () => {
  it("says the usable pool is empty rather than repeating another pool's oracle failure", () => {
    const empty = oraclePool({ oracleValuation: { signature: "0x", quote: { price: "2000000000", currency: "0x", timestamp: 1, duration: 1 } }, ticks: [tick(1000, 1, 0)] });
    expect(bindingConstraint({ hasActiveLoan: false, taxBlocked: false, oracleReasons: ["The other pool's oracle is stale."], maxBorrowUsd: 0, pools: [empty, oraclePool()] })).toMatchObject({ limitedBy: "pool_liquidity" });
  });
});
