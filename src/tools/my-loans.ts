import { NETWORK, NETWORK_LABEL, WEB_BASE } from "../config.js";
import { hasScope, type AccountAuth } from "../auth/token.js";
import { AccountApiError, getAccountProfile } from "../clients/account.js";
import { getDepositPools, getPoolDeposits, getWallet, getWalletLoans } from "../clients/graphql.js";
import { formatTokenAmount, formatUsd, shortenAddress, sortLoans } from "../format.js";
import { formatLoanProvider, LENDING_POOL_NAME } from "../labels.js";
import type { DepositPool, PoolDeposit, WalletLoan } from "../types/index.js";

/**
 * The connected person's lending: loans they took against their properties, loans they made, and
 * their deposits in the DeFi lending pool. Public data, read for the wallets on their account
 * (portfolio:read). Links only: repaying and depositing happen on fabrica.land.
 */

const DAY_MS = 86_400_000;
const MATURING_SOON_DAYS = 14;
/** Pool shares, values and deposits are 1e18 fixed-point USD. */
const WAD = 10n ** 18n;

export interface MyLoanRow {
  loanId: string;
  property: { tokenId: string | null; name: string | null };
  status: string;
  provider: string | null;
  principal: string | null;
  apr: string | null;
  duration: string;
  startedAt: string;
  maturityDate: string;
  daysToMaturity?: number;
  maturingSoon?: boolean;
  payoffToday?: string | null;
  payoffAsOf?: string | null;
  payoffNote?: string;
  repaidAt?: string;
  liquidatedAt?: string;
  borrower?: string | null;
  lender?: string | null;
  links: { property: string | null };
}

export interface MyDepositRow {
  pool: string;
  /** What the shares are worth at the pool's current tick values. */
  positionValue: string | null;
  deposited: string | null;
  /** Value of the shares waiting in the redemption queue. */
  pendingRedemption: string | null;
  links: { pool: string };
}

export interface MyLoansResult {
  network: string;
  totals: { activeTaken: number; maturingSoon: number; activeMade: number; deposits: number };
  taken: MyLoanRow[];
  made: MyLoanRow[];
  deposits: MyDepositRow[];
  /** Loan counts across the account's wallets. */
  history: { total: number; active: number; repaid: number; defaulted: number; liquidated: number };
  notes: string[];
  error?: string;
}

function propertyPage(tokenId: string | null | undefined): string | null {
  return tokenId ? `${WEB_BASE}/property/${NETWORK}/${encodeURIComponent(tokenId)}` : null;
}

/** Past maturity a pool loan shows Default until its auction starts, and the borrower can still pay it off. */
export function isOpenLoan(loan: { loanStatus: string } | { status: string }): boolean {
  const status = "loanStatus" in loan ? loan.loanStatus : loan.status;
  return status === "Active" || status === "Default";
}

/** Open loans (active, or defaulted and still repayable) first, then the rest newest first. */
function openFirst(loans: WalletLoan[]): WalletLoan[] {
  return sortLoans(loans).sort((a, b) => Number(isOpenLoan(b)) - Number(isOpenLoan(a)));
}

function toRow(loan: WalletLoan, side: "taken" | "made", now: number): MyLoanRow {
  const symbol = loan.currencySymbol ?? "USDC";
  const active = isOpenLoan(loan);
  const row: MyLoanRow = {
    loanId: loan.loanId,
    property: { tokenId: loan.token?.tokenId ?? loan.collateralId, name: loan.token?.name ?? loan.token?.vanityName ?? null },
    status: loan.loanStatus,
    provider: formatLoanProvider(loan.loanProvider),
    principal: formatTokenAmount(loan.principalScaled, symbol),
    apr: loan.aprPercent !== null ? `${loan.aprPercent.toFixed(1)}%` : null,
    duration: loan.durationFormatted,
    startedAt: loan.startTime,
    maturityDate: loan.maturityDate,
    links: { property: loan.token?.propertyLink ?? propertyPage(loan.collateralId) },
  };
  if (active) {
    const maturity = Date.parse(loan.maturityDate);
    if (Number.isFinite(maturity)) {
      row.daysToMaturity = Math.floor((maturity - now) / DAY_MS);
      row.maturingSoon = row.daysToMaturity <= MATURING_SOON_DAYS;
    }
    row.payoffToday = formatTokenAmount(loan.livePayoffScaled ?? loan.maxRepaymentScaled, symbol);
    row.payoffAsOf = loan.payoffAsOf;
    if (!loan.livePayoffScaled) row.payoffNote = "The API has no live payoff for this loan; the full repayment is shown, and paying off early can cost less.";
  }
  if (loan.loanRepaidDate) row.repaidAt = loan.loanRepaidDate;
  if (loan.loanLiquidationDate) row.liquidatedAt = loan.loanLiquidationDate;
  if (side === "taken" && loan.lender) row.lender = shortenAddress(loan.lender.address);
  if (side === "made") row.borrower = shortenAddress(loan.borrower.address);
  return row;
}

/** A 1e18 fixed-point USD amount as "$1,234". */
function wadUsd(value: bigint): string | null {
  return formatUsd(String(Number(value / 10n ** 14n) / 10_000));
}

function sharesValue(shares: bigint, tick: DepositPool["ticks"][number] | undefined): bigint | null {
  if (!tick) return null;
  const tickShares = BigInt(tick.shares);
  return tickShares === 0n ? null : (shares * BigInt(tick.value)) / tickShares;
}

function depositRow(pool: DepositPool, deposits: PoolDeposit[]): MyDepositRow {
  const ticks = new Map(pool.ticks.map((tick) => [tick.raw, tick]));
  let value = 0n;
  let pending = 0n;
  let deposited = 0n;
  let priced = true;
  for (const deposit of deposits) {
    const tick = ticks.get(deposit.tickRaw);
    const held = sharesValue(BigInt(deposit.shares), tick);
    const queued = sharesValue(deposit.redemptions.reduce((sum, r) => sum + BigInt(r.shares), 0n), tick);
    if (held === null) priced = false;
    value += held ?? 0n;
    pending += queued ?? 0n;
    deposited += /^-?\d+$/.test(deposit.depositedAmount) ? BigInt(deposit.depositedAmount) : 0n;
  }
  return {
    pool: LENDING_POOL_NAME,
    positionValue: priced ? wadUsd(value) : null,
    deposited: wadUsd(deposited < 0n ? 0n : deposited),
    pendingRedemption: pending > 0n ? wadUsd(pending) : null,
    links: { pool: `${WEB_BASE}/pools/${NETWORK}/${pool.address}` },
  };
}

async function depositsFor(wallets: string[]): Promise<MyDepositRow[]> {
  const pools = await getDepositPools();
  const rows: MyDepositRow[] = [];
  for (const pool of pools) {
    const lists = await Promise.all(wallets.map((wallet) => getPoolDeposits(wallet, pool.address)));
    const deposits = lists.flat().filter((deposit) => deposit.shares !== "0" || deposit.redemptions.length > 0);
    if (deposits.length > 0) rows.push(depositRow(pool, deposits));
  }
  return rows;
}

function dedupe(loans: WalletLoan[]): WalletLoan[] {
  const byId = new Map<string, WalletLoan>();
  for (const loan of loans) if (!byId.has(loan.loanId)) byId.set(loan.loanId, loan);
  return [...byId.values()];
}

/** The API serves loan counts as integer strings. */
function count(value: string): number {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

const EMPTY_HISTORY = { total: 0, active: 0, repaid: 0, defaulted: 0, liquidated: 0 };

function empty(notes: string[], error?: string): MyLoansResult {
  return { network: NETWORK_LABEL, totals: { activeTaken: 0, maturingSoon: 0, activeMade: 0, deposits: 0 }, taken: [], made: [], deposits: [], history: EMPTY_HISTORY, notes, ...(error ? { error } : {}) };
}

export async function getMyLoans(auth: AccountAuth): Promise<MyLoansResult> {
  if (!hasScope(auth, "portfolio:read")) {
    return empty(["This connection was not granted portfolio:read. Reconnect Fabrica and approve \"See your properties, listings, offers and loans\" to read loans."]);
  }
  let wallets: string[];
  try {
    const profile = await getAccountProfile(auth, "portfolio:read");
    if (!profile) return empty([`The Fabrica API on ${NETWORK_LABEL} does not serve account details yet, so this account's loans cannot be listed here. get_land_portfolio reads any wallet address's loans.`]);
    wallets = [...new Set(profile.wallets.map((wallet) => wallet.address.toLowerCase()))];
  } catch (error) {
    if (error instanceof AccountApiError) return empty([], error.message);
    throw error;
  }
  if (wallets.length === 0) return empty(["No linked account (wallet address) is on this Fabrica account yet, so it has no loans."]);

  const now = Date.now();
  const [loanRecords, walletRecords, deposits] = await Promise.all([
    Promise.all(wallets.map((wallet) => getWalletLoans(wallet))),
    Promise.all(wallets.map((wallet) => getWallet(wallet))),
    // Deposits come from the pool indexer; when it is down, the loans still answer.
    depositsFor(wallets).catch(() => null),
  ]);
  const taken = openFirst(dedupe(loanRecords.flatMap((record) => record?.loansTaken ?? []))).map((loan) => toRow(loan, "taken", now));
  const made = openFirst(dedupe(loanRecords.flatMap((record) => record?.loansMade ?? []))).map((loan) => toRow(loan, "made", now));
  const history = { ...EMPTY_HISTORY };
  for (const record of walletRecords) {
    const credit = record?.creditHistory;
    if (!credit) continue;
    history.total += count(credit.totalLoans.loanCount);
    history.active += count(credit.activeLoans.loanCount);
    history.repaid += count(credit.repaidLoans.loanCount);
    history.defaulted += count(credit.defaultedLoans.loanCount);
    history.liquidated += count(credit.liquidatedLoans.loanCount);
  }
  const notes: string[] = [];
  if (deposits === null) notes.push(`Deposits in the ${LENDING_POOL_NAME} could not be read right now; loans are complete. Try again shortly.`);
  if (taken.some((row) => row.status === "Default")) notes.push("A loan with status Default is past maturity and its auction has not started: it can still be paid off from the property page (links.property), and until it is the property is at risk.");
  if (taken.some((row) => row.maturingSoon)) notes.push(`A loan marked maturingSoon is due within ${MATURING_SOON_DAYS} days. It is repaid from the property page (links.property); nothing is prepared here.`);
  if (deposits !== null && taken.length + made.length + deposits.length === 0) notes.push("This account has no loans and no deposits in the DeFi lending pool.");
  return {
    network: NETWORK_LABEL,
    totals: {
      activeTaken: taken.filter(isOpenLoan).length,
      maturingSoon: taken.filter((row) => row.maturingSoon).length,
      activeMade: made.filter(isOpenLoan).length,
      deposits: deposits?.length ?? 0,
    },
    taken,
    made,
    deposits: deposits ?? [],
    history,
    notes,
  };
}
