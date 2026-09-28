import { getToken } from "../clients/graphql.js";
import { LENDING_POOL_NAME, formatLoanProvider } from "../labels.js";

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
    const pool = token.poolLendingLiquidity;
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
        provider: formatLoanProvider(l.loanProvider),
        principal: `${l.principalScaled} ${l.currencySymbol ?? ""}`.trim(),
        apr: l.aprPercent !== null ? `${l.aprPercent.toFixed(1)}%` : null,
        maturityDate: l.maturityDate,
        borrower: shortenAddress(l.borrower?.address),
      }));
    }
    if (pool) {
      result.lendingPool = {
        name: LENDING_POOL_NAME,
        available: true,
        // maxPrincipalScaled is whole USDC; maxPrincipalUsdc is raw 6-decimal units.
        maxBorrow: `${pool.maxPrincipalScaled} USDC`,
        durations: pool.durations ?? [],
        hasExistingLoan: pool.activeLoan !== null,
        ...(pool.activeLoan ? {
          existingLoan: {
            principal: pool.activeLoan.principal,
            repayment: pool.activeLoan.repayment,
            duration: pool.activeLoan.duration,
            maturity: pool.activeLoan.maturity,
          },
        } : {}),
      };
    } else {
      result.lendingPool = {
        name: LENDING_POOL_NAME,
        available: false,
        reason: `No ${LENDING_POOL_NAME} liquidity available for this property`,
      };
    }
    result.summary = hasActiveLoan
      ? "This property already has an active loan. Additional borrowing may be limited."
      : pool
        ? `Up to ${pool.maxPrincipalScaled} USDC advertised by the ${LENDING_POOL_NAME}, subject to available pool liquidity.`
        : "No borrowing options currently available for this property.";
    return result;
  } catch (e) {
    return { error: `Failed to get borrow quote: ${e instanceof Error ? e.message : String(e)}` };
  }
}
