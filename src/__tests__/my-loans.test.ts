import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../clients/graphql.js", () => ({ getWalletLoans: vi.fn(), getWallet: vi.fn(), getDepositPools: vi.fn(), getPoolDeposits: vi.fn() }));
vi.mock("../clients/account.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../clients/account.js")>();
  return { ...actual, getAccountProfile: vi.fn() };
});

import { getDepositPools, getPoolDeposits, getWallet, getWalletLoans } from "../clients/graphql.js";
import { getAccountProfile } from "../clients/account.js";
import { getMyLoans } from "../tools/my-loans.js";
import type { AccountAuth } from "../auth/token.js";
import type { WalletLoan } from "../types/index.js";
import { wallet, walletCreditHistory } from "./fixtures.js";

const NOW = new Date("2026-10-24T12:00:00Z");
const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const POOL = "0x1111111111111111111111111111111111111111";
const E18 = 10n ** 18n;

function auth(scopes: string[] = ["portfolio:read"]): AccountAuth {
  return { token: "t", subject: "s", clientId: "c", scopes, expiresAt: 4102444800 };
}

function loan(overrides: Partial<WalletLoan>): WalletLoan {
  return {
    loanId: "L1", loanStatus: "Active", loanProvider: "PoolLending", principalScaled: "5000", maxRepaymentScaled: "5200", livePayoffScaled: "5050.5",
    payoffAsOf: "2026-10-24T11:59:00Z", currencySymbol: "USDC", aprPercent: 12, durationFormatted: "30 days", startTime: "2026-10-01T00:00:00Z",
    maturityDate: "2026-10-31T00:00:00Z", loanRepaidDate: null, loanLiquidationDate: null, collateralId: "7",
    borrower: { address: ME }, lender: { address: POOL }, token: { tokenId: "7", name: "My lot", vanityName: null, propertyLink: "https://fabrica.land/property/ethereum/7" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(getAccountProfile).mockReset().mockResolvedValue({ email: null, kycStatus: null, wallets: [{ address: ME, kind: "embedded" }] });
  vi.mocked(getWalletLoans).mockReset().mockResolvedValue({
    address: ME,
    loansTaken: [loan({ loanId: "old", loanStatus: "Repaid", loanRepaidDate: "2026-05-01T00:00:00Z", startTime: "2026-04-01T00:00:00Z" }), loan({})],
    loansMade: [],
  });
  vi.mocked(getWallet).mockReset().mockResolvedValue(wallet({ creditHistory: walletCreditHistory() }));
  vi.mocked(getDepositPools).mockReset().mockResolvedValue([
    { address: POOL, currencyToken: { symbol: "USDC", decimals: 6 }, ticks: [{ raw: "42", value: String(1100n * E18), shares: String(1000n * E18), redemptionPending: "0" }] },
  ]);
  vi.mocked(getPoolDeposits).mockReset().mockResolvedValue([
    { id: "0xd", tickRaw: "42", shares: String(100n * E18), depositedAmount: String(100n * E18), redemptions: [{ redemptionId: "1", shares: String(10n * E18) }] },
  ]);
});
afterEach(() => vi.useRealTimers());

describe("get_my_loans", () => {
  it("shows a borrower's active loan first with maturity and payoff, and a depositor's position", async () => {
    const result = await getMyLoans(auth());
    expect(result.error).toBeUndefined();
    expect(result.taken.map((row) => row.loanId)).toEqual(["L1", "old"]);
    expect(result.taken[0]).toMatchObject({
      daysToMaturity: 6, maturingSoon: true, payoffToday: "5,050.5 USDC", payoffAsOf: "2026-10-24T11:59:00Z", apr: "12.0%",
      links: { property: "https://fabrica.land/property/ethereum/7" },
    });
    expect(result.taken[1].payoffToday).toBeUndefined();
    expect(result.deposits).toEqual([{ pool: "DeFi lending pool", positionValue: "$110", deposited: "$100", pendingRedemption: "$11", links: { pool: expect.stringContaining(`/pools/`) } }]);
    expect(result.totals).toEqual({ activeTaken: 1, maturingSoon: 1, activeMade: 0, deposits: 1 });
    expect(result.notes.join(" ")).toContain("maturingSoon");
  });

  it("treats a defaulted loan before its auction as open, with its payoff", async () => {
    vi.mocked(getWalletLoans).mockResolvedValue({
      address: ME,
      loansTaken: [loan({ loanId: "old", loanStatus: "Repaid", loanRepaidDate: "2026-05-01T00:00:00Z", startTime: "2026-10-10T00:00:00Z" }), loan({ loanId: "D", loanStatus: "Default", maturityDate: "2026-10-22T00:00:00Z" })],
      loansMade: [],
    });
    const result = await getMyLoans(auth());
    expect(result.taken.map((row) => row.loanId)).toEqual(["D", "old"]);
    expect(result.taken[0]).toMatchObject({ daysToMaturity: -3, payoffToday: "5,050.5 USDC" });
    expect(result.totals.activeTaken).toBe(1);
    expect(result.notes.join(" ")).toContain("can still be paid off");
  });

  it("still answers with loans when the pool read fails", async () => {
    vi.mocked(getDepositPools).mockRejectedValue(new Error("indexer down"));
    const result = await getMyLoans(auth());
    expect(result.taken).toHaveLength(2);
    expect(result.deposits).toEqual([]);
    expect(result.notes[0]).toContain("could not be read");
  });

  it("needs portfolio:read", async () => {
    const result = await getMyLoans(auth(["onramp:read"]));
    expect(result.notes[0]).toContain("portfolio:read");
    expect(vi.mocked(getWalletLoans)).not.toHaveBeenCalled();
  });
});
