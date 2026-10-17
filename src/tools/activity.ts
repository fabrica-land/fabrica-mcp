import { getNetworkActivity, getToken, getWallet, propertyLookupError } from "../clients/graphql.js";
import { NETWORK, NETWORK_LABEL } from "../config.js";
import type { ActivityModel } from "../types/index.js";
import { formatActivityAmount, formatActivitySource } from "../labels.js";
import { z } from "zod";
import { type ArgsOf, propertyRefInputs } from "./inputs.js";
import { describeScoreChange } from "./scoring.js";

/**
 * The encoding a ScoreChanged event replaced: the next older ScoreChanged for the same token in a
 * newest-first feed. Keyed by event index.
 */
export function previousScores(activities: readonly ActivityModel[]): Map<number, string | null> {
  const previous = new Map<number, string | null>();
  activities.forEach((a, i) => {
    if (a.activity !== "ScoreChanged") return;
    const older = activities.slice(i + 1).find(o => o.activity === "ScoreChanged" && o.tokenId === a.tokenId && o.time < a.time);
    previous.set(i, older?.newValue ?? null);
  });
  return previous;
}

export function formatActivity(a: ActivityModel, previousScore?: string | null) {
  const scoreChange = a.activity === "ScoreChanged" ? describeScoreChange(a.newValue, previousScore) : null;
  return {
    type: a.activity,
    source: formatActivitySource(a.source),
    time: a.time,
    tokenId: a.tokenId ?? null,
    amount: formatActivityAmount(a),
    txHash: a.transactionHash ?? null,
    ...(scoreChange ? { propertyChecks: scoreChange } : {}),
  };
}

/** Property checks recalculations: most of the feed by count, so the network-wide view leaves them out unless asked. */
const SCORE_CHANGED = "ScoreChanged";

export const getActivityInput = {
  tokenId: z.string().optional().describe("Property token ID (for property activity). Leave tokenId, slug and address out for the recent activity across every property on the network."),
  slug: propertyRefInputs.slug.describe("Property slug (for property activity)"),
  address: z.string().optional().describe("Wallet address (for wallet activity)"),
  type: z.string().optional().describe("Filter by activity type (e.g. 'loan', 'transfer', 'sale', 'mint')"),
  limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20, max 100)"),
};
export type GetActivityArgs = ArgsOf<typeof getActivityInput>;

export async function getActivity(args: GetActivityArgs) {
  const { tokenId, slug, address, type: activityType } = args;
  const limit = Math.min(Math.max(Math.trunc(args.limit ?? 20), 1), 100);
  if (!tokenId && !slug && !address) {
    return getNetworkWideActivity(activityType, limit);
  }
  try {
    let activities: ActivityModel[] = [];
    let label = "";
    if (tokenId || slug) {
      const token = await getToken({ tokenId, slug });
      if (!token) {
        return { error: `No property found with ${tokenId ? `token ID ${tokenId}` : `slug ${slug}`}` };
      }
      activities = token.activity ?? [];
      label = `property ${token.name ?? token.vanityName ?? token.tokenId}`;
    } else if (address) {
      const wallet = await getWallet(address);
      if (!wallet) {
        return { address, events: [], message: "No Fabrica activity found for this address." };
      }
      activities = wallet.activity ?? [];
      label = `wallet ${address.slice(0, 6)}...${address.slice(-4)}`;
    }
    // The API names each event's network with the same strings as FABRICA_NETWORK
    // ("ethereum", "sepolia"), so a deployment only reports events from its own network.
    activities = activities.filter(a => a.network === NETWORK);
    if (activityType) {
      const lower = activityType.toLowerCase();
      activities = activities.filter(a => a.activity.toLowerCase().includes(lower));
    }
    const total = activities.length;
    const previous = previousScores(activities);
    const page = activities.slice(0, limit).map((a, i) => formatActivity(a, previous.get(i)));
    if (page.length === 0) {
      return { label, total: 0, events: [], message: `No${activityType ? ` "${activityType}"` : ""} activity found for ${label}.` };
    }
    return {
      label,
      total,
      showing: page.length < total ? `${page.length} of ${total}` : `${total}`,
      events: page,
    };
  } catch (e) {
    return { error: propertyLookupError(e, { tokenId, slug }, "get activity") };
  }
}

/** The newest events across every minted property on this network, each with the property it belongs to. */
async function getNetworkWideActivity(activityType: string | undefined, limit: number) {
  try {
    const tokens = await getNetworkActivity();
    const lower = activityType?.toLowerCase();
    const events = tokens.flatMap(token => (token.activity ?? [])
      .filter(a => a.network === NETWORK)
      .filter(a => lower ? a.activity.toLowerCase().includes(lower) : a.activity !== SCORE_CHANGED)
      .map(a => ({ ...formatActivity(a), tokenId: token.tokenId, property: token.name ?? token.vanityName ?? null, timestamp: a.timestamp })))
      .sort((a, b) => b.timestamp - a.timestamp);
    const label = `every property on ${NETWORK_LABEL}`;
    const scope = `Activity across ${tokens.length} minted properties on ${NETWORK_LABEL}, newest first.${lower ? "" : " Property checks recalculations (ScoreChanged) are left out; type \"ScoreChanged\" lists them."} tokenId, slug or address narrows it to one property or wallet.`;
    if (events.length === 0) {
      return { label, total: 0, events: [], scope, message: `No${activityType ? ` "${activityType}"` : ""} activity found across the network.` };
    }
    const page = events.slice(0, limit).map(({ timestamp: _timestamp, ...event }) => event);
    return {
      label,
      total: events.length,
      showing: page.length < events.length ? `${page.length} of ${events.length}` : `${events.length}`,
      scope,
      events: page,
    };
  } catch (e) {
    return { error: `Failed to get network activity: ${e instanceof Error ? e.message : String(e)}` };
  }
}
