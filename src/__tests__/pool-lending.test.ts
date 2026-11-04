import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../clients/graphql.js", () => ({
  getSignContext: vi.fn(),
  getLoanContext: vi.fn(),
  getDepositPoolsWithTime: vi.fn(),
  isTokenNotFound: () => false,
}));
vi.mock("../clients/rpc.js", () => ({
  CHAIN_ID: 11155111,
  ethCall: vi.fn(),
  getTransaction: vi.fn(),
  getTransactionReceipt: vi.fn(),
  getBlockTimestamp: vi.fn(),
  getBlockNumber: vi.fn(),
  getLogs: vi.fn(),
}));

import { getDepositPoolsWithTime } from "../clients/graphql.js";
import type { AccountWallet } from "../clients/account.js";
import { ethCall, getBlockNumber, getLogs, getTransaction, getTransactionReceipt } from "../clients/rpc.js";
import { NETWORK } from "../config.js";
import { MemoryBackend, setSignRequestStore, SignRequestStore } from "../sign-requests/store.js";
import { decodeTick, depositToPool, prepareDeposit, prepareWithdraw, sharesValue, withdrawFromPool } from "../tools/pool-lending.js";
import { getSignRequest, signPageView, verifyResult } from "../tools/sign-requests.js";

const E18 = 10n ** 18n;
const NOW = Date.parse("2026-11-03T00:00:00Z");
const NOW_S = NOW / 1000;
const POOL = "0x842ffbf1ad5314503904626122376f71603a3cf9";
const ME = "0x2222222222222222222222222222222222222222";
const OTHER = "0x1111111111111111111111111111111111111111";
const TX = `0x${"c".repeat(64)}`;
/** 50% loan-to-value (ratio limit 5000 bps), duration index 1, rate index 0. */
const TICK_50 = String((5000n << 8n) | (1n << 5n) | 1n);
/** 30% loan-to-value, duration index 0. */
const TICK_30 = String((3000n << 8n) | 1n);
const DEPOSITED = "0xd3d9500b000f4b80b8f9aea0e7ce7d135560d7775a63356999a9f3efd4f5edf8";
const REDEEMED = "0x3ac2f453c81511b46084827fa6798fc6c8f7da31176e5be199525d49e59c7675";

const OWN: AccountWallet[] = [{ address: ME, kind: "embedded" }, { address: OTHER, kind: "external" }];
const USDC = 10n ** 6n;

const word = (v: bigint | string) => (typeof v === "string" ? v.toLowerCase().replace(/^0x/, "") : v.toString(16)).padStart(64, "0");

/** A pool log for ME at a tick: Deposited(amount, shares) or Redeemed(redemptionId; shares). */
function poolLog(kind: "deposit" | "redeem", tickRaw: string, values: { amount?: bigint; shares: bigint; redemptionId?: bigint }, hash = TX) {
  const topics = [kind === "deposit" ? DEPOSITED : REDEEMED, `0x${word(ME)}`, `0x${word(BigInt(tickRaw))}`, ...(kind === "redeem" ? [`0x${word(values.redemptionId ?? 0n)}`] : [])];
  const data = kind === "deposit" ? `0x${word(values.amount ?? 0n)}${word(values.shares)}` : `0x${word(values.shares)}`;
  return { address: POOL, topics, data, transactionHash: hash };
}

function tick(raw: string, overrides: Record<string, unknown> = {}) {
  return { raw, value: String(1000n * E18), shares: String(1000n * E18), available: String(400n * E18), redemptionPending: "0", accrued: null, accrualRate: null, accrualTimestamp: null, ...overrides };
}

function pools(ticks = [tick(TICK_50), tick(TICK_30)]) {
  return { pools: [{ address: POOL, currencyToken: { symbol: "USDC", decimals: 6 }, durations: [15 * 86_400, 30 * 86_400], ticks }], blockTimestamp: NOW_S };
}

/** deposits(account, tick) answers, per wallet. */
function positions(byWallet: Record<string, [bigint, bigint]>) {
  vi.mocked(ethCall).mockImplementation(async (_to, data) => {
    const wallet = `0x${data.slice(10 + 24, 10 + 64)}`;
    const [shares, redemptionId] = byWallet[wallet.toLowerCase()] ?? [0n, 0n];
    return `0x${word(shares)}${word(redemptionId)}`;
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  vi.mocked(getDepositPoolsWithTime).mockReset().mockResolvedValue(pools());
  positions({});
  vi.mocked(getBlockNumber).mockReset().mockResolvedValue(100);
  vi.mocked(getLogs).mockReset().mockResolvedValue([]);
  setSignRequestStore(new SignRequestStore(new MemoryBackend(), "test-secret"));
});
afterEach(() => {
  vi.useRealTimers();
  setSignRequestStore(undefined);
});

describe("tick math", () => {
  it("decodes a ratio tick's loan-to-value and duration index", () => {
    expect(decodeTick(TICK_50)).toEqual({ ltvPercent: 50, fixedLimitUsd: null, durationIndex: 1 });
    // A fixed limit is a dollar amount in the pool's 18-decimal scale.
    expect(decodeTick(String(((25_000n * E18) << 8n) | 0n))).toEqual({ ltvPercent: null, fixedLimitUsd: 25_000, durationIndex: 0 });
    expect(decodeTick("not a tick")).toBeNull();
  });
  it("values shares at (value + accrued) / shares, projecting accrual to now", () => {
    const t = tick(TICK_50, { value: String(1000n * E18), shares: String(500n * E18), accrued: String(10n * E18), accrualRate: String(E18), accrualTimestamp: NOW_S - 10 });
    expect(sharesValue(t, 50n * E18, NOW_S)).toBe(102n * E18);
  });
});

describe("deposit_to_lending_pool", () => {
  it("lists the open ticks when tick is left out and several are open", async () => {
    const result = await prepareDeposit({ amountUsd: 100, wallet: ME });
    expect(result).toMatchObject({ ticks: [{ tick: TICK_30, ltvPercent: 30, maxLoanDays: 15 }, { tick: TICK_50, ltvPercent: 50, maxLoanDays: 30 }] });
    expect("error" in result && result.error).toMatch(/2 ticks/);
  });

  it("leaves a malformed tick out instead of failing the whole pool", async () => {
    vi.mocked(getDepositPoolsWithTime).mockResolvedValue(pools([tick(TICK_50), tick("0x1f"), tick(TICK_30)]));
    const result = await prepareDeposit({ amountUsd: 100, wallet: ME });
    expect(result).toMatchObject({ ticks: [{ tick: TICK_30 }, { tick: TICK_50 }] });
    expect("ticks" in result && result.ticks).toHaveLength(2);
  });

  it("prepares a deposit with the pool page link, the terms and the risk, and no rate", async () => {
    positions({ [ME]: [0n, 0n] });
    const result = await depositToPool({ amountUsd: 250.5, tick: TICK_50, wallet: ME });
    if (!("signRequest" in result)) throw new Error(JSON.stringify(result));
    const link = new URL(result.signRequest.signLink);
    expect(link.pathname).toBe(`/pools/${NETWORK}/${POOL}`);
    expect(Object.fromEntries(link.searchParams)).toMatchObject({ action: "deposit", tick: TICK_50, amount: "250.50", request: result.signRequest.id });
    const text = result.signRequest.summary.join(" ");
    expect(text).toContain("$250.5");
    expect(text).toContain("up to 50% of a property's value, up to 30 days");
    expect(text).toMatch(/variable and not guaranteed/);
    expect(text).toMatch(/at risk/);
    expect(text).not.toMatch(/APR|APY|yield/i);
  });

  it("refuses a tick that is not open", async () => {
    const result = await prepareDeposit({ amountUsd: 100, tick: "999", wallet: ME });
    expect("error" in result && result.error).toMatch(/No open tick 999/);
  });

  it("asks which wallet when the connected account has several", async () => {
    const result = await prepareDeposit({ amountUsd: 100, tick: TICK_50, wallet: { own: OWN } });
    expect(result).toMatchObject({ accountWallets: [ME, OTHER] });
  });
});

describe("withdraw_from_lending_pool", () => {
  it("withdraws the whole position by default, paid when signed when the tick has the funds", async () => {
    positions({ [ME]: [100n * E18, 2n] });
    const result = await prepareWithdraw({ tick: TICK_50, wallet: ME });
    if ("error" in result) throw new Error(result.error);
    expect(result.pool).toMatchObject({ amountUsd: 100, wholePosition: true, before: { shares: String(100n * E18), redemptionId: "2" } });
    expect(result.warnings.map(w => w.message).join(" ")).toMatch(/enough funds not lent out/);
    expect(new URL(result.link("sr_x")).searchParams.get("amount")).toBe("100");
    expect(new URL(result.link("sr_x")).searchParams.get("max")).toBe("1");
  });

  it("rounds the whole position down to the cent without losing one to floating point", async () => {
    positions({ [ME]: [113n * 10n ** 16n, 0n] });
    const result = await prepareWithdraw({ tick: TICK_50, wallet: ME });
    if ("error" in result) throw new Error(result.error);
    expect(result.pool).toMatchObject({ amountUsd: 1.13, wholePosition: true });
  });

  it("warns that the part above the tick's free funds waits in the queue", async () => {
    vi.mocked(getDepositPoolsWithTime).mockResolvedValue(pools([tick(TICK_50, { available: String(30n * E18) })]));
    positions({ [ME]: [100n * E18, 0n] });
    const result = await prepareWithdraw({ tick: TICK_50, amountUsd: 60, wallet: ME });
    if ("error" in result) throw new Error(result.error);
    expect(result.pool).toMatchObject({ amountUsd: 60, wholePosition: false });
    expect(result.warnings).toContainEqual(expect.objectContaining({ level: "warning", message: expect.stringMatching(/\$30 not lent out.*withdrawal queue/) }));
  });

  it("refuses more than the position, and a wallet with no deposit", async () => {
    positions({ [ME]: [100n * E18, 0n] });
    expect(await prepareWithdraw({ tick: TICK_50, amountUsd: 150, wallet: ME })).toMatchObject({ error: expect.stringMatching(/more than this wallet's position/) });
    expect(await prepareWithdraw({ tick: TICK_50, wallet: OTHER })).toMatchObject({ error: expect.stringMatching(/no deposit at tick/) });
  });

  it("picks the connected account's wallet that holds the deposit", async () => {
    positions({ [OTHER]: [10n * E18, 0n] });
    const result = await prepareWithdraw({ tick: TICK_50, wallet: { own: OWN } });
    if ("error" in result) throw new Error(result.error);
    expect(result.wallet).toBe(OTHER);
  });
});

describe("pool sign requests: status and the sign page", () => {
  it("completes a deposit when the pool logs this wallet depositing this amount at this tick", async () => {
    const prepared = await depositToPool({ amountUsd: 100, tick: TICK_50, wallet: ME });
    if (!("signRequest" in prepared)) throw new Error(JSON.stringify(prepared));
    const id = prepared.signRequest.id;
    expect(await getSignRequest({ id })).toMatchObject({ status: "pending", pool: { address: POOL, tick: TICK_50 } });
    vi.mocked(getLogs).mockResolvedValue([poolLog("deposit", TICK_50, { amount: 40n * USDC, shares: 40n * E18 })]);
    expect(await getSignRequest({ id })).toMatchObject({ status: "pending" });
    vi.mocked(getLogs).mockResolvedValue([poolLog("deposit", TICK_50, { amount: 100n * USDC, shares: 100n * E18 })]);
    expect(await getSignRequest({ id })).toMatchObject({ status: "completed" });
    expect(vi.mocked(getLogs)).toHaveBeenCalledWith(POOL, [DEPOSITED, `0x${word(ME)}`, `0x${word(BigInt(TICK_50))}`], 101);
  });

  it("does not let one request's polling hold back another request that the same deposit matches", async () => {
    const first = await depositToPool({ amountUsd: 100, tick: TICK_50, wallet: ME });
    const second = await depositToPool({ amountUsd: 100, tick: TICK_50, wallet: ME });
    if (!("signRequest" in first) || !("signRequest" in second)) throw new Error("not issued");
    vi.mocked(getLogs).mockResolvedValue([poolLog("deposit", TICK_50, { amount: 100n * USDC, shares: 100n * E18 })]);
    expect(await getSignRequest({ id: first.signRequest.id })).toMatchObject({ status: "completed" });
    expect(await getSignRequest({ id: second.signRequest.id })).toMatchObject({ status: "completed" });
  });

  it("completes a whole-position withdrawal only on a new redemption of all its shares", async () => {
    positions({ [ME]: [100n * E18, 3n] });
    const prepared = await withdrawFromPool({ tick: TICK_50, wallet: ME });
    if (!("signRequest" in prepared)) throw new Error(JSON.stringify(prepared));
    const id = prepared.signRequest.id;
    vi.mocked(getLogs).mockResolvedValue([poolLog("redeem", TICK_50, { shares: 100n * E18, redemptionId: 2n }), poolLog("redeem", TICK_50, { shares: 10n * E18, redemptionId: 3n })]);
    expect(await getSignRequest({ id })).toMatchObject({ status: "pending" });
    vi.mocked(getLogs).mockResolvedValue([poolLog("redeem", TICK_50, { shares: 100n * E18, redemptionId: 3n })]);
    expect(await getSignRequest({ id })).toMatchObject({ status: "completed" });
  });

  it("completes a partial withdrawal on redeemed shares close to the estimate", async () => {
    positions({ [ME]: [100n * E18, 0n] });
    const prepared = await withdrawFromPool({ tick: TICK_50, amountUsd: 40, wallet: ME });
    if (!("signRequest" in prepared)) throw new Error(JSON.stringify(prepared));
    const id = prepared.signRequest.id;
    vi.mocked(getLogs).mockResolvedValue([poolLog("redeem", TICK_50, { shares: 20n * E18, redemptionId: 0n })]);
    expect(await getSignRequest({ id })).toMatchObject({ status: "pending" });
    vi.mocked(getLogs).mockResolvedValue([poolLog("redeem", TICK_50, { shares: 40n * E18 + 1n, redemptionId: 0n })]);
    expect(await getSignRequest({ id })).toMatchObject({ status: "completed" });
  });

  it("shapes the sign page view without a token id", async () => {
    positions({ [ME]: [100n * E18, 0n] });
    const prepared = await prepareWithdraw({ tick: TICK_50, amountUsd: 40, wallet: ME });
    if ("error" in prepared) throw new Error(prepared.error);
    const record = { ...prepared, id: "sr_aaaaaaaaaaaaaaaaaaaaaa", status: "pending" as const, network: "sepolia" as const, chainId: 11155111, signLink: prepared.link("sr_aaaaaaaaaaaaaaaaaaaaaa"), payload: null, createdAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 900_000).toISOString() };
    const { link: _link, ...stored } = record;
    const view = signPageView(stored);
    expect(view).toMatchObject({ action: "withdraw", tool: "withdraw_from_lending_pool", poolAddress: POOL, maker: ME, params: { tick: TICK_50, amountUsd: 40, wholePosition: false } });
    expect(view).not.toHaveProperty("tokenId");
  });

  it("accepts a reported transaction only when the pool logged this wallet's deposit of this amount at this tick", async () => {
    positions({ [ME]: [0n, 0n] });
    const prepared = await prepareDeposit({ amountUsd: 100, tick: TICK_50, wallet: ME });
    if ("error" in prepared) throw new Error(prepared.error);
    const { link: _link, ...rest } = prepared;
    const record = { ...rest, id: "sr_aaaaaaaaaaaaaaaaaaaaaa", status: "pending" as const, network: "sepolia" as const, chainId: 11155111, signLink: "x", payload: null, createdAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 900_000).toISOString() };
    vi.mocked(getTransaction).mockResolvedValue({ hash: TX, from: ME, to: POOL, value: "0x0", blockNumber: "0x65" });
    const receipt = (log: ReturnType<typeof poolLog>, blockNumber = "0x65") => ({ status: "0x1", blockNumber, gasUsed: "0x1", logs: [log] });
    vi.mocked(getTransactionReceipt).mockResolvedValue(receipt(poolLog("deposit", TICK_50, { amount: 100n * USDC, shares: 100n * E18 })));
    expect(await verifyResult(record, { transactionHash: TX })).toEqual({ ok: true });
    // The pool's 18-decimal scale counts as the same amount.
    vi.mocked(getTransactionReceipt).mockResolvedValue(receipt(poolLog("deposit", TICK_50, { amount: 100n * E18, shares: 100n * E18 })));
    expect(await verifyResult(record, { transactionHash: TX })).toEqual({ ok: true });
    vi.mocked(getTransactionReceipt).mockResolvedValue(receipt(poolLog("deposit", TICK_50, { amount: 1n * USDC, shares: E18 })));
    expect(await verifyResult(record, { transactionHash: TX })).toMatchObject({ ok: false });
    vi.mocked(getTransactionReceipt).mockResolvedValue(receipt(poolLog("deposit", TICK_30, { amount: 100n * USDC, shares: 100n * E18 })));
    expect(await verifyResult(record, { transactionHash: TX })).toMatchObject({ ok: false });
    vi.mocked(getTransactionReceipt).mockResolvedValue(receipt(poolLog("redeem", TICK_50, { shares: 100n * E18 })));
    expect(await verifyResult(record, { transactionHash: TX })).toMatchObject({ ok: false });
    // Mined in the block sampled when the request was made (100), or earlier: not this request's transaction.
    vi.mocked(getTransactionReceipt).mockResolvedValue(receipt(poolLog("deposit", TICK_50, { amount: 100n * USDC, shares: 100n * E18 }), "0x64"));
    expect(await verifyResult(record, { transactionHash: TX })).toMatchObject({ ok: false });
  });
});
