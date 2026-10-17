import { aggregatePoolStats } from "../clients/subgraph.js";
import type { SubgraphPool } from "../types/index.js";
import { LENDING_POOL_NAME } from "../labels.js";

/** Subgraph pool values are 18-decimal fixed point whatever the pool currency. */
const POOL_VALUE_DECIMALS = 18;

function poolValue(raw: string): number {
  const num = Number.parseFloat(raw) / 10 ** POOL_VALUE_DECIMALS;
  return Number.isFinite(num) ? num : 0;
}

function formatPoolValue(raw: string): string {
  return `$${poolValue(raw).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

const CAPACITY_POINTER = "Borrowing capacity for one property comes from get_borrow_quote, which reads the Fabrica API and can differ from these pool totals.";

/**
 * DeFi lending pool block shared by get_lending_market and get_protocol_stats.
 * null pools means the subgraph could not be read: the figures are unknown, not zero.
 */
export function buildPoolStats(pools: SubgraphPool[] | null) {
  if (pools === null) {
    return {
      name: LENDING_POOL_NAME,
      poolDataUnavailable: true,
      note: `The ${LENDING_POOL_NAME} data source did not respond, so pool deposits and counts are unknown right now (not zero). ${CAPACITY_POINTER}`,
    };
  }
  const agg = aggregatePoolStats(pools);
  if (!agg) {
    return {
      name: LENDING_POOL_NAME,
      poolCount: 0,
      pools: [],
      note: `No ${LENDING_POOL_NAME} accepting Fabrica tokens as collateral was found on this network. ${CAPACITY_POINTER}`,
    };
  }
  const locked = poolValue(agg.totalValueLocked);
  const available = poolValue(agg.totalValueAvailable);
  const currencies = [...new Set(pools.map(p => p.currencyToken?.symbol).filter((s): s is string => Boolean(s)))];
  const poolIds = pools.map(p => p.id);
  return {
    name: LENDING_POOL_NAME,
    poolCount: agg.poolCount,
    pools: poolIds,
    totalValueLocked: formatPoolValue(agg.totalValueLocked),
    totalValueUsed: formatPoolValue(agg.totalValueUsed),
    totalValueAvailable: formatPoolValue(agg.totalValueAvailable),
    utilization: locked > 0 ? `${((poolValue(agg.totalValueUsed) / locked) * 100).toFixed(1)}%` : null,
    loansOriginated: agg.loansOriginated,
    loansActive: agg.loansActive,
    loansRepaid: agg.loansRepaid,
    loansLiquidated: agg.loansLiquidated,
    countsScope: `Lifetime loan counts for the ${agg.poolCount === 1 ? "pool" : "pools"} listed.`,
    currency: currencies.length > 0 ? currencies.join(", ") : null,
    note: available > 0
      ? `Pool values are deposits in the ${agg.poolCount === 1 ? "pool" : "pools"} listed, read now. ${CAPACITY_POINTER}`
      : `The ${agg.poolCount === 1 ? "pool" : "pools"} read (${poolIds.join(", ")}) ${agg.poolCount === 1 ? "shows" : "show"} no deposits available to borrow right now. This is the pool's current deposits, not a statement that lending is closed. ${CAPACITY_POINTER}`,
    ...(agg.totalsFromTicks ? { totalsSource: "Summed from the pool's ticks, because the pool-level totals in the data source read zero." } : {}),
    raw: {
      decimals: POOL_VALUE_DECIMALS,
      totalValueLocked: agg.totalValueLocked,
      totalValueUsed: agg.totalValueUsed,
      totalValueAvailable: agg.totalValueAvailable,
    },
  };
}
