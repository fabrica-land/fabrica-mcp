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
