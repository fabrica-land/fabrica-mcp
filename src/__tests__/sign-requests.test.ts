import { createServer as createHttpServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
    isTokenNotFound: (e: unknown) => e instanceof FabricaApiError && e.graphQLErrors.some(m => m.includes("No token or premint found")),
  };
});
vi.mock("../clients/rpc.js", () => ({
  CHAIN_ID: 1,
  EXPLORER_URL: "https://etherscan.io",
  getTransaction: vi.fn(),
  getTransactionReceipt: vi.fn(),
  getBlockNumber: vi.fn(),
}));

import { FabricaApiError, getSignContext } from "../clients/graphql.js";
import { getBlockNumber, getTransaction, getTransactionReceipt } from "../clients/rpc.js";
import {
  acceptOffer,
  buy,
  cancelOrder,
  getSignRequest,
  listForSale,
  makeOffer,
  observe,
  PREPARED_STATUS,
  signPageView,
  signLink,
  usdToRaw,
  verifyResult,
} from "../tools/sign-requests.js";
import { getTransactionStatus } from "../tools/transactions.js";
import { isExpired, MemoryBackend, newSignRequestId, setSignRequestStore, SignRequestStore, type SignRequest } from "../sign-requests/store.js";
import { handleSignRequestHttp, parseSignRequestUrl } from "../sign-requests/http.js";

const NOW = Date.parse("2026-10-18T00:00:00Z");
const BUYER = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const POOL = "0x3333333333333333333333333333333333333333";
const HASH_A = `0x${"a".repeat(64)}`;
const HASH_B = `0x${"b".repeat(64)}`;
const TX = `0x${"c".repeat(64)}`;

function order(overrides: Partial<SignContextOrder>): SignContextOrder {
  return {
    marketplaceId: HASH_A,
    side: "buy",
    status: "active",
    price: "10000000000",
    usdPrice: "10000.00",
    symbol: "USDC",
    decimals: 6,
    feeBps: "100",
    supply: "1",
    startTime: "2026-10-10T00:00:00Z",
    endTime: "2026-11-16T00:00:00Z",
    makerAddress: BUYER,
    maker: { user: { displayName: "" } },
    restrictedToAddresses: null,
    disclosurePackage: null,
    encumbrance: null,
    matchTransactionHash: null,
    ...overrides,
  };
}

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

let store: SignRequestStore;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.mocked(getSignContext).mockReset();
  vi.mocked(getTransaction).mockReset();
  store = new SignRequestStore(new MemoryBackend(), "test-secret");
  setSignRequestStore(store);
});
afterEach(() => {
  vi.useRealTimers();
  setSignRequestStore(undefined);
});

/** A stored request, as a prepare tool writes it. */
function record(overrides: Partial<SignRequest> = {}): SignRequest {
  return {
    id: newSignRequestId(),
    status: "pending",
    network: "ethereum",
    chainId: 1,
    action: "make_land_offer",
    kind: "typedData",
    wallet: BUYER,
    property: { tokenId: "123", contractAddress: "0x5cbeb7A0df7Ed85D82a472FD56d81ed550f3Ea95", name: "1 Test Road", link: "https://fabrica.land/property/ethereum/123" },
    order: { side: "buy", priceUsd: "9000", price: "9000000000", symbol: "USDC", decimals: 6, durationDays: 14, supply: "1" },
    signLink: "https://fabrica.land/property/ethereum/123?action=offer",
    summary: ["Offer"],
    warnings: [],
    payload: null,
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 900_000).toISOString(),
    ...overrides,
  };
}

describe("helpers", () => {
  it("converts dollars to raw USDC units at the cent", () => {
    expect(usdToRaw(250000)).toBe("250000000000");
    expect(usdToRaw(12.345)).toBe("12350000");
  });

  it("builds the sign link on the property page with the sign page's query and the id", () => {
    const link = signLink("123", { action: "offer", amount: "500" }, "sr_x");
    expect(link).toBe("https://fabrica.land/property/ethereum/123?action=offer&amount=500&request=sr_x");
  });

  it("reads the id and operation from the path or the Vercel rewrite", () => {
    expect(parseSignRequestUrl("/sign-requests/sr_abc")).toEqual({ id: "sr_abc", op: "get" });
    expect(parseSignRequestUrl("/sign-requests/sr_abc/result")).toEqual({ id: "sr_abc", op: "result" });
    expect(parseSignRequestUrl("/sign-requests?id=sr_abc&op=result")).toEqual({ id: "sr_abc", op: "result" });
    expect(parseSignRequestUrl("/elsewhere")).toBeNull();
  });
});

describe("the sign-request store", () => {
  it("returns what it stored, and nothing for an unknown or malformed id", async () => {
    const r = record();
    await store.create(r);
    expect(await store.get(r.id)).toEqual(r);
    expect(await store.get(newSignRequestId())).toBeNull();
    expect(await store.get("../../etc")).toBeNull();
  });

  it("refuses a record whose contents no longer match the server's signature", async () => {
    const backend = new MemoryBackend();
    const signed = new SignRequestStore(backend, "secret");
    const r = record();
    await signed.create(r);
    const raw = await backend.get(`sign-request:${r.id}`);
    const tampered = (raw ?? "").replace(BUYER, OWNER);
    await backend.set(`sign-request:${r.id}`, tampered, "keep");
    expect(await signed.get(r.id)).toBeNull();
    expect(await new SignRequestStore(backend, "another secret").get(r.id)).toBeNull();
  });

  it("marks a request expired 15 minutes after it was prepared and forgets it after a day", async () => {
    const r = record();
    await store.create(r);
    expect(isExpired(r)).toBe(false);
    vi.setSystemTime(NOW + 15 * 60_000 + 1);
    expect(isExpired(r)).toBe(true);
    expect(await store.get(r.id)).toEqual(r);
    vi.setSystemTime(NOW + 24 * 3600_000 + 1);
    expect(await store.get(r.id)).toBeNull();
  });

  it("records the result and keeps the record valid", async () => {
    const r = record();
    await store.create(r);
    const done = await store.complete(r, { orderHash: HASH_B });
    expect(done.status).toBe("completed");
    expect(await store.get(r.id)).toEqual(done);
  });

  it("gives a loan to one request even when two claim it at once", async () => {
    const first = { ...record(), id: newSignRequestId() };
    const second = { ...record(), id: newSignRequestId() };
    const claims = await Promise.all([store.claimLoan(first, "900"), store.claimLoan(second, "900")]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await store.claimLoan(claims[0] ? first : second, "900")).toBe(true);
  });
});

describe("make_land_offer", () => {
  it("prepares an offer with the link, the summary and the stored record", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token());
    const result = await makeOffer({ tokenId: "123", amountUsd: 9000, wallet: BUYER });
    if (!("signRequest" in result)) throw new Error(JSON.stringify(result));
    expect(result.status).toBe(PREPARED_STATUS);
    expect(result.signRequest.kind).toBe("typedData");
    expect(result.signRequest.payload).toBeNull();
    expect(result.signRequest.signLink).toBe(`https://fabrica.land/property/ethereum/123?action=offer&amount=9000&expires=14&request=${result.signRequest.id}`);
    expect(result.signRequest.expiresAt).toBe(new Date(NOW + 900_000).toISOString());
    expect(result.signRequest.summary[0]).toContain("$9,000");
    const stored = await store.get(result.signRequest.id);
    expect(stored?.order).toEqual({ side: "buy", priceUsd: "9000", price: "9000000000", symbol: "USDC", decimals: 6, durationDays: 14, supply: "1" });
    expect(stored?.wallet).toBe(BUYER);
  });

  it("refuses an offer from the wallet that holds the property", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token());
    const result = await makeOffer({ tokenId: "123", amountUsd: 9000, wallet: OWNER });
    expect(result).toHaveProperty("error");
    expect(result).not.toHaveProperty("signRequest");
  });

  it("warns when the amount is far below the estimate and when a cheaper listing exists", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token({
      marketplaceListings: [order({ side: "sell", marketplaceId: HASH_B, makerAddress: OWNER, usdPrice: "3000.00", price: "3000000000" })],
    }));
    const result = await makeOffer({ tokenId: "123", amountUsd: 4000, wallet: BUYER });
    if (!("signRequest" in result)) throw new Error(JSON.stringify(result));
    const messages = result.signRequest.warnings.map(w => w.message).join("\n");
    expect(messages).toContain("60% below Fabrica's estimate of $10,000");
    expect(messages).toContain(HASH_B);
  });

  it("stops on premints, burned tokens and unknown properties", async () => {
    vi.mocked(getSignContext).mockResolvedValueOnce(token({ isPremint: true }));
    expect(await makeOffer({ tokenId: "123", amountUsd: 9000, wallet: BUYER })).toHaveProperty("error");
    vi.mocked(getSignContext).mockResolvedValueOnce(token({ isBurned: true }));
    expect(await makeOffer({ tokenId: "123", amountUsd: 9000, wallet: BUYER })).toHaveProperty("error");
    vi.mocked(getSignContext).mockRejectedValueOnce(new FabricaApiError(["No token or premint found"]));
    expect(await makeOffer({ tokenId: "999", amountUsd: 9000, wallet: BUYER })).toEqual({ error: "No property found with token ID 999" });
  });

  it("says the server is not configured when no store is available", async () => {
    setSignRequestStore(null);
    vi.mocked(getSignContext).mockResolvedValue(token());
    const result = await makeOffer({ tokenId: "123", amountUsd: 9000, wallet: BUYER });
    expect(result).toHaveProperty("error");
    expect(result).toHaveProperty("propertyLink", "https://fabrica.land/property/ethereum/123");
  });
});

describe("list_land_for_sale", () => {
  it("refuses a wallet that does not hold the property", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token());
    expect(await listForSale({ tokenId: "123", priceUsd: 12000, wallet: BUYER })).toHaveProperty("error");
  });

  it("lets the borrower list a property a lending pool holds, with the loan warning", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token({
      majorityOwnerAddress: POOL,
      supplyUnderLoan: "1",
      balances: [{ balance: "1", holder: { address: POOL }, owner: { address: OWNER } }],
    }));
    const result = await listForSale({ tokenId: "123", priceUsd: 12000, wallet: OWNER });
    if (!("signRequest" in result)) throw new Error(JSON.stringify(result));
    expect(result.signRequest.signLink).toContain("action=list&price=12000&expires=180");
    expect(result.signRequest.warnings.some(w => w.message.includes("collateral for an active loan"))).toBe(true);
  });
});

describe("accept_land_offer, buy_land and cancel_land_order", () => {
  it("accept_land_offer prepares a signature for the holder of an open offer", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token({ marketplaceBids: [order({})] }));
    const result = await acceptOffer({ tokenId: "123", orderHash: HASH_A, wallet: OWNER });
    if (!("signRequest" in result)) throw new Error(JSON.stringify(result));
    expect(result.signRequest.signLink).toContain(`action=accept&order=${HASH_A}`);
    expect(result.signRequest.summary[0]).toContain("$10,000");
  });

  it("accept_land_offer refuses a listing, an expired offer and a wallet that does not hold the token", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token({ marketplaceBids: [order({ endTime: "2026-10-01T00:00:00Z" })], marketplaceListings: [order({ side: "sell", marketplaceId: HASH_B, makerAddress: OWNER })] }));
    expect(await acceptOffer({ tokenId: "123", orderHash: HASH_B, wallet: OWNER })).toHaveProperty("error");
    expect(await acceptOffer({ tokenId: "123", orderHash: HASH_A, wallet: OWNER })).toHaveProperty("error");
    vi.mocked(getSignContext).mockResolvedValue(token({ marketplaceBids: [order({})] }));
    expect(await acceptOffer({ tokenId: "123", orderHash: HASH_A, wallet: BUYER })).toHaveProperty("error");
  });

  it("buy prepares a transaction and lists the disclosures", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token({
      marketplaceListings: [order({ side: "sell", makerAddress: OWNER, disclosurePackage: [{ name: "Survey", url: "https://ipfs.fabrica.land/x" }] })],
    }));
    const result = await buy({ tokenId: "123", orderHash: HASH_A, wallet: BUYER });
    if (!("signRequest" in result)) throw new Error(JSON.stringify(result));
    expect(result.signRequest.kind).toBe("transaction");
    expect(result.signRequest.warnings.some(w => w.message.includes("Survey"))).toBe(true);
  });

  it("buy refuses the seller's own listing, an unbuyable encumbered one and a reserved one", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token({ marketplaceListings: [order({ side: "sell", makerAddress: OWNER })] }));
    expect(await buy({ tokenId: "123", orderHash: HASH_A, wallet: OWNER })).toHaveProperty("error");
    vi.mocked(getSignContext).mockResolvedValue(token({ marketplaceListings: [order({ side: "sell", makerAddress: OWNER, status: "encumbered", encumbrance: { buyable: false, blockReason: "UNDERWATER", loanId: "1" } })] }));
    expect(await buy({ tokenId: "123", orderHash: HASH_A, wallet: BUYER })).toHaveProperty("error");
    vi.mocked(getSignContext).mockResolvedValue(token({ marketplaceListings: [order({ side: "sell", makerAddress: OWNER, restrictedToAddresses: [POOL] })] }));
    expect(await buy({ tokenId: "123", orderHash: HASH_A, wallet: BUYER })).toHaveProperty("error");
  });

  it("cancel_land_order refuses an order past its end time even if the API still says active", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token({ marketplaceBids: [order({ endTime: "2026-10-01T00:00:00Z" })] }));
    expect(await cancelOrder({ tokenId: "123", orderHash: HASH_A, wallet: BUYER })).toHaveProperty("error");
  });

  it("cancel_land_order is for the maker only and needs no signature", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token({ marketplaceBids: [order({})] }));
    expect(await cancelOrder({ tokenId: "123", orderHash: HASH_A, wallet: OWNER })).toHaveProperty("error");
    const result = await cancelOrder({ tokenId: "123", orderHash: HASH_A, wallet: BUYER });
    if (!("signRequest" in result)) throw new Error(JSON.stringify(result));
    expect(result.signRequest.kind).toBe("offchain");
    expect(result.signRequest.signLink).toContain(`action=cancel&order=${HASH_A}`);
  });
});

describe("results", () => {
  const started = new Date(NOW + 60_000).toISOString();

  it("sees a new offer from the wallet at the requested price, and not one made before the request", async () => {
    const r = record();
    expect(await observe(r, token({ marketplaceBids: [order({ marketplaceId: HASH_B, price: "9000000000", startTime: started })] }))).toEqual({ orderHash: HASH_B });
    expect(await observe(r, token({ marketplaceBids: [order({ marketplaceId: HASH_B, price: "8000000000", startTime: started })] }))).toBeNull();
    expect(await observe(r, token({ marketplaceBids: [order({ marketplaceId: HASH_B, price: "9000000000", startTime: new Date(NOW - 60_000).toISOString() })] }))).toBeNull();
  });

  it("completes a buy only when this wallet's successful transaction filled the listing", async () => {
    const r = record({ action: "buy_land", kind: "transaction", order: undefined, orderHash: HASH_A });
    const filled = token({ marketplaceListings: [order({ side: "sell", makerAddress: OWNER, status: "filled", matchTransactionHash: TX })] });
    vi.mocked(getTransactionReceipt).mockResolvedValue({ status: "0x1", blockNumber: "0x1", gasUsed: "0x1" });
    vi.mocked(getTransaction).mockResolvedValue({ hash: TX, from: POOL, to: POOL, value: "0x0", blockNumber: "0x1" });
    expect(await observe(r, filled)).toBeNull();
    vi.mocked(getTransaction).mockResolvedValue({ hash: TX, from: BUYER, to: POOL, value: "0x0", blockNumber: "0x1" });
    expect(await observe(r, filled)).toEqual({ orderHash: HASH_A, transactionHash: TX });
    vi.mocked(getTransactionReceipt).mockResolvedValue({ status: "0x0", blockNumber: "0x1", gasUsed: "0x1" });
    expect(await observe(r, filled)).toBeNull();
  });

  it("accepts a reported order only when it matches the prepared terms", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token({ marketplaceBids: [order({ marketplaceId: HASH_B, price: "9000000000", startTime: started })] }));
    expect(await verifyResult(record(), { orderHash: HASH_B })).toEqual({ ok: true });
    expect((await verifyResult(record({ wallet: OWNER }), { orderHash: HASH_B })).ok).toBe(false);
    vi.mocked(getSignContext).mockResolvedValue(token({ marketplaceBids: [order({ marketplaceId: HASH_B, price: "1000000", startTime: started })] }));
    expect((await verifyResult(record(), { orderHash: HASH_B })).ok).toBe(false);
  });

  it("accepting an offer completes with the sell order reserved for the offer's maker", async () => {
    const r = record({ action: "accept_land_offer", wallet: OWNER, order: undefined, orderHash: HASH_A });
    const reserved = (restrictedToAddresses: string[]) => token({
      marketplaceBids: [order({})],
      marketplaceListings: [order({ side: "sell", marketplaceId: HASH_B, makerAddress: OWNER, startTime: started, restrictedToAddresses })],
    });
    vi.mocked(getSignContext).mockResolvedValue(reserved([BUYER]));
    expect(await verifyResult(r, { orderHash: HASH_B })).toEqual({ ok: true });
    vi.mocked(getSignContext).mockResolvedValue(reserved([POOL]));
    expect((await verifyResult(r, { orderHash: HASH_B })).ok).toBe(false);
  });

  it("accepts a transaction only when it is the one that filled the order", async () => {
    const r = record({ action: "buy_land", kind: "transaction", order: undefined, orderHash: HASH_A });
    vi.mocked(getTransaction).mockResolvedValue({ hash: TX, from: BUYER, to: POOL, value: "0x0", blockNumber: "0x1" });
    vi.mocked(getTransactionReceipt).mockResolvedValue({ status: "0x1", blockNumber: "0x1", gasUsed: "0x1" });
    vi.mocked(getSignContext).mockResolvedValue(token({ marketplaceListings: [order({ side: "sell", makerAddress: OWNER, status: "active" })] }));
    expect((await verifyResult(r, { transactionHash: TX })).ok).toBe(false);
    vi.mocked(getSignContext).mockResolvedValue(token({ marketplaceListings: [order({ side: "sell", makerAddress: OWNER, status: "filled", matchTransactionHash: TX })] }));
    expect(await verifyResult(r, { transactionHash: TX })).toEqual({ ok: true });
    expect((await verifyResult(record(), { transactionHash: TX })).ok).toBe(false);
  });

  it("get_sign_request completes a pending request the order book already shows", async () => {
    const r = record();
    await store.create(r);
    vi.mocked(getSignContext).mockResolvedValue(token({ marketplaceBids: [order({ marketplaceId: HASH_B, price: "9000000000", startTime: started })] }));
    const result = await getSignRequest({ id: r.id });
    expect(result).toMatchObject({ status: "completed", result: { orderHash: HASH_B } });
    expect(await getSignRequest({ id: newSignRequestId() })).toHaveProperty("error");
  });
});

describe("the sign page endpoints", () => {
  let httpServer: Server;
  let base: string;

  beforeAll(async () => {
    httpServer = createHttpServer((req, res) => void handleSignRequestHttp(req, res));
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    base = `http://127.0.0.1:${address.port}/sign-requests`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("serves the sign page's view with CORS, 404s an unknown id and 410s an expired one", async () => {
    const r = record();
    await store.create(r);
    const response = await fetch(`${base}/${r.id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toMatchObject({
      id: r.id,
      action: "offer",
      tool: "make_land_offer",
      network: "ethereum",
      tokenId: "123",
      maker: BUYER,
      params: { amountUsd: 9000, durationDays: 14, expiresAt: new Date(NOW + 14 * 86_400_000).toISOString() },
      summary: "Offer",
    });
    expect((await fetch(`${base}/${newSignRequestId()}`)).status).toBe(404);
    expect((await fetch(`${base}/${r.id}`, { method: "POST" })).status).toBe(405);
    vi.setSystemTime(NOW + 16 * 60_000);
    expect((await fetch(`${base}/${r.id}`)).status).toBe(410);
  });

  it("names the order for accept and cancel as orderId", () => {
    expect(signPageView(record({ action: "cancel_land_order", kind: "offchain", order: undefined, orderHash: HASH_A })).params).toEqual({ orderId: HASH_A });
    expect(signPageView(record({ action: "buy_land", kind: "transaction", order: undefined, orderHash: HASH_A })).action).toBe("accept");
  });

  it("records a checked result and refuses one that does not match", async () => {
    const r = record();
    await store.create(r);
    const started = new Date(NOW + 60_000).toISOString();
    vi.mocked(getSignContext).mockResolvedValue(token({ marketplaceBids: [order({ marketplaceId: HASH_B, makerAddress: OWNER, price: "9000000000", startTime: started })] }));
    const refused = await fetch(`${base}/${r.id}/result`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderHash: HASH_B }) });
    expect(refused.status).toBe(409);
    vi.mocked(getSignContext).mockResolvedValue(token({ marketplaceBids: [order({ marketplaceId: HASH_B, price: "9000000000", startTime: started })] }));
    const accepted = await fetch(`${base}/${r.id}/result`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderHash: HASH_B }) });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ status: "completed", result: { orderHash: HASH_B } });
    const bad = await fetch(`${base}/${r.id}/result`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ signature: "0x00" }) });
    expect(bad.status).toBe(400);
  });
});

describe("get_transaction_status", () => {
  it("reports pending, succeeded, failed and unknown transactions", async () => {
    vi.mocked(getBlockNumber).mockResolvedValue(110);
    vi.mocked(getTransaction).mockResolvedValue({ hash: TX, from: BUYER, to: POOL, value: "0x0", blockNumber: null });
    vi.mocked(getTransactionReceipt).mockResolvedValueOnce(null);
    expect(await getTransactionStatus({ hash: TX })).toMatchObject({ status: "pending" });
    vi.mocked(getTransactionReceipt).mockResolvedValueOnce({ status: "0x1", blockNumber: "0x64", gasUsed: "0x5208" });
    expect(await getTransactionStatus({ hash: TX })).toMatchObject({ status: "succeeded", blockNumber: 100, confirmations: 11 });
    vi.mocked(getTransactionReceipt).mockResolvedValueOnce({ status: "0x0", blockNumber: "0x64", gasUsed: "0x5208" });
    expect(await getTransactionStatus({ hash: TX })).toMatchObject({ status: "failed" });
    vi.mocked(getTransaction).mockResolvedValue(null);
    vi.mocked(getTransactionReceipt).mockResolvedValueOnce(null);
    expect(await getTransactionStatus({ hash: TX })).toMatchObject({ status: "not_found", explorer: `https://etherscan.io/tx/${TX}` });
  });
});
