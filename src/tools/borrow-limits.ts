import type { PoolLendingPoolValuation } from "../types/index.js";

/** The valuation rows the appraisal reads; modelVersion is not needed. */
type PricingRow = { source: string; scope: string; value: string | null; confidence: string | null };

/** Pool tick amounts are 18-decimal fixed point; collateral prices are USDC with 6 decimals. */
const TICK_DECIMALS = 18;
const BPS = 10_000;
/** Ticks holding less than one dollar are dust: they never decide how much can be borrowed. */
const DUST_USD = 1;
/** How far this estimate may drift from the API's own figure before the reading is withheld. */
const MATCH_TOLERANCE = 0.02;

export type LimitType = "absolute" | "ratio";

/** A lending pool tick: limit (120 bits) << 8 | duration index (3) << 5 | rate index (3) << 2 | limit type (2). */
export function decodeTick(raw: string): { limit: bigint; durationIndex: number; rateIndex: number; limitType: LimitType } | null {
  if (!/^\d+$/.test(raw)) return null;
  const tick = BigInt(raw);
  const type = Number(tick & 3n);
  if (type > 1) return null;
  return {
    limit: tick >> 8n,
    durationIndex: Number((tick >> 5n) & 7n),
    rateIndex: Number((tick >> 2n) & 7n),
    limitType: type === 1 ? "ratio" : "absolute",
  };
}

function tickUsd(raw: string): number {
  const value = Number(raw) / 10 ** TICK_DECIMALS;
  return Number.isFinite(value) ? value : 0;
}

/** The price this pool lends against, in dollars: the signed quote, or the onchain oracle's usable price. */
export function collateralPriceUsd(pool: PoolLendingPoolValuation): number | null {
  const raw = pool.pricing === "SignedQuote" ? pool.oracleValuation?.quote.price : pool.onchainValuation?.usablePriceUsdc6;
  const value = Number.parseFloat(raw ?? "");
  return Number.isFinite(value) ? value / 1e6 : null;
}

export interface PoolCapacity {
  pool: string;
  priceUsd: number;
  freeLiquidityUsd: number;
  /** Highest loan-to-value any funded ratio tick allows, as a fraction (0.5 for 50%); null when the pool has no ratio tick. */
  maxLtv: number | null;
  /** What the tick limits allow at this price if every tick were fully funded. */
  limitAmountUsd: number;
  /** What the ratio ticks alone allow at this price; null when the pool has no ratio tick. */
  ltvLimitUsd: number | null;
  /** Which kinds of tick limit kept free liquidity out of the capacity; null when every free dollar counted. */
  boundBy: LimitType | "mixed" | null;
  /** What the ticks can lend now: each tick adds its free liquidity up to its own limit. */
  capacityUsd: number;
}

/**
 * How one pool's ticks bound a loan against `priceUsd`, the way the pool sources a loan: ticks in
 * order of their limit (a ratio tick's limit is that share of the price), each adding what it has
 * free up to its own limit.
 */
export function poolCapacity(pool: PoolLendingPoolValuation, priceUsd: number): PoolCapacity {
  const ticks = pool.ticks.flatMap(t => {
    const decoded = decodeTick(t.raw);
    if (!decoded) return [];
    const limitUsd = decoded.limitType === "ratio"
      ? (Number(decoded.limit) / BPS) * priceUsd
      : Number(decoded.limit) / 10 ** TICK_DECIMALS;
    return [{ ...decoded, limitUsd, availableUsd: tickUsd(t.available) }];
  }).filter(t => t.availableUsd >= DUST_USD).sort((a, b) => a.limitUsd - b.limitUsd);
  let capacity = 0;
  // Every tick whose limit left some of its liquidity out, including ticks skipped outright.
  const binding = new Set<LimitType>();
  for (const tick of ticks) {
    const filled = capacity + tick.availableUsd;
    if (filled > tick.limitUsd + 1e-9) binding.add(tick.limitType);
    if (tick.limitUsd <= capacity) continue;
    capacity = Math.min(filled, tick.limitUsd);
  }
  const boundBy = binding.size === 0 ? null : binding.size > 1 ? "mixed" : [...binding][0];
  const ratioTicks = ticks.filter(t => t.limitType === "ratio");
  const ratios = ratioTicks.map(t => Number(t.limit) / BPS);
  return {
    pool: pool.address,
    priceUsd,
    freeLiquidityUsd: ticks.reduce((sum, t) => sum + t.availableUsd, 0),
    maxLtv: ratios.length > 0 ? Math.max(...ratios) : null,
    limitAmountUsd: ticks.reduce((max, t) => Math.max(max, t.limitUsd), 0),
    ltvLimitUsd: ratioTicks.length > 0 ? Math.max(...ratioTicks.map(t => t.limitUsd)) : null,
    boundBy,
    capacityUsd: capacity,
  };
}

export type LimitedBy = "pool_liquidity" | "ltv" | "pool_limit" | "tax_status" | "oracle" | "existing_loan" | "unknown";

/**
 * Whether a pool can add to the API's amount at all: a signed quote needs its signature, and an
 * onchain price with a capacity block reason contributes nothing even when a price is set.
 */
function canLend(pool: PoolLendingPoolValuation): boolean {
  if (pool.pricing === "SignedQuote") return Boolean(pool.oracleValuation?.signature);
  return !pool.onchainValuation?.capacityBlockReason;
}

function usd(value: number): string {
  return `$${Math.floor(value).toLocaleString("en-US")}`;
}

function percent(fraction: number): string {
  return `${Math.round(fraction * 1000) / 10}%`;
}

/**
 * What binds a borrow quote. `maxBorrowUsd` is the API's advertised amount; this reading is only
 * given when the pool's own ticks reproduce it, so it never contradicts the API.
 */
export function bindingConstraint(input: {
  maxBorrowUsd: number;
  hasActiveLoan: boolean;
  taxBlocked: boolean;
  oracleReasons: readonly string[];
  pools: readonly PoolLendingPoolValuation[];
}) {
  const priced = input.pools.flatMap(pool => {
    const price = collateralPriceUsd(pool);
    return price !== null && price > 0 && canLend(pool) ? [poolCapacity(pool, price)] : [];
  });
  const best = priced.reduce<PoolCapacity | null>((top, p) => (top === null || p.capacityUsd > top.capacityUsd ? p : top), null);
  const details = best ? {
    collateralPrice: usd(best.priceUsd),
    poolFreeLiquidity: usd(best.freeLiquidityUsd),
    maxLtv: best.maxLtv !== null ? percent(best.maxLtv) : null,
    ltvLimitedAmount: best.ltvLimitUsd !== null ? usd(best.ltvLimitUsd) : null,
    tickLimitAmount: usd(best.limitAmountUsd),
  } : {};
  if (input.maxBorrowUsd <= 0) {
    if (input.taxBlocked) return { limitedBy: "tax_status" as LimitedBy, explanation: "The property's taxes are not known to be current, so the pool's price for it is set to zero.", ...details };
    if (priced.length === 0 || input.oracleReasons.length > 0) return { limitedBy: "oracle" as LimitedBy, explanation: input.oracleReasons[0] ?? "No pool has a usable price for this property.", ...details };
    if (best && best.freeLiquidityUsd < DUST_USD) return { limitedBy: "pool_liquidity" as LimitedBy, explanation: "The pool has no free liquidity to lend right now.", ...details };
    return { limitedBy: input.hasActiveLoan ? "existing_loan" as LimitedBy : "unknown" as LimitedBy, explanation: input.hasActiveLoan ? "The property already backs a loan, so the pool shows no new capacity." : "The API reports no capacity and states no reason.", ...details };
  }
  if (input.hasActiveLoan) {
    return { limitedBy: "existing_loan" as LimitedBy, explanation: "The property already backs a loan; the amount is net of it.", ...details };
  }
  if (!best || Math.abs(best.capacityUsd - input.maxBorrowUsd) > Math.max(DUST_USD, input.maxBorrowUsd * MATCH_TOLERANCE)) {
    return { limitedBy: "unknown" as LimitedBy, explanation: "The pool's ticks do not reproduce the API's amount, so the binding limit is not stated.", ...details };
  }
  if (best.capacityUsd >= best.freeLiquidityUsd - DUST_USD) {
    return {
      limitedBy: "pool_liquidity" as LimitedBy,
      explanation: `The amount is all the free liquidity in the pool (${usd(best.freeLiquidityUsd)}). It says nothing about the property's value: at the pool's highest loan-to-value${best.maxLtv !== null ? ` (${percent(best.maxLtv)})` : ""} the ${usd(best.priceUsd)} collateral price would support up to ${usd(best.limitAmountUsd)} under the pool's tick limits once the pool holds the deposits.`,
      ...details,
    };
  }
  if (best.boundBy === "absolute" || best.boundBy === "mixed") {
    return {
      limitedBy: "pool_limit" as LimitedBy,
      explanation: best.boundBy === "absolute"
        ? `A fixed dollar ceiling on the pool's ticks caps the amount, not the property's value; the pool holds ${usd(best.freeLiquidityUsd)} free.`
        : `The pool's tick limits cap the amount: some are fixed dollar ceilings and some are loan-to-value limits${best.maxLtv !== null ? ` (up to ${percent(best.maxLtv)})` : ""} against the ${usd(best.priceUsd)} collateral price; the pool holds ${usd(best.freeLiquidityUsd)} free.`,
      ...details,
    };
  }
  return {
    limitedBy: "ltv" as LimitedBy,
    explanation: `The pool's loan-to-value limits${best.maxLtv !== null ? ` (up to ${percent(best.maxLtv)})` : ""} against the ${usd(best.priceUsd)} collateral price cap the amount; the pool holds ${usd(best.freeLiquidityUsd)} free.`,
    ...details,
  };
}

function amount(value: string | null | undefined): number | null {
  const num = Number.parseFloat(value ?? "");
  return Number.isFinite(num) ? num : null;
}

/**
 * The values the API's appraisal can produce from these rows. With a Prycd value: Prycd itself
 * (the Prycd-only rule) or the lower of Prycd and the Fabrica AVM (the safe rule). Without one:
 * 30% of the county assessment. The AVM alone, or the assessment beside a Prycd value, never is.
 */
function appraisalCandidates(pricing: readonly PricingRow[]) {
  const adjusted = (source: string, label: string) => {
    const row = pricing.find(p => p.source === source && p.scope === "land");
    const value = amount(row?.value);
    const confidence = amount(row?.confidence);
    if (value === null || confidence === null || value <= 0 || confidence <= 0) return [];
    return [{ value: value * (confidence / 100), text: `${label} land value ${usd(value)} x its confidence ${confidence}% = ${usd(value * (confidence / 100))}`, rule: SAFE_RULE }];
  };
  const assessor = amount(pricing.find(p => p.source === "regrid-county-assessor" && p.scope === "parcel")?.value);
  const prycd = adjusted("prycd", "Prycd");
  if (prycd.length > 0) {
    const lowerAvm = adjusted("fabrica-avm", "Fabrica AVM").filter(avm => avm.value < prycd[0].value);
    // With a lower AVM beside it, a price equal to Prycd can only come from the Prycd-only rule.
    return [{ ...prycd[0], rule: lowerAvm.length > 0 ? PRYCD_ONLY_RULE : prycd[0].rule }, ...lowerAvm];
  }
  return assessor !== null && assessor > 0 ? [{ value: assessor * 0.3, text: `county assessment ${usd(assessor)} x 0.3 = ${usd(assessor * 0.3)}`, rule: PRYCD_ONLY_RULE }] : [];
}

const SAFE_RULE = "The pool's price is the API's appraisal: the lower of the Prycd and Fabrica AVM land values, each multiplied by its own confidence. It is a haircut of the estimate, not a separate valuation.";
const PRYCD_ONLY_RULE = "The pool's price is the API's Prycd-only appraisal: the Prycd land value multiplied by its confidence, or with no Prycd value 30% of the county assessment. It is a haircut of the estimate, not a separate valuation.";
export const APPRAISAL_RULE = "The pool's price is the API's appraisal, by the pool's oracle rule: either the lower of the Prycd and Fabrica AVM land values, each multiplied by its own confidence, or the Prycd value alone (30% of the county assessment when there is none). It is a haircut of the estimate, not a separate valuation.";

/** How a signed or oracle price was derived from the valuation rows, when one of the rule's inputs reproduces it. */
export function describeAppraisalDerivation(priceUsd: number | null, pricing: readonly PricingRow[]) {
  if (priceUsd === null || priceUsd <= 0) return null;
  const match = appraisalCandidates(pricing)
    .filter(c => Math.abs(c.value - priceUsd) <= Math.max(1, priceUsd * 0.001))
    .sort((a, b) => a.value - b.value)[0];
  return { rule: match?.rule ?? APPRAISAL_RULE, ...(match ? { derivation: match.text } : { derivation: null, note: "No current valuation row reproduces this price exactly; it may come from rows updated since." }) };
}
