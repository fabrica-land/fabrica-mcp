import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignContextToken } from "../types/index.js";

vi.mock("../clients/graphql.js", () => ({
  getSignContext: vi.fn(),
  getLoanContext: vi.fn(),
  isTokenNotFound: () => false,
}));
vi.mock("../clients/rpc.js", () => ({
  CHAIN_ID: 1,
  EXPLORER_URL: "https://etherscan.io",
  getTransaction: vi.fn(),
  getTransactionReceipt: vi.fn(),
  getBlockTimestamp: vi.fn(),
  getBlockNumber: vi.fn(),
}));

import { getSignContext } from "../clients/graphql.js";
import { getBlockTimestamp, getTransaction, getTransactionReceipt } from "../clients/rpc.js";
import { holdsShare, observeOwner, transferLand, updateDescription, updatePhotos, updateTrustAgreement } from "../tools/owner-actions.js";
import { getSignRequest, signPageView, verifyResult } from "../tools/sign-requests.js";
import { MemoryBackend, setSignRequestStore, SignRequestStore, type SignRequest } from "../sign-requests/store.js";
import type { AccountWallet } from "../clients/account.js";
import type { RpcReceipt, RpcTransaction } from "../clients/rpc.js";

const NOW = Date.parse("2026-11-03T00:00:00Z");
const OWNER = "0x2222222222222222222222222222222222222222";
const SECOND = "0x4444444444444444444444444444444444444444";
const STRANGER = "0x5555555555555555555555555555555555555555";
const CONTRACT = "0x5cbeb7A0df7Ed85D82a472FD56d81ed550f3Ea95";
const TX = `0x${"c".repeat(64)}`;

function token(overrides: Partial<SignContextToken> = {}): SignContextToken {
  return {
    tokenId: "123", name: "1 Test Road", vanityName: null, propertyLink: "https://fabrica.land/property/ethereum/123",
    contractAddress: CONTRACT, network: "ethereum", isPremint: false, claimState: null, supersededByTokenId: null,
    offRampStatus: null, isBurned: false, supply: "1", supplyUnderLoan: "0",
    operatingAgreementName: "Trust v4.3", configurationUrl: "ipfs://QmConfigBefore",
    configuration: { userDescription: "Old text", media: [{ source: "ipfs://QmPhoto" }] },
    estimatedValue: "10000", majorityOwnerAddress: OWNER,
    balances: [{ balance: "1", holder: { address: OWNER }, owner: { address: OWNER } }],
    marketplaceListings: [], marketplaceBids: [],
    ...overrides,
  };
}

const wallet = (address: string): AccountWallet => ({ address, kind: "external" });
const own = (...addresses: string[]): { own: AccountWallet[] } => ({ own: addresses.map(wallet) });
const transaction = (overrides: Partial<RpcTransaction> = {}): RpcTransaction => ({ hash: TX, from: OWNER, to: CONTRACT, value: "0x0", blockNumber: "0x1", ...overrides });
const receipt = (overrides: Partial<RpcReceipt> = {}): RpcReceipt => ({ status: "0x1", blockNumber: "0x1", gasUsed: "0x1", logs: [], ...overrides });

let store: SignRequestStore;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.mocked(getSignContext).mockReset();
  store = new SignRequestStore(new MemoryBackend(), "test-secret");
  setSignRequestStore(store);
});
afterEach(() => {
  vi.useRealTimers();
  setSignRequestStore(undefined);
});

function issuedId(result: object): string {
  if (!("signRequest" in result) || typeof result.signRequest !== "object" || result.signRequest === null || !("id" in result.signRequest) || typeof result.signRequest.id !== "string") throw new Error(`No sign request in ${JSON.stringify(result)}`);
  return result.signRequest.id;
}
async function stored(result: object): Promise<SignRequest> {
  expect(result).not.toHaveProperty("error");
  const record = await store.get(issuedId(result));
  if (!record) throw new Error("Sign request not stored");
  return record;
}

describe("holdsShare", () => {
  it("follows the contract's floor percent over directly held shares", () => {
    const split = token({ supply: "10", balances: [{ balance: "7", holder: { address: OWNER }, owner: { address: OWNER } }, { balance: "3", holder: { address: STRANGER }, owner: { address: STRANGER } }] });
    expect(holdsShare(split, OWNER, 70)).toBe(true);
    expect(holdsShare(split, STRANGER, 50)).toBe(false);
  });
  it("does not count a token held by a loan contract for its beneficial owner", () => {
    expect(holdsShare(token({ balances: [{ balance: "1", holder: { address: STRANGER }, owner: { address: OWNER } }] }), OWNER, 50)).toBe(false);
  });
});

describe("transfer_land", () => {
  it("prepares a transfer to another of the person's accounts, with the recipient in the link and the record", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token());
    const record = await stored(await transferLand({ tokenId: "123", recipient: SECOND, wallet: own(OWNER, SECOND) }));
    expect(record.action).toBe("transfer_land");
    expect(record.wallet).toBe(OWNER);
    expect(record.owner?.recipient).toBe(SECOND);
    expect(record.signLink).toContain("action=transfer");
    expect(record.signLink).toContain(`to=${SECOND}`);
    expect(record.summary.join(" ")).toMatch(/final/);
    expect(signPageView(record)).toMatchObject({ action: "transfer", params: { recipient: SECOND } });
  });
  it("refuses a recipient outside the connected account's wallets", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token());
    const result = await transferLand({ tokenId: "123", recipient: STRANGER, wallet: own(OWNER, SECOND) });
    expect(result).toMatchObject({ error: expect.stringContaining("not one of the accounts linked") });
  });
  it("refuses the holder as recipient, the zero address, a split property and a property under loan", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token());
    expect(await transferLand({ tokenId: "123", recipient: OWNER, wallet: OWNER })).toHaveProperty("error");
    expect(await transferLand({ tokenId: "123", recipient: `0x${"0".repeat(40)}`, wallet: OWNER })).toHaveProperty("error");
    vi.mocked(getSignContext).mockResolvedValue(token({ supply: "2", balances: [{ balance: "2", holder: { address: OWNER }, owner: { address: OWNER } }] }));
    expect(await transferLand({ tokenId: "123", recipient: SECOND, wallet: OWNER })).toMatchObject({ error: expect.stringContaining("shares") });
    vi.mocked(getSignContext).mockResolvedValue(token({ supplyUnderLoan: "1" }));
    expect(await transferLand({ tokenId: "123", recipient: SECOND, wallet: OWNER })).toMatchObject({ error: expect.stringContaining("loan") });
  });
  it("refuses a wallet that does not hold the property", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token());
    expect(await transferLand({ tokenId: "123", recipient: SECOND, wallet: STRANGER })).toHaveProperty("error");
  });
  it("completes once the recipient holds the property", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token());
    const record = await stored(await transferLand({ tokenId: "123", recipient: SECOND, wallet: OWNER }));
    vi.mocked(getSignContext).mockResolvedValue(token({ majorityOwnerAddress: SECOND, balances: [{ balance: "1", holder: { address: SECOND }, owner: { address: SECOND } }] }));
    expect(await getSignRequest({ id: record.id })).toMatchObject({ status: "completed" });
  });
});

describe("update_trust_agreement", () => {
  it("needs 70% of the property and links to the trust action", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token());
    const record = await stored(await updateTrustAgreement({ tokenId: "123", wallet: OWNER }));
    expect(record.signLink).toContain("action=trust");
    expect(record.owner?.before.operatingAgreementName).toBe("Trust v4.3");
    vi.mocked(getSignContext).mockResolvedValue(token({ supply: "10", balances: [{ balance: "6", holder: { address: OWNER }, owner: { address: OWNER } }] }));
    expect(await updateTrustAgreement({ tokenId: "123", wallet: OWNER })).toHaveProperty("error");
  });
  it("is observed when the agreement name changes", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token());
    const record = await stored(await updateTrustAgreement({ tokenId: "123", wallet: OWNER }));
    expect(observeOwner(record, token())).toBe(false);
    expect(observeOwner(record, token({ operatingAgreementName: "Trust v4.4" }))).toBe(true);
  });
});

describe("update_land_description", () => {
  it("stores the text for the sign page, and refuses an unchanged one", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token());
    const record = await stored(await updateDescription({ tokenId: "123", description: "  Ten acres of high desert.  ", wallet: OWNER }));
    expect(record.owner?.description).toBe("Ten acres of high desert.");
    expect(signPageView(record)).toMatchObject({ action: "describe", params: { description: "Ten acres of high desert." } });
    expect(await updateDescription({ tokenId: "123", description: "Old text", wallet: OWNER })).toHaveProperty("error");
  });
  it("is observed when a new configuration changes the description, edited on the page or not", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token());
    const record = await stored(await updateDescription({ tokenId: "123", description: "New", wallet: OWNER }));
    const photos = [{ source: "ipfs://QmPhoto" }];
    expect(observeOwner(record, token({ configurationUrl: "ipfs://QmOther", configuration: { userDescription: "Old text", media: [] } }))).toBe(false);
    expect(observeOwner(record, token({ configurationUrl: "ipfs://QmNew", configuration: { userDescription: "New", media: photos } }))).toBe(true);
    expect(observeOwner(record, token({ configurationUrl: "ipfs://QmNew", configuration: { userDescription: "New, edited", media: photos } }))).toBe(true);
  });
});

describe("update_land_photos", () => {
  it("opens the photo editor and completes on a new configuration", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token());
    const record = await stored(await updatePhotos({ tokenId: "123", wallet: OWNER }));
    expect(record.signLink).toContain("action=media");
    expect(observeOwner(record, token({ configurationUrl: "ipfs://QmNew", configuration: { userDescription: "Old text", media: [{ source: "ipfs://QmPhoto2" }] } }))).toBe(true);
  });
  it("is not observed when only the description changed", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token());
    const record = await stored(await updatePhotos({ tokenId: "123", wallet: OWNER }));
    expect(observeOwner(record, token({ configurationUrl: "ipfs://QmNew", configuration: { userDescription: "New text", media: [{ source: "ipfs://QmPhoto" }] } }))).toBe(false);
  });
});

describe("verifyResult for owner actions", () => {
  it("accepts a successful transaction to the token contract that made the change", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token());
    const record = await stored(await updatePhotos({ tokenId: "123", wallet: OWNER }));
    vi.mocked(getTransaction).mockResolvedValue(transaction());
    vi.mocked(getTransactionReceipt).mockResolvedValue(receipt());
    vi.mocked(getBlockTimestamp).mockResolvedValue(NOW + 5_000);
    vi.mocked(getSignContext).mockResolvedValue(token({ configurationUrl: "ipfs://QmNew", configuration: { userDescription: "Old text", media: [] } }));
    expect(await verifyResult(record, { transactionHash: TX })).toEqual({ ok: true });
  });
  it("refuses an order hash, a failed transaction and one mined before the request", async () => {
    vi.mocked(getSignContext).mockResolvedValue(token());
    const record = await stored(await updatePhotos({ tokenId: "123", wallet: OWNER }));
    expect(await verifyResult(record, { orderHash: TX })).toMatchObject({ ok: false });
    vi.mocked(getTransaction).mockResolvedValue(transaction());
    vi.mocked(getTransactionReceipt).mockResolvedValue(receipt({ status: "0x0" }));
    expect(await verifyResult(record, { transactionHash: TX })).toMatchObject({ ok: false });
    vi.mocked(getTransactionReceipt).mockResolvedValue(receipt());
    vi.mocked(getBlockTimestamp).mockResolvedValue(NOW - 60_000);
    expect(await verifyResult(record, { transactionHash: TX })).toMatchObject({ ok: false });
  });
});
