import { LOANS_INCOMPLETE_NOTE, loansMayBeIncomplete } from "../clients/budgets.js";
import { getAllLoans } from "../clients/graphql.js";
import { aggregatePoolStats, getFabricaPools } from "../clients/subgraph.js";
import { MAINNET_WARNING, NETWORK, NETWORK_LABEL, WEB_BASE } from "../config.js";
import { formatLoanProvider, LENDING_POOL_NAME, loanVolumeByCurrency } from "../labels.js";
import { formatTokenAmount, formatUsdOrNull, shortenAddress } from "../format.js";
import type { LoanModel, SubgraphPool } from "../types/index.js";
import { z } from "zod";
import type { ArgsOf } from "./inputs.js";

const STABLECOINS = new Set(["USDC", "USDT", "DAI"]);
const MONTHS_SHOWN = 12;
const DEFAULT_LARGEST = 10;
const DAY_MS = 86_400_000;

const LTV_BANDS = [
  { label: "under 25%", below: 0.25 },
  { label: "25% to 50%", below: 0.5 },
  { label: "50% to 75%", below: 0.75 },
  { label: "75% to 100%", below: 1 },
  { label: "100% or more", below: Number.POSITIVE_INFINITY },
];
const NO_ESTIMATE = "no estimate today";
const NOT_IN_DOLLARS = "principal not in digital dollars";

const ACRE_BANDS = [
  { label: "under 1 acre", below: 1 },
  { label: "1 to 5 acres", below: 5 },
  { label: "5 to 20 acres", below: 20 },
  { label: "20 to 100 acres", below: 100 },
  { label: "100 acres or more", below: Number.POSITIVE_INFINITY },
];
const NO_ACREAGE = "acreage not recorded";

const STATUS_ORDER = ["Active", "Repaid", "Liquidated", "Liquidating", "Default"];

export const getLoanBookInput = {
  provider: z.enum(["pool", "peer-to-peer", "all"]).optional().describe(`pool: the ${LENDING_POOL_NAME}. peer-to-peer: historical loans through the retired NFTfi integration. Default all.`),
  status: z.enum(["active", "repaid", "liquidated", "all"]).optional().describe("Only loans with this status (default all)."),
  sinceDays: z.number().int().min(1).max(3650).optional().describe("Only loans started in the last N days (default: the whole history)."),
  groupBy: z.enum(["state", "provider", "status", "ltvBand", "acreBand"]).optional().describe("Adds a groups table: loans, principal and outcome counts per state, provider, status, loan-to-value band or acre band."),
  largest: z.number().int().min(1).max(25).optional().describe(`How many of the largest loans to list (default ${DEFAULT_LARGEST}, max 25).`),
};
export type GetLoanBookArgs = ArgsOf<typeof getLoanBookInput>;

const isPool = (loan: LoanModel) => loan.loanProvider === "PoolLending";

const isDollar = (loan: LoanModel) => loan.currencySymbol !== null && STABLECOINS.has(loan.currencySymbol);

function amount(value: string | null | undefined): number | null {
  const num = Number.parseFloat(value ?? "");
  return Number.isFinite(num) ? num : null;
}

/** Principal over the property's estimated value today, for a dollar loan on a property with an estimate. */
export function loanToValue(loan: LoanModel): number | null {
  const principal = amount(loan.principalScaled);
  const value = amount(loan.token?.estimatedValue);
  if (!isDollar(loan) || principal === null || value === null || value <= 0) return null;
  return principal / value;
}

export function ltvBand(loan: LoanModel): string {
  if (!isDollar(loan)) return NOT_IN_DOLLARS;
  const ltv = loanToValue(loan);
  if (ltv === null) return NO_ESTIMATE;
  return LTV_BANDS.find(b => ltv < b.below)?.label ?? NO_ESTIMATE;
}

export function acreBand(loan: LoanModel): string {
  const acres = amount(loan.token?.acres);
  if (acres === null || acres <= 0) return NO_ACREAGE;
  return ACRE_BANDS.find(b => acres < b.below)?.label ?? NO_ACREAGE;
}

/**
 * The name a wallet's owner chose, or null. The API fills `displayName` with a shortened address
 * ("0xA75…0B4f") when nobody set one, which is not a name.
 */
export function chosenName(wallet: { address: string; user: { displayName: string } | null } | null): string | null {
  const name = wallet?.user?.displayName?.trim() ?? "";
  if (!name || name.toLowerCase() === wallet?.address.toLowerCase()) return null;
  return /^0x[0-9a-f]+(…|\.\.\.)[0-9a-f]+$/i.test(name) ? null : name;
}

function durationDays(loan: LoanModel): number | null {
  const days = (Date.parse(loan.maturityDate) - Date.parse(loan.startTime)) / DAY_MS;
  return Number.isFinite(days) && days > 0 ? Math.round(days) : null;
}

function quantile(sorted: ReadonlyArray<number>, q: number): number {
  const pos = (sorted.length - 1) * q;
  const low = Math.floor(pos);
  const high = Math.ceil(pos);
  return sorted[low] + (sorted[high] - sorted[low]) * (pos - low);
}

function spread(values: ReadonlyArray<number>, format: (n: number) => string) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    loans: sorted.length,
    min: format(sorted[0]),
    p25: format(quantile(sorted, 0.25)),
    median: format(quantile(sorted, 0.5)),
    p75: format(quantile(sorted, 0.75)),
    max: format(sorted[sorted.length - 1]),
  };
}

const percent = (n: number) => `${n.toFixed(1)}%`;
const days = (n: number) => `${Math.round(n)} days`;

function countBy<T>(items: ReadonlyArray<T>, key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  return groups;
}

/** Dollar principal of a set of loans, for ordering groups; loans in other currencies count 0. */
function dollarPrincipal(loans: ReadonlyArray<LoanModel>): number {
  return loans.reduce((sum, l) => sum + (isDollar(l) ? amount(l.principalScaled) ?? 0 : 0), 0);
}

function outcomeRow(loans: ReadonlyArray<LoanModel>) {
  const counts = { active: 0, repaid: 0, liquidated: 0, other: 0 };
  for (const l of loans) {
    if (l.loanStatus === "Active") counts.active += 1;
    else if (l.loanStatus === "Repaid") counts.repaid += 1;
    else if (l.loanStatus === "Liquidated") counts.liquidated += 1;
    else counts.other += 1;
  }
  return { loans: loans.length, principal: loanVolumeByCurrency(loans), ...counts };
}

/** `{ [name]: value }` typed by its key, so a table's rows keep their group field ("status", "state"). */
function keyed<K extends string>(name: K, value: string): Record<K, string>;
function keyed(name: string, value: string): Record<string, string> {
  return { [name]: value };
}

/** Rows in the order given, then any other key; empty keys are left out. */
function table<K extends string>(loans: ReadonlyArray<LoanModel>, key: (l: LoanModel) => string, order: ReadonlyArray<string>, name: K) {
  const groups = countBy(loans, key);
  const known = order.filter(k => groups.has(k));
  const rest = [...groups.keys()].filter(k => !order.includes(k));
  return [...known, ...rest].map(k => ({ ...keyed(name, k), ...outcomeRow(groups.get(k) ?? []) }));
}

/** Rows ordered by dollar principal, largest first. */
function tableByPrincipal<K extends string>(loans: ReadonlyArray<LoanModel>, key: (l: LoanModel) => string, name: K) {
  return [...countBy(loans, key)]
    .sort(([, a], [, b]) => dollarPrincipal(b) - dollarPrincipal(a) || b.length - a.length)
    .map(([k, group]) => ({ ...keyed(name, k), ...outcomeRow(group) }));
}

const stateOf = (l: LoanModel) => l.token?.regionCode ?? l.token?.region ?? "state not recorded";
const providerOf = (l: LoanModel) => formatLoanProvider(l.loanProvider) ?? "Unknown provider";

function propertyLink(tokenId: string): string {
  return `${WEB_BASE}/property/${NETWORK}/${encodeURIComponent(tokenId)}`;
}

function collateral(loan: LoanModel) {
  return {
    tokenId: loan.collateralId,
    name: loan.token?.name ?? null,
    state: loan.token?.regionCode ?? null,
    county: loan.token?.district ?? null,
    acres: amount(loan.token?.acres),
    estimatedValueToday: formatUsdOrNull(loan.token?.estimatedValue),
    propertyLink: propertyLink(loan.collateralId),
  };
}

function wallet(w: { address: string; user: { displayName: string } | null } | null) {
  const name = chosenName(w);
  return { address: shortenAddress(w?.address), ...(name ? { name } : {}) };
}

function ltvText(loan: LoanModel): string | null {
  const ltv = loanToValue(loan);
  return ltv === null ? null : percent(ltv * 100);
}

/** The largest digital-dollar loans by principal; loans in other currencies cannot be ranked against them. */
function largestLoans(loans: ReadonlyArray<LoanModel>, count: number) {
  return loans.filter(isDollar)
    .sort((a, b) => (amount(b.principalScaled) ?? 0) - (amount(a.principalScaled) ?? 0))
    .slice(0, count)
    .map(l => ({
      loanId: l.loanId,
      provider: providerOf(l),
      status: l.loanStatus,
      principal: formatTokenAmount(l.principalScaled, l.currencySymbol),
      apr: l.aprPercent !== null ? percent(l.aprPercent) : null,
      durationDays: durationDays(l),
      startTime: l.startTime,
      loanToValueToday: ltvText(l),
      borrower: wallet(l.borrower),
      collateral: collateral(l),
    }));
}

/** Originations per calendar month (UTC) for the last MONTHS_SHOWN months, this month included, empty months shown. */
export function originationsByMonth(loans: ReadonlyArray<LoanModel>, now: Date) {
  const months = Array.from({ length: MONTHS_SHOWN }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (MONTHS_SHOWN - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
  const groups = countBy(loans, l => l.startTime.slice(0, 7));
  return months.map(month => {
    const group = groups.get(month) ?? [];
    return { month, loans: group.length, principal: loanVolumeByCurrency(group) };
  });
}

/**
 * Pool loan counts from the loan records next to the pool data source's own counters
 * (ENG-5029: its liquidation counter has read 0 while ten pool loans were liquidated).
 * Covers every pool loan, whatever the filters.
 */
function poolCounts(allLoans: ReadonlyArray<LoanModel>, pools: SubgraphPool[] | null) {
  const poolIds = new Set((pools ?? []).map(p => p.id.toLowerCase()));
  const records = allLoans.filter(l => isPool(l) && (poolIds.size === 0 || poolIds.has(l.loanContract.toLowerCase())));
  const loanRecords = {
    originated: records.length,
    active: records.filter(l => l.loanStatus === "Active").length,
    repaid: records.filter(l => l.loanStatus === "Repaid").length,
    liquidated: records.filter(l => l.loanStatus === "Liquidated").length,
  };
  const agg = pools ? aggregatePoolStats(pools) : null;
  if (!agg) return { countsSource: "loan records", loanRecords, poolDataSource: null };
  const poolDataSource = {
    originated: agg.loansOriginated,
    active: agg.loansActive,
    repaid: agg.loansRepaid,
    liquidated: agg.loansLiquidated,
  };
  const keys = ["originated", "active", "repaid", "liquidated"] satisfies Array<keyof typeof loanRecords>;
  const disagree = keys.filter(k => loanRecords[k] !== poolDataSource[k]);
  return {
    countsSource: "loan records",
    loanRecords,
    poolDataSource,
    ...(disagree.length > 0
      ? { note: `The ${LENDING_POOL_NAME} data source's own counters differ on ${disagree.join(", ")}. Every count in this response comes from the loan records, which list each loan with its status.` }
      : {}),
  };
}

export async function getLoanBook(args: GetLoanBookArgs) {
  const largest = Math.min(Math.max(Math.trunc(args.largest ?? DEFAULT_LARGEST), 1), 25);
  try {
    const [allLoans, pools] = await Promise.all([getAllLoans(), getFabricaPools()]);
    const now = new Date();
    const since = args.sinceDays ? now.getTime() - args.sinceDays * DAY_MS : null;
    const status = args.status && args.status !== "all" ? args.status.charAt(0).toUpperCase() + args.status.slice(1) : null;
    const loans = allLoans.filter(l =>
      (args.provider === "pool" ? isPool(l) : args.provider === "peer-to-peer" ? !isPool(l) : true)
      && (status === null || l.loanStatus === status)
      && (since === null || Date.parse(l.startTime) >= since));
    const dollarLoans = loans.filter(isDollar);
    const groupKey = {
      state: stateOf,
      provider: providerOf,
      status: (l: LoanModel) => l.loanStatus,
      ltvBand,
      acreBand,
    };
    return {
      network: NETWORK_LABEL,
      ...(MAINNET_WARNING ? { legalNotice: MAINNET_WARNING } : {}),
      scope: {
        provider: args.provider ?? "all",
        status: args.status ?? "all",
        sinceDays: args.sinceDays ?? null,
        loans: loans.length,
        description: `Loans the API records on this network: ${LENDING_POOL_NAME} loans and historical peer-to-peer loans (retired NFTfi integration), filtered as listed.`,
      },
      byStatus: table(loans, l => l.loanStatus, STATUS_ORDER, "status"),
      byProvider: table(loans, providerOf, [], "provider"),
      principalByCurrency: loanVolumeByCurrency(loans),
      loanToValue: {
        bands: table(loans, ltvBand, [...LTV_BANDS.map(b => b.label), NO_ESTIMATE, NOT_IN_DOLLARS], "band"),
        spread: spread(dollarLoans.map(loanToValue).filter((v): v is number => v !== null).map(v => v * 100), percent),
        basis: "Principal against the property's estimated value today. The value at origination is not stored, so a band reflects today's estimate, not the loan-to-value the loan was made at.",
      },
      byState: tableByPrincipal(loans, stateOf, "state"),
      byAcreBand: table(loans, acreBand, [...ACRE_BANDS.map(b => b.label), NO_ACREAGE], "band"),
      apr: spread(loans.map(l => l.aprPercent).filter((v): v is number => v !== null), percent),
      duration: {
        spread: spread(loans.map(durationDays).filter((v): v is number => v !== null), days),
        byTerm: [...countBy(loans, l => l.durationFormatted)].sort(([, a], [, b]) => b.length - a.length).map(([term, group]) => ({ term, loans: group.length })),
      },
      originationsByMonth: originationsByMonth(loans, now),
      largestLoans: largestLoans(loans, largest),
      ...(loans.length > dollarLoans.length ? { largestLoansScope: `Ranked among digital-dollar loans only; ${loans.length - dollarLoans.length} ${loans.length - dollarLoans.length === 1 ? "loan" : "loans"} in other currencies (see principalByCurrency) cannot be ranked against them.` } : {}),
      ...(args.groupBy ? { groups: { by: args.groupBy, rows: tableByPrincipal(loans, groupKey[args.groupBy], args.groupBy) } } : {}),
      poolCounts: poolCounts(allLoans, pools),
      ...(loansMayBeIncomplete(allLoans) ? { loansNote: LOANS_INCOMPLETE_NOTE } : {}),
      notes: [
        "Principal is in each loan's own currency and is never summed across currencies. Fabrica counts one USDC as one dollar.",
        "Borrower names appear only where the wallet's owner set one; addresses are shortened.",
        "This is the history of loans made, for research. It is not a forecast of what a loan or a deposit will do.",
      ],
    };
  } catch (e) {
    return { error: `Failed to get the loan book: ${e instanceof Error ? e.message : String(e)}` };
  }
}
