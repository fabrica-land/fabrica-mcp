import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoanContextLoan, LoanContextToken, SignContextOrder, SignContextToken } from "../types/index.js";

vi.mock("../clients/graphql.js", () => {
  class FabricaApiError extends Error {
    readonly graphQLErrors: readonly string[];
    constructor(messages: readonly string[]) {
      super(messages.join("; "));
      this.graphQLErrors = messages;
    }
  }
  return {
    FabricaApiError,
    getSignContext: vi.fn(),
    getLoanContext: vi.fn(),
    getAllLoans: vi.fn(),
    isTokenNotFound: (e: unknown) => e instanceof FabricaApiError && e.graphQLErrors.some(m => m.includes("No token or premint found")),
  };
});
vi.mock("../clients/rpc.js", () => ({
  CHAIN_ID: 1,
  getTransaction: vi.fn(),
  getTransactionReceipt: vi.fn(),
  getBlockTimestamp: vi.fn(),
}));
vi.mock("../clients/account.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../clients/account.js")>();
  return { ...actual, getAccountProfile: vi.fn() };
});

import { FabricaApiError, getLoanContext, getSignContext } from "../clients/graphql.js";
import { getAccountProfile, type AccountWallet } from "../clients/account.js";
import type { AccountAuth } from "../auth/token.js";
import { pickSigner, prepareAccept, prepareBuy, prepareCancel, prepareListing, prepareOffer } from "../tools/sign-requests.js";
import { prepareBorrow, prepareRepay } from "../tools/loans.js";
import { signerFor } from "../tools/own-wallet.js";
import { PERSONALIZED_NOTE, readAsViewer } from "../tools/personal-view.js";

const EMBEDDED = "0x1111111111111111111111111111111111111111";
const LINKED = "0x2222222222222222222222222222222222222222";
const STRANGER = "0x3333333333333333333333333333333333333333";
const HASH = `0x${"a".repeat(64)}`;
const NOW = Date.parse("2026-11-01T00:00:00Z");
const DAY = 86_400;

const OWN: AccountWallet[] = [{ address: EMBEDDED, kind: "embedded" }, { address: LINKED, kind: "external" }];

function auth(scopes: string[] = ["portfolio:read"]): AccountAuth {
  return { token: "t", subject: "s", clientId: "c", scopes, expiresAt: 4102444800 };
}

function order(overrides: Partial<SignContextOrder> = {}): SignContextOrder {
  return {
    marketplaceId: HASH, side: "buy", status: "active", price: "10000000000", usdPrice: "10000.00", symbol: "USDC", decimals: 6, feeBps: "100", supply: "1",
    startTime: "2026-10-10T00:00:00Z", endTime: "2026-11-20T00:00:00Z", makerAddress: STRANGER, maker: { user: { displayName: "" } },
    restrictedToAddresses: null, disclosurePackage: null, encumbrance: null, matchTransactionHash: null, ...overrides,
  };
}

function token(holder: string, overrides: Partial<SignContextToken> = {}): SignContextToken {
  return {
    tokenId: "123", name: "1 Test Road", vanityName: null, propertyLink: "https://fabrica.land/property/ethereum/123",
    contractAddress: "0x5cbeb7A0df7Ed85D82a472FD56d81ed550f3Ea95", network: "ethereum", isPremint: false, claimState: null,
    supersededByTokenId: null, offRampStatus: null, isBurned: false, supply: "1", supplyUnderLoan: "0", operatingAgreementName: "Trust v4.3", configurationUrl: "ipfs://QmConfigBefore", configuration: { userDescription: "Old text", media: [{ source: "ipfs://QmPhoto" }] }, estimatedValue: "10000",
    majorityOwnerAddress: holder, balances: [{ balance: "1", holder: { address: holder }, owner: { address: holder } }],
    marketplaceListings: [], marketplaceBids: [], ...overrides,
  };
}

function loan(borrower: string): LoanContextLoan {
  return {
    loanId: "777", loanStatus: "Active", loanProvider: "PoolLending", loanType: "Prorated", loanContract: STRANGER, principalScaled: "500",
    maxRepaymentScaled: "520.5", livePayoffScaled: "505.25", payoffAsOf: "2026-11-01T00:00:00Z", currencySymbol: "USDC", aprPercent: 12,
    durationFormatted: "60 days", durationSeconds: String(60 * DAY), startTime: "2026-10-01T00:00:00Z", maturityDate: "2026-11-30T00:00:00Z",
    loanRepaidDate: null, loanLiquidationDate: null, borrower: { address: borrower }, lender: null,
  };
}

function context(overrides: Partial<LoanContextToken> = {}): LoanContextToken {
  return {
    tokenId: "123", name: "1 Test Road", vanityName: null, propertyLink: "https://fabrica.land/property/ethereum/123",
    contractAddress: "0x5cbeb7A0df7Ed85D82a472FD56d81ed550f3Ea95",
    poolLendingLiquidity: { appraisalBlockReason: null, maxPrincipalScaled: "1000", durations: [30 * DAY], activeLoan: null },
    loans: [], ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.mocked(getSignContext).mockReset();
  vi.mocked(getLoanContext).mockReset().mockResolvedValue(context());
  vi.mocked(getAccountProfile).mockReset().mockResolvedValue({ email: null, kycStatus: null, wallets: [{ address: LINKED, kind: "external" }, { address: EMBEDDED, kind: "embedded" }, { address: EMBEDDED.toUpperCase().replace("0X", "0x"), kind: "embedded" }] });
});
afterEach(() => vi.useRealTimers());

describe("pickSigner", () => {
  it("uses a given address as is, with no note", () => {
    expect(pickSigner(STRANGER, () => false, "holds it", "no.")).toEqual({ wallet: STRANGER, chosen: [] });
  });

  it("picks the one account wallet that fits and says which", () => {
    const picked = pickSigner({ own: OWN }, a => a === LINKED, "holds it", "no.");
    expect(picked).toMatchObject({ wallet: LINKED, chosen: [{ level: "info", message: expect.stringContaining("the one that holds it") }] });
  });

  it("blocks when none fits and lists them when several do", () => {
    expect(pickSigner({ own: OWN }, () => false, "holds it", "only its owner can list it.")).toMatchObject({ error: expect.stringMatching(/None of the 2 wallets .* holds it; only its owner can list it\./), accountWallets: [EMBEDDED, LINKED] });
    expect(pickSigner({ own: OWN }, () => true, "holds it", "no.")).toMatchObject({ error: expect.stringContaining("The call runs once wallet names one of them"), accountWallets: [EMBEDDED, LINKED] });
  });
});

describe("sign requests from the connected account's wallets", () => {
  it("lists from the wallet that holds the property", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token(LINKED));
    const prepared = await prepareListing({ tokenId: "123", priceUsd: 12000, wallet: { own: OWN } });
    expect(prepared).toMatchObject({ wallet: LINKED, warnings: expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining(LINKED) })]) });
  });

  it("accepts and borrows from the holder, and blocks when no account wallet holds it", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token(EMBEDDED, { marketplaceBids: [order()] }));
    expect(await prepareAccept({ tokenId: "123", orderHash: HASH, wallet: { own: OWN } })).toMatchObject({ wallet: EMBEDDED });
    expect(await prepareBorrow({ tokenId: "123", amountUsd: 100, wallet: { own: OWN } })).toMatchObject({ wallet: EMBEDDED });
    vi.mocked(getSignContext).mockResolvedValue(token(STRANGER));
    expect(await prepareBorrow({ tokenId: "123", amountUsd: 100, wallet: { own: OWN } })).toMatchObject({ error: expect.stringContaining("only its owner can borrow against it") });
  });

  it("offers from the only wallet that does not hold it, and asks when both could", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token(EMBEDDED));
    expect(await prepareOffer({ tokenId: "123", amountUsd: 9000, wallet: { own: OWN } })).toMatchObject({ wallet: LINKED });
    vi.mocked(getSignContext).mockResolvedValue(token(STRANGER));
    expect(await prepareOffer({ tokenId: "123", amountUsd: 9000, wallet: { own: OWN } })).toMatchObject({ error: expect.stringContaining("2 wallets on the connected account could sign this"), accountWallets: [EMBEDDED, LINKED] });
    expect(await prepareOffer({ tokenId: "123", amountUsd: 9000, wallet: { own: [OWN[0]!] } })).toMatchObject({ wallet: EMBEDDED });
  });

  it("buys only from a wallet the listing is reserved for", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token(STRANGER, { marketplaceListings: [order({ side: "sell", restrictedToAddresses: [LINKED] })] }));
    expect(await prepareBuy({ tokenId: "123", orderHash: HASH, wallet: { own: OWN } })).toMatchObject({ wallet: LINKED });
  });

  it("cancels from the wallet that made the order", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token(STRANGER, { marketplaceBids: [order({ makerAddress: LINKED })] }));
    expect(await prepareCancel({ tokenId: "123", orderHash: HASH, wallet: { own: OWN } })).toMatchObject({ wallet: LINKED, warnings: [expect.objectContaining({ level: "info" })] });
    vi.mocked(getSignContext).mockResolvedValue(token(STRANGER, { marketplaceBids: [order()] }));
    expect(await prepareCancel({ tokenId: "123", orderHash: HASH, wallet: { own: OWN } })).toMatchObject({ error: expect.stringContaining("only its maker can cancel it") });
  });

  it("repays from the wallet that took the loan", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token(STRANGER));
    vi.mocked(getLoanContext).mockResolvedValue(context({ loans: [loan(LINKED)] }));
    expect(await prepareRepay({ tokenId: "123", wallet: { own: OWN } })).toMatchObject({ wallet: LINKED, loan: { loanId: "777" } });
  });

  it("still checks a given address as before", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token(EMBEDDED));
    expect(await prepareListing({ tokenId: "123", priceUsd: 12000, wallet: LINKED })).toMatchObject({ error: expect.stringContaining("does not hold") });
  });
});

describe("signerFor", () => {
  it("reads the account's wallets, deduplicated with the one Fabrica created first, when the wallet is left out or \"me\"", async () => {
    expect(await signerFor(auth(), undefined)).toEqual({ own: [{ address: EMBEDDED, kind: "embedded" }, { address: LINKED, kind: "external" }] });
    expect(await signerFor(auth(), " ME ")).toMatchObject({ own: expect.any(Array) });
  });

  it("passes an address through without reading the account", async () => {
    expect(await signerFor(auth(), STRANGER)).toBe(STRANGER);
    expect(vi.mocked(getAccountProfile)).not.toHaveBeenCalled();
  });

  it("needs portfolio:read for the account's wallets", async () => {
    expect(await signerFor(auth(["profile:read"]), undefined)).toMatchObject({ error: expect.stringContaining("portfolio:read") });
  });
});

describe("readAsViewer", () => {
  it("reads anonymously on the anonymous endpoint, as the person with portfolio:read", async () => {
    const read = vi.fn(async (as?: AccountAuth) => (as ? "personal" : "public"));
    expect(await readAsViewer(undefined, read)).toEqual({ value: "public" });
    expect(await readAsViewer(auth(), read)).toEqual({ value: "personal", view: { personalized: true, note: PERSONALIZED_NOTE } });
    expect(await readAsViewer(auth(["profile:read"]), read)).toMatchObject({ value: "public", view: { personalized: false } });
  });

  it("falls back to the public read when the personal one fails, but not for an unknown property", async () => {
    const failing = vi.fn(async (as?: AccountAuth) => {
      if (as) throw new Error("Fabrica API request failed (HTTP 403).");
      return "public";
    });
    expect(await readAsViewer(auth(), failing)).toMatchObject({ value: "public", view: { personalized: false, note: expect.stringContaining("HTTP 403") } });
    const missing = async () => { throw new FabricaApiError(["No token or premint found"]); };
    await expect(readAsViewer(auth(), missing)).rejects.toThrow("No token or premint found");
  });
});

describe("borrow_against_land as the connected person", () => {
  it("checks the amount against the person's own pool capacity, as estimate_land_borrowing reads it", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token(EMBEDDED));
    vi.mocked(getLoanContext).mockImplementation(async (_params, options) => context({
      poolLendingLiquidity: { appraisalBlockReason: null, maxPrincipalScaled: options?.as ? "2000" : "1000", durations: [30 * DAY], activeLoan: null },
    }));
    expect(await prepareBorrow({ tokenId: "123", amountUsd: 1500, wallet: { own: OWN } })).toMatchObject({ error: expect.stringContaining("above") });
    expect(await prepareBorrow({ tokenId: "123", amountUsd: 1500, wallet: { own: OWN } }, auth())).toMatchObject({ wallet: EMBEDDED, loan: { amountUsd: 1500 } });
  });
});
