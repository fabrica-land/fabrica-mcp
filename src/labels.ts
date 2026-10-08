import type { ActivityModel } from "./types/index.js";

/** Public name of the in-app lending pool. */
export const LENDING_POOL_NAME = "Fabrica lending pool";

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
