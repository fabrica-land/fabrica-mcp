import {
  getAllLoans,
  getLoanStartedEvents,
  getLoanRepaidEvents,
  getLoanLiquidatedEvents,
} from "../clients/graphql.js";
import { getFabricaPools, aggregatePoolStats } from "../clients/subgraph.js";
import type { LoanModel } from "../types/index.js";

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

function formatPoolValue(raw: string, decimals: number): string {
  const num = parseFloat(raw) / Math.pow(10, decimals);
  return `$${num.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function loanSummary(loan: LoanModel) {
  return {
    loanId: loan.loanId,
    provider: loan.loanProvider,
    status: loan.loanStatus,
    principal: `${loan.principalScaled} ${loan.currencySymbol ?? ""}`.trim(),
    apr: loan.aprPercent !== null ? `${loan.aprPercent.toFixed(1)}%` : null,
    duration: loan.durationFormatted,
    maturityDate: loan.maturityDate,
    startTime: loan.startTime,
    borrower: shortenAddress(loan.borrower?.address),
    lender: shortenAddress(loan.lender?.address),
    collateral: loan.token ? {
      tokenId: loan.token.tokenId,
      name: loan.token.name,
      estimatedValue: formatUsd(loan.token.estimatedValue),
    } : { tokenId: loan.collateralId },
    ...(loan.loanStatus === "Repaid" ? {
      amountRepaid: loan.amountPaidToLenderScaled ? `${loan.amountPaidToLenderScaled} ${loan.currencySymbol ?? ""}`.trim() : null,
      repaidDate: loan.loanRepaidDate,
    } : {}),
    ...(loan.loanStatus === "Liquidated" ? {
      liquidationDate: loan.loanLiquidationDate,
    } : {}),
  };
}

export async function getLendingMarket(args: Record<string, unknown>) {
  const status = args.status as string | undefined;
  const borrower = args.borrower as string | undefined;
  const lender = args.lender as string | undefined;
  const since = args.since as string | undefined;
  const limit = Math.min((args.limit as number | undefined) ?? 20, 100);
  try {
    const [allLoans, pools, startedEvents, repaidEvents, liquidatedEvents] = await Promise.all([
      getAllLoans(),
      getFabricaPools(),
      getLoanStartedEvents(10),
      getLoanRepaidEvents(10),
      getLoanLiquidatedEvents(10),
    ]);
    let filtered = allLoans;
    if (status && status !== "all") {
      const statusMap: Record<string, string> = {
        active: "Active",
        repaid: "Repaid",
        liquidated: "Liquidated",
      };
      const mapped = statusMap[status.toLowerCase()];
      if (mapped) {
        filtered = filtered.filter(l => l.loanStatus === mapped);
      }
    }
    if (borrower) {
      const lower = borrower.toLowerCase();
      filtered = filtered.filter(l => l.borrower?.address?.toLowerCase() === lower);
    }
    if (lender) {
      const lower = lender.toLowerCase();
      filtered = filtered.filter(l => l.lender?.address?.toLowerCase() === lower);
    }
    if (since) {
      const sinceDate = new Date(since);
      filtered = filtered.filter(l => new Date(l.startTime) >= sinceDate);
    }
    const activeLoans = allLoans.filter(l => l.loanStatus === "Active");
    const repaidLoans = allLoans.filter(l => l.loanStatus === "Repaid");
    const liquidatedLoans = allLoans.filter(l => l.loanStatus === "Liquidated");
    const totalVolume = allLoans.reduce((sum, l) => sum + parseFloat(l.principalScaled || "0"), 0);
    const avgApr = activeLoans.length > 0
      ? activeLoans.reduce((sum, l) => sum + (l.aprPercent ?? 0), 0) / activeLoans.length
      : 0;
    const repaymentRate = allLoans.length > 0
      ? ((repaidLoans.length / (repaidLoans.length + liquidatedLoans.length)) * 100) || 100
      : 100;
    const agg = aggregatePoolStats(pools);
    const poolStats = agg ? {
      poolCount: agg.poolCount,
      pools: pools.map(p => p.id),
      totalValueLocked: formatPoolValue(agg.totalValueLocked, 18),
      totalValueUsed: formatPoolValue(agg.totalValueUsed, 18),
      totalValueAvailable: formatPoolValue(agg.totalValueAvailable, 18),
      utilization: agg.totalValueLocked !== "0"
        ? `${((parseFloat(agg.totalValueUsed) / parseFloat(agg.totalValueLocked)) * 100).toFixed(1)}%`
        : "0%",
      loansOriginated: agg.loansOriginated,
      loansActive: agg.loansActive,
      loansRepaid: agg.loansRepaid,
      loansLiquidated: agg.loansLiquidated,
      currency: "USDC",
    } : null;
    const recentEvents = [
      ...startedEvents.map(e => ({
        type: "loan_started" as const,
        date: e.blockTimestamp,
        loanId: e.loanId,
        principal: e.loanPrincipalAmount,
        borrower: shortenAddress(e.borrower),
        provider: e.loanProvider,
        collateralTokenId: e.nftCollateralId,
      })),
      ...repaidEvents.map(e => ({
        type: "loan_repaid" as const,
        date: e.blockTimestamp,
        loanId: e.loanId,
        principal: e.loanPrincipalAmount,
        amountPaid: e.amountPaidToLender,
        borrower: shortenAddress(e.borrower),
        collateralTokenId: e.nftCollateralId,
      })),
      ...liquidatedEvents.map(e => ({
        type: "loan_liquidated" as const,
        date: e.blockTimestamp,
        loanId: e.loanId,
        principal: e.loanPrincipalAmount,
        borrower: shortenAddress(e.borrower),
        collateralTokenId: e.nftCollateralId,
      })),
    ].sort((a, b) => {
      const ta = parseInt(a.date) || new Date(a.date).getTime();
      const tb = parseInt(b.date) || new Date(b.date).getTime();
      return tb - ta;
    }).slice(0, 10);
    return {
      summary: {
        totalLoans: allLoans.length,
        activeLoans: activeLoans.length,
        repaidLoans: repaidLoans.length,
        liquidatedLoans: liquidatedLoans.length,
        totalVolume: formatUsd(String(totalVolume)),
        repaymentRate: `${repaymentRate.toFixed(0)}%`,
        averageAPR: avgApr > 0 ? `${avgApr.toFixed(1)}%` : "N/A",
      },
      poolStats,
      loans: filtered.slice(0, limit).map(loanSummary),
      recentEvents,
    };
  } catch (e) {
    return { error: `Failed to get lending market: ${e instanceof Error ? e.message : String(e)}` };
  }
}
