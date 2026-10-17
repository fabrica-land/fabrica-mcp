import { LOANS_INCOMPLETE_NOTE, loansMayBeIncomplete } from "../clients/budgets.js";
import { getAllLoans } from "../clients/graphql.js";
import { getFabricaPools } from "../clients/subgraph.js";
import type { LoanModel } from "../types/index.js";
import { formatLoanProvider, loanVolumeByCurrency } from "../labels.js";
import { estimateFields, formatTokenAmount, sortLoans, shortenAddress } from "../format.js";
import { buildPoolStats } from "./pool-stats.js";
import { z } from "zod";
import type { ArgsOf } from "./inputs.js";

const RECENT_EVENT_COUNT = 10;

function loanSummary(loan: LoanModel) {
  return {
    loanId: loan.loanId,
    provider: formatLoanProvider(loan.loanProvider),
    status: loan.loanStatus,
    principal: formatTokenAmount(loan.principalScaled, loan.currencySymbol),
    apr: loan.aprPercent !== null ? `${loan.aprPercent.toFixed(1)}%` : null,
    duration: loan.durationFormatted,
    maturityDate: loan.maturityDate,
    startTime: loan.startTime,
    borrower: shortenAddress(loan.borrower?.address),
    lender: shortenAddress(loan.lender?.address),
    collateral: loan.token ? {
      tokenId: loan.token.tokenId,
      name: loan.token.name,
      ...estimateFields(loan.token.estimatedValue),
    } : { tokenId: loan.collateralId },
    ...(loan.loanStatus === "Repaid" ? {
      amountRepaid: formatTokenAmount(loan.amountPaidToLenderScaled, loan.currencySymbol),
      repaidDate: loan.loanRepaidDate,
    } : {}),
    ...(loan.loanStatus === "Liquidated" ? {
      liquidationDate: loan.loanLiquidationDate,
    } : {}),
  };
}

/**
 * The latest loan events (started, repaid, liquidated) across all lenders, derived from the loan
 * records. The API's event lists have no ordering argument and return the oldest events first,
 * so they cannot answer "recent".
 */
function recentLoanEvents(loans: ReadonlyArray<LoanModel>) {
  const events = loans.flatMap(loan => {
    const base = {
      loanId: loan.loanId,
      principal: formatTokenAmount(loan.principalScaled, loan.currencySymbol),
      borrower: shortenAddress(loan.borrower?.address),
      provider: formatLoanProvider(loan.loanProvider),
      collateralTokenId: loan.collateralId,
    };
    return [
      { type: "loan_started" as const, date: loan.startTime, ...base },
      ...(loan.loanRepaidDate ? [{
        type: "loan_repaid" as const,
        date: loan.loanRepaidDate,
        ...base,
        amountPaid: formatTokenAmount(loan.amountPaidToLenderScaled, loan.currencySymbol),
      }] : []),
      ...(loan.loanLiquidationDate ? [{ type: "loan_liquidated" as const, date: loan.loanLiquidationDate, ...base }] : []),
    ];
  });
  const time = (d: string | null) => {
    const t = Date.parse(d ?? "");
    return Number.isFinite(t) ? t : 0;
  };
  return events.sort((a, b) => time(b.date) - time(a.date)).slice(0, RECENT_EVENT_COUNT);
}

/** Loan counts per provider, so the pool's own counts and the retired peer-to-peer loans add up to the summary. */
function countsByProvider(loans: ReadonlyArray<LoanModel>) {
  const counts: Record<string, { total: number; active: number; repaid: number; liquidated: number }> = {};
  for (const loan of loans) {
    const name = formatLoanProvider(loan.loanProvider) ?? "Unknown provider";
    const row = counts[name] ??= { total: 0, active: 0, repaid: 0, liquidated: 0 };
    row.total += 1;
    if (loan.loanStatus === "Active") row.active += 1;
    else if (loan.loanStatus === "Repaid") row.repaid += 1;
    else if (loan.loanStatus === "Liquidated") row.liquidated += 1;
  }
  return counts;
}

export const getLendingMarketInput = {
  status: z.enum(["active", "repaid", "liquidated", "all"]).optional().describe("Filter loans by status (default: 'all')"),
  borrower: z.string().optional().describe("Filter by borrower wallet address"),
  lender: z.string().optional().describe("Filter by lender wallet address"),
  since: z.string().optional().describe("ISO date. Only return loans started after this date."),
  limit: z.number().int().min(1).max(100).optional().describe("Max loan results (default 20, max 100)"),
};
export type GetLendingMarketArgs = ArgsOf<typeof getLendingMarketInput>;

export async function getLendingMarket(args: GetLendingMarketArgs) {
  const { status, borrower, lender, since } = args;
  const limit = Math.min(Math.max(Math.trunc(args.limit ?? 20), 1), 100);
  try {
    const [allLoans, pools] = await Promise.all([
      getAllLoans(),
      getFabricaPools(),
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
    const avgApr = activeLoans.length > 0
      ? activeLoans.reduce((sum, l) => sum + (l.aprPercent ?? 0), 0) / activeLoans.length
      : 0;
    return {
      summary: {
        totalLoans: allLoans.length,
        activeLoans: activeLoans.length,
        repaidLoans: repaidLoans.length,
        liquidatedLoans: liquidatedLoans.length,
        byProvider: countsByProvider(allLoans),
        volumeByCurrency: loanVolumeByCurrency(allLoans),
        averageAPR: avgApr > 0 ? `${avgApr.toFixed(1)}%` : "N/A",
      },
      poolStats: buildPoolStats(pools, allLoans),
      loans: sortLoans(filtered).slice(0, limit).map(loanSummary),
      loansOrder: "Active loans first, then most recently started first.",
      recentEvents: recentLoanEvents(allLoans),
      ...(loansMayBeIncomplete(allLoans) ? { loansNote: LOANS_INCOMPLETE_NOTE } : {}),
      recentEventsScope: `The ${RECENT_EVENT_COUNT} most recent loan events (started, repaid, liquidated) across all lenders, from the loan records. A type missing here has no event among the latest ${RECENT_EVENT_COUNT}; lifetime counts are in summary.`,
    };
  } catch (e) {
    return { error: `Failed to get lending market: ${e instanceof Error ? e.message : String(e)}` };
  }
}
