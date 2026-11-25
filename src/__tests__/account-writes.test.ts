// The writes that act as the connected person in the Fabrica API (no sign page): an unconfirmed
// listing of a property being added and its cancellation (listing:write), stopping adding a
// property (onramp:write, after its listings) and a message to an owner (message:write).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignContextOrder, SignContextToken } from "../types/index.js";

vi.mock("../clients/graphql.js", () => {
  class FabricaApiError extends Error {
    readonly graphQLErrors: readonly string[];
    constructor(messages: readonly string[]) {
      super(`Fabrica API rejected the query: ${messages.join("; ")}`);
      this.graphQLErrors = messages;
    }
  }
  return {
    FabricaApiError,
    getSignContext: vi.fn(),
    getLoanContext: vi.fn(),
    getTokenPayments: vi.fn(),
    listUnsigned: vi.fn(),
    cancelOrderAs: vi.fn(),
    sendMessageAs: vi.fn(),
    isTokenNotFound: (e: unknown) => e instanceof FabricaApiError && e.graphQLErrors.some(m => m.includes("No token or premint found")),
  };
});
vi.mock("../clients/account.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../clients/account.js")>();
  return { ...actual, getAccountProfile: vi.fn(), cancelOnRamp: vi.fn() };
});
vi.mock("../clients/rpc.js", () => ({ CHAIN_ID: 1, EXPLORER_URL: "https://etherscan.io", getTransaction: vi.fn(), getTransactionReceipt: vi.fn(), getBlockNumber: vi.fn() }));

import { AccountApiError, cancelOnRamp, getAccountProfile, type AccountProfile } from "../clients/account.js";
import { cancelOrderAs, FabricaApiError, getSignContext, listUnsigned, sendMessageAs, type ListedOrder } from "../clients/graphql.js";
import type { AccountAuth } from "../auth/token.js";
import { cancelOrder, listForSale, LISTING_GRANT } from "../tools/sign-requests.js";
import { ADDING_GRANT, cancelAdding } from "../tools/cancel-adding.js";
import { contactOwner, MESSAGE_GRANT } from "../tools/contact-owner.js";
import { MemoryBackend, setSignRequestStore, SignRequestStore } from "../sign-requests/store.js";
import { missingScopes } from "../http.js";

const NOW = Date.parse("2026-11-25T12:00:00Z");
const OWNER = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const BUYER = "0x1111111111111111111111111111111111111111";
const HASH_A = `0x${"a".repeat(64)}`;
const HASH_B = `0x${"b".repeat(64)}`;
const CONTRACT = "0x5cbeb7A0df7Ed85D82a472FD56d81ed550f3Ea95";

function auth(scopes: string[]): AccountAuth {
  return { token: "t", subject: "s", clientId: "c", scopes, expiresAt: 4102444800 };
}
function profile(address: string): AccountProfile {
  return { email: "owner@example.com", kycStatus: null, wallets: [{ address, kind: "embedded" }] };
}
const WRITER = auth(["profile:read", "portfolio:read", "onramp:read", "onramp:write", "listing:write", "message:write"]);

function order(overrides: Partial<SignContextOrder> = {}): SignContextOrder {
  return {
    marketplaceId: HASH_A, side: "sell", status: "active", price: "25000000000", usdPrice: "25000", symbol: "USDC", decimals: 6, feeBps: "100", supply: "1",
    startTime: "2026-11-20T00:00:00Z", endTime: "2036-11-20T00:00:00Z", makerAddress: OWNER, maker: { user: { displayName: "" } },
    restrictedToAddresses: null, disclosurePackage: null, encumbrance: null, signature: null, matchTransactionHash: null, ...overrides,
  };
}

function token(overrides: Partial<SignContextToken> = {}): SignContextToken {
  return {
    tokenId: "77", name: "Lot 7, Costilla County", vanityName: null, propertyLink: "https://fabrica.land/property/ethereum/77",
    contractAddress: CONTRACT, network: "ethereum", isPremint: true, claimState: "CLAIMED", supersededByTokenId: null, offRampStatus: null, isBurned: false,
    supply: "1", supplyUnderLoan: "0", estimatedValue: "20000", majorityOwnerAddress: OWNER, majorityOwner: { address: OWNER, displayName: "Land Co", contactable: true },
    operatingAgreementName: null, configurationUrl: null, configuration: null,
    balances: [{ balance: "1", holder: { address: OWNER }, owner: { address: OWNER } }],
    marketplaceListings: [], marketplaceBids: [], ...overrides,
  };
}

function listed(overrides: Partial<ListedOrder> = {}): ListedOrder {
  return { marketplaceId: HASH_A, side: "sell", status: "active", price: "25000000000", usdPrice: "25000", symbol: "USDC", decimals: 6, supply: "1", startTime: "2026-11-25T12:00:00Z", endTime: "2036-11-25T12:00:00Z", makerAddress: OWNER, signature: null, ...overrides };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  setSignRequestStore(new SignRequestStore(new MemoryBackend(), "test-secret"));
  vi.mocked(getAccountProfile).mockResolvedValue(profile(OWNER));
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  setSignRequestStore(null);
});

describe("list_land_for_sale on a property being added", () => {
  it("lists it in the API with the listing grant: no sign request, the price as dollars and cents", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token());
    vi.mocked(listUnsigned).mockResolvedValue(listed({ usdPrice: "25000.5", price: "25000500000" }));
    const result = await listForSale({ tokenId: "77", priceUsd: 25000.5, expiresDays: 30, wallet: { own: [{ address: OWNER, kind: "embedded" }] } }, WRITER) as Record<string, unknown>;
    expect(listUnsigned).toHaveBeenCalledWith(WRITER, { tokenId: "77", priceUsd: "25000.50" });
    expect(result).not.toHaveProperty("signRequest");
    expect(result.status).toMatch(/^Listed\./);
    expect(result.listing).toMatchObject({ orderHash: HASH_A, confirmed: false, wallet: OWNER, priceUsd: "25000.5" });
    expect(JSON.stringify(result.warnings)).toMatch(/expiresDays does not apply/);
    expect(JSON.stringify(result.nextSteps)).toMatch(/cancel_land_order with orderHash/);
  });

  it("sends whole dollars without decimals, and relays the API's refusal", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token());
    vi.mocked(listUnsigned).mockRejectedValue(new FabricaApiError(["The premint already has a signed listing by this wallet. Cancel it before you list the premint again."]));
    const result = await listForSale({ tokenId: "77", priceUsd: 25000, wallet: OWNER }, WRITER) as Record<string, unknown>;
    expect(listUnsigned).toHaveBeenCalledWith(WRITER, { tokenId: "77", priceUsd: "25000" });
    expect(result.error).toMatch(/^Fabrica did not list it: The premint already has a signed listing/);
  });

  it("still checks the owner before listing, and never calls the API for someone else's property", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token());
    const result = await listForSale({ tokenId: "77", priceUsd: 25000, wallet: OTHER }, WRITER) as Record<string, unknown>;
    expect(result.error).toMatch(/does not hold/);
    expect(listUnsigned).not.toHaveBeenCalled();
  });

  it("falls back to the sign page without the grant, naming it, and for a live property with it", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token());
    const without = await listForSale({ tokenId: "77", priceUsd: 25000, wallet: OWNER }, auth(["profile:read", "onramp:write"])) as Record<string, unknown>;
    expect(without).toHaveProperty("signRequest");
    expect(JSON.stringify(without.signRequest)).toContain(LISTING_GRANT);
    vi.mocked(getSignContext).mockResolvedValue(token({ isPremint: false, claimState: null }));
    const live = await listForSale({ tokenId: "77", priceUsd: 25000, wallet: OWNER }, WRITER) as Record<string, unknown>;
    expect(live).toHaveProperty("signRequest");
    expect(JSON.stringify(live.signRequest)).not.toContain(LISTING_GRANT);
    expect(listUnsigned).not.toHaveBeenCalled();
  });
});

describe("cancel_land_order on an unconfirmed listing", () => {
  it("takes it down in the API with the grant, and refuses without one or signed out", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token({ marketplaceListings: [order()] }));
    vi.mocked(cancelOrderAs).mockResolvedValue(listed({ status: "canceled" }));
    const done = await cancelOrder({ tokenId: "77", orderHash: HASH_A, wallet: OWNER }, WRITER) as Record<string, unknown>;
    expect(cancelOrderAs).toHaveBeenCalledWith(WRITER, HASH_A);
    expect(done.status).toMatch(/^Taken down\./);
    expect(done.listing).toMatchObject({ status: "canceled", confirmed: false });
    const noGrant = await cancelOrder({ tokenId: "77", orderHash: HASH_A, wallet: OWNER }, auth(["profile:read"])) as Record<string, unknown>;
    expect(noGrant.error).toContain(LISTING_GRANT);
    const signedOut = await cancelOrder({ tokenId: "77", orderHash: HASH_A, wallet: OWNER }) as Record<string, unknown>;
    expect(signedOut.error).toMatch(/sign in to Fabrica/);
    expect(signedOut.propertyLink).toBe("https://fabrica.land/property/ethereum/77");
    expect(cancelOrderAs).toHaveBeenCalledTimes(1);
  });

  it("keeps a signed listing on the sign page, and the maker check for both", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token({ isPremint: false, claimState: null, marketplaceListings: [order({ signature: "0xsigned" })] }));
    const signed = await cancelOrder({ tokenId: "77", orderHash: HASH_A, wallet: OWNER }, WRITER) as Record<string, unknown>;
    expect(signed).toHaveProperty("signRequest");
    expect(cancelOrderAs).not.toHaveBeenCalled();
    vi.mocked(getSignContext).mockResolvedValue(token({ marketplaceListings: [order()] }));
    expect(await cancelOrder({ tokenId: "77", orderHash: HASH_A, wallet: OTHER }, WRITER)).toHaveProperty("error");
    expect(cancelOrderAs).not.toHaveBeenCalled();
  });
});

describe("cancel_adding_land", () => {
  it("needs the add-property grant, and refuses a property already set up", async () => {
    const noGrant = await cancelAdding(auth(["onramp:read"]), { tokenId: "77" }) as Record<string, unknown>;
    expect(noGrant.error).toContain(ADDING_GRANT);
    vi.mocked(getSignContext).mockResolvedValue(token({ isPremint: false, claimState: null }));
    const live = await cancelAdding(WRITER, { tokenId: "77" }) as Record<string, unknown>;
    expect(live.error).toMatch(/already set up on Fabrica/);
    expect(cancelOnRamp).not.toHaveBeenCalled();
  });

  it("refuses someone else's property before touching the API", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token({ majorityOwnerAddress: OTHER, balances: [{ balance: "1", holder: { address: OTHER }, owner: { address: OTHER } }] }));
    const result = await cancelAdding(WRITER, { tokenId: "77" }) as Record<string, unknown>;
    expect(result.error).toMatch(/not being added by the connected account/);
    expect(cancelOnRamp).not.toHaveBeenCalled();
  });

  it("takes the unconfirmed listings down first, then deletes the record", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token({ marketplaceListings: [order(), order({ marketplaceId: HASH_B, status: "expired" })] }));
    vi.mocked(cancelOrderAs).mockResolvedValue(listed({ status: "canceled" }));
    vi.mocked(cancelOnRamp).mockResolvedValue(undefined);
    const result = await cancelAdding(WRITER, { tokenId: "77" }) as Record<string, unknown>;
    expect(cancelOrderAs).toHaveBeenCalledTimes(1);
    expect(cancelOrderAs).toHaveBeenCalledWith(WRITER, HASH_A);
    expect(cancelOnRamp).toHaveBeenCalledWith(WRITER, "77");
    expect(result.status).toMatch(/^Stopped\./);
    expect(result.status).toMatch(/listing was taken off the marketplace first/);
    expect(result.listingsTakenDown).toHaveLength(1);
  });

  it("stops at a listing the owner confirmed, or one it lacks the grant to take down", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token({ marketplaceListings: [order({ signature: "0xsigned" })] }));
    const confirmed = await cancelAdding(WRITER, { tokenId: "77" }) as Record<string, unknown>;
    expect(confirmed.error).toMatch(/cancel_land_order/);
    expect(confirmed.listings).toEqual([{ orderHash: HASH_A, priceUsd: "25000", wallet: OWNER }]);
    vi.mocked(getSignContext).mockResolvedValue(token({ marketplaceListings: [order()] }));
    const noGrant = await cancelAdding(auth(["profile:read", "portfolio:read", "onramp:write"]), { tokenId: "77" }) as Record<string, unknown>;
    expect(noGrant.error).toContain(LISTING_GRANT);
    expect(cancelOrderAs).not.toHaveBeenCalled();
    expect(cancelOnRamp).not.toHaveBeenCalled();
  });

  it("relays the API's refusal of the delete, and says the listing already came down", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token({ marketplaceListings: [order()] }));
    vi.mocked(cancelOrderAs).mockResolvedValue(listed({ status: "canceled" }));
    vi.mocked(cancelOnRamp).mockRejectedValue(new AccountApiError(409, "Fabrica refused this: the deed is being recorded."));
    const result = await cancelAdding(WRITER, { tokenId: "77" }) as Record<string, unknown>;
    expect(result.error).toBe("Fabrica refused this: the deed is being recorded. Its listing was taken down.");
    expect(result.listingsTakenDown).toHaveLength(1);
  });

  it("is a write tool behind the add-property grant for the HTTP step-up", () => {
    const call = (name: string) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });
    expect(missingScopes(call("cancel_adding_land"), auth(["profile:read"]))).toEqual(["onramp:write"]);
    expect(missingScopes(call("contact_land_owner"), auth(["profile:read"]))).toEqual(["message:write"]);
    expect(missingScopes(call("contact_land_owner"), WRITER)).toEqual([]);
  });
});

describe("contact_land_owner", () => {
  const message = "Hello, I am interested in your lot. Would you take an offer near the estimate?";

  it("sends the message as the account's wallet, about the property", async () => {
    vi.mocked(getAccountProfile).mockResolvedValue(profile(BUYER));
    vi.mocked(getSignContext).mockResolvedValue(token());
    vi.mocked(sendMessageAs).mockResolvedValue(true);
    const result = await contactOwner(WRITER, { tokenId: "77", message }) as Record<string, unknown>;
    expect(sendMessageAs).toHaveBeenCalledWith(WRITER, { sender: BUYER, recipient: OWNER, message, property: { contractAddress: CONTRACT, tokenId: "77" } });
    expect(result.status).toMatch(/^Sent\. Fabrica emailed the message to Land Co/);
    expect(result.to).toEqual({ displayName: "Land Co", wallet: OWNER });
    expect(result.from).toBe(BUYER);
  });

  it("needs the grant, refuses an owner without a verified email, and refuses writing to oneself", async () => {
    const noGrant = await contactOwner(auth(["profile:read"]), { tokenId: "77", message }) as Record<string, unknown>;
    expect(noGrant.error).toContain(MESSAGE_GRANT);
    vi.mocked(getSignContext).mockResolvedValue(token({ majorityOwner: { address: OWNER, displayName: "Land Co", contactable: false } }));
    const unreachable = await contactOwner(WRITER, { tokenId: "77", message }) as Record<string, unknown>;
    expect(unreachable.error).toMatch(/cannot be reached through Fabrica right now/);
    vi.mocked(getSignContext).mockResolvedValue(token());
    const self = await contactOwner(WRITER, { tokenId: "77", message, wallet: OWNER }) as Record<string, unknown>;
    expect(self.error).toMatch(/the connected person's own/);
    // The owner's wallet is one of several on the account: still oneself, whichever wallet would send.
    vi.mocked(getAccountProfile).mockResolvedValue({ email: null, kycStatus: null, wallets: [{ address: BUYER, kind: "embedded" }, { address: OWNER, kind: "external" }] });
    const linked = await contactOwner(WRITER, { tokenId: "77", message }) as Record<string, unknown>;
    expect(linked.error).toMatch(/the connected person's own/);
    // A chosen sender does not get around it: the owner is still another wallet of the same account.
    const chosen = await contactOwner(WRITER, { tokenId: "77", message, wallet: BUYER }) as Record<string, unknown>;
    expect(chosen.error).toMatch(/the connected person's own/);
    expect(sendMessageAs).not.toHaveBeenCalled();
  });

  it("does not report a message the API says it did not send", async () => {
    vi.mocked(getAccountProfile).mockResolvedValue(profile(BUYER));
    vi.mocked(getSignContext).mockResolvedValue(token());
    vi.mocked(sendMessageAs).mockResolvedValue(false);
    const result = await contactOwner(WRITER, { tokenId: "77", message }) as Record<string, unknown>;
    expect(result.error).toMatch(/^Fabrica did not send the message to Land Co/);
    expect(result).not.toHaveProperty("status");
  });

  it("refuses a property nobody has claimed, a secret in the message, and relays the API's refusal", async () => {
    vi.mocked(getAccountProfile).mockResolvedValue(profile(BUYER));
    vi.mocked(getSignContext).mockResolvedValue(token({ claimState: "UNCLAIMED", majorityOwnerAddress: null, majorityOwner: null }));
    expect(((await contactOwner(WRITER, { tokenId: "77", message })) as Record<string, unknown>).error).toMatch(/nobody has claimed it yet/);
    vi.mocked(getSignContext).mockResolvedValue(token());
    expect(((await contactOwner(WRITER, { tokenId: "77", message: `my key is 0x${"1".repeat(64)}`, wallet: BUYER })) as Record<string, unknown>).error).toMatch(/private key or seed phrase/);
    vi.mocked(sendMessageAs).mockRejectedValue(new FabricaApiError(["You must have an email address to contact users. Visit help.fabrica.land if this keeps happening."]));
    const refused = await contactOwner(WRITER, { tokenId: "77", message, wallet: BUYER }) as Record<string, unknown>;
    expect(refused.error).toMatch(/^Fabrica did not send the message: You must have an email address/);
  });
});
