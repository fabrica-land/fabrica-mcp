// Owner actions as sign requests: transfer_land, update_trust_agreement, update_land_description and
// update_land_photos check the live data, then return a sign request whose link opens the matching
// dialog on fabrica.land. Each one ends in an onchain transaction on the property's token that the
// holder signs with their own wallet. The server holds no key, signs nothing and submits nothing.
import { z } from "zod";
import type { AccountAuth } from "../auth/token.js";
import { getSignContext } from "../clients/graphql.js";
import { getBlockTimestamp, getTransactionReceipt } from "../clients/rpc.js";
import { CONTRACTS, IS_MAINNET, NETWORK_LABEL } from "../config.js";
import type { SignContextToken } from "../types/index.js";
import type { SignRequest, SignRequestWarning } from "../sign-requests/store.js";
import { type ArgsOf, propertyRefInputs } from "./inputs.js";
import { isLiveOrder } from "./marketplace.js";
import { getOwnWallets } from "./own-wallet.js";
import {
  type Blocked,
  issue,
  label,
  lookup,
  type OwnWallets,
  pickSigner,
  type Prepared,
  propertyOf,
  same,
  shorten,
  signLink,
  type WithSigner,
} from "./sign-requests.js";

export const OWNER_ACTIONS: ReadonlySet<SignRequest["action"]> = new Set(["transfer_land", "update_trust_agreement", "update_land_description", "update_land_photos"]);

export function isOwnerAction(record: Pick<SignRequest, "action">): boolean {
  return OWNER_ACTIONS.has(record.action);
}

/** The contract's thresholds: updateOperatingAgreement needs 70% of the supply, updateConfiguration 50%. */
const TRUST_SHARE = 70;
const CONFIGURATION_SHARE = 50;
/** The description editor on the property page keeps text to this length. */
export const DESCRIPTION_MAX = 5000;

const walletInput = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "A 0x-prefixed Ethereum address").describe("The wallet that holds the property and will sign (0x address). The sign page only lets this wallet sign.");

/** Shares held directly by the wallet (not through a loan), as the contract counts them. */
function directShares(token: SignContextToken, wallet: string): bigint {
  return (token.balances ?? [])
    .filter(b => same(b.holder.address, wallet) && /^\d+$/.test(b.balance))
    .reduce((sum, b) => sum + BigInt(b.balance), 0n);
}

/** The contract's percent check: floor(shares * 100 / supply) >= threshold. */
export function holdsShare(token: SignContextToken, wallet: string, threshold: number): boolean {
  const supply = /^\d+$/.test(token.supply ?? "") ? BigInt(token.supply) : 0n;
  if (supply === 0n) return false;
  return (directShares(token, wallet) * 100n) / supply >= BigInt(threshold);
}

function underLoan(token: SignContextToken): boolean {
  return Number.parseInt(token.supplyUnderLoan || "0", 10) > 0;
}

function before(token: SignContextToken): NonNullable<SignRequest["owner"]>["before"] {
  return { operatingAgreementName: token.operatingAgreementName ?? null, configurationUrl: token.configurationUrl ?? null, userDescription: descriptionOf(token), media: mediaOf(token) };
}

function descriptionOf(token: SignContextToken): string {
  return (token.configuration?.userDescription ?? "").trim();
}

function mediaOf(token: SignContextToken): string[] {
  return (token.configuration?.media ?? []).map(item => item.source);
}

const LOAN_BLOCK = "The property is collateral for an active loan, so the token is held by the loan and cannot be changed or moved until the loan is paid off (repay_loan_against_land).";

function openListings(token: SignContextToken, wallet: string): SignRequestWarning[] {
  const now = Date.now();
  const mine = (token.marketplaceListings ?? []).filter(order => same(order.makerAddress, wallet) && isLiveOrder(order, now));
  return mine.length
    ? [{ level: "warning", message: `This wallet has ${mine.length} open listing${mine.length === 1 ? "" : "s"} on the property. After the transfer ${mine.length === 1 ? "it" : "they"} can no longer be filled; cancel_land_order removes ${mine.length === 1 ? "it" : "them"}.` }]
    : [];
}

/** Pick the holding wallet with at least `threshold` percent of the supply, then the common checks. */
async function ownerContext(args: { tokenId?: string; slug?: string; wallet: string | OwnWallets }, threshold: number, what: string): Promise<{ token: SignContextToken; wallet: string; chosen: SignRequestWarning[] } | Blocked> {
  const found = await lookup(args.tokenId, args.slug);
  if ("error" in found) return found;
  const { token } = found;
  if (underLoan(token)) return { error: LOAN_BLOCK };
  const share = threshold === 100 ? "holds" : `holds at least ${threshold}% of`;
  const picked = pickSigner(args.wallet, address => holdsShare(token, address, threshold), `${share} ${label(token)}`, `only its owner can ${what}.`);
  if ("error" in picked) return picked;
  if (!holdsShare(token, picked.wallet, threshold)) return { error: `Wallet ${shorten(picked.wallet)} does not hold ${threshold === 100 ? "" : `at least ${threshold}% of `}${label(token)}; only its owner can ${what}.` };
  return { token, wallet: picked.wallet, chosen: picked.chosen };
}

// --- transfer_land ---

export const transferInput = {
  ...propertyRefInputs,
  recipient: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "A 0x-prefixed Ethereum address").describe("The account the property moves to (0x address). The sign page only offers accounts linked to the signer's own Fabrica login."),
  wallet: walletInput,
};
export type TransferArgs = ArgsOf<typeof transferInput>;

/**
 * The signed-in account's linked wallets, which the sign page offers as recipients. Read even when
 * the caller names the signing wallet itself; null when there is no account or they cannot be read,
 * and then the request carries a warning instead of a check.
 */
async function linkedWallets(wallet: WithSigner<TransferArgs>["wallet"], account: AccountAuth | undefined): Promise<OwnWallets["own"] | null> {
  if (typeof wallet === "object") return wallet.own;
  if (!account) return null;
  const own = await getOwnWallets(account);
  return "error" in own ? null : own;
}

export async function prepareTransfer(args: WithSigner<TransferArgs>, account?: AccountAuth): Promise<Prepared | Blocked> {
  const own = await linkedWallets(args.wallet, account);
  const signer = typeof args.wallet === "object" ? { own: args.wallet.own.filter(w => !same(w.address, args.recipient)) } : args.wallet;
  const context = await ownerContext({ ...args, wallet: signer }, 100, "transfer it");
  if ("error" in context) return context;
  const { token, wallet, chosen } = context;
  if (token.supply !== "1") return { error: `${label(token)} is split into ${token.supply} shares; transfers here move a whole property only.` };
  if (/^0x0{40}$/i.test(args.recipient)) return { error: "The recipient cannot be the zero address: a transfer there would lose the property." };
  if (same(args.recipient, wallet)) return { error: `The recipient ${shorten(args.recipient)} is the wallet that already holds the property.` };
  if (own && !own.some(w => same(w.address, args.recipient))) {
    return { error: `${shorten(args.recipient)} is not one of the accounts linked to this Fabrica login (${own.map(w => shorten(w.address)).join(", ")}). Transfers go only to the person's own linked accounts; selling to someone else is done with list_land_for_sale or accept_land_offer.`, accountWallets: own.map(w => w.address) };
  }
  const warnings: SignRequestWarning[] = [...chosen, ...openListings(token, wallet)];
  if (!own) warnings.push({ level: "info", message: "The sign page only offers accounts linked to the signer's own Fabrica login. A recipient outside that list cannot be chosen there." });
  return {
    action: "transfer_land",
    kind: "transaction",
    wallet,
    property: propertyOf(token),
    owner: { recipient: args.recipient, before: before(token) },
    summary: [
      `Transfer ${label(token)} from ${shorten(wallet)} to ${args.recipient} on ${NETWORK_LABEL}.`,
      "This is final: once the transaction confirms, the property belongs to the recipient account, and only that account can move it back.",
      ...(IS_MAINNET ? ["Ownership of the property moves with the token: whoever controls the recipient account owns the land."] : ["This is a test transfer on Sepolia with no real-world effect."]),
      "Signing sends an onchain transaction from this wallet.",
    ],
    warnings,
    link: id => signLink(token.tokenId, { action: "transfer", to: args.recipient }, id),
  };
}

// --- update_trust_agreement ---

export const trustInput = { ...propertyRefInputs, wallet: walletInput };
export type TrustArgs = ArgsOf<typeof trustInput>;

export async function prepareTrustUpdate(args: WithSigner<TrustArgs>): Promise<Prepared | Blocked> {
  const context = await ownerContext(args, TRUST_SHARE, "update its trust agreement");
  if ("error" in context) return context;
  const { token, wallet, chosen } = context;
  const current = token.operatingAgreementName;
  return {
    action: "update_trust_agreement",
    kind: "transaction",
    wallet,
    property: propertyOf(token),
    owner: { before: before(token) },
    summary: [
      `Move ${label(token)} to the latest version of the Fabrica trust agreement on ${NETWORK_LABEL}${current ? ` (it is on ${current} now)` : ""}.`,
      "The sign page shows the new agreement's name and text before signing, and says so when the property is already on the latest version.",
      "The update cannot be undone from the property page: earlier versions are not offered.",
      "Signing sends an onchain transaction from this wallet.",
    ],
    warnings: chosen,
    link: id => signLink(token.tokenId, { action: "trust" }, id),
  };
}

// --- update_land_description ---

export const descriptionInput = {
  ...propertyRefInputs,
  description: z.string().trim().min(1).max(DESCRIPTION_MAX).describe(`The property's new description, as plain text (up to ${DESCRIPTION_MAX} characters). It replaces the current one.`),
  wallet: walletInput,
};
export type DescriptionArgs = ArgsOf<typeof descriptionInput>;

export async function prepareDescription(args: WithSigner<DescriptionArgs>): Promise<Prepared | Blocked> {
  const context = await ownerContext(args, CONFIGURATION_SHARE, "edit its description");
  if ("error" in context) return context;
  const { token, wallet, chosen } = context;
  const text = args.description.trim();
  if (text === (token.configuration?.userDescription ?? "").trim()) return { error: "That is already the property's description." };
  return {
    action: "update_land_description",
    kind: "transaction",
    wallet,
    property: propertyOf(token),
    owner: { description: text, before: before(token) },
    summary: [
      `Replace the description of ${label(token)} on ${NETWORK_LABEL} with the prepared text (${text.length} characters).`,
      "The sign page opens the description editor with the text filled in; it can be edited there before saving.",
      "Saving stores the text with the property and sends an onchain transaction from this wallet that records it.",
    ],
    warnings: chosen,
    link: id => signLink(token.tokenId, { action: "describe" }, id),
  };
}

// --- update_land_photos ---

export const photosInput = { ...propertyRefInputs, wallet: walletInput };
export type PhotosArgs = ArgsOf<typeof photosInput>;

export async function preparePhotos(args: WithSigner<PhotosArgs>): Promise<Prepared | Blocked> {
  const context = await ownerContext(args, CONFIGURATION_SHARE, "edit its photos");
  if ("error" in context) return context;
  const { token, wallet, chosen } = context;
  const count = token.configuration?.media?.length ?? 0;
  return {
    action: "update_land_photos",
    kind: "transaction",
    wallet,
    property: propertyOf(token),
    owner: { before: before(token) },
    summary: [
      `Open the photo editor for ${label(token)} on ${NETWORK_LABEL} (${count} photo${count === 1 ? "" : "s"} and videos now).`,
      "Photos are chosen on the sign page from the person's own device: added, removed, reordered or given a cover there. Files are not sent through the conversation.",
      "Saving uploads the photos and sends an onchain transaction from this wallet that records them.",
    ],
    warnings: chosen,
    link: id => signLink(token.tokenId, { action: "media" }, id),
  };
}

export const transferLand = async (args: WithSigner<TransferArgs>, account?: AccountAuth) => issue(await prepareTransfer(args, account));
export const updateTrustAgreement = async (args: WithSigner<TrustArgs>) => issue(await prepareTrustUpdate(args));
export const updateDescription = async (args: WithSigner<DescriptionArgs>) => issue(await prepareDescription(args));
export const updatePhotos = async (args: WithSigner<PhotosArgs>) => issue(await preparePhotos(args));

// --- results ---

/** What the token says happened to an owner request, or null when it shows nothing yet. */
export function observeOwner(record: SignRequest, token: SignContextToken): boolean {
  const was = record.owner?.before;
  if (!was) return false;
  switch (record.action) {
    case "transfer_land":
      return !!record.owner?.recipient && holdsShare(token, record.owner.recipient, 100) && !holdsShare(token, record.wallet, 1);
    case "update_trust_agreement":
      return !!token.operatingAgreementName && token.operatingAgreementName !== was.operatingAgreementName;
    // The text can still be edited on the sign page, so any new description counts, not only the prepared one.
    case "update_land_description":
      return token.configurationUrl !== was.configurationUrl && descriptionOf(token) !== (was.userDescription ?? "").trim();
    // A description-only save also changes the configuration, so the photo list itself has to differ.
    case "update_land_photos":
      return !!token.configurationUrl && token.configurationUrl !== was.configurationUrl && was.media !== undefined && mediaOf(token).join("\n") !== was.media.join("\n");
    default:
      return false;
  }
}

/** The event each owner action's transaction emits from the token contract (FabricaToken.sol). */
const ACTION_EVENTS: Partial<Record<SignRequest["action"], string>> = {
  transfer_land: "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62", // TransferSingle(address,address,address,uint256,uint256)
  update_trust_agreement: "0x6b491e3cbe1a3d27a215d960a465834cf22a7e3e87ffe8be5724ab67f72583fb", // UpdateOperatingAgreement(uint256,string)
  update_land_description: "0xb56c2e2e610c525cd60429993be20aab298f5bc84e28ad1a0b8eb2c2ca855920", // UpdateConfiguration(uint256,string)
  update_land_photos: "0xb56c2e2e610c525cd60429993be20aab298f5bc84e28ad1a0b8eb2c2ca855920",
};

/** The 32-byte word at `index` of a log's data, as a number; null when the data is shorter. */
function dataWord(data: string | undefined, index: number): bigint | null {
  const word = (data ?? "").slice(2 + index * 64, 2 + (index + 1) * 64);
  return /^[0-9a-fA-F]{64}$/.test(word) ? BigInt(`0x${word}`) : null;
}

function topicAddress(topic: string | undefined): string {
  return `0x${(topic ?? "").slice(-40)}`;
}

/**
 * Whether a receipt log is this request's change: the action's event from the property's token
 * contract, for its token ID, and for a transfer from the request's wallet to its recipient.
 */
function provesAction(record: SignRequest, contract: string, log: { address: string; topics?: string[]; data?: string }): boolean {
  const topics = log.topics ?? [];
  if (!same(log.address, contract) || topics[0]?.toLowerCase() !== ACTION_EVENTS[record.action]) return false;
  // TransferSingle carries the token ID in data word 0 (after the indexed operator, from, to); the update events do too.
  if (dataWord(log.data, 0) !== BigInt(record.property.tokenId)) return false;
  if (record.action !== "transfer_land") return true;
  return same(topicAddress(topics[2]), record.wallet) && !!record.owner?.recipient && same(topicAddress(topics[3]), record.owner.recipient);
}

/**
 * An owner result holds when the transaction succeeded after the request was made, its receipt
 * carries the action's event for this property (so a smart account sending through its entry point
 * still counts, and an unrelated transaction on the same contract does not), and the token shows the change.
 */
export async function verifyOwnerResult(record: SignRequest, result: { transactionHash: string } | { orderHash: string }): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!("transactionHash" in result)) return { ok: false, reason: `A ${record.action} sign request completes with a transaction, not an order hash.` };
  const receipt = await getTransactionReceipt(result.transactionHash);
  if (receipt?.status !== "0x1") return { ok: false, reason: "The transaction did not succeed (yet)." };
  const contract = record.property.contractAddress || CONTRACTS.fabricaToken;
  if (!(receipt.logs ?? []).some(log => provesAction(record, contract, log))) return { ok: false, reason: "The transaction does not make this change to this property." };
  const minedAt = await getBlockTimestamp(receipt.blockNumber);
  if (minedAt === null || minedAt < Math.floor(Date.parse(record.createdAt) / 1000) * 1000) return { ok: false, reason: "The transaction was mined before this sign request was made." };
  const token = await getSignContext({ tokenId: record.property.tokenId });
  return observeOwner(record, token) ? { ok: true } : { ok: false, reason: "The property does not show this change (yet)." };
}
