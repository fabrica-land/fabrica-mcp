import { z } from "zod";
import { CONTRACTS, IS_MAINNET, NETWORK_LABEL } from "../config.js";
import { hasScope, type AccountAuth } from "../auth/token.js";
import { AccountApiError, getAccountProfile } from "../clients/account.js";
import { getOrderBook, getTokens, getWallet } from "../clients/graphql.js";
import type { OrderBookOrder } from "../types/index.js";
import { byUsd, effectiveStatus, formatOrder, LIVE_STATUSES } from "./marketplace.js";
import type { ArgsOf } from "./inputs.js";

/**
 * Offers on the connected person's side of the market: the ones they made, and the ones waiting
 * on their properties. Public order data, read for the wallets on their account (portfolio:read).
 */

const EXPIRING_SOON_MS = 3 * 86_400_000;

export const getMyOffersInput = {
  side: z.enum(["made", "received", "both"]).optional().describe("'both' (default), 'made': offers this person made, 'received': offers waiting on their properties"),
  status: z.enum(["active", "all"]).optional().describe("'active' (default): live offers only. 'all': also expired, canceled and filled ones."),
};
export type GetMyOffersArgs = ArgsOf<typeof getMyOffersInput>;

type FormattedOffer = ReturnType<typeof formatOrder> & { expiringSoon: boolean };

export interface ReceivedOffers {
  tokenId: string;
  name: string | null;
  /** The property is collateral for a loan: a sale pays the loan off from the proceeds. */
  underLoan: boolean;
  offers: FormattedOffer[];
  links: { respond: string };
}

export type MadeOffer = FormattedOffer & {
  tokenId: string;
  name: string | null;
  links: { property: string };
};

export interface MyOffersResult {
  network: string;
  showing: string;
  totals: { received: number; made: number; expiringSoon: number };
  received?: ReceivedOffers[];
  made?: MadeOffer[];
  notes: string[];
  error?: string;
}

function format(order: OrderBookOrder, status: OrderBookOrder["status"], now: number): FormattedOffer {
  const end = order.endTime ? Date.parse(order.endTime) : Number.NaN;
  const expiringSoon = LIVE_STATUSES.has(status) && !Number.isNaN(end) && end - now <= EXPIRING_SOON_MS;
  return { ...formatOrder(order, status, now), expiringSoon };
}

function select(orders: OrderBookOrder[] | null, includeAll: boolean, now: number): Array<{ order: OrderBookOrder; status: OrderBookOrder["status"] }> {
  return (orders ?? [])
    .filter((order) => order.side === "buy")
    .map((order) => ({ order, status: effectiveStatus(order, now) }))
    .filter(({ status }) => includeAll || LIVE_STATUSES.has(status));
}

async function receivedOffers(wallets: string[], includeAll: boolean, now: number): Promise<ReceivedOffers[]> {
  const lists = await Promise.all(wallets.map((ownedBy) => getTokens({
    ownedBy,
    premints: false,
    burned: false,
    testnets: !IS_MAINNET,
    contractAddress: CONTRACTS.fabricaToken,
  })));
  const tokenIds = [...new Set(lists.flat().filter((token) => includeAll || token.marketplaceBidCount > 0).map((token) => token.tokenId))];
  const books = await Promise.all(tokenIds.map((tokenId) => getOrderBook({ tokenId })));
  const mine = new Set(wallets);
  const rows: ReceivedOffers[] = [];
  for (const book of books) {
    if (!book) continue;
    // The person's own offers on a property they co-own are not offers waiting on them.
    const offers = select(book.marketplaceBids, includeAll, now)
      .filter(({ order }) => !mine.has(order.makerAddress.toLowerCase()))
      .sort(byUsd(-1));
    if (offers.length === 0) continue;
    rows.push({
      tokenId: book.tokenId,
      name: book.name ?? book.vanityName ?? null,
      underLoan: Number.parseInt(book.supplyUnderLoan || "0", 10) > 0,
      offers: offers.map(({ order, status }) => format(order, status, now)),
      links: { respond: book.propertyLink },
    });
  }
  return rows;
}

async function madeOffers(wallets: string[], includeAll: boolean, now: number): Promise<MadeOffer[]> {
  const walletRecords = await Promise.all(wallets.map((wallet) => getWallet(wallet)));
  const made = walletRecords.flatMap((record) => record?.marketplaceOffersMade ?? []).filter((order) => order.side === "buy");
  const orderIds = new Set(made.map((order) => order.marketplaceId));
  const tokenIds = [...new Set(made.map((order) => order.tokenId))];
  // The wallet query carries no expiry or USD price; the token's order book has the full order.
  const books = await Promise.all(tokenIds.map((tokenId) => getOrderBook({ tokenId })));
  const rows: MadeOffer[] = [];
  for (const book of books) {
    if (!book) continue;
    for (const { order, status } of select(book.marketplaceBids, includeAll, now)) {
      if (!orderIds.has(order.marketplaceId)) continue;
      rows.push({ ...format(order, status, now), tokenId: book.tokenId, name: book.name ?? book.vanityName ?? null, links: { property: book.propertyLink } });
    }
  }
  return rows.sort((a, b) => (a.expiresAt ?? "").localeCompare(b.expiresAt ?? ""));
}

function empty(notes: string[], error?: string): MyOffersResult {
  return { network: NETWORK_LABEL, showing: "", totals: { received: 0, made: 0, expiringSoon: 0 }, notes, ...(error ? { error } : {}) };
}

export async function getMyOffers(auth: AccountAuth, args: GetMyOffersArgs = {}): Promise<MyOffersResult> {
  if (!hasScope(auth, "portfolio:read")) {
    return empty(["This connection was not granted portfolio:read. Reconnect Fabrica and approve \"See your properties, listings, offers and loans\" to read offers."]);
  }
  const side = args.side ?? "both";
  const includeAll = args.status === "all";
  let wallets: string[];
  try {
    const profile = await getAccountProfile(auth, "portfolio:read");
    if (!profile) return empty([`The Fabrica API on ${NETWORK_LABEL} does not serve account details yet, so this account's offers cannot be listed here. get_land_order_book reads any property's offers.`]);
    wallets = [...new Set(profile.wallets.map((wallet) => wallet.address.toLowerCase()))];
  } catch (error) {
    if (error instanceof AccountApiError) return empty([], error.message);
    throw error;
  }
  if (wallets.length === 0) return empty(["No linked account (wallet address) is on this Fabrica account yet, so it has no offers."]);

  const now = Date.now();
  const [received, made] = await Promise.all([
    side === "made" ? Promise.resolve(undefined) : receivedOffers(wallets, includeAll, now),
    side === "received" ? Promise.resolve(undefined) : madeOffers(wallets, includeAll, now),
  ]);
  const receivedCount = (received ?? []).reduce((sum, row) => sum + row.offers.length, 0);
  const all = [...(received ?? []).flatMap((row) => row.offers), ...(made ?? [])];
  const notes: string[] = [];
  if (received?.some((row) => row.underLoan)) notes.push("A property marked underLoan is collateral for a loan: selling it pays the loan off from the proceeds.");
  if (all.length === 0) notes.push(includeAll ? "This account has no offers, made or received." : "This account has no live offers, made or received.");
  return {
    network: NETWORK_LABEL,
    showing: includeAll ? "offers of every status" : "live offers only (active, encumbered or pending); pass status 'all' for expired, canceled and filled ones",
    totals: { received: receivedCount, made: made?.length ?? 0, expiringSoon: all.filter((offer) => offer.expiringSoon).length },
    ...(received ? { received } : {}),
    ...(made ? { made } : {}),
    notes,
  };
}
