import { getWallet } from "../clients/graphql.js";
import { formatLoanProvider } from "../labels.js";
import { capList, estimateFields, formatTokenAmount, sortLoans, formatUsd, shortenAddress } from "../format.js";

const DEFAULT_PROPERTY_LIMIT = 50;
const MAX_PROPERTY_LIMIT = 200;
/** Active loans listed per side; the counts are always complete. */
const MAX_LOANS_LISTED = 50;

function activeLoansOf<T extends { loanStatus: string; startTime: string | null }>(loans: ReadonlyArray<T>): T[] {
  return sortLoans(loans.filter(l => l.loanStatus === "Active"));
}

export async function getPortfolio(args: Record<string, unknown>) {
  const address = typeof args.address === "string" ? args.address : "";
  const limit = Math.min(Math.max(Math.trunc(typeof args.limit === "number" ? args.limit : DEFAULT_PROPERTY_LIMIT), 1), MAX_PROPERTY_LIMIT);
  const offset = Math.max(Math.trunc(typeof args.offset === "number" ? args.offset : 0), 0);
  if (!address) {
    return { error: "address is required (Ethereum wallet address)" };
  }
  try {
    const wallet = await getWallet(address);
    if (!wallet) {
      return {
        address,
        portfolioValue: "$0",
        properties: [],
        lending: { asBorrower: { activeLoans: 0 }, asLender: { activeLoans: 0 } },
        creditHistory: null,
        message: "No Fabrica activity found for this address.",
      };
    }
    const allTokens = wallet.tokens ?? [];
    const properties = allTokens.slice(offset, offset + limit).map(t => ({
      tokenId: t.tokenId,
      name: t.name ?? t.vanityName,
      location: { state: t.regionCode, county: t.district },
      acres: t.acres ? parseFloat(t.acres) : null,
      ...estimateFields(t.estimatedValue),
      confidenceScore: t.score ?? null,
      hasActiveLoan: parseInt(t.supplyUnderLoan || "0") > 0,
      hasActiveListing: t.marketplacePrice !== null,
      listingPrice: t.marketplacePrice ? formatUsd(t.marketplacePrice) : null,
    }));
    const borrowedShown = capList(activeLoansOf(wallet.loansTaken ?? []), MAX_LOANS_LISTED);
    const lentShown = capList(activeLoansOf(wallet.loansMade ?? []), MAX_LOANS_LISTED);
    const ch = wallet.creditHistory;
    return {
      address: wallet.address,
      displayName: wallet.user?.displayName ?? null,
      portfolioValue: formatUsd(wallet.totalValue),
      totalAcres: wallet.totalAcres ? parseFloat(wallet.totalAcres) : 0,
      propertyCount: parseInt(wallet.tokenCount || "0"),
      properties,
      propertiesPage: {
        offset,
        limit,
        returned: properties.length,
        total: allTokens.length,
        ...(offset + properties.length < allTokens.length ? { nextOffset: offset + properties.length } : {}),
      },
      lending: {
        asBorrower: {
          activeLoans: borrowedShown.total,
          totalBorrowed: formatUsd(ch?.totalLoans?.totalPrincipalValue),
          totalRepaid: formatUsd(ch?.repaidLoans?.totalPaidValue),
          outstandingLoans: formatUsd(wallet.totalOutstandingLoansUSDC),
          ...(borrowedShown.truncated ? { loansNote: `The ${MAX_LOANS_LISTED} most recent of ${borrowedShown.total} active loans.` } : {}),
          loans: borrowedShown.items.map(l => ({
            loanId: l.loanId,
            provider: formatLoanProvider(l.loanProvider),
            principal: formatTokenAmount(l.principalScaled, l.currencySymbol),
            apr: l.aprPercent !== null ? `${l.aprPercent.toFixed(1)}%` : null,
            duration: l.durationFormatted,
            startTime: l.startTime,
            maturityDate: l.maturityDate,
            collateralTokenId: l.collateralId,
          })),
        },
        asLender: {
          activeLoans: lentShown.total,
          ...(lentShown.truncated ? { loansNote: `The ${MAX_LOANS_LISTED} most recent of ${lentShown.total} active loans.` } : {}),
          loans: lentShown.items.map(l => ({
            loanId: l.loanId,
            provider: formatLoanProvider(l.loanProvider),
            principal: formatTokenAmount(l.principalScaled, l.currencySymbol),
            apr: l.aprPercent !== null ? `${l.aprPercent.toFixed(1)}%` : null,
            duration: l.durationFormatted,
            startTime: l.startTime,
            maturityDate: l.maturityDate,
            borrower: shortenAddress(l.borrower?.address),
            collateralTokenId: l.collateralId,
          })),
        },
      },
      creditHistory: ch ? {
        totalLoans: parseInt(ch.totalLoans.loanCount),
        activeLoans: parseInt(ch.activeLoans.loanCount),
        repaidLoans: parseInt(ch.repaidLoans.loanCount),
        defaultedLoans: parseInt(ch.defaultedLoans.loanCount),
        liquidatedLoans: parseInt(ch.liquidatedLoans.loanCount),
        totalBorrowed: formatUsd(ch.totalLoans.totalPrincipalValue),
        totalRepaid: formatUsd(ch.repaidLoans.totalPaidValue),
        averageLoanDuration: ch.totalLoans.averageDurationDays !== "0"
          ? `${Math.round(parseFloat(ch.totalLoans.averageDurationDays))} days`
          : null,
        repaymentRate: (parseInt(ch.repaidLoans.loanCount) + parseInt(ch.liquidatedLoans.loanCount)) > 0
          ? `${((parseInt(ch.repaidLoans.loanCount) / (parseInt(ch.repaidLoans.loanCount) + parseInt(ch.liquidatedLoans.loanCount))) * 100).toFixed(0)}%`
          : "N/A",
      } : null,
      marketplaceActivity: {
        activeListings: wallet.marketplaceOffersMade?.filter(o => o.side === "sell" && o.status === "active").length ?? 0,
        activeBids: wallet.marketplaceOffersMade?.filter(o => o.side === "buy" && o.status === "active").length ?? 0,
      },
    };
  } catch (e) {
    return { error: `Failed to get portfolio: ${e instanceof Error ? e.message : String(e)}` };
  }
}
