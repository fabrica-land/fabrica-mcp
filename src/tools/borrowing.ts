import { getToken } from "../clients/graphql.js";

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

export async function getBorrowQuote(args: Record<string, unknown>) {
  const tokenId = args.tokenId as string | undefined;
  const slug = args.slug as string | undefined;
  if (!tokenId && !slug) {
    return { error: "Either tokenId or slug is required" };
  }
  try {
    const token = await getToken({ tokenId, slug });
    if (!token) {
      return { error: `No property found with ${tokenId ? `token ID ${tokenId}` : `slug ${slug}`}` };
    }
    const ms = token.poolLendingLiquidity;
    const activeLoans = token.loans?.filter(l => l.loanStatus === "Active") ?? [];
    const hasActiveLoan = activeLoans.length > 0 || parseInt(token.supplyUnderLoan || "0") > 0;
    const result: Record<string, unknown> = {
      tokenId: token.tokenId,
      name: token.name ?? token.vanityName,
      estimatedValue: formatUsd(token.estimatedValue),
      hasActiveLoan,
    };
    if (hasActiveLoan) {
      result.currentLoans = activeLoans.map(l => ({
        loanId: l.loanId,
        provider: l.loanProvider,
        principal: `${l.principalScaled} ${l.currencySymbol ?? ""}`.trim(),
        apr: l.aprPercent !== null ? `${l.aprPercent.toFixed(1)}%` : null,
        maturityDate: l.maturityDate,
        borrower: shortenAddress(l.borrower?.address),
      }));
    }
    if (ms) {
      result.metaStreet = {
        available: true,
        maxBorrow: ms.maxPrincipalUsdc ? `${ms.maxPrincipalUsdc} USDC` : `${ms.maxPrincipalScaled} USDC`,
        durations: ms.durations ?? [],
        hasExistingLoan: ms.activeLoan !== null,
        ...(ms.activeLoan ? {
          existingLoan: {
            principal: ms.activeLoan.principal,
            repayment: ms.activeLoan.repayment,
            duration: ms.activeLoan.duration,
            maturity: ms.activeLoan.maturity,
          },
        } : {}),
      };
    } else {
      result.metaStreet = {
        available: false,
        reason: "No MetaStreet liquidity available for this property",
      };
    }
    result.summary = hasActiveLoan
      ? "This property already has an active loan. Additional borrowing may be limited."
      : ms
        ? `Up to ${ms.maxPrincipalUsdc ?? ms.maxPrincipalScaled} USDC available via MetaStreet pool.`
        : "No borrowing options currently available for this property.";
    return result;
  } catch (e) {
    return { error: `Failed to get borrow quote: ${e instanceof Error ? e.message : String(e)}` };
  }
}
