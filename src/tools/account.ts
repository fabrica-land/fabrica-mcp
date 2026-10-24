import { z } from "zod";
import { CONTRACTS, IS_MAINNET, NETWORK_LABEL } from "../config.js";
import { hasScope, type AccountAuth } from "../auth/token.js";
import { AccountApiError, getAccountProfile, type AccountWallet } from "../clients/account.js";
import { getOrderBook, getTokens } from "../clients/graphql.js";
import { estimateFields, formatUsd } from "../format.js";
import { propertyStage, type PropertyStage } from "../lifecycle.js";
import type { TokenListItem } from "../types/index.js";
import type { ArgsOf } from "./inputs.js";
import { isLiveOrder } from "./marketplace.js";

/**
 * Personal tools: registered only on the signed-in endpoint (/mcp/account), where every request
 * carries a verified access token. They read the connected user's own data with that token.
 */

export interface MyAccountResult {
  network: string;
  connection: {
    /** The user's Fabrica account id. */
    accountId: string;
    /** The AI client the user connected, as registered with Fabrica. */
    client: string;
    /** What the user approved for this client. */
    scopes: readonly string[];
    accessExpiresAt: string;
  };
  email?: string | null;
  wallets?: AccountWallet[];
  /** Identity verification (KYC) state. */
  verification?: string | null;
  notes: string[];
  error?: string;
}

export async function getMyAccount(auth: AccountAuth): Promise<MyAccountResult> {
  const result: MyAccountResult = {
    network: NETWORK_LABEL,
    connection: {
      accountId: auth.subject,
      client: auth.clientId,
      scopes: auth.scopes,
      accessExpiresAt: new Date(auth.expiresAt * 1000).toISOString(),
    },
    notes: [],
  };
  if (!hasScope(auth, "profile:read")) {
    result.notes.push("This connection was not granted profile:read, so email, linked accounts and verification status are not shown. Reconnect Fabrica and approve it to see them.");
    return result;
  }
  try {
    const profile = await getAccountProfile(auth);
    if (!profile) {
      result.notes.push(`The Fabrica API on ${NETWORK_LABEL} does not serve account details yet; email, linked accounts and verification status will appear here once it does.`);
      return result;
    }
    result.email = profile.email;
    result.wallets = profile.wallets;
    result.verification = profile.kycStatus;
    if (profile.wallets.length === 0) result.notes.push("No linked account (wallet address) is on this Fabrica account yet.");
    return result;
  } catch (error) {
    if (error instanceof AccountApiError) return { ...result, error: error.message };
    throw error;
  }
}

/** Owner-facing words for each stage, in the person's own portfolio. */
const OWNER_STATUS: Record<PropertyStage, string> = {
  unclaimed: "Being added to Fabrica (not claimed yet)",
  being_added: "Being added to Fabrica",
  replaced: "Replaced by its issued token",
  live: "Live on Fabrica",
  removal_in_progress: "Removal in progress",
  removed: "Removed from Fabrica",
  retired: "No longer on Fabrica",
};

export interface MyPropertyRow {
  tokenId: string;
  name: string | null;
  location: { state: string | null; county: string | null };
  acres: number | null;
  stage: PropertyStage;
  status: string;
  listingPrice: string | null;
  /** Live offers only (the API's bid count includes expired ones); null when the order book could not be read. */
  offersWaiting: number | null;
  underLoan: boolean;
  propertyChecks: number | null;
  estimatedValue: string | null;
  estimateNote?: string;
  links: { property: string };
}

export interface MyPropertiesResult {
  network: string;
  wallets: string[];
  totals: {
    properties: number;
    beingAdded: number;
    live: number;
    listed: number;
    offersWaiting: number;
    underLoan: number;
    totalAcres: number;
    /** Sum of the live properties' estimates; properties without one are left out. */
    estimatedValueOfLive: string;
  };
  properties: MyPropertyRow[];
  notes: string[];
  error?: string;
}

export const getMyPropertiesInput = {
  includePremints: z.boolean().optional().describe("Include properties still being added to Fabrica (default true)"),
};
export type GetMyPropertiesArgs = ArgsOf<typeof getMyPropertiesInput>;

const BEING_ADDED: ReadonlySet<PropertyStage> = new Set(["being_added", "unclaimed"]);

function emptyProperties(notes: string[], error?: string): MyPropertiesResult {
  return {
    network: NETWORK_LABEL,
    wallets: [],
    totals: { properties: 0, beingAdded: 0, live: 0, listed: 0, offersWaiting: 0, underLoan: 0, totalAcres: 0, estimatedValueOfLive: "$0" },
    properties: [],
    notes,
    ...(error ? { error } : {}),
  };
}

function toRow(token: TokenListItem, offersWaiting: number | null): MyPropertyRow {
  const stage = propertyStage(token);
  return {
    tokenId: token.tokenId,
    name: token.name ?? token.vanityName ?? null,
    location: { state: token.regionCode ?? null, county: token.district ?? null },
    acres: token.acres ? parseFloat(token.acres) : null,
    stage,
    status: OWNER_STATUS[stage],
    listingPrice: token.marketplacePrice ? formatUsd(token.marketplacePrice) : null,
    offersWaiting,
    underLoan: parseInt(token.supplyUnderLoan || "0") > 0,
    propertyChecks: token.score ?? null,
    ...estimateFields(token.estimatedValue),
    links: { property: token.propertyLink },
  };
}

/**
 * Live offers on a token from someone else. The list query's bid count includes expired offers, so
 * a token with any is read from its order book; null when that read fails. The person's own offers
 * (from any wallet on the account) are not offers waiting on them, as in get_my_offers.
 */
async function liveOfferCount(token: TokenListItem, mine: ReadonlySet<string>): Promise<number | null> {
  if (token.marketplaceBidCount === 0) return 0;
  try {
    const book = await getOrderBook({ tokenId: token.tokenId });
    const now = Date.now();
    return (book?.marketplaceBids ?? []).filter((order) => order.side === "buy" && isLiveOrder(order, now) && !mine.has(order.makerAddress.toLowerCase())).length;
  } catch {
    return null;
  }
}

/** Being added first (newest work at the top of the owner's mind), then the rest by estimated value. */
function compareRows(a: { row: MyPropertyRow; value: number }, b: { row: MyPropertyRow; value: number }): number {
  const addingA = BEING_ADDED.has(a.row.stage) ? 0 : 1;
  const addingB = BEING_ADDED.has(b.row.stage) ? 0 : 1;
  return addingA - addingB || b.value - a.value;
}

/**
 * The connected person's properties: every token and premint owned by the wallets on their account,
 * merged across wallets. Reads public token data for those wallets; the wallets themselves come from
 * the account (portfolio:read).
 */
export async function getMyProperties(auth: AccountAuth, args: GetMyPropertiesArgs = {}): Promise<MyPropertiesResult> {
  if (!hasScope(auth, "portfolio:read")) {
    return emptyProperties(["This connection was not granted portfolio:read. Reconnect Fabrica and approve \"See your properties, listings, offers and loans\" to list them."]);
  }
  let wallets: string[];
  try {
    const profile = await getAccountProfile(auth, "portfolio:read");
    if (!profile) return emptyProperties([`The Fabrica API on ${NETWORK_LABEL} does not serve account details yet, so the account's properties cannot be listed here. get_land_portfolio lists any wallet address's properties.`]);
    wallets = [...new Set(profile.wallets.map((wallet) => wallet.address.toLowerCase()))];
  } catch (error) {
    if (error instanceof AccountApiError) return emptyProperties([], error.message);
    throw error;
  }
  if (wallets.length === 0) return emptyProperties(["No linked account (wallet address) is on this Fabrica account yet, so it holds no properties."]);

  const includePremints = args.includePremints ?? true;
  const lists = await Promise.all(wallets.map((ownedBy) => getTokens({
    ownedBy,
    premints: includePremints,
    burned: false,
    testnets: !IS_MAINNET,
    contractAddress: CONTRACTS.fabricaToken,
  })));
  // A token held across two of the person's wallets is listed once.
  const byId = new Map<string, TokenListItem>();
  for (const token of lists.flat()) if (!byId.has(token.tokenId)) byId.set(token.tokenId, token);

  const tokens = [...byId.values()];
  const mine = new Set(wallets);
  const offers = await Promise.all(tokens.map((token) => liveOfferCount(token, mine)));
  const ranked = tokens
    .map((token, index) => ({ row: toRow(token, offers[index]), value: Number.parseFloat(token.estimatedValue ?? "") || 0 }))
    .filter(({ row }) => includePremints || !BEING_ADDED.has(row.stage))
    .sort(compareRows);
  const rows = ranked.map(({ row }) => row);
  const live = ranked.filter(({ row }) => row.stage === "live" || row.stage === "removal_in_progress");
  return {
    network: NETWORK_LABEL,
    wallets,
    totals: {
      properties: rows.length,
      beingAdded: rows.filter((row) => BEING_ADDED.has(row.stage)).length,
      live: live.length,
      listed: rows.filter((row) => row.listingPrice !== null).length,
      offersWaiting: rows.reduce((sum, row) => sum + (row.offersWaiting ?? 0), 0),
      underLoan: rows.filter((row) => row.underLoan).length,
      totalAcres: Math.round(rows.reduce((sum, row) => sum + (row.acres ?? 0), 0) * 100) / 100,
      estimatedValueOfLive: formatUsd(String(live.reduce((sum, { value }) => sum + value, 0))) ?? "$0",
    },
    properties: rows,
    notes: rows.length === 0 ? ["No properties on Fabrica are held by the wallets on this account."] : [],
  };
}
