import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../clients/graphql.js", () => ({ getTokens: vi.fn(), getWallet: vi.fn(), getOrderBook: vi.fn() }));
vi.mock("../clients/account.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../clients/account.js")>();
  return { ...actual, getAccountProfile: vi.fn() };
});

import { getOrderBook, getTokens, getWallet } from "../clients/graphql.js";
import { getAccountProfile } from "../clients/account.js";
import { getMyOffers } from "../tools/offers.js";
import type { AccountAuth } from "../auth/token.js";
import type { OrderBookOrder, OrderBookToken } from "../types/index.js";
import { tokenListItem, wallet } from "./fixtures.js";

const NOW = new Date("2026-10-24T12:00:00Z");
const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BUYER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function auth(scopes: string[] = ["portfolio:read"]): AccountAuth {
  return { token: "t", subject: "s", clientId: "c", scopes, expiresAt: 4102444800 };
}

function order(overrides: Partial<OrderBookOrder>): OrderBookOrder {
  return {
    marketplaceId: "0xorder", side: "buy", status: "active", price: "10000000000", usdPrice: "10000.00", symbol: "USDC", decimals: 6, feeBps: "100", supply: "1",
    startTime: "2026-10-01T00:00:00Z", endTime: "2026-11-16T00:00:00Z", makerAddress: BUYER, maker: { user: { displayName: "" } },
    restrictedToAddresses: null, disclosurePackage: null, encumbrance: null, ...overrides,
  };
}

function book(overrides: Partial<OrderBookToken>): OrderBookToken {
  return {
    tokenId: "1", name: "My lot", vanityName: null, propertyLink: "https://fabrica.land/property/ethereum/1", isPremint: false, claimState: null,
    supersededByTokenId: null, offRampStatus: null, isBurned: false, supply: "1", supplyUnderLoan: "0", marketplaceListings: [], marketplaceBids: [], ...overrides,
  };
}

const myLot = book({
  tokenId: "1",
  supplyUnderLoan: "1",
  marketplaceBids: [
    order({ marketplaceId: "0xlow", usdPrice: "8000", endTime: "2026-10-26T00:00:00Z" }),
    order({ marketplaceId: "0xhigh", usdPrice: "12000" }),
    order({ marketplaceId: "0xold", usdPrice: "15000", endTime: "2026-10-01T00:00:00Z" }),
    order({ marketplaceId: "0xlisting", side: "sell", makerAddress: ME }),
  ],
});
const theirLot = book({
  tokenId: "2", name: "Their lot", propertyLink: "https://fabrica.land/property/ethereum/2",
  marketplaceBids: [order({ marketplaceId: "0xmine", makerAddress: ME, usdPrice: "5000" }), order({ marketplaceId: "0xsomeone", usdPrice: "6000" })],
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(getAccountProfile).mockReset().mockResolvedValue({ email: null, kycStatus: null, wallets: [{ address: ME.toUpperCase().replace("0X", "0x"), kind: "embedded" }] });
  vi.mocked(getTokens).mockReset().mockResolvedValue([tokenListItem({ tokenId: "1", marketplaceBidCount: 3 }), tokenListItem({ tokenId: "3", marketplaceBidCount: 0 })]);
  vi.mocked(getWallet).mockReset().mockResolvedValue(wallet({ marketplaceOffersMade: [{ marketplaceId: "0xmine", tokenId: "2", side: "buy", status: "active", price: "5000000000", symbol: "USDC" }] }));
  vi.mocked(getOrderBook).mockReset().mockImplementation(async ({ tokenId }) => (tokenId === "1" ? myLot : tokenId === "2" ? theirLot : null));
});
afterEach(() => vi.useRealTimers());

describe("get_my_offers", () => {
  it("lists one offer made and two received, highest first, with expiry flags; expired left out", async () => {
    const result = await getMyOffers(auth());
    expect(result.error).toBeUndefined();
    expect(result.received).toHaveLength(1);
    const [lot] = result.received ?? [];
    expect(lot.offers.map((o) => [o.orderId, o.expiringSoon])).toEqual([["0xhigh", false], ["0xlow", true]]);
    expect(lot).toMatchObject({ underLoan: true, links: { respond: "https://fabrica.land/property/ethereum/1" } });
    expect(result.made?.map((o) => [o.orderId, o.tokenId, o.price])).toEqual([["0xmine", "2", "$5,000"]]);
    expect(result.totals).toEqual({ received: 2, made: 1, expiringSoon: 1 });
    expect(result.notes.join(" ")).toContain("pays the loan off");
    expect(vi.mocked(getOrderBook)).not.toHaveBeenCalledWith({ tokenId: "3" });
  });

  it("includes expired offers with status all", async () => {
    const result = await getMyOffers(auth(), { side: "received", status: "all" });
    expect(result.made).toBeUndefined();
    expect(result.received?.[0].offers.map((o) => [o.orderId, o.status])).toContainEqual(["0xold", "expired"]);
  });

  it("reads only the side asked for", async () => {
    const result = await getMyOffers(auth(), { side: "made" });
    expect(result.received).toBeUndefined();
    expect(vi.mocked(getTokens)).not.toHaveBeenCalled();
  });

  it("needs portfolio:read", async () => {
    const result = await getMyOffers(auth(["profile:read"]));
    expect(result.notes[0]).toContain("portfolio:read");
    expect(vi.mocked(getAccountProfile)).not.toHaveBeenCalled();
  });
});
