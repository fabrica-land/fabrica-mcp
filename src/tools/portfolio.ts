import { getWallet } from "../clients/graphql.js";

function formatUsd(value: string | null | undefined): string | null {
  if (!value) return null;
  const num = parseFloat(value);
  if (isNaN(num)) return null;
  return `$${num.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function shortenAddress(addr: string | null | undefined): string | null {
  if (!addr) return null;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export async function getPortfolio(args: Record<string, unknown>) {
  const address = args.address as string;
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
    const properties = wallet.tokens?.map(t => ({
      tokenId: t.tokenId,
      name: t.name ?? t.vanityName,
      location: { state: t.regionCode, county: t.district },
      acres: t.acres ? parseFloat(t.acres) : null,
      estimatedValue: formatUsd(t.estimatedValue),
      confidenceScore: t.score ?? null,
      hasActiveLoan: parseInt(t.supplyUnderLoan || "0") > 0,
      hasActiveListing: t.marketplacePrice !== null,
      listingPrice: t.marketplacePrice ? formatUsd(t.marketplacePrice) : null,
    })) ?? [];
    const borrowedLoans = wallet.loansTaken ?? [];
    const lentLoans = wallet.loansMade ?? [];
    const activeBorrowed = borrowedLoans.filter(l => l.loanStatus === "Active");
    const activelyLent = lentLoans.filter(l => l.loanStatus === "Active");
    const ch = wallet.creditHistory;
    return {
      address: wallet.address,
      displayName: wallet.user?.displayName ?? null,
      portfolioValue: formatUsd(wallet.totalValue),
      totalAcres: wallet.totalAcres ? parseFloat(wallet.totalAcres) : 0,
      propertyCount: parseInt(wallet.tokenCount || "0"),
      properties,
      lending: {
        asBorrower: {
          activeLoans: activeBorrowed.length,
          totalBorrowed: formatUsd(ch?.totalLoans?.totalPrincipalValue),
          totalRepaid: formatUsd(ch?.repaidLoans?.totalPaidValue),
          outstandingLoans: formatUsd(wallet.totalOutstandingLoansUSDC),
          loans: activeBorrowed.map(l => ({
            loanId: l.loanId,
            provider: l.loanProvider,
            principal: `${l.principalScaled} ${l.currencySymbol ?? ""}`.trim(),
            apr: l.aprPercent !== null ? `${l.aprPercent.toFixed(1)}%` : null,
            duration: l.durationFormatted,
            maturityDate: l.maturityDate,
            collateralTokenId: l.collateralId,
          })),
        },
        asLender: {
          activeLoans: activelyLent.length,
          loans: activelyLent.map(l => ({
            loanId: l.loanId,
            provider: l.loanProvider,
            principal: `${l.principalScaled} ${l.currencySymbol ?? ""}`.trim(),
            apr: l.aprPercent !== null ? `${l.aprPercent.toFixed(1)}%` : null,
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
