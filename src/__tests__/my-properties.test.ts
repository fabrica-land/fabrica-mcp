import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../clients/graphql.js", () => ({ getTokens: vi.fn(), getOrderBook: vi.fn() }));
vi.mock("../clients/account.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../clients/account.js")>();
  return { ...actual, getAccountProfile: vi.fn() };
});

import { getOrderBook, getTokens } from "../clients/graphql.js";
import { AccountApiError, getAccountProfile } from "../clients/account.js";
import { getMyProperties } from "../tools/account.js";
import type { AccountAuth } from "../auth/token.js";
import type { OrderBookOrder, OrderBookToken } from "../types/index.js";
import { tokenListItem } from "./fixtures.js";

const WALLET_A = "0xAaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAA";
const WALLET_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BUYER = "0xcccccccccccccccccccccccccccccccccccccccc";

function auth(scopes: string[] = ["profile:read", "portfolio:read"]): AccountAuth {
  return { token: "t", subject: "s", clientId: "c", scopes, expiresAt: 4102444800 };
}

const premint = tokenListItem({ tokenId: "101", name: "Costilla lot", isPremint: true, claimState: "CLAIMED", estimatedValue: undefined, marketplacePrice: null, marketplaceBidCount: 0, acres: "5", propertyLink: "https://fabrica.land/p/101" });
const small = tokenListItem({ tokenId: "201", name: "Small lot", estimatedValue: "10000", marketplacePrice: null, marketplaceBidCount: 0, acres: "1.25", supplyUnderLoan: "0", propertyLink: "https://fabrica.land/p/201" });
const big = tokenListItem({ tokenId: "202", name: "Big lot", estimatedValue: "90000", marketplacePrice: "95000", marketplaceBidCount: 2, acres: "40", supplyUnderLoan: "1", propertyLink: "https://fabrica.land/p/202" });
const other = tokenListItem({ tokenId: "301", name: "Second wallet lot", estimatedValue: "20000", marketplacePrice: null, marketplaceBidCount: 1, acres: "2", propertyLink: "https://fabrica.land/p/301" });

// Live offers per token; each book also holds an expired offer, which the count leaves out.
const LIVE_OFFERS: Record<string, number> = { "202": 2, "301": 1 };
function bid(endTime: string, makerAddress = BUYER): OrderBookOrder {
  return {
    marketplaceId: `0x${endTime}`, side: "buy", status: "active", price: "1000000000", usdPrice: "1000", symbol: "USDC", decimals: 6, feeBps: "100", supply: "1",
    startTime: "2019-01-01T00:00:00Z", endTime, makerAddress, maker: { user: { displayName: "" } }, restrictedToAddresses: null, disclosurePackage: null, encumbrance: null,
  };
}
function orderBook(bids: OrderBookOrder[]): OrderBookToken {
  return {
    tokenId: "1", name: null, vanityName: null, propertyLink: "", isPremint: false, claimState: null, supersededByTokenId: null, offRampStatus: null,
    isBurned: false, supply: "1", supplyUnderLoan: "0", marketplaceListings: [], marketplaceBids: bids,
  };
}

beforeEach(() => {
  vi.mocked(getOrderBook).mockReset().mockImplementation(async ({ tokenId }) => {
    const live = Array.from({ length: LIVE_OFFERS[tokenId ?? ""] ?? 0 }, () => bid("2099-01-01T00:00:00Z"));
    return orderBook([...live, bid("2020-01-01T00:00:00Z")]);
  });
  vi.mocked(getTokens).mockReset();
  vi.mocked(getAccountProfile).mockReset();
});

describe("get_my_properties", () => {
  it("lists a premint and two minted tokens with stages, offers and totals, being-added first", async () => {
    vi.mocked(getAccountProfile).mockResolvedValue({ email: null, kycStatus: null, wallets: [{ address: WALLET_A, kind: "embedded" }] });
    vi.mocked(getTokens).mockResolvedValue([small, premint, big]);
    const result = await getMyProperties(auth());
    expect(result.error).toBeUndefined();
    expect(result.properties.map((row) => [row.tokenId, row.stage, row.status])).toEqual([
      ["101", "being_added", "Being added to Fabrica"],
      ["202", "live", "Live on Fabrica"],
      ["201", "live", "Live on Fabrica"],
    ]);
    expect(result.properties[1]).toMatchObject({ listingPrice: "$95,000", offersWaiting: 2, underLoan: true, links: { property: "https://fabrica.land/p/202" } });
    expect(result.totals).toEqual({ properties: 3, beingAdded: 1, live: 2, listed: 1, offersWaiting: 2, underLoan: 1, totalAcres: 46.25, estimatedValueOfLive: "$100,000" });
    expect(vi.mocked(getTokens)).toHaveBeenCalledWith(expect.objectContaining({ ownedBy: WALLET_A.toLowerCase(), premints: true, burned: false }));
  });

  it("merges two wallets and lists a shared token once", async () => {
    vi.mocked(getAccountProfile).mockResolvedValue({ email: null, kycStatus: null, wallets: [{ address: WALLET_A, kind: "embedded" }, { address: WALLET_B, kind: "external" }] });
    vi.mocked(getTokens).mockImplementation(async (filters) => (filters.ownedBy === WALLET_B ? [other, big] : [big, small]));
    const result = await getMyProperties(auth());
    expect(result.wallets).toEqual([WALLET_A.toLowerCase(), WALLET_B]);
    expect(result.properties.map((row) => row.tokenId)).toEqual(["202", "301", "201"]);
    expect(result.totals.offersWaiting).toBe(3);
  });

  it("counts live offers only, and says null when an order book cannot be read", async () => {
    vi.mocked(getAccountProfile).mockResolvedValue({ email: null, kycStatus: null, wallets: [{ address: WALLET_A, kind: "embedded" }] });
    vi.mocked(getTokens).mockResolvedValue([big, other]);
    vi.mocked(getOrderBook).mockImplementation(async ({ tokenId }) => {
      if (tokenId === "301") throw new Error("API down");
      return orderBook([bid("2099-01-01T00:00:00Z"), bid("2020-01-01T00:00:00Z"), bid("2020-02-01T00:00:00Z")]);
    });
    const result = await getMyProperties(auth());
    expect(result.properties.map((row) => [row.tokenId, row.offersWaiting])).toEqual([["202", 1], ["301", null]]);
    expect(result.totals.offersWaiting).toBe(1);
    expect(vi.mocked(getOrderBook)).toHaveBeenCalledTimes(2);
  });

  it("does not count the account's own offers as offers waiting", async () => {
    vi.mocked(getAccountProfile).mockResolvedValue({ email: null, kycStatus: null, wallets: [{ address: WALLET_A, kind: "embedded" }, { address: WALLET_B, kind: "external" }] });
    vi.mocked(getTokens).mockResolvedValue([big]);
    vi.mocked(getOrderBook).mockResolvedValue(orderBook([bid("2099-01-01T00:00:00Z"), bid("2099-02-01T00:00:00Z", WALLET_B)]));
    const result = await getMyProperties(auth());
    expect(result.properties[0].offersWaiting).toBe(1);
  });

  it("leaves out properties being added when asked", async () => {
    vi.mocked(getAccountProfile).mockResolvedValue({ email: null, kycStatus: null, wallets: [{ address: WALLET_A, kind: "embedded" }] });
    vi.mocked(getTokens).mockResolvedValue([small, premint]);
    const result = await getMyProperties(auth(), { includePremints: false });
    expect(result.properties.map((row) => row.tokenId)).toEqual(["201"]);
    expect(vi.mocked(getTokens)).toHaveBeenCalledWith(expect.objectContaining({ premints: false }));
  });

  it("needs portfolio:read and reads nothing without it", async () => {
    const result = await getMyProperties(auth(["profile:read"]));
    expect(result.properties).toEqual([]);
    expect(result.notes[0]).toContain("portfolio:read");
    expect(vi.mocked(getAccountProfile)).not.toHaveBeenCalled();
  });

  it("says so while the API does not serve the account", async () => {
    vi.mocked(getAccountProfile).mockResolvedValue(null);
    const result = await getMyProperties(auth());
    expect(result.notes[0]).toContain("does not serve account details yet");
    expect(vi.mocked(getTokens)).not.toHaveBeenCalled();
  });

  it("passes a revoked connection through as an error", async () => {
    vi.mocked(getAccountProfile).mockRejectedValue(new AccountApiError(401, "Fabrica no longer accepts this connection"));
    const result = await getMyProperties(auth());
    expect(result.error).toContain("no longer accepts");
  });

  it("handles an account with no wallet", async () => {
    vi.mocked(getAccountProfile).mockResolvedValue({ email: null, kycStatus: null, wallets: [] });
    const result = await getMyProperties(auth());
    expect(result.properties).toEqual([]);
    expect(result.notes[0]).toContain("No linked account");
  });
});
