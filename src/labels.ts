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
