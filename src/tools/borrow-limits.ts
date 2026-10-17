import type { PoolLendingPoolValuation, PoolLendingPoolWithTicks } from "../types/index.js";

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
  /** What the funded tick limits allow at this price if every one were fully funded. */
  limitAmountUsd: number;
  /** The same over every configured tick, empty ones included: what full funding would allow. */
  configuredLimitUsd: number;
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
export function poolCapacity(pool: PoolLendingPoolWithTicks, priceUsd: number): PoolCapacity {
  const configured = pool.ticks.flatMap(t => {
    const decoded = decodeTick(t.raw);
    if (!decoded) return [];
    const limitUsd = decoded.limitType === "ratio"
      ? (Number(decoded.limit) / BPS) * priceUsd
      : Number(decoded.limit) / 10 ** TICK_DECIMALS;
    return [{ ...decoded, limitUsd, availableUsd: tickUsd(t.available) }];
  });
  const ticks = configured.filter(t => t.availableUsd >= DUST_USD).sort((a, b) => a.limitUsd - b.limitUsd);
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
    configuredLimitUsd: configured.reduce((max, t) => Math.max(max, t.limitUsd), 0),
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
  pools: readonly PoolLendingPoolWithTicks[];
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
  const reading = (limitedBy: LimitedBy, explanation: string) => ({ limitedBy, explanation, ...details });
  if (input.maxBorrowUsd <= 0) {
    if (input.taxBlocked) return reading("tax_status", "The property's taxes are not known to be current, so the pool's price for it is set to zero.");
    // A pool that can price the property but is empty explains the zero better than another pool's oracle failure.
    if (best && best.freeLiquidityUsd < DUST_USD) return reading("pool_liquidity", "The pool has no free liquidity to lend right now.");
    // With a usable pool that holds liquidity, an existing loan explains the zero better than another pool's oracle failure.
    if (best && input.hasActiveLoan) return reading("existing_loan", "The property already backs a loan, so the pool shows no new capacity.");
    if (priced.length === 0 || input.oracleReasons.length > 0) return reading("oracle", input.oracleReasons[0] ?? "No pool has a usable price for this property.");
    return input.hasActiveLoan
      ? reading("existing_loan", "The property already backs a loan, so the pool shows no new capacity.")
      : reading("unknown", "The API reports no capacity and states no reason.");
  }
  if (input.hasActiveLoan) {
    return reading("existing_loan", "The property already backs a loan; the amount is net of it.");
  }
  if (!best || Math.abs(best.capacityUsd - input.maxBorrowUsd) > Math.max(DUST_USD, input.maxBorrowUsd * MATCH_TOLERANCE)) {
    return reading("unknown", "The pool's ticks do not reproduce the API's amount, so the binding limit is not stated.");
  }
  if (best.capacityUsd >= best.freeLiquidityUsd - DUST_USD) {
    return reading("pool_liquidity", `The amount is all the free liquidity in the pool (${usd(best.freeLiquidityUsd)}). It says nothing about the property's value: ${best.ltvLimitUsd !== null && best.maxLtv !== null ? `at the pool's highest loan-to-value (${percent(best.maxLtv)}) the ${usd(best.priceUsd)} collateral price would support up to ${usd(best.ltvLimitUsd)}` : `the pool's tick limits would allow up to ${usd(best.limitAmountUsd)}`} once the pool holds the deposits.`);
  }
  if (best.boundBy === "absolute" || best.boundBy === "mixed") {
    return reading("pool_limit", best.boundBy === "absolute"
      ? `A fixed dollar ceiling on the pool's ticks caps the amount, not the property's value; the pool holds ${usd(best.freeLiquidityUsd)} free.`
      : `The pool's tick limits cap the amount: some are fixed dollar ceilings and some are loan-to-value limits${best.maxLtv !== null ? ` (up to ${percent(best.maxLtv)})` : ""} against the ${usd(best.priceUsd)} collateral price; the pool holds ${usd(best.freeLiquidityUsd)} free.`);
  }
  return reading("ltv", `The pool's loan-to-value limits${best.maxLtv !== null ? ` (up to ${percent(best.maxLtv)})` : ""} against the ${usd(best.priceUsd)} collateral price cap the amount; the pool holds ${usd(best.freeLiquidityUsd)} free.`);
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

/** The lowest price the appraisal rule can produce from these rows: a cautious stand-in for a price the API has not set. */
export function appraisalFloorUsd(pricing: readonly PricingRow[]): number | null {
  const values = appraisalCandidates(pricing).map(c => c.value).filter(v => v > 0);
  return values.length > 0 ? Math.min(...values) : null;
}

const HELP_LOAN_AMOUNT = "https://help.fabrica.land/en/articles/16280912-why-is-my-loan-amount-low-or-zero";
const DOCS_LENDING_POOL = "https://docs.fabrica.land/docs/lending-pool";
const DOCS_VALUATION = "https://docs.fabrica.land/docs/valuation";

export type Lever = "onramp" | "tax_status" | "deed_check" | "fees" | "existing_loan" | "price" | "ltv" | "pool_liquidity";

export interface RaiseLever {
  lever: Lever;
  /** Where this lever stands now, in plain words. */
  today: string;
  /** What the pool's ticks would allow with this lever cleared, in USD; null when it cannot be computed. */
  wouldAllow: string | null;
  /** The step or the mechanism that moves the lever, with the page that explains it. */
  how: string;
  url: string;
}

/** Property checks the lending pool reads, from the help center's "Why is my loan amount low or zero?". */
const POOL_CHECKS: Record<string, { lever: Lever; today: string; how: string }> = {
  proofOfTitleValid: {
    lever: "deed_check",
    today: "The Property check \"Deed checked against the county\" is not passing; the pool's price for this property is zero until it does.",
    how: "The check passes once the recorded deed into the trust is on file and matches the county record. If the on-ramp's recording step is still open (in paper-recording counties, sending the county-stamped deed back to Fabrica), completing it clears the check; otherwise Fabrica support reviews the deed on file (contact_support).",
  },
  feesInGoodStanding: {
    lever: "fees",
    today: "The Property check \"Fabrica fees in good standing\" is not passing; the pool's price for this property is zero until it does.",
    how: "The owner authorizes the fee from the Owner Toolbox on the property page (Authorize Fee).",
  },
};

/**
 * What would raise a borrow quote, one entry per lever that applies: blockers first (each with what
 * the pool's ticks would allow once it clears), then the price, the loan-to-value and the pool's
 * liquidity. Facts and steps only; none is a suggestion to borrow.
 */
export function raiseLevers(input: {
  maxBorrowUsd: number;
  hasActiveLoan: boolean;
  isPremint: boolean;
  appraisalBlockReason: string | null | undefined;
  checks: readonly { checkName: string; value: boolean | null }[];
  pricing: readonly PricingRow[];
  pools: readonly PoolLendingPoolWithTicks[];
  /** A loan amount to test against the loan-to-value and the pool's liquidity. */
  amountUsd?: number;
}): RaiseLever[] {
  const levers: RaiseLever[] = [];
  const priced = input.pools.flatMap(pool => {
    const price = collateralPriceUsd(pool);
    return price !== null && price > 0 && canLend(pool) ? [poolCapacity(pool, price)] : [];
  });
  const best = priced.reduce<PoolCapacity | null>((top, p) => (top === null || p.capacityUsd > top.capacityUsd ? p : top), null);
  // With no usable price, what the ticks would lend at the lowest price the appraisal rule gives from today's rows.
  const floor = appraisalFloorUsd(input.pricing);
  const unblocked = best === null && floor !== null
    ? input.pools.map(pool => poolCapacity(pool, floor)).reduce<PoolCapacity | null>((top, p) => (top === null || p.capacityUsd > top.capacityUsd ? p : top), null)
    : null;
  const unblockedUsd = unblocked && unblocked.capacityUsd >= DUST_USD ? usd(unblocked.capacityUsd) : null;
  // Each blocker zeroes the price on its own, so an amount is only tied to one blocker when it is the only one.
  const blockerCount = (input.isPremint ? 1 : 0) + (input.appraisalBlockReason ? 1 : 0)
    + input.checks.filter(c => POOL_CHECKS[c.checkName] && c.value !== true).length;
  const unblockedAllow = blockerCount === 1 ? unblockedUsd : null;
  const unblockedNote = unblockedUsd && floor !== null
    ? ` ${blockerCount === 1 ? "With this block cleared" : `With all ${blockerCount} blocks listed in toRaise cleared (this one alone does not restore it)`}, at an appraisal of ${usd(floor)} (the lowest the pool's rule gives from today's valuation rows) and today's pool liquidity, the ticks would allow up to ${unblockedUsd}.`
    : "";

  if (input.isPremint) {
    levers.push({
      lever: "onramp",
      today: "The property is still being added to Fabrica; the token is not issued yet.",
      wouldAllow: null,
      how: "Borrowing opens once the on-ramp is finished and the token is issued.",
      url: HELP_LOAN_AMOUNT,
    });
  }
  if (input.appraisalBlockReason) {
    levers.push({
      lever: "tax_status",
      today: input.appraisalBlockReason === "TAX_DELINQUENT"
        ? "The last property tax verification found taxes past due, so the pool's price for this property is zero."
        : "The property's taxes are not verified as current, so the pool's price for this property is zero.",
      wouldAllow: unblockedAllow,
      how: `${input.appraisalBlockReason === "TAX_DELINQUENT"
        ? "Paying the past-due taxes and the county's records showing them as paid; Fabrica's tax verification then reads the county again."
        : "A current tax verification: the taxes may already be paid. Fabrica's verification reads the county's public records, so the block clears once a verification finds them shown as paid; if any are unpaid, paying them comes first."} Recent payments can take time to appear at the county; get_tax_status shows the current state.${unblockedNote}`,
      url: HELP_LOAN_AMOUNT,
    });
  }
  for (const check of input.checks) {
    const rule = POOL_CHECKS[check.checkName];
    if (!rule || check.value === true) continue;
    levers.push({ ...rule, how: `${rule.how}${unblockedNote}`, wouldAllow: unblockedAllow, url: HELP_LOAN_AMOUNT });
  }
  if (input.hasActiveLoan) {
    levers.push({
      lever: "existing_loan",
      today: "The property already backs an active loan; the quote is net of it.",
      wouldAllow: best && best.capacityUsd >= DUST_USD ? usd(best.capacityUsd) : null,
      how: "Repaying the active loan releases the property as collateral; a new quote is then set against the same price and the pool's liquidity at that time.",
      url: DOCS_LENDING_POOL,
    });
  }
  const blocked = levers.length > 0;
  if (!best && !blocked) {
    const hasPrycd = input.pricing.some(p => p.source === "prycd" && p.scope === "land" && (amount(p.value) ?? 0) > 0);
    const hasAssessor = (amount(input.pricing.find(p => p.source === "regrid-county-assessor" && p.scope === "parcel")?.value) ?? 0) > 0;
    levers.push({
      lever: "price",
      today: hasPrycd || hasAssessor
        ? "No pool has a usable collateral price for this property right now, although valuation rows exist; the price oracle's reasons are in limits and oracle."
        : "No valuation source has a land value for this property: no Prycd value and no county assessment, so the appraisal has nothing to start from.",
      wouldAllow: null,
      how: "Valuation sources refresh on their own schedule; get_valuation lists each source, its value and why one is missing. This is not an owner step.",
      url: DOCS_VALUATION,
    });
  } else if (best) {
    const derivation = describeAppraisalDerivation(best.priceUsd, input.pricing)?.derivation ?? null;
    if (derivation?.startsWith("county assessment")) {
      levers.push({
        lever: "price",
        today: `The collateral price ${usd(best.priceUsd)} is 30% of the county assessment, because no Prycd land value is on file.`,
        wouldAllow: null,
        how: "A Prycd land value replaces the assessment fallback when the source publishes one; get_valuation lists each source. This is not an owner step.",
        url: DOCS_VALUATION,
      });
    }
  }
  // The tick reading only speaks for the API's amount when it reproduces it, as in bindingConstraint.
  const consistent = best !== null && !input.hasActiveLoan
    && Math.abs(best.capacityUsd - input.maxBorrowUsd) <= Math.max(DUST_USD, input.maxBorrowUsd * MATCH_TOLERANCE);
  if (best && consistent && best.maxLtv !== null && best.ltvLimitUsd !== null) {
    const target = input.amountUsd !== undefined && input.amountUsd > 0 ? input.amountUsd : null;
    const priceNeeded = target !== null ? target / best.maxLtv : null;
    levers.push({
      lever: "ltv",
      today: `The pool's highest loan-to-value is ${percent(best.maxLtv)} of the ${usd(best.priceUsd)} collateral price: up to ${usd(best.ltvLimitUsd)}.`,
      wouldAllow: usd(best.ltvLimitUsd),
      how: `${target !== null && priceNeeded !== null
        ? priceNeeded <= best.priceUsd
          ? `${usd(target)} is within that loan-to-value at today's price. `
          : `${usd(target)} at ${percent(best.maxLtv)} needs a collateral price of ${usd(priceNeeded)}. `
        : ""}The collateral price is the API's appraisal, a haircut of the valuation sources (oracle shows how); it moves when the sources or their confidence change, not by an owner step.`,
      url: DOCS_VALUATION,
    });
  }
  if (best && consistent && best.configuredLimitUsd > best.capacityUsd + DUST_USD) {
    const target = input.amountUsd !== undefined && input.amountUsd > best.freeLiquidityUsd ? input.amountUsd : null;
    levers.push({
      lever: "pool_liquidity",
      today: `The pool has ${usd(best.freeLiquidityUsd)} free to lend now.`,
      wouldAllow: usd(best.configuredLimitUsd),
      how: `The pool lends from what lenders deposit; as deposits come in, the amount for this property can rise up to ${usd(best.configuredLimitUsd)} at today's price with no step by the owner${target !== null ? `, and ${usd(target)} needs ${usd(target - best.freeLiquidityUsd)} more in deposits` : ""}. get_lending_market shows the pool's totals.`,
      url: DOCS_LENDING_POOL,
    });
  }
  return levers;
}
