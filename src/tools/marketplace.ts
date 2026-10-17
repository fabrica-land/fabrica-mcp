import { getOrderBook as fetchOrderBook, getPremintSuccessor, isTokenNotFound } from "../clients/graphql.js";
import type { OrderBookOrder, OrderBookToken } from "../types/index.js";
import { MAINNET_WARNING, NETWORK_LABEL } from "../config.js";

const DAY_MS = 86_400_000;

/** Orders that can still be filled or are waiting on the seller's loan payoff: the default view. */
const LIVE_STATUSES: ReadonlySet<OrderBookOrder["status"]> = new Set(["active", "encumbered", "pending"]);

/** Why a listing on a property under a loan cannot be bought right now (API `MarketplaceOrderBlockReason`). */
const BLOCK_REASONS: Record<NonNullable<NonNullable<OrderBookOrder["encumbrance"]>["blockReason"]>, string> = {
  AWAITING_ALLOWANCE: "The seller has not yet approved the loan payoff from the sale proceeds.",
  LEGACY_POOL: "The loan is in a lending pool that cannot be paid off by a third party, so the seller has to refinance or repay before this listing can be bought.",
  UNDERWATER: "The loan payoff is larger than the seller's proceeds at this price.",
};

function formatUsd(value: string | null): string | null {
  const num = Number.parseFloat(value ?? "");
  if (!Number.isFinite(num)) return null;
  return `$${num.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/** The raw onchain amount scaled by the currency's decimals, with its symbol: "25000000000" (6) → "25,000 USDC". */
export function formatTokenAmount(raw: string, decimals: number, symbol: string): string {
  if (!/^\d+$/.test(raw)) return `${raw} ${symbol}`;
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = decimals > 0 ? padded.slice(-decimals).replace(/0+$/, "") : "";
  const grouped = BigInt(whole).toLocaleString("en-US");
  return `${grouped}${fraction ? `.${fraction}` : ""} ${symbol}`;
}

/** "in 12 days", "in less than a day", "3 days ago". */
export function relativeExpiry(endTime: string | null, now: number): string | null {
  if (!endTime) return null;
  const end = Date.parse(endTime);
  if (Number.isNaN(end)) return null;
  const days = Math.floor(Math.abs(end - now) / DAY_MS);
  const span = days === 0 ? "less than a day" : `${days} day${days === 1 ? "" : "s"}`;
  return end >= now ? `in ${span}` : `${span} ago`;
}

function shortenAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/**
 * An order whose end time has passed is expired whatever status the API still reports,
 * so a stale "active" row never reads as live.
 */
function effectiveStatus(order: OrderBookOrder, now: number): OrderBookOrder["status"] {
  const end = order.endTime ? Date.parse(order.endTime) : Number.NaN;
  if (LIVE_STATUSES.has(order.status) && !Number.isNaN(end) && end < now) return "expired";
  return order.status;
}

function formatOrder(order: OrderBookOrder, status: OrderBookOrder["status"], now: number) {
  const feeBps = Number.parseInt(order.feeBps, 10);
  return {
    price: formatUsd(order.usdPrice),
    amount: formatTokenAmount(order.price, order.decimals, order.symbol),
    status,
    ...(order.side === "sell" ? { seller: shortenAddress(order.makerAddress) } : { buyer: shortenAddress(order.makerAddress) }),
    ...(order.maker?.user?.displayName ? { makerName: order.maker.user.displayName } : {}),
    supply: order.supply,
    startsAt: order.startTime,
    expiresAt: order.endTime,
    expires: relativeExpiry(order.endTime, now),
    ...(order.side === "sell" && Number.isFinite(feeBps) ? { marketplaceFee: `${(feeBps / 100).toFixed(2)}% of the price` } : {}),
    ...(order.restrictedToAddresses?.length ? { restrictedTo: order.restrictedToAddresses.map(shortenAddress) } : {}),
    ...(order.disclosurePackage?.length ? { disclosures: order.disclosurePackage.map(d => ({ name: d.name, url: d.url })) } : {}),
    ...(order.encumbrance ? {
      encumbrance: {
        loanId: order.encumbrance.loanId,
        buyable: order.encumbrance.buyable,
        ...(order.encumbrance.blockReason ? { reason: BLOCK_REASONS[order.encumbrance.blockReason] } : {}),
      },
    } : {}),
    orderId: order.marketplaceId,
  };
}

const usdValue = (order: OrderBookOrder): number | null => {
  const num = Number.parseFloat(order.usdPrice ?? "");
  return Number.isFinite(num) ? num : null;
};

/** Sort by USD price; an order the API could not price in USD is not comparable and goes last. */
function byUsd(direction: 1 | -1) {
  return (a: { order: OrderBookOrder }, b: { order: OrderBookOrder }): number => {
    const x = usdValue(a.order);
    const y = usdValue(b.order);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    return (x - y) * direction;
  };
}

function stageOf(token: OrderBookToken): string {
  if (token.isBurned) return "burned";
  if (!token.isPremint) return "minted";
  if (token.claimState === "UNCLAIMED") return "premint, not yet claimed by the owner";
  if (token.claimState === "CLAIMED") return "premint, claimed by the owner and not yet minted";
  return "premint";
}

/**
 * Load the order book, following a premint that was replaced by a minted token: its old ID
 * either still loads with `supersededByTokenId` set or no longer loads at all. The live
 * token's order book is the one that can be acted on.
 */
async function loadOrderBook(tokenId: string | undefined, slug: string | undefined): Promise<{ token: OrderBookToken | null; replacedPremintTokenId: string | null }> {
  let token: OrderBookToken | null;
  try {
    token = await fetchOrderBook({ tokenId, slug });
  } catch (e) {
    if (!isTokenNotFound(e)) throw e;
    if (!tokenId) return { token: null, replacedPremintTokenId: null };
    const successorId = await getPremintSuccessor(tokenId);
    if (!successorId) return { token: null, replacedPremintTokenId: null };
    return { token: await fetchOrderBook({ tokenId: successorId }), replacedPremintTokenId: tokenId };
  }
  if (token?.isPremint && token.supersededByTokenId) {
    return { token: await fetchOrderBook({ tokenId: token.supersededByTokenId }), replacedPremintTokenId: token.tokenId };
  }
  return { token, replacedPremintTokenId: null };
}

export interface OrderBookArgs {
  tokenId?: string;
  slug?: string;
  status?: "active" | "all";
  minOfferUsd?: number;
}

export async function getOrderBook({ tokenId, slug, status, minOfferUsd }: OrderBookArgs) {
  const includeAll = status === "all";
  if (!tokenId && !slug) {
    return { error: "Either tokenId or slug is required" };
  }
  try {
    const { token, replacedPremintTokenId } = await loadOrderBook(tokenId, slug);
    if (!token) {
      return { error: `No property found with ${tokenId ? `token ID ${tokenId}` : `slug ${slug}`}` };
    }
    const now = Date.now();
    const select = (orders: OrderBookOrder[] | null) => (orders ?? [])
      .map(order => ({ order, status: effectiveStatus(order, now) }))
      .filter(({ status }) => includeAll || LIVE_STATUSES.has(status));
    const listings = select(token.marketplaceListings).sort(byUsd(1));
    const offers = select(token.marketplaceBids)
      .filter(({ order }) => minOfferUsd === undefined || (usdValue(order) ?? -1) >= minOfferUsd)
      .sort(byUsd(-1));
    const liveListings = listings.filter(({ status }) => LIVE_STATUSES.has(status));
    const lowest = liveListings[0];
    const underLoan = Number.parseInt(token.supplyUnderLoan || "0", 10) > 0;
    const notes: string[] = [];
    if (replacedPremintTokenId) {
      notes.push(`Token ${replacedPremintTokenId} was a premint that has been replaced by minted token ${token.tokenId}; this is the minted token's order book.`);
    }
    if (underLoan) {
      notes.push("The property is collateral for an active loan. A sale pays the loan off from the sale proceeds before the seller is paid.");
    }
    if (token.isPremint) {
      notes.push("This property is a premint: its token has not been minted yet.");
    }
    if (listings.length === 0 && offers.length === 0) {
      notes.push(includeAll ? "No listings or offers have been made on this property." : "No active listings or offers on this property.");
    }
    return {
      ...(MAINNET_WARNING ? { legalNotice: MAINNET_WARNING } : {}),
      network: NETWORK_LABEL,
      tokenId: token.tokenId,
      name: token.name ?? token.vanityName,
      stage: stageOf(token),
      ...(replacedPremintTokenId ? { replacesPremintTokenId: replacedPremintTokenId } : {}),
      isPremint: token.isPremint,
      claimState: token.claimState,
      showing: includeAll ? "all orders, every status" : "live orders only (active, encumbered or pending); pass status 'all' for expired, canceled and filled orders",
      listing: lowest ? formatOrder(lowest.order, lowest.status, now) : null,
      listings: listings.map(({ order, status }) => formatOrder(order, status, now)),
      offerCount: offers.filter(({ status }) => LIVE_STATUSES.has(status)).length,
      offers: offers.map(({ order, status }) => formatOrder(order, status, now)),
      underActiveLoan: underLoan,
      ...(notes.length > 0 ? { notes } : {}),
      links: {
        property: token.propertyLink,
        makeOffer: token.propertyLink,
      },
    };
  } catch (e) {
    return { error: `Failed to get order book: ${e instanceof Error ? e.message : String(e)}` };
  }
}
