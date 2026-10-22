import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoanContextLoan, LoanContextToken, SignContextToken } from "../types/index.js";
import { loan as networkLoan } from "./fixtures.js";

vi.mock("../clients/graphql.js", () => ({
  getSignContext: vi.fn(),
  getLoanContext: vi.fn(),
  getAllLoans: vi.fn(),
  isTokenNotFound: () => false,
}));
vi.mock("../clients/rpc.js", () => ({
  CHAIN_ID: 1,
  getTransaction: vi.fn(),
  getTransactionReceipt: vi.fn(),
  getBlockTimestamp: vi.fn(),
}));

import { getAllLoans, getLoanContext, getSignContext } from "../clients/graphql.js";
import { getBlockTimestamp, getTransaction, getTransactionReceipt } from "../clients/rpc.js";
import { borrowAgainstLand, closestDuration, getLoan, prepareBorrow, prepareRepay, repayLandLoan } from "../tools/loans.js";
import { getSignRequest, signPageView, verifyResult } from "../tools/sign-requests.js";
import { MemoryBackend, setSignRequestStore, SignRequestStore } from "../sign-requests/store.js";

const NOW = Date.parse("2026-10-22T00:00:00Z");
const OWNER = "0x2222222222222222222222222222222222222222";
const OTHER = "0x1111111111111111111111111111111111111111";
const TX = `0x${"c".repeat(64)}`;
const POOL = "0x842ffbf1ad5314503904626122376f71603a3cf9";
const DAY = 86_400;

function token(overrides: Partial<SignContextToken> = {}): SignContextToken {
  return {
    tokenId: "123",
    name: "1 Test Road",
    vanityName: null,
    propertyLink: "https://fabrica.land/property/ethereum/123",
    contractAddress: "0x5cbeb7A0df7Ed85D82a472FD56d81ed550f3Ea95",
    network: "ethereum",
    isPremint: false,
    claimState: null,
    supersededByTokenId: null,
    offRampStatus: null,
    isBurned: false,
    supply: "1",
    supplyUnderLoan: "0",
    estimatedValue: "10000",
    majorityOwnerAddress: OWNER,
    balances: [{ balance: "1", holder: { address: OWNER }, owner: { address: OWNER } }],
    marketplaceListings: [],
    marketplaceBids: [],
    ...overrides,
  };
}

function loan(overrides: Partial<LoanContextLoan> = {}): LoanContextLoan {
  return {
    loanId: "777",
    loanStatus: "Active",
    loanProvider: "PoolLending",
    loanType: "Prorated",
    loanContract: POOL,
    principalScaled: "500",
    maxRepaymentScaled: "520.5",
    livePayoffScaled: "505.25",
    payoffAsOf: "2026-10-22T00:00:00Z",
    currencySymbol: "USDC",
    aprPercent: 12.34,
    durationFormatted: "60 days",
    durationSeconds: String(60 * DAY),
    startTime: "2026-10-01T00:00:00Z",
    maturityDate: "2026-11-30T00:00:00Z",
    loanRepaidDate: null,
    loanLiquidationDate: null,
    borrower: { address: OWNER },
    lender: null,
    ...overrides,
  };
}

function context(overrides: Partial<LoanContextToken> = {}): LoanContextToken {
  return {
    tokenId: "123",
    name: "1 Test Road",
    vanityName: null,
    propertyLink: "https://fabrica.land/property/ethereum/123",
    contractAddress: "0x5cbeb7A0df7Ed85D82a472FD56d81ed550f3Ea95",
    poolLendingLiquidity: { appraisalBlockReason: null, maxPrincipalScaled: "1000", durations: [30 * DAY, 60 * DAY, 7 * DAY], activeLoan: null },
    loans: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.mocked(getSignContext).mockReset().mockResolvedValue(token());
  vi.mocked(getLoanContext).mockReset().mockResolvedValue(context());
  setSignRequestStore(new SignRequestStore(new MemoryBackend(), "test-secret"));
});
afterEach(() => {
  vi.useRealTimers();
  setSignRequestStore(undefined);
});

describe("closestDuration", () => {
  it("picks the offered length closest to the one asked for, ties to the shorter", () => {
    expect(closestDuration([7 * DAY, 30 * DAY, 60 * DAY], 45)).toBe(30);
    expect(closestDuration([7 * DAY, 30 * DAY, 60 * DAY], 50)).toBe(60);
    expect(closestDuration([], 30)).toBeNull();
  });
});

describe("borrow_against_land", () => {
  it("prepares a borrow sign request with the pool's closest length and a borrow link", async () => {
    const result = await borrowAgainstLand({ tokenId: "123", amountUsd: 400, durationDays: 45, wallet: OWNER });
    if (!("signRequest" in result)) throw new Error(JSON.stringify(result));
    const link = new URL(result.signRequest.signLink);
    expect(link.searchParams.get("action")).toBe("borrow");
    expect(link.searchParams.get("amount")).toBe("400");
    expect(link.searchParams.get("duration")).toBe("30");
    expect(link.searchParams.get("request")).toBe(result.signRequest.id);
    expect(result.signRequest.kind).toBe("transaction");
    expect(result.signRequest.summary.join(" ")).toMatch(/real obligation/);
    expect(result.signRequest.warnings.map(w => w.message).join(" ")).toMatch(/closest length it offers is 30 days/);
  });

  it("refuses an amount above the pool's maximum, a wallet that does not hold the token, and a token under loan", async () => {
    expect(await prepareBorrow({ tokenId: "123", amountUsd: 1500, wallet: OWNER })).toMatchObject({ error: expect.stringMatching(/above the \$1,000/) });
    expect(await prepareBorrow({ tokenId: "123", amountUsd: 100, wallet: OTHER })).toMatchObject({ error: expect.stringMatching(/does not hold/) });
    vi.mocked(getLoanContext).mockResolvedValue(context({ loans: [loan()] }));
    expect(await prepareBorrow({ tokenId: "123", amountUsd: 100, wallet: OWNER })).toMatchObject({ error: expect.stringMatching(/already backs an active loan; repay_land_loan/) });
  });

  it("refuses when the pool shows no capacity or blocks on tax status", async () => {
    vi.mocked(getLoanContext).mockResolvedValue(context({ poolLendingLiquidity: { appraisalBlockReason: null, maxPrincipalScaled: "0", durations: [], activeLoan: null } }));
    expect(await prepareBorrow({ tokenId: "123", amountUsd: 100, wallet: OWNER })).toMatchObject({ error: expect.stringMatching(/no borrowing capacity/) });
    vi.mocked(getLoanContext).mockResolvedValue(context({ poolLendingLiquidity: { appraisalBlockReason: "TAX_STATUS_UNKNOWN", maxPrincipalScaled: "0", durations: [], activeLoan: null } }));
    expect(await prepareBorrow({ tokenId: "123", amountUsd: 100, wallet: OWNER })).toMatchObject({ error: expect.stringMatching(/does not lend against this property/) });
  });

  it("checks the pool's maximum against the amount rounded to cents", async () => {
    vi.mocked(getLoanContext).mockResolvedValue(context({ poolLendingLiquidity: { appraisalBlockReason: null, maxPrincipalScaled: "1000.006", durations: [30 * DAY], activeLoan: null } }));
    expect(await prepareBorrow({ tokenId: "123", amountUsd: 1000.006, wallet: OWNER })).toMatchObject({ error: expect.stringMatching(/\$1,000\.01 is above/) });
  });

  it("serves the sign page the borrow action with amount and length, and completes once the loan appears", async () => {
    const result = await borrowAgainstLand({ tokenId: "123", amountUsd: 400, wallet: OWNER });
    if (!("signRequest" in result)) throw new Error(JSON.stringify(result));
    const pending = await getSignRequest({ id: result.signRequest.id });
    expect(pending).toMatchObject({ status: "pending" });
    const started = new Date(NOW + 60_000).toISOString();
    vi.mocked(getLoanContext).mockResolvedValue(context({ loans: [loan({ loanId: "900", startTime: started, principalScaled: "400", durationSeconds: String(30 * DAY) })] }));
    const done = await getSignRequest({ id: result.signRequest.id });
    expect(done).toMatchObject({ status: "completed", result: { loanId: "900" } });
  });

  it("does not take a new loan on other terms as the borrow", async () => {
    const result = await borrowAgainstLand({ tokenId: "123", amountUsd: 400, wallet: OWNER });
    if (!("signRequest" in result)) throw new Error(JSON.stringify(result));
    const startTime = new Date(NOW + 60_000).toISOString();
    vi.mocked(getLoanContext).mockResolvedValue(context({ loans: [
      loan({ loanId: "901", startTime, principalScaled: "500", durationSeconds: String(30 * DAY) }),
      loan({ loanId: "902", startTime, principalScaled: "400", durationSeconds: String(60 * DAY) }),
      loan({ loanId: "903", startTime, principalScaled: "400", durationSeconds: String(30 * DAY), loanProvider: "NFTfi" }),
    ] }));
    expect(await getSignRequest({ id: result.signRequest.id })).toMatchObject({ status: "pending" });
  });

  it("ties one loan to one request when two were made for the same terms", async () => {
    const first = await borrowAgainstLand({ tokenId: "123", amountUsd: 400, wallet: OWNER });
    const second = await borrowAgainstLand({ tokenId: "123", amountUsd: 400, wallet: OWNER });
    if (!("signRequest" in first) || !("signRequest" in second)) throw new Error("not issued");
    vi.mocked(getLoanContext).mockResolvedValue(context({ loans: [loan({ loanId: "900", startTime: new Date(NOW + 60_000).toISOString(), principalScaled: "400", durationSeconds: String(30 * DAY) })] }));
    expect(await getSignRequest({ id: first.signRequest.id })).toMatchObject({ status: "completed", result: { loanId: "900" } });
    expect(await getSignRequest({ id: second.signRequest.id })).toMatchObject({ status: "pending" });
    expect(await getSignRequest({ id: first.signRequest.id })).toMatchObject({ status: "completed" });
  });

  it("does not attribute a loan to a request whose link expired", async () => {
    const result = await borrowAgainstLand({ tokenId: "123", amountUsd: 400, wallet: OWNER });
    if (!("signRequest" in result)) throw new Error(JSON.stringify(result));
    vi.setSystemTime(NOW + 16 * 60_000);
    vi.mocked(getLoanContext).mockResolvedValue(context({ loans: [loan({ loanId: "900", startTime: new Date().toISOString(), principalScaled: "400", durationSeconds: String(30 * DAY) })] }));
    expect(await getSignRequest({ id: result.signRequest.id })).toMatchObject({ status: "expired" });
    expect(await getSignRequest({ id: result.signRequest.id })).not.toHaveProperty("result");
  });

  it("does not take an older loan by the same wallet as the borrow", async () => {
    const result = await borrowAgainstLand({ tokenId: "123", amountUsd: 400, wallet: OWNER });
    if (!("signRequest" in result)) throw new Error(JSON.stringify(result));
    vi.mocked(getLoanContext).mockResolvedValue(context({ loans: [loan({ startTime: "2026-10-01T00:00:00Z" })] }));
    expect(await getSignRequest({ id: result.signRequest.id })).toMatchObject({ status: "pending" });
  });
});

describe("repay_land_loan", () => {
  beforeEach(() => {
    vi.mocked(getLoanContext).mockResolvedValue(context({ loans: [loan()] }));
  });

  it("prepares paying off the active loan with today's payoff and a repay link", async () => {
    const result = await repayLandLoan({ tokenId: "123", wallet: OWNER });
    if (!("signRequest" in result)) throw new Error(JSON.stringify(result));
    const link = new URL(result.signRequest.signLink);
    expect(link.searchParams.get("action")).toBe("repay");
    expect(link.searchParams.get("loan")).toBe("777");
    expect(result.signRequest.summary[0]).toMatch(/\$505\.25 in USDC today/);
  });

  it("refuses a wallet that is not the borrower and a loan that is no longer open", async () => {
    expect(await prepareRepay({ tokenId: "123", wallet: OTHER })).toMatchObject({ error: expect.stringMatching(/only its borrower/) });
    vi.mocked(getLoanContext).mockResolvedValue(context({ loans: [loan({ loanStatus: "Repaid" })] }));
    expect(await prepareRepay({ tokenId: "123", loanId: "777", wallet: OWNER })).toMatchObject({ error: expect.stringMatching(/repaid, no longer open/) });
    expect(await prepareRepay({ tokenId: "123", wallet: OWNER })).toMatchObject({ error: expect.stringMatching(/no open loan/) });
  });

  it("still pays off a loan in default, before its auction", async () => {
    vi.mocked(getLoanContext).mockResolvedValue(context({ loans: [loan({ loanStatus: "Default", maturityDate: "2026-10-20T00:00:00Z" })] }));
    const prepared = await prepareRepay({ tokenId: "123", wallet: OWNER });
    if ("error" in prepared) throw new Error(prepared.error);
    expect(prepared.warnings.map(w => w.message).join(" ")).toMatch(/matured on 2026-10-20/);
    vi.mocked(getLoanContext).mockResolvedValue(context({ loans: [loan({ loanStatus: "Liquidating" })] }));
    expect(await prepareRepay({ tokenId: "123", loanId: "777", wallet: OWNER })).toMatchObject({ error: expect.stringMatching(/liquidating, no longer open/) });
  });

  it("warns when the loan is past maturity", async () => {
    vi.mocked(getLoanContext).mockResolvedValue(context({ loans: [loan({ maturityDate: "2026-10-20T00:00:00Z" })] }));
    const prepared = await prepareRepay({ tokenId: "123", wallet: OWNER });
    if ("error" in prepared) throw new Error(prepared.error);
    expect(prepared.warnings.map(w => w.message).join(" ")).toMatch(/matured on 2026-10-20/);
  });

  it("gives the sign page the loan id, and accepts a successful transaction from the borrower once the loan is repaid", async () => {
    const result = await repayLandLoan({ tokenId: "123", wallet: OWNER });
    if (!("signRequest" in result)) throw new Error(JSON.stringify(result));
    const { getSignRequestStore } = await import("../sign-requests/store.js");
    const record = await getSignRequestStore()?.get(result.signRequest.id);
    if (!record) throw new Error("not stored");
    expect(signPageView(record)).toMatchObject({ action: "repay", params: { loanId: "777" } });
    vi.mocked(getTransaction).mockResolvedValue({ hash: TX, from: OWNER, to: POOL, blockNumber: "0x1", value: "0x0" });
    vi.mocked(getTransactionReceipt).mockResolvedValue({ status: "0x1", blockNumber: "0x1", gasUsed: "0x1" });
    vi.mocked(getBlockTimestamp).mockResolvedValue(NOW + 60_000);
    expect(await verifyResult(record, { transactionHash: TX })).toMatchObject({ ok: false });
    vi.mocked(getLoanContext).mockResolvedValue(context({ loans: [loan({ loanStatus: "Repaid" })] }));
    expect(await verifyResult(record, { transactionHash: TX })).toEqual({ ok: true, loanId: "777" });
    expect(await verifyResult(record, { orderHash: TX })).toMatchObject({ ok: false });
  });

  it("refuses a transaction mined before the request, or one that never touched the loan's contract", async () => {
    const result = await repayLandLoan({ tokenId: "123", wallet: OWNER });
    if (!("signRequest" in result)) throw new Error(JSON.stringify(result));
    const { getSignRequestStore } = await import("../sign-requests/store.js");
    const record = await getSignRequestStore()?.get(result.signRequest.id);
    if (!record) throw new Error("not stored");
    vi.mocked(getLoanContext).mockResolvedValue(context({ loans: [loan({ loanStatus: "Repaid" })] }));
    vi.mocked(getTransactionReceipt).mockResolvedValue({ status: "0x1", blockNumber: "0x1", gasUsed: "0x1" });
    vi.mocked(getTransaction).mockResolvedValue({ hash: TX, from: OWNER, to: POOL, blockNumber: "0x1", value: "0x0" });
    vi.mocked(getBlockTimestamp).mockResolvedValue(NOW - DAY * 1000);
    expect(await verifyResult(record, { transactionHash: TX })).toMatchObject({ ok: false, reason: expect.stringMatching(/before this sign request/) });
    vi.mocked(getBlockTimestamp).mockResolvedValue(NOW + 60_000);
    vi.mocked(getTransaction).mockResolvedValue({ hash: TX, from: OWNER, to: OTHER, blockNumber: "0x1", value: "0x0" });
    expect(await verifyResult(record, { transactionHash: TX })).toMatchObject({ ok: false, reason: expect.stringMatching(/loan's contract/) });
    vi.mocked(getTransactionReceipt).mockResolvedValue({ status: "0x1", blockNumber: "0x1", gasUsed: "0x1", logs: [{ address: POOL.toUpperCase().replace("0X", "0x") }] });
    expect(await verifyResult(record, { transactionHash: TX })).toEqual({ ok: true, loanId: "777" });
  });
});

describe("get_land_loan", () => {
  it("returns the property's active loan with the payoff today and lists the others", async () => {
    vi.mocked(getLoanContext).mockResolvedValue(context({ loans: [loan({ loanId: "1", loanStatus: "Repaid", startTime: "2026-01-01T00:00:00Z" }), loan()] }));
    const result = await getLoan({ tokenId: "123" });
    expect(result).toMatchObject({ loan: { loanId: "777", status: "Active", payoffToday: "505.25 USDC", apr: "12.3%", borrower: "0x2222...2222" }, otherLoans: [{ loanId: "1" }] });
  });

  it("finds a loan by id across the network", async () => {
    vi.mocked(getAllLoans).mockResolvedValue([networkLoan({ loanId: "777", collateralId: "123" })]);
    vi.mocked(getLoanContext).mockResolvedValue(context({ loans: [loan()] }));
    expect(await getLoan({ loanId: "777" })).toMatchObject({ property: { tokenId: "123" }, loan: { loanId: "777" } });
    expect(vi.mocked(getLoanContext)).toHaveBeenCalledWith({ tokenId: "123", slug: undefined });
    expect(await getLoan({ loanId: "999" })).toMatchObject({ error: expect.stringMatching(/No loan 999/) });
  });

  it("needs a property or a loan id", async () => {
    expect(await getLoan({})).toMatchObject({ error: expect.stringMatching(/required/) });
  });
});
