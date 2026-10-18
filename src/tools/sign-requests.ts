// Write tools as sign requests (ENG-5073): make_offer, list_for_sale, accept_offer, buy and
// cancel_order check the live data, then return a sign request whose link opens the matching
// dialog on fabrica.land, prefilled. The person signs there with their own wallet. The server
// holds no key, signs nothing and submits nothing: it prepares, the person decides.
import { z } from "zod";
import { getSignContext, isTokenNotFound } from "../clients/graphql.js";
import { CHAIN_ID, getTransaction } from "../clients/rpc.js";
import { IS_MAINNET, MAINNET_WARNING, NETWORK, NETWORK_LABEL } from "../config.js";
import type { OrderBookOrder, SignContextToken } from "../types/index.js";
import {
  getSignRequestStore,
  newSignRequestId,
  SIGN_REQUEST_TTL_SECONDS,
  type SignRequest,
  type SignRequestWarning,
} from "../sign-requests/store.js";
import { formatTokenAmount, isLiveOrder, relativeExpiry } from "./marketplace.js";
import { type ArgsOf, propertyRefInputs } from "./inputs.js";

/** Orders are priced in USDC, which Fabrica counts one for one as dollars, with 6 decimals (as the web app builds them). */
const CURRENCY = { symbol: "USDC", decimals: 6 } as const;
/** The web app's defaults: offers last 14 days, listings 180. */
export const OFFER_DAYS = 14;
export const LISTING_DAYS = 180;
/** A price below half or above twice the estimate gets a warning. */
const FAR_BELOW = 0.5;
const FAR_ABOVE = 2;
const DAY_MS = 86_400_000;

export const PREPARED_STATUS = "Prepared, not sent. Nothing happens until the person opens the sign link and signs with their own wallet.";
const PAYLOAD_NOTE = "payload is null: the order is built on the sign page from the person's own session. Signing from a wallet inside the conversation comes later.";

const walletInput = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "A 0x-prefixed Ethereum address").describe("The wallet that will sign (0x address). The sign page only lets this wallet sign.");
const orderHashInput = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "A 0x-prefixed 32-byte order hash").describe("The order's hash: orderId in get_order_book");

type Lookup = { token: SignContextToken } | { error: string };
type Prepared = Omit<SignRequest, "id" | "status" | "network" | "chainId" | "payload" | "createdAt" | "expiresAt" | "signLink" | "result"> & {
  link: (id: string) => string;
};
type Blocked = { error: string; warnings?: SignRequestWarning[] };

const same = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase();

const shorten = (address: string): string => `${address.slice(0, 6)}...${address.slice(-4)}`;

function usd(amount: number): string {
  return `$${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/** Dollars to raw USDC units, rounded to the cent: 250000 → "250000000000". */
export function usdToRaw(amountUsd: number): string {
  const cents = BigInt(Math.round(amountUsd * 100));
  return (cents * 10n ** BigInt(CURRENCY.decimals - 2)).toString();
}

/** The property link with the sign-link query (ENG-5071 routes) and the request id. */
export function signLink(propertyLink: string, params: Record<string, string>, id: string): string {
  const url = new URL(propertyLink);
  for (const [key, value] of Object.entries({ ...params, signRequest: id })) url.searchParams.set(key, value);
  return url.toString();
}

async function lookup(tokenId: string | undefined, slug: string | undefined): Promise<Lookup> {
  if (!tokenId && !slug) return { error: "Either tokenId or slug is required" };
  const name = tokenId ? `token ID ${tokenId}` : `slug ${slug}`;
  let token: SignContextToken;
  try {
    token = await getSignContext({ tokenId, slug });
  } catch (e) {
    if (isTokenNotFound(e)) return { error: `No property found with ${name}` };
    return { error: `Failed to load the property: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (token.isPremint && token.supersededByTokenId) {
    return { error: `Token ${token.tokenId} was a premint that has been replaced by minted token ${token.supersededByTokenId}; prepare the action on ${token.supersededByTokenId}.` };
  }
  if (token.isPremint) return { error: "This property is a premint (its token has not been minted yet). Sign requests cover minted properties only for now; offers on a premint are made on its property page." };
  if (token.isBurned) return { error: "This property's token has been burned: it is no longer on Fabrica, so it cannot be bought, sold or offered on." };
  if (token.offRampStatus) return { error: "This property is being removed from Fabrica (off-ramp in progress), so marketplace actions are closed on it." };
  return { token };
}

/** The wallet holds the token, directly or as the beneficial owner of a token held by a loan. */
export function holds(token: SignContextToken, wallet: string): boolean {
  if (same(token.majorityOwnerAddress, wallet)) return true;
  return (token.balances ?? []).some(b => BigInt(/^\d+$/.test(b.balance) ? b.balance : "0") > 0n && (same(b.holder.address, wallet) || same(b.owner.address, wallet)));
}

function underLoan(token: SignContextToken): boolean {
  return Number.parseInt(token.supplyUnderLoan || "0", 10) > 0;
}

function priceWarning(amountUsd: number, token: SignContextToken, what: string): SignRequestWarning[] {
  const estimate = Number.parseFloat(token.estimatedValue);
  if (!Number.isFinite(estimate) || estimate <= 0) return [];
  const ratio = amountUsd / estimate;
  if (ratio < FAR_BELOW) return [{ level: "warning", message: `The ${what} of ${usd(amountUsd)} is ${Math.floor((1 - ratio) * 100)}% below Fabrica's estimate of ${usd(estimate)}.` }];
  if (ratio > FAR_ABOVE) return [{ level: "warning", message: `The ${what} of ${usd(amountUsd)} is ${Math.round(ratio * 100 - 100)}% above Fabrica's estimate of ${usd(estimate)}.` }];
  return [];
}

function liveOrders(orders: OrderBookOrder[] | null, now: number): OrderBookOrder[] {
  return (orders ?? []).filter(order => isLiveOrder(order, now));
}

function findOrder(token: SignContextToken, hash: string): OrderBookOrder | null {
  return [...(token.marketplaceListings ?? []), ...(token.marketplaceBids ?? [])].find(order => same(order.marketplaceId, hash)) ?? null;
}

function propertyOf(token: SignContextToken): SignRequest["property"] {
  return { tokenId: token.tokenId, contractAddress: token.contractAddress, name: token.name ?? token.vanityName ?? null, link: token.propertyLink };
}

function label(token: SignContextToken): string {
  return `${token.name ?? token.vanityName ?? "the property"} (token ${token.tokenId})`;
}

function orderPrice(order: OrderBookOrder): string {
  const dollars = Number.parseFloat(order.usdPrice ?? "");
  return Number.isFinite(dollars) ? usd(dollars) : formatTokenAmount(order.price, order.decimals, order.symbol);
}

function expiringSoon(order: OrderBookOrder, now: number): SignRequestWarning[] {
  const end = order.endTime ? Date.parse(order.endTime) : Number.NaN;
  if (Number.isNaN(end) || end - now > DAY_MS) return [];
  return [{ level: "warning", message: `This order expires ${relativeExpiry(order.endTime, now)}; sign before then.` }];
}

/** Store the request and shape the tool's answer. */
async function issue(prepared: Prepared | Blocked) {
  if ("error" in prepared) return prepared;
  const store = getSignRequestStore();
  if (!store) return { error: "Sign requests are not configured on this server yet. The same action can be taken on the property page.", propertyLink: prepared.property.link };
  const id = newSignRequestId();
  const now = Date.now();
  const { link, ...fields } = prepared;
  const record: SignRequest = {
    ...fields,
    id,
    status: "pending",
    network: NETWORK,
    chainId: CHAIN_ID,
    signLink: link(id),
    payload: null,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SIGN_REQUEST_TTL_SECONDS * 1000).toISOString(),
  };
  try {
    await store.create(record);
  } catch (e) {
    return { error: `Could not save the sign request: ${e instanceof Error ? e.message : String(e)}. The same action can be taken on the property page.`, propertyLink: record.property.link };
  }
  return {
    ...(MAINNET_WARNING ? { legalNotice: MAINNET_WARNING } : {}),
    network: NETWORK_LABEL,
    status: PREPARED_STATUS,
    signRequest: {
      id: record.id,
      action: record.action,
      kind: record.kind,
      summary: record.summary,
      signLink: record.signLink,
      wallet: record.wallet,
      payload: record.payload,
      payloadNote: PAYLOAD_NOTE,
      expiresAt: record.expiresAt,
      warnings: record.warnings,
    },
    nextSteps: [
      `The person opens signLink in a browser, signs in to ${new URL(record.property.link).host} with wallet ${record.wallet}, reviews the dialog and signs. The link stays open for ${SIGN_REQUEST_TTL_SECONDS / 60} minutes (until ${record.expiresAt}).`,
      `get_sign_request with id ${record.id} says whether it was signed; get_order_book shows the order once it is.`,
    ],
  };
}

// --- make_offer ---

export const makeOfferInput = {
  ...propertyRefInputs,
  amountUsd: z.number().min(1).max(1_000_000_000).describe("Offer amount in US dollars, paid in USDC (one USDC counts as one dollar)"),
  expiresDays: z.number().int().min(1).max(180).optional().describe(`Days the offer stays open (default ${OFFER_DAYS})`),
  wallet: walletInput,
};
export type MakeOfferArgs = ArgsOf<typeof makeOfferInput>;

export async function prepareOffer({ tokenId, slug, amountUsd, expiresDays, wallet }: MakeOfferArgs): Promise<Prepared | Blocked> {
  const found = await lookup(tokenId, slug);
  if ("error" in found) return found;
  const { token } = found;
  if (holds(token, wallet)) return { error: `Wallet ${shorten(wallet)} already holds ${label(token)}, so it cannot make an offer on it.` };
  const now = Date.now();
  const days = expiresDays ?? OFFER_DAYS;
  const warnings: SignRequestWarning[] = [...priceWarning(amountUsd, token, "offer")];
  const lowest = liveOrders(token.marketplaceListings, now)
    .filter(order => Number.parseFloat(order.usdPrice ?? "") <= amountUsd)
    .sort((a, b) => Number.parseFloat(a.usdPrice ?? "") - Number.parseFloat(b.usdPrice ?? ""))[0];
  if (lowest) warnings.push({ level: "info", message: `It is listed for ${orderPrice(lowest)}, at or below this offer: buy (order ${lowest.marketplaceId}) takes the listing as is.` });
  if (underLoan(token)) warnings.push({ level: "info", message: "The property is collateral for an active loan; if the owner accepts, the loan is paid off from the sale at settlement." });
  return {
    action: "make_offer",
    kind: "typedData",
    wallet,
    property: propertyOf(token),
    order: { side: "buy", priceUsd: String(amountUsd), price: usdToRaw(amountUsd), symbol: CURRENCY.symbol, decimals: CURRENCY.decimals, durationDays: days, supply: "1" },
    summary: [
      `Offer ${usd(amountUsd)} (${formatTokenAmount(usdToRaw(amountUsd), CURRENCY.decimals, CURRENCY.symbol)}) for ${label(token)} on ${NETWORK_LABEL}.`,
      `The offer stays open for ${days} day${days === 1 ? "" : "s"} unless canceled.`,
      "Signing creates the offer; no money moves unless the owner accepts it. The digital dollars stay in the wallet until then.",
      "If the wallet has not yet allowed the marketplace to use its USDC, the sign page asks for that approval first.",
    ],
    warnings,
    link: id => signLink(token.propertyLink, { action: "offer", amount: String(amountUsd), expires: String(days) }, id),
  };
}

// --- list_for_sale ---

export const listForSaleInput = {
  ...propertyRefInputs,
  priceUsd: z.number().min(1).max(1_000_000_000).describe("Asking price in US dollars, paid in USDC"),
  expiresDays: z.number().int().min(1).max(365).optional().describe(`Days the listing stays open (default ${LISTING_DAYS})`),
  wallet: walletInput,
};
export type ListForSaleArgs = ArgsOf<typeof listForSaleInput>;

export async function prepareListing({ tokenId, slug, priceUsd, expiresDays, wallet }: ListForSaleArgs): Promise<Prepared | Blocked> {
  const found = await lookup(tokenId, slug);
  if ("error" in found) return found;
  const { token } = found;
  if (!holds(token, wallet)) return { error: `Wallet ${shorten(wallet)} does not hold ${label(token)}; only its owner can list it for sale.` };
  const now = Date.now();
  const days = expiresDays ?? LISTING_DAYS;
  const warnings: SignRequestWarning[] = [...priceWarning(priceUsd, token, "price")];
  const own = liveOrders(token.marketplaceListings, now).filter(order => same(order.makerAddress, wallet));
  for (const order of own) warnings.push({ level: "warning", message: `This wallet already lists it for ${orderPrice(order)} (order ${order.marketplaceId}); cancel_order removes that listing.` });
  const best = liveOrders(token.marketplaceBids, now)
    .filter(order => Number.parseFloat(order.usdPrice ?? "") >= priceUsd)
    .sort((a, b) => Number.parseFloat(b.usdPrice ?? "") - Number.parseFloat(a.usdPrice ?? ""))[0];
  if (best) warnings.push({ level: "info", message: `There is an offer of ${orderPrice(best)}, at or above this price: accept_offer (order ${best.marketplaceId}) takes it.` });
  if (underLoan(token)) warnings.push({ level: "warning", message: "The property is collateral for an active loan: the sale pays the loan off first, so the price has to cover the payoff, and the listing can only be bought once the payoff is approved." });
  return {
    action: "list_for_sale",
    kind: "typedData",
    wallet,
    property: propertyOf(token),
    order: { side: "sell", priceUsd: String(priceUsd), price: usdToRaw(priceUsd), symbol: CURRENCY.symbol, decimals: CURRENCY.decimals, durationDays: days, supply: "1" },
    summary: [
      `List ${label(token)} for sale at ${usd(priceUsd)} (${formatTokenAmount(usdToRaw(priceUsd), CURRENCY.decimals, CURRENCY.symbol)}) on ${NETWORK_LABEL}.`,
      `The listing stays open for ${days} day${days === 1 ? "" : "s"} unless canceled. Anyone can buy at this price while it is open.`,
      "The marketplace fee is shown on the sign page before signing and is taken from the proceeds.",
      "If the wallet has not yet allowed the marketplace to transfer its Fabrica tokens, the sign page asks for that approval first.",
      ...(IS_MAINNET ? ["A sale transfers the beneficial interest in the trust that holds the land and can trigger tax events."] : []),
    ],
    warnings,
    link: id => signLink(token.propertyLink, { action: "list", price: String(priceUsd), expires: String(days) }, id),
  };
}

// --- accept_offer, buy, cancel_order ---

export const orderActionInput = {
  ...propertyRefInputs,
  orderHash: orderHashInput,
  wallet: walletInput,
};
export type OrderActionArgs = ArgsOf<typeof orderActionInput>;

async function loadOrder({ tokenId, slug, orderHash }: OrderActionArgs): Promise<{ token: SignContextToken; order: OrderBookOrder } | { error: string }> {
  const found = await lookup(tokenId, slug);
  if ("error" in found) return found;
  const order = findOrder(found.token, orderHash);
  if (!order) return { error: `No order ${orderHash} on ${label(found.token)}. get_order_book lists its orders and their orderId.` };
  return { token: found.token, order };
}

export async function prepareAccept(args: OrderActionArgs): Promise<Prepared | Blocked> {
  const loaded = await loadOrder(args);
  if ("error" in loaded) return loaded;
  const { token, order } = loaded;
  const now = Date.now();
  if (order.side !== "buy") return { error: `Order ${args.orderHash} is a listing, not an offer; buy takes a listing.` };
  if (!isLiveOrder(order, now)) return { error: `The offer ${args.orderHash} is no longer open (${order.status}${order.endTime && Date.parse(order.endTime) < now ? `, expired ${relativeExpiry(order.endTime, now)}` : ""}).` };
  if (!holds(token, args.wallet)) return { error: `Wallet ${shorten(args.wallet)} does not hold ${label(token)}; only its owner can accept an offer on it.` };
  const dollars = Number.parseFloat(order.usdPrice ?? "");
  const warnings: SignRequestWarning[] = [...expiringSoon(order, now), ...(Number.isFinite(dollars) ? priceWarning(dollars, token, "offer") : [])];
  if (underLoan(token)) warnings.push({ level: "warning", message: "The property is collateral for an active loan: the sale pays the loan off first and the rest comes to the seller." });
  return {
    action: "accept_offer",
    kind: "typedData",
    wallet: args.wallet,
    property: propertyOf(token),
    orderHash: order.marketplaceId,
    summary: [
      `Accept the offer of ${orderPrice(order)} from ${shorten(order.makerAddress)} for ${label(token)} on ${NETWORK_LABEL}.`,
      "Signing sells the property: the token goes to the buyer and the USDC, less the marketplace fee shown on the sign page, comes to this wallet when the sale settles onchain.",
      "If the wallet has not yet allowed the marketplace to transfer its Fabrica tokens, the sign page asks for that approval first.",
      ...(IS_MAINNET ? ["A sale transfers the beneficial interest in the trust that holds the land and can trigger tax events."] : []),
    ],
    warnings,
    link: id => signLink(token.propertyLink, { action: "accept", order: order.marketplaceId }, id),
  };
}

export async function prepareBuy(args: OrderActionArgs): Promise<Prepared | Blocked> {
  const loaded = await loadOrder(args);
  if ("error" in loaded) return loaded;
  const { token, order } = loaded;
  const now = Date.now();
  if (order.side !== "sell") return { error: `Order ${args.orderHash} is an offer, not a listing; accept_offer takes an offer.` };
  if (!isLiveOrder(order, now)) return { error: `The listing ${args.orderHash} is no longer open (${order.status}).` };
  if (same(order.makerAddress, args.wallet)) return { error: "This wallet made the listing; it cannot buy its own listing." };
  if (order.encumbrance && !order.encumbrance.buyable) {
    return { error: `This listing cannot be bought right now: the property is collateral for a loan and the payoff is not ready (${order.encumbrance.blockReason ?? "unknown reason"}). get_order_book explains each listing's state.` };
  }
  if (order.restrictedToAddresses?.length && !order.restrictedToAddresses.some(address => same(address, args.wallet))) {
    return { error: `This listing is reserved for ${order.restrictedToAddresses.map(shorten).join(", ")}; wallet ${shorten(args.wallet)} cannot buy it.` };
  }
  const warnings: SignRequestWarning[] = [...expiringSoon(order, now)];
  const dollars = Number.parseFloat(order.usdPrice ?? "");
  if (Number.isFinite(dollars)) warnings.push(...priceWarning(dollars, token, "price"));
  if (order.disclosurePackage?.length) warnings.push({ level: "info", message: `The seller attached ${order.disclosurePackage.length} disclosure document${order.disclosurePackage.length === 1 ? "" : "s"}; the sign page shows them before buying: ${order.disclosurePackage.map(d => d.name).join(", ")}.` });
  if (order.encumbrance) warnings.push({ level: "info", message: "The property is collateral for a loan that the purchase pays off at settlement; the buyer receives it free of the loan." });
  return {
    action: "buy",
    kind: "transaction",
    wallet: args.wallet,
    property: propertyOf(token),
    orderHash: order.marketplaceId,
    summary: [
      `Buy ${label(token)} for ${orderPrice(order)} on ${NETWORK_LABEL}, from ${shorten(order.makerAddress)}.`,
      "Signing sends an onchain transaction from this wallet: the USDC goes to the seller and the token comes to this wallet. The wallet pays the network fee.",
      "If the wallet has not yet allowed the marketplace to use its USDC, the sign page asks for that approval first.",
      ...(IS_MAINNET ? ["The buyer becomes the holder of the beneficial interest in the trust that holds the land, with the obligations tied to it (property taxes among them)."] : []),
    ],
    warnings,
    link: id => signLink(token.propertyLink, { action: "accept", order: order.marketplaceId }, id),
  };
}

export async function prepareCancel(args: OrderActionArgs): Promise<Prepared | Blocked> {
  const loaded = await loadOrder(args);
  if ("error" in loaded) return loaded;
  const { token, order } = loaded;
  if (order.status !== "active" && order.status !== "encumbered") return { error: `Order ${args.orderHash} is ${order.status}, so there is nothing to cancel.` };
  if (!same(order.makerAddress, args.wallet)) return { error: `Order ${args.orderHash} was made by ${shorten(order.makerAddress)}; only its maker can cancel it.` };
  const what = order.side === "sell" ? "listing" : "offer";
  return {
    action: "cancel_order",
    kind: "offchain",
    wallet: args.wallet,
    property: propertyOf(token),
    orderHash: order.marketplaceId,
    summary: [
      `Cancel the ${what} of ${orderPrice(order)} on ${label(token)}.`,
      `Confirming on the sign page (signed in with this wallet) takes the ${what} off the marketplace. No transaction and no network fee.`,
    ],
    warnings: [],
    link: id => signLink(token.propertyLink, { action: "cancel", order: order.marketplaceId }, id),
  };
}

export const makeOffer = async (args: MakeOfferArgs) => issue(await prepareOffer(args));
export const listForSale = async (args: ListForSaleArgs) => issue(await prepareListing(args));
export const acceptOffer = async (args: OrderActionArgs) => issue(await prepareAccept(args));
export const buy = async (args: OrderActionArgs) => issue(await prepareBuy(args));
export const cancelOrder = async (args: OrderActionArgs) => issue(await prepareCancel(args));

// --- results: what the sign page reports, and what the order book shows ---

/**
 * What the order book says happened to a request, or null when it shows nothing yet. Offers and
 * listings: a live order from the wallet at the requested price, started after the request.
 * Cancel and buy: the named order is canceled or filled.
 */
export function observe(record: SignRequest, token: SignContextToken): { orderHash: string } | null {
  const now = Date.now();
  if ((record.action === "make_offer" || record.action === "list_for_sale") && record.order) {
    const orders = record.action === "make_offer" ? token.marketplaceBids : token.marketplaceListings;
    const created = Date.parse(record.createdAt) - 5 * 60_000;
    const match = liveOrders(orders, now).find(order => same(order.makerAddress, record.wallet) && order.price === record.order?.price && Date.parse(order.startTime) >= created);
    return match ? { orderHash: match.marketplaceId } : null;
  }
  if (!record.orderHash) return null;
  const order = findOrder(token, record.orderHash);
  if (!order) return null;
  if (record.action === "cancel_order" && order.status === "canceled") return { orderHash: order.marketplaceId };
  if ((record.action === "buy" || record.action === "accept_offer") && order.status === "filled") return { orderHash: order.marketplaceId };
  return null;
}

export const signResultSchema = z.union([
  z.object({ orderHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict(),
  z.object({ transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict(),
]);
export type SignResult = z.infer<typeof signResultSchema>;

/** Check a result the sign page reports against the API or the chain; a reason when it does not hold. */
export async function verifyResult(record: SignRequest, result: SignResult): Promise<{ ok: true } | { ok: false; reason: string }> {
  if ("transactionHash" in result) {
    if (record.action !== "buy" && record.action !== "accept_offer") return { ok: false, reason: `A ${record.action} sign request completes with an order hash, not a transaction.` };
    const transaction = await getTransaction(result.transactionHash);
    if (!transaction) return { ok: false, reason: "The transaction is not on the network (yet)." };
    if (!same(transaction.from, record.wallet)) return { ok: false, reason: "The transaction was not sent by the request's wallet." };
    return { ok: true };
  }
  const token = await getSignContext({ tokenId: record.property.tokenId });
  const order = findOrder(token, result.orderHash);
  if (!order) return { ok: false, reason: "No order with that hash on this property." };
  const named = same(order.marketplaceId, record.orderHash);
  const madeByWallet = same(order.makerAddress, record.wallet);
  const holds = (() => {
    switch (record.action) {
      case "make_offer": return order.side === "buy" && madeByWallet;
      case "list_for_sale": return order.side === "sell" && madeByWallet;
      case "accept_offer": return (order.side === "sell" && madeByWallet) || (named && order.status === "filled");
      case "buy": return named && order.status === "filled";
      case "cancel_order": return named && order.status === "canceled";
    }
  })();
  return holds ? { ok: true } : { ok: false, reason: `The order does not show this ${record.action} as done.` };
}

// --- get_sign_request ---

export const getSignRequestInput = {
  id: z.string().describe("The sign request id (sr_...) a prepare tool returned"),
};
export type GetSignRequestArgs = ArgsOf<typeof getSignRequestInput>;

export async function getSignRequest({ id }: GetSignRequestArgs) {
  const store = getSignRequestStore();
  if (!store) return { error: "Sign requests are not configured on this server yet." };
  let record: SignRequest | null;
  try {
    record = await store.get(id);
  } catch (e) {
    return { error: `Could not read the sign request: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!record) return { error: `No open sign request ${id}: the id is unknown or the request expired (requests stay open for ${SIGN_REQUEST_TTL_SECONDS / 60} minutes). get_order_book shows what was signed.` };
  if (record.status === "pending") {
    try {
      const seen = observe(record, await getSignContext({ tokenId: record.property.tokenId }));
      if (seen) record = await store.complete(record, seen);
    } catch {
      // The order book check is best effort; the stored state still answers.
    }
  }
  return {
    network: NETWORK_LABEL,
    id: record.id,
    status: record.status,
    action: record.action,
    property: record.property,
    wallet: record.wallet,
    summary: record.summary,
    signLink: record.signLink,
    expiresAt: record.expiresAt,
    ...(record.result ? { result: record.result } : {}),
    note: record.status === "completed"
      ? "Signed. get_order_book shows the order; a transaction hash can be followed with get_transaction_status."
      : "Not signed yet. The person has not finished on the sign page, or the order has not reached the order book.",
  };
}
