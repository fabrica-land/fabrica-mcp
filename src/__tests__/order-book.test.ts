import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OrderBookOrder, OrderBookToken } from "../types/index.js";

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
    getOrderBook: vi.fn(),
    getPremintSuccessor: vi.fn(),
    isTokenNotFound: (e: unknown) => e instanceof FabricaApiError && e.graphQLErrors.some(m => m.includes("No token or premint found")),
  };
});

import { FabricaApiError, getOrderBook as fetchOrderBook, getPremintSuccessor } from "../clients/graphql.js";
import { getOrderBook, formatTokenAmount, relativeExpiry } from "../tools/marketplace.js";

const NOW = Date.parse("2026-10-17T00:00:00Z");

function order(overrides: Partial<OrderBookOrder>): OrderBookOrder {
  return {
    marketplaceId: "0xorder",
    side: "buy",
    status: "active",
    price: "10000000000",
    usdPrice: "10000.00",
    symbol: "USDC",
    decimals: 6,
    feeBps: "100",
    supply: "1",
    startTime: "2026-10-01T00:00:00Z",
    endTime: "2026-11-16T00:00:00Z",
    makerAddress: "0x1908d26657e238a9f464a98b1f017f4cbd2066c7",
    maker: { user: { displayName: null } },
    restrictedToAddresses: null,
    disclosurePackage: null,
    encumbrance: null,
    ...overrides,
  };
}

function token(overrides: Partial<OrderBookToken>): OrderBookToken {
  return {
    tokenId: "3484741603659410548",
    name: "92 Cuatro Ruedas Dr",
    vanityName: null,
    propertyLink: "https://fabrica.land/property/ethereum/3484741603659410548",
    isPremint: false,
    claimState: null,
    supersededByTokenId: null,
    isBurned: false,
    supply: "1",
    supplyUnderLoan: "0",
    marketplaceListings: [],
    marketplaceBids: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(fetchOrderBook).mockReset();
  vi.mocked(getPremintSuccessor).mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("formatting helpers", () => {
  it("scales the raw amount by decimals", () => {
    expect(formatTokenAmount("25000000000", 6, "USDC")).toBe("25,000 USDC");
    expect(formatTokenAmount("1500000", 6, "USDC")).toBe("1.5 USDC");
    expect(formatTokenAmount("500000000000000000", 18, "WETH")).toBe("0.5 WETH");
  });

  it("states expiry relative to now", () => {
    expect(relativeExpiry("2026-10-29T00:00:00Z", NOW)).toBe("in 12 days");
    expect(relativeExpiry("2026-10-17T05:00:00Z", NOW)).toBe("in less than a day");
    expect(relativeExpiry("2026-10-14T00:00:00Z", NOW)).toBe("3 days ago");
    expect(relativeExpiry(null, NOW)).toBeNull();
  });
});

describe("get_order_book", () => {
  it("requires a token ID or slug", async () => {
    expect(await getOrderBook({})).toEqual({ error: "Either tokenId or slug is required" });
  });

  it("returns a listed property with offers, offers sorted high to low", async () => {
    vi.mocked(fetchOrderBook).mockResolvedValue(token({
      marketplaceListings: [
        order({ side: "sell", price: "30000000000", usdPrice: "30000.00", marketplaceId: "0xhigh" }),
        order({ side: "sell", price: "25000000000", usdPrice: "25000.00", marketplaceId: "0xlow", maker: { user: { displayName: "badmonky.eth" } } }),
      ],
      marketplaceBids: [
        order({ usdPrice: "12000.00", price: "12000000000", marketplaceId: "0xb1", restrictedToAddresses: ["0x0c687a27410e8a655bf31befc4c88237a60b1d3d"] }),
        order({ usdPrice: "18000.00", price: "18000000000", marketplaceId: "0xb2", disclosurePackage: [{ name: "Survey.pdf", url: "https://example.com/survey.pdf" }] }),
      ],
    }));
    const result = await getOrderBook({ tokenId: "3484741603659410548" });
    expect(result).toMatchObject({
      tokenId: "3484741603659410548",
      stage: "minted",
      isPremint: false,
      offerCount: 2,
      underActiveLoan: false,
      listing: { price: "$25,000", amount: "25,000 USDC", seller: "0x1908...66c7", makerName: "badmonky.eth", marketplaceFee: "1.00% of the price", expires: "in 30 days", orderId: "0xlow" },
      links: { property: "https://fabrica.land/property/ethereum/3484741603659410548", makeOffer: "https://fabrica.land/property/ethereum/3484741603659410548" },
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.listings.map(l => l.orderId)).toEqual(["0xlow", "0xhigh"]);
    expect(result.offers.map(o => o.price)).toEqual(["$18,000", "$12,000"]);
    expect(result.offers[0]).toMatchObject({ buyer: "0x1908...66c7", disclosures: [{ name: "Survey.pdf", url: "https://example.com/survey.pdf" }] });
    expect(result.offers[0]).not.toHaveProperty("marketplaceFee");
    expect(result.offers[1]).toMatchObject({ restrictedTo: ["0x0c68...1d3d"] });
  });

  it("returns a premint with offers and its claim state", async () => {
    vi.mocked(fetchOrderBook).mockResolvedValue(token({
      isPremint: true,
      claimState: "CLAIMED",
      marketplaceBids: [order({ usdPrice: "12.00", price: "12000000" })],
    }));
    const result = await getOrderBook({ tokenId: "15325100240721923369" });
    expect(result).toMatchObject({
      isPremint: true,
      claimState: "CLAIMED",
      stage: "premint, claimed by the owner and not yet minted",
      listing: null,
      offerCount: 1,
      offers: [{ price: "$12", amount: "12 USDC", status: "active" }],
    });
    expect(JSON.stringify(result)).toContain("premint");
  });

  it("returns a compact payload for a token with no orders", async () => {
    vi.mocked(fetchOrderBook).mockResolvedValue(token({ marketplaceListings: null, marketplaceBids: null }));
    const result = await getOrderBook({ slug: "us/new-mexico/taos-county/carson/92-cuatro-ruedas-dr" });
    expect(result).toMatchObject({ listing: null, listings: [], offers: [], offerCount: 0, notes: ["No active listings or offers on this property."] });
  });

  it("leaves out expired, canceled and filled orders by default and includes them with status all", async () => {
    vi.mocked(fetchOrderBook).mockResolvedValue(token({
      marketplaceBids: [
        order({ status: "expired", usdPrice: "5.00", marketplaceId: "0xexpired" }),
        order({ status: "canceled", usdPrice: "6.00", marketplaceId: "0xcanceled" }),
        order({ status: "active", usdPrice: "7.00", endTime: "2026-10-10T00:00:00Z", marketplaceId: "0xstale" }),
        order({ status: "active", usdPrice: "8.00", marketplaceId: "0xlive" }),
      ],
    }));
    const live = await getOrderBook({ tokenId: "1" });
    if ("error" in live) throw new Error(live.error);
    expect(live.offers.map(o => o.orderId)).toEqual(["0xlive"]);
    const all = await getOrderBook({ tokenId: "1", status: "all" });
    if ("error" in all) throw new Error(all.error);
    expect(all.offers.map(o => [o.orderId, o.status])).toEqual([
      ["0xlive", "active"],
      ["0xstale", "expired"],
      ["0xcanceled", "canceled"],
      ["0xexpired", "expired"],
    ]);
    expect(all.offerCount).toBe(1);
  });

  it("filters offers by minimum USD amount", async () => {
    vi.mocked(fetchOrderBook).mockResolvedValue(token({
      marketplaceBids: [order({ usdPrice: "500.00", marketplaceId: "0xsmall" }), order({ usdPrice: "5000.00", marketplaceId: "0xbig" })],
    }));
    const result = await getOrderBook({ tokenId: "1", minOfferUsd: 1000 });
    if ("error" in result) throw new Error(result.error);
    expect(result.offers.map(o => o.orderId)).toEqual(["0xbig"]);
  });

  it("explains a listing on a property under a loan", async () => {
    vi.mocked(fetchOrderBook).mockResolvedValue(token({
      supplyUnderLoan: "1",
      marketplaceListings: [order({ side: "sell", status: "encumbered", encumbrance: { buyable: false, blockReason: "UNDERWATER", loanId: "42" } })],
    }));
    const result = await getOrderBook({ tokenId: "1" });
    expect(result).toMatchObject({
      underActiveLoan: true,
      listing: { status: "encumbered", encumbrance: { loanId: "42", buyable: false, reason: "The loan payoff is larger than the seller's proceeds at this price." } },
    });
    expect(JSON.stringify(result)).toContain("A sale pays the loan off");
  });

  it("reports an unknown token as not found", async () => {
    vi.mocked(fetchOrderBook).mockRejectedValue(new FabricaApiError(["No token or premint found for token with ID 123 on any network"]));
    vi.mocked(getPremintSuccessor).mockResolvedValue(null);
    expect(await getOrderBook({ tokenId: "123" })).toEqual({ error: "No property found with token ID 123" });
    expect(await getOrderBook({ slug: "us/nowhere" })).toEqual({ error: "No property found with slug us/nowhere" });
  });

  it("reports any other API failure without throwing", async () => {
    vi.mocked(fetchOrderBook).mockRejectedValue(new Error("Fabrica API did not respond within 20 s. Try again shortly."));
    expect(await getOrderBook({ tokenId: "1" })).toEqual({ error: "Failed to get order book: Fabrica API did not respond within 20 s. Try again shortly." });
  });

  it("follows a premint that no longer loads to its minted successor", async () => {
    vi.mocked(fetchOrderBook)
      .mockRejectedValueOnce(new FabricaApiError(["No token or premint found for token with ID 111 on any network"]))
      .mockResolvedValueOnce(token({ tokenId: "222" }));
    vi.mocked(getPremintSuccessor).mockResolvedValue("222");
    const result = await getOrderBook({ tokenId: "111" });
    expect(fetchOrderBook).toHaveBeenLastCalledWith({ tokenId: "222" });
    expect(result).toMatchObject({ tokenId: "222", stage: "minted", replacesPremintTokenId: "111" });
  });

  it("follows a superseded premint that still loads to its minted successor", async () => {
    vi.mocked(fetchOrderBook)
      .mockResolvedValueOnce(token({ tokenId: "111", isPremint: true, supersededByTokenId: "222" }))
      .mockResolvedValueOnce(token({ tokenId: "222" }));
    const result = await getOrderBook({ tokenId: "111" });
    expect(result).toMatchObject({ tokenId: "222", stage: "minted", replacesPremintTokenId: "111" });
  });

  it("ranks orders without a USD price after priced ones", async () => {
    vi.mocked(fetchOrderBook).mockResolvedValue(token({
      marketplaceListings: [
        order({ side: "sell", usdPrice: null, price: "1000000000000000000", symbol: "WETH", decimals: 18, marketplaceId: "0xweth" }),
        order({ side: "sell", usdPrice: "25000.00", marketplaceId: "0xusdc" }),
      ],
      marketplaceBids: [
        order({ usdPrice: null, marketplaceId: "0xunpriced" }),
        order({ usdPrice: "100.00", marketplaceId: "0xpriced" }),
      ],
    }));
    const result = await getOrderBook({ tokenId: "1" });
    if ("error" in result) throw new Error(result.error);
    expect(result.listing?.orderId).toBe("0xusdc");
    expect(result.listings.map(l => l.orderId)).toEqual(["0xusdc", "0xweth"]);
    expect(result.listings[1]).toMatchObject({ price: null, amount: "1 WETH" });
    expect(result.offers.map(o => o.orderId)).toEqual(["0xpriced", "0xunpriced"]);
  });

  it("keeps output free of em dashes and fairness judgments", async () => {
    vi.mocked(fetchOrderBook).mockResolvedValue(token({
      isPremint: true,
      claimState: "UNCLAIMED",
      supplyUnderLoan: "1",
      marketplaceListings: [order({ side: "sell", status: "encumbered", encumbrance: { buyable: false, blockReason: "LEGACY_POOL", loanId: "1" } })],
      marketplaceBids: [order({})],
    }));
    const text = JSON.stringify(await getOrderBook({ tokenId: "1" }));
    expect(text).not.toContain("—");
    expect(text).not.toMatch(/\b(fair|good deal|bargain|overpriced|underpriced|instantly)\b/i);
  });
});
