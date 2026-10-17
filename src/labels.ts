import type { ActivityModel } from "./types/index.js";

/** Public name of the in-app lending pool. */
export const LENDING_POOL_NAME = "DeFi lending pool";

/**
 * Human-readable lending venue for a loan record.
 *
 * The API reports the loan provider as a raw enum. Pool loans are shown as
 * pool-based lending; peer-to-peer loans came through a former integration
 * that is retired, so they are labeled as historical.
 */
export function formatLoanProvider(provider: string | null | undefined): string | null {
  if (!provider) return null;
  switch (provider) {
    case "PoolLending":
    case "MetaStreet": // older API name for pool loans
      return "Pool-based lending";
    case "NFTfi":
    case "NftFi": // spelling used by the activity feed
      return "Peer-to-peer (NFTfi, retired integration)";
    default:
      return provider;
  }
}

/**
 * Human-readable source for an activity-feed entry. Lending sources get the
 * same labels as loan providers; marketplace sources (Fabrica, Seaport) pass
 * through unchanged.
 */
export function formatActivitySource(source: string | null | undefined): string | null {
  return formatLoanProvider(source);
}

/**
 * Total loan principal per currency. Principal amounts are in each loan's own currency
 * (USDC, WETH, ...), so they are never summed across currencies or labeled as dollars.
 */
export function loanVolumeByCurrency(loans: ReadonlyArray<{ principalScaled: string | null; currencySymbol: string | null }>): Record<string, string> {
  const totals = new Map<string, number>();
  for (const loan of loans) {
    const amount = Number.parseFloat(loan.principalScaled ?? "");
    if (!Number.isFinite(amount)) continue;
    const symbol = loan.currencySymbol ?? "unknown currency";
    totals.set(symbol, (totals.get(symbol) ?? 0) + amount);
  }
  return Object.fromEntries([...totals].map(([symbol, total]) => {
    const digits = symbol === "USDC" || symbol === "USDT" || symbol === "DAI" ? 0 : 4;
    return [symbol, `${total.toLocaleString("en-US", { maximumFractionDigits: digits })} ${symbol}`];
  }));
}

/**
 * Whole-USDC amount for a borrowing ceiling ("up to"), rounded down so it never overstates:
 * "325.684574" → "325 USDC", "2500" → "2,500 USDC".
 */
export function formatUsdcCeiling(amount: string | null | undefined): string | null {
  const value = Number.parseFloat(amount ?? "");
  if (!Number.isFinite(value)) return null;
  return `${Math.floor(value).toLocaleString("en-US")} USDC`;
}

const STABLECOINS = new Set(["USDC", "USDT", "DAI"]);

/**
 * Amount of an activity-feed entry, scaled from the raw token amount by its decimals, the rule the
 * property page follows: "$4,950" for stablecoins, "1.25 WETH" otherwise. With no decimals, USDC (or
 * an unknown currency) is taken as 6 decimals. `usdAmount` is a fallback only, because the API does
 * not scale it on every event type (Seaport sales store the raw token amount there).
 */
export function formatActivityAmount(a: Pick<ActivityModel, "currencyAmount" | "currencyDecimals" | "currencySymbol" | "usdAmount">): string | null {
  const symbol = a.currencySymbol;
  const isUsd = symbol === null || STABLECOINS.has(symbol);
  const decimals = a.currencyDecimals ?? (symbol === null || symbol === "USDC" ? 6 : null);
  const raw = Number.parseFloat(a.currencyAmount ?? "");
  if (Number.isFinite(raw) && decimals !== null) {
    const value = raw / 10 ** decimals;
    return isUsd
      ? `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
      : `${value.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${symbol}`;
  }
  const usd = Number.parseFloat(a.usdAmount ?? "");
  if (Number.isFinite(usd)) return `$${usd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return a.currencyAmount ? `${a.currencyAmount} ${symbol ?? ""}`.trim() : null;
}

/** Public names for the API's `pricing[].source` values. */
const VALUATION_SOURCE_NAMES: Record<string, string> = {
  "fabrica-avm": "Fabrica AVM (automated valuation model)",
  prycd: "Prycd",
  "regrid-county-assessor": "County assessor (via Regrid)",
  "data-tree": "DataTree",
};

export function formatValuationSource(source: string): string {
  return VALUATION_SOURCE_NAMES[source] ?? source;
}

/**
 * Why the pool's appraisal for a token is set to zero (`poolLendingLiquidity.appraisalBlockReason`).
 * The API only discloses the tax reasons; null does not by itself mean borrowing is available.
 */
export function describeAppraisalBlock(reason: string | null | undefined): string | null {
  switch (reason) {
    case null:
    case undefined:
      return null;
    case "TAX_DELINQUENT":
      return "The last property tax verification found taxes past due, so the lending pool's appraisal for this property is zero.";
    case "TAX_STATUS_UNKNOWN":
      return "The property tax status has not been verified, or the last verification expired, so the lending pool's appraisal for this property is zero.";
    default:
      return "The lending pool's appraisal for this property is zero.";
  }
}

/** The first eligibility gate the price oracle failed for a token (`onchainValuation.failedCheck`). */
const FAILED_CHECKS: Record<string, string> = {
  heartbeat: "The price feed's keeper heartbeat is not fresh.",
  registry: "This token is not registered with the price oracle.",
  recovery: "The token's recovery status is not Normal, so the oracle does not price it.",
  currency: "The oracle's price is not in the pool's currency.",
  max_silence: "The price feed has been silent longer than its allowed maximum.",
  min_sources: "Fewer price sources have published a price for this parcel than the oracle requires.",
  dispersion: "The published prices for this parcel differ from each other by more than the oracle allows.",
  land_use: "The parcel's land use is not one the oracle prices.",
  eligibility_unattested: "The eligibility publisher has not attested this token.",
  eligibility: "A required eligibility check is not passing for this token.",
  eligibility_region_unattested: "The parcel's region eligibility is missing, locked or stale.",
  eligibility_region: "The parcel's country or region is not eligible for this pool.",
  eligibility_vacant_land: "The parcel is not attested as vacant land.",
  price_unavailable: "The API could not read a price for this parcel from the oracle.",
  eligibility_unavailable: "The API could not read the oracle's eligibility report for this parcel.",
  oracle_state_unavailable: "The API could not read the oracle's state.",
};

export function describeFailedCheck(check: string | null | undefined): string | null {
  if (!check) return null;
  return FAILED_CHECKS[check] ?? `The price oracle reports the check "${check}" as not passing.`;
}

/** Why an onchain-oracle pool contributes no borrowing capacity (`onchainValuation.capacityBlockReason`). */
export function describeCapacityBlock(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (reason === "oracle_read_not_pool_oracle") {
    return "This pool lends against a different oracle than the one read, so it contributes no borrowing capacity.";
  }
  return `This pool contributes no borrowing capacity (${reason}).`;
}

/** Why a source in the signed valuation panel returned no quote (`valuations[].reason`). */
export function describeSignedValuationReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (reason === "valuation_unavailable") return "This source could not produce a valuation.";
  return `This source returned no valuation (${reason}).`;
}

/** "$1,524.97" from a USDC amount in 6-decimal base units ("1524966393"). */
export function formatUsdc6(amount: string | null | undefined): string | null {
  const raw = Number.parseFloat(amount ?? "");
  if (!Number.isFinite(raw)) return null;
  return `$${(raw / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** ISO date-time from Unix seconds (a number or a numeric string). */
export function unixToIso(seconds: number | string | null | undefined): string | null {
  const value = typeof seconds === "string" ? Number.parseInt(seconds, 10) : seconds;
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000).toISOString();
}
