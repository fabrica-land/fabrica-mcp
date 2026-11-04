// Deposit into and withdraw from the DeFi lending pool as sign requests: deposit_to_lending_pool and
// withdraw_from_lending_pool check the pool's ticks (from the Fabrica API) and the wallet's position
// at the tick (read onchain), then return a sign request whose link opens the pool page's deposit
// or withdraw dialog on fabrica.land, prefilled. The person signs there with their own wallet.
import { z } from "zod";
import { getDepositPoolsWithTime } from "../clients/graphql.js";
import { ethCall, getBlockNumber, getLogs, getTransaction, getTransactionReceipt } from "../clients/rpc.js";
import { IS_MAINNET, NETWORK, NETWORK_LABEL, WEB_BASE } from "../config.js";
import { LENDING_POOL_NAME } from "../labels.js";
import type { SignRequest, SignRequestWarning } from "../sign-requests/store.js";
import type { DepositPool } from "../types/index.js";
import { decodeTick as decodeTickLayout } from "./borrow-limits.js";
import { type ArgsOf } from "./inputs.js";
import { type Blocked, issue, pickSigner, type Prepared, same, shorten, usd, type WithSigner } from "./sign-requests.js";

/** The pool page lists ticks holding at least a cent; only those can be opened there. */
const MIN_TICK_VALUE = 10n ** 16n;
/** A withdrawal within a cent of the position takes all of it, as the pool page's Max does. */
const WHOLE_TOLERANCE = 10n ** 16n;
/** deposits(address account, uint128 tick) returns (uint128 shares, uint128 redemptionId). */
const DEPOSITS_SELECTOR = "0x6c2bb22d";
/** Deposited(address indexed account, uint128 indexed tick, uint256 amount, uint256 shares). */
const DEPOSITED_TOPIC = "0xd3d9500b000f4b80b8f9aea0e7ce7d135560d7775a63356999a9f3efd4f5edf8";
/** Redeemed(address indexed account, uint128 indexed tick, uint128 indexed redemptionId, uint256 shares). */
const REDEEMED_TOPIC = "0x3ac2f453c81511b46084827fa6798fc6c8f7da31176e5be199525d49e59c7675";
/** A partial withdrawal's redeemed shares may differ this much (in percent) from the estimate made when it was prepared. */
const SHARES_SLACK_PERCENT = 2n;

const RISK_LINE = "Deposited funds are lent to borrowers against land. Interest is set by the pool, variable and not guaranteed, and a deposit is at risk: if a borrower does not repay and the property's auction does not cover the loan, the deposit can lose value.";
const SELF_DIRECTED = "The pool is an autonomous smart contract; the depositor chooses the tick and the pool issues deposit shares. Nothing here is financial advice.";

const walletInput = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "A 0x-prefixed Ethereum address").describe("The wallet that will sign (0x address). The sign page only lets this wallet sign.");
const tickInput = z.string().regex(/^\d{1,40}$/, "A tick id: digits").describe("The pool tick: tick from the list this tool returns when tick is left out. A tick sets the largest loan it funds (a share of a property's value, or a fixed dollar amount) and the longest loan length");
const poolInput = z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional().describe("The pool's address, when the network has more than one");

type Tick = DepositPool["ticks"][number];
type Position = { shares: bigint; redemptionId: bigint };

export type TickChoice = { tick: string; ltvPercent: number | null; fixedLimitUsd: number | null; maxLoanDays: number | null };

/** A tick's loan terms (see borrow-limits for the layout), or null when the tick is malformed; a ratio limit is in basis points. */
export function decodeTick(raw: string): { ltvPercent: number | null; fixedLimitUsd: number | null; durationIndex: number } | null {
  const decoded = decodeTickLayout(raw);
  if (!decoded) return null;
  const ratio = decoded.limitType === "ratio";
  // A fixed limit is a dollar amount in the pool's 18-decimal scale.
  return { ltvPercent: ratio ? Number(decoded.limit) / 100 : null, fixedLimitUsd: ratio ? null : Number(decoded.limit / 10n ** 16n) / 100, durationIndex: decoded.durationIndex };
}

function choice(pool: DepositPool, tick: Tick): TickChoice {
  const { ltvPercent, fixedLimitUsd, durationIndex } = decodeTick(tick.raw) ?? { ltvPercent: null, fixedLimitUsd: null, durationIndex: -1 };
  const seconds = pool.durations[durationIndex];
  return { tick: tick.raw, ltvPercent, fixedLimitUsd, maxLoanDays: typeof seconds === "number" ? Math.round(seconds / 86_400) : null };
}

function describe(c: TickChoice): string {
  const ltv = c.ltvPercent === null ? `loans up to ${c.fixedLimitUsd === null ? "a fixed amount" : usd(c.fixedLimitUsd)}` : `loans up to ${c.ltvPercent}% of a property's value`;
  return `${ltv}, up to ${c.maxLoanDays ?? "?"} days`;
}

/** Ticks the pool page can open, lowest loan-to-value first. A malformed tick is left out. */
export function openTicks(pool: DepositPool): Tick[] {
  return pool.ticks
    .filter(tick => /^\d+$/.test(tick.value) && BigInt(tick.value) >= MIN_TICK_VALUE && decodeTick(tick.raw) !== null)
    .sort((a, b) => (decodeTick(a.raw)?.ltvPercent ?? 0) - (decodeTick(b.raw)?.ltvPercent ?? 0));
}

/** Interest accrued to the tick and not yet in its value, projected to `nowSeconds` as the pool does. */
function accrued(tick: Tick, nowSeconds: number): bigint {
  const base = BigInt(tick.accrued ?? "0");
  const rate = BigInt(tick.accrualRate ?? "0");
  const since = tick.accrualTimestamp ?? nowSeconds;
  return base + rate * BigInt(Math.max(0, nowSeconds - since));
}

/** The fair value (1e18 USD) of `shares` at a tick: (value + accrued) / shares, the price deposits mint at. */
export function sharesValue(tick: Tick, shares: bigint, nowSeconds: number): bigint {
  const total = BigInt(tick.shares);
  if (total === 0n) return shares;
  return (shares * (BigInt(tick.value) + accrued(tick, nowSeconds))) / total;
}

/** Whole cents of a 1e18 USD value, rounded down in integer math so no cent is lost to floating point. */
/** Shares a withdrawal of `amount` (1e18 USD) redeems at the tick's fair price. */
function sharesFor(tick: Tick, amount: bigint, nowSeconds: number): bigint {
  const worth = BigInt(tick.value) + accrued(tick, nowSeconds);
  return worth === 0n ? amount : (amount * BigInt(tick.shares)) / worth;
}

function sharesRange(shares: bigint): { minShares: string; maxShares: string } {
  const slack = (shares * SHARES_SLACK_PERCENT) / 100n;
  return { minShares: (shares - slack).toString(), maxShares: (shares + slack).toString() };
}

/** A deposit of `cents`, as the pool may log it: in token units, or scaled to its 18-decimal fixed point. */
function depositAmounts(cents: bigint, decimals: number): string[] {
  const units = decimals >= 2 ? cents * 10n ** BigInt(decimals - 2) : cents / 10n ** BigInt(2 - decimals);
  return [...new Set([units, units * 10n ** BigInt(Math.max(0, 18 - decimals))].map(String))];
}

const floorCents = (value: bigint): number => Number(value / 10n ** 16n) / 100;

const word = (hex: string): string => hex.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const addressTopic = (address: string): string => `0x${word(address)}`;
const tickTopic = (tick: string): string => `0x${word(BigInt(tick).toString(16))}`;

/** The wallet's shares and next redemption id at a tick, read from the pool contract. */
export async function readPosition(poolAddress: string, wallet: string, tick: string): Promise<Position> {
  const result = await ethCall(poolAddress, `${DEPOSITS_SELECTOR}${word(wallet)}${word(BigInt(tick).toString(16))}`);
  const data = result.replace(/^0x/, "");
  if (data.length < 128) throw new Error("The pool did not return a position.");
  return { shares: BigInt(`0x${data.slice(0, 64)}`), redemptionId: BigInt(`0x${data.slice(64, 128)}`) };
}

type Loaded = { pool: DepositPool; nowSeconds: number } | Blocked;

async function loadPool(address: string | undefined): Promise<Loaded> {
  let data: Awaited<ReturnType<typeof getDepositPoolsWithTime>>;
  try {
    data = await getDepositPoolsWithTime();
  } catch (e) {
    return { error: `The ${LENDING_POOL_NAME} could not be read right now: ${e instanceof Error ? e.message : String(e)}` };
  }
  const nowSeconds = data.blockTimestamp ?? Math.floor(Date.now() / 1000);
  if (address) {
    const pool = data.pools.find(p => same(p.address, address));
    return pool ? { pool, nowSeconds } : { error: `No ${LENDING_POOL_NAME} at ${address} on ${NETWORK_LABEL}. Pools here: ${data.pools.map(p => p.address).join(", ") || "none"}.` };
  }
  const [only] = data.pools;
  if (data.pools.length === 1 && only) return { pool: only, nowSeconds };
  if (data.pools.length === 0) return { error: `No ${LENDING_POOL_NAME} takes deposits on ${NETWORK_LABEL} right now.` };
  return { error: `${data.pools.length} ${LENDING_POOL_NAME}s on ${NETWORK_LABEL}: ${data.pools.map(p => p.address).join(", ")}. The call runs once pool names one of them.` };
}

function findTick(pool: DepositPool, tick: string | undefined): { tick: Tick } | (Blocked & { ticks: TickChoice[] }) {
  const open = openTicks(pool);
  const ticks = open.map(t => choice(pool, t));
  if (open.length === 0) return { error: `The ${LENDING_POOL_NAME} has no ticks open for deposits on ${NETWORK_LABEL} right now.`, ticks };
  const [only] = open;
  if (tick === undefined) {
    if (open.length === 1 && only) return { tick: only };
    return { error: `The ${LENDING_POOL_NAME} has ${open.length} ticks; the call runs once tick names one of them: ${ticks.map(c => `${c.tick} (${describe(c)})`).join("; ")}.`, ticks };
  }
  const found = open.find(t => t.raw === tick);
  return found ? { tick: found } : { error: `No open tick ${tick} in the ${LENDING_POOL_NAME}. Open ticks: ${ticks.map(c => `${c.tick} (${describe(c)})`).join("; ")}.`, ticks };
}

function poolLink(pool: DepositPool, params: Record<string, string>, id: string): string {
  const url = new URL(`${WEB_BASE}/pools/${NETWORK}/${pool.address}`);
  for (const [key, value] of Object.entries({ ...params, request: id })) url.searchParams.set(key, value);
  return url.toString();
}

function amountParam(amount: number): string {
  return amount.toFixed(2).replace(/\.00$/, "");
}

// --- deposit_to_lending_pool ---

export const depositInput = {
  amountUsd: z.number().min(1).max(10_000_000).describe("Amount to deposit in US dollars, paid in USDC (one USDC counts as one dollar)"),
  tick: tickInput.optional(),
  pool: poolInput,
  wallet: walletInput,
};
export type DepositArgs = ArgsOf<typeof depositInput>;

export async function prepareDeposit({ amountUsd, tick: tickArg, pool: poolArg, wallet: signer }: WithSigner<DepositArgs>): Promise<Prepared | Blocked> {
  const loaded = await loadPool(poolArg);
  if ("error" in loaded) return loaded;
  const { pool } = loaded;
  const found = findTick(pool, tickArg);
  if ("error" in found) return found;
  const { tick } = found;
  const picked = pickSigner(signer, () => true, "can deposit", "");
  if ("error" in picked) return picked;
  const { wallet } = picked;
  let before: Position;
  let fromBlock: number;
  try {
    [before, fromBlock] = await Promise.all([readPosition(pool.address, wallet, tick.raw), getBlockNumber()]);
  } catch (e) {
    return { error: `The wallet's position in the ${LENDING_POOL_NAME} could not be read right now: ${e instanceof Error ? e.message : String(e)}` };
  }
  const terms = choice(pool, tick);
  const amount = Math.round(amountUsd * 100) / 100;
  const amounts = depositAmounts(BigInt(Math.round(amountUsd * 100)), pool.currencyToken.decimals ?? 6);
  const warnings: SignRequestWarning[] = [...picked.chosen];
  if (before.shares > 0n) warnings.push({ level: "info", message: `This wallet already has a deposit at this tick; the new deposit adds to it.` });
  return {
    action: "deposit_to_lending_pool",
    kind: "transaction",
    wallet,
    pool: { address: pool.address, tick: tick.raw, ltvPercent: terms.ltvPercent, maxLoanDays: terms.maxLoanDays, amountUsd: amount, wholePosition: false, link: `${WEB_BASE}/pools/${NETWORK}/${pool.address}`, before: { shares: before.shares.toString(), redemptionId: before.redemptionId.toString() }, fromBlock, expect: { amounts } },
    summary: [
      `Deposit ${usd(amount)} in USDC into the ${LENDING_POOL_NAME} on ${NETWORK_LABEL}, at the tick for ${describe(terms)}.`,
      RISK_LINE,
      `A withdrawal is paid from funds the tick has not lent out; the rest waits in the pool's withdrawal queue until loans are repaid (loans at this tick run up to ${terms.maxLoanDays ?? "?"} days, longer if a property goes to auction).`,
      "Signing sends an onchain transaction from this wallet; the wallet pays the network fee. If the wallet has not yet allowed the pool to use its USDC, the sign page asks for that approval first.",
      "The sign page also offers paying by card or bank. Those deposits reach the pool only once the payment clears, which can be after this link expires; the pool page shows them as deposits in transit.",
      SELF_DIRECTED,
      ...(IS_MAINNET ? [] : ["Sepolia testnet: test USDC, no real-world effect."]),
    ],
    warnings,
    link: id => poolLink(pool, { action: "deposit", tick: tick.raw, amount: amountParam(amount) }, id),
  };
}

// --- withdraw_from_lending_pool ---

export const withdrawInput = {
  tick: tickInput,
  amountUsd: z.number().min(0.01).max(10_000_000).optional().describe("Amount to withdraw in US dollars (default: the whole position at the tick)"),
  pool: poolInput,
  wallet: walletInput,
};
export type WithdrawArgs = ArgsOf<typeof withdrawInput>;

export async function prepareWithdraw({ tick: tickArg, amountUsd, pool: poolArg, wallet: signer }: WithSigner<WithdrawArgs>): Promise<Prepared | Blocked> {
  const loaded = await loadPool(poolArg);
  if ("error" in loaded) return loaded;
  const { pool, nowSeconds } = loaded;
  const found = findTick(pool, tickArg);
  if ("error" in found) return found;
  const { tick } = found;
  const candidates = typeof signer === "string" ? [signer] : signer.own.map(w => w.address);
  const positions = new Map<string, Position>();
  let fromBlock: number;
  try {
    [fromBlock] = await Promise.all([getBlockNumber(), ...candidates.map(async address => positions.set(address.toLowerCase(), await readPosition(pool.address, address, tick.raw)))]);
  } catch (e) {
    return { error: `The position in the ${LENDING_POOL_NAME} could not be read right now: ${e instanceof Error ? e.message : String(e)}` };
  }
  const sharesOf = (address: string) => positions.get(address.toLowerCase())?.shares ?? 0n;
  const picked = pickSigner(signer, address => sharesOf(address) > 0n, `has a deposit at tick ${tick.raw}`, "a withdrawal comes from the wallet that deposited.");
  if ("error" in picked) return picked;
  const { wallet } = picked;
  const position = positions.get(wallet.toLowerCase()) ?? { shares: 0n, redemptionId: 0n };
  if (position.shares === 0n) {
    return { error: `Wallet ${shorten(wallet)} has no deposit at tick ${tick.raw} in the ${LENDING_POOL_NAME}.${position.redemptionId > 0n ? " Withdrawals it already requested and that are waiting in the queue are claimed on the pool page." : ""}` };
  }
  const value = sharesValue(tick, position.shares, nowSeconds);
  const wanted = amountUsd === undefined ? value : BigInt(Math.round(amountUsd * 100)) * 10n ** 16n;
  if (wanted > value + WHOLE_TOLERANCE) return { error: `${usd(amountUsd ?? 0)} is more than this wallet's position at the tick, about ${usd(floorCents(value))}.` };
  const whole = value - (wanted < value ? wanted : value) <= WHOLE_TOLERANCE;
  const amount = whole ? floorCents(value) : Math.round((amountUsd ?? 0) * 100) / 100;
  const expect = whole
    ? { minShares: position.shares.toString() }
    : sharesRange(sharesFor(tick, wanted, nowSeconds));
  const terms = choice(pool, tick);
  const available = BigInt(tick.available);
  const warnings: SignRequestWarning[] = [...picked.chosen];
  if (available >= (whole ? value : wanted)) {
    warnings.push({ level: "info", message: "The tick has enough funds not lent out to pay this withdrawal when it is signed, at the tick's cash price, which leaves out interest still accruing on open loans; the sign page shows the difference." });
  } else {
    warnings.push({ level: "warning", message: `The tick has about ${usd(floorCents(available))} not lent out. That part is paid when signed; the rest waits in the pool's withdrawal queue until loans are repaid and is claimed later from the pool page.` });
  }
  return {
    action: "withdraw_from_lending_pool",
    kind: "transaction",
    wallet,
    pool: { address: pool.address, tick: tick.raw, ltvPercent: terms.ltvPercent, maxLoanDays: terms.maxLoanDays, amountUsd: amount, wholePosition: whole, link: `${WEB_BASE}/pools/${NETWORK}/${pool.address}`, before: { shares: position.shares.toString(), redemptionId: position.redemptionId.toString() }, fromBlock, expect },
    summary: [
      `Withdraw ${whole ? `the whole position, about ${usd(amount)},` : usd(amount)} in USDC from the ${LENDING_POOL_NAME} on ${NETWORK_LABEL}, tick for ${describe(terms)}.`,
      `The position at this tick is worth about ${usd(floorCents(value))} now, including interest accrued on open loans; the sign page shows the live figure.`,
      "Signing sends an onchain transaction from this wallet that redeems deposit shares; the wallet pays the network fee. The USDC paid now comes to this wallet.",
      ...(IS_MAINNET ? [] : ["Sepolia testnet: test USDC, no real-world effect."]),
    ],
    warnings,
    link: id => poolLink(pool, { action: "withdraw", tick: tick.raw, amount: amountParam(amount), ...(whole ? { max: "1" } : {}) }, id),
  };
}

export const depositToPool = async (args: WithSigner<DepositArgs>) => issue(await prepareDeposit(args));
export const withdrawFromPool = async (args: WithSigner<WithdrawArgs>) => issue(await prepareWithdraw(args));

// --- results ---

const POOL_ACTIONS: ReadonlySet<SignRequest["action"]> = new Set(["deposit_to_lending_pool", "withdraw_from_lending_pool"]);

export function isPoolAction(record: SignRequest): boolean {
  return POOL_ACTIONS.has(record.action);
}

type PoolLog = { address: string; topics?: string[]; data?: string };

const dataWord = (data: string | undefined, index: number): bigint | null => {
  const hex = (data ?? "").replace(/^0x/, "").slice(index * 64, (index + 1) * 64);
  return hex.length === 64 ? BigInt(`0x${hex}`) : null;
};

/**
 * Whether a pool log is the operation this request prepared: the request's event, wallet and tick,
 * and for a deposit the same amount, for a withdrawal a new redemption of the expected shares.
 */
export function matchesPoolLog(record: SignRequest, log: PoolLog): boolean {
  const pool = record.pool;
  if (!pool || !same(log.address, pool.address)) return false;
  const deposit = record.action === "deposit_to_lending_pool";
  const topics = (log.topics ?? []).map(t => t.toLowerCase());
  if (topics[0] !== (deposit ? DEPOSITED_TOPIC : REDEEMED_TOPIC) || topics[1] !== addressTopic(record.wallet) || topics[2] !== tickTopic(pool.tick)) return false;
  if (deposit) {
    const amount = dataWord(log.data, 0);
    return amount !== null && (pool.expect.amounts ?? []).includes(amount.toString());
  }
  const redemptionId = topics[3] ? BigInt(topics[3]) : null;
  const shares = dataWord(log.data, 0);
  if (redemptionId === null || redemptionId < BigInt(pool.before.redemptionId) || shares === null) return false;
  if (pool.expect.minShares !== undefined && shares < BigInt(pool.expect.minShares)) return false;
  return pool.expect.maxShares === undefined || shares <= BigInt(pool.expect.maxShares);
}

/**
 * The transaction that did what the request prepared, if the pool has logged one in a block after
 * the head sampled when the request was made. Observation is not exclusive: a matching operation shows every request it matches as done.
 */
export async function observePool(record: SignRequest): Promise<string | null> {
  const pool = record.pool;
  if (!pool) return null;
  const topic0 = record.action === "deposit_to_lending_pool" ? DEPOSITED_TOPIC : REDEEMED_TOPIC;
  const logs = await getLogs(pool.address, [topic0, addressTopic(record.wallet), tickTopic(pool.tick)], pool.fromBlock + 1);
  return logs.find(log => matchesPoolLog(record, log))?.transactionHash ?? null;
}

/**
 * A deposit or withdraw result holds when the transaction succeeded, was sent by the request's wallet
 * in a block after the one sampled when the request was made, and the pool logged the operation the request prepared (see matchesPoolLog).
 */
export async function verifyPoolResult(record: SignRequest, transactionHash: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const pool = record.pool;
  if (!pool) return { ok: false, reason: "The sign request names no pool." };
  const [transaction, receipt] = await Promise.all([getTransaction(transactionHash), getTransactionReceipt(transactionHash)]);
  if (!transaction || receipt?.status !== "0x1" || !same(transaction.from, record.wallet)) return { ok: false, reason: "The transaction did not succeed, or was not sent by the request's wallet." };
  const minedBlock = Number.parseInt(receipt.blockNumber, 16);
  if (!Number.isSafeInteger(minedBlock) || minedBlock <= pool.fromBlock) return { ok: false, reason: "The transaction was mined before this sign request was made." };
  const logged = (receipt.logs ?? []).some(log => matchesPoolLog(record, log));
  return logged ? { ok: true } : { ok: false, reason: `The transaction did not ${record.action === "deposit_to_lending_pool" ? "deposit this amount" : "request this withdrawal"} at this tick from this wallet.` };
}

