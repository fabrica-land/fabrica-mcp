import { getToken, getWallet, propertyLookupError } from "../clients/graphql.js";
import { NETWORK } from "../config.js";
import type { ActivityModel } from "../types/index.js";
import { formatActivityAmount, formatActivitySource } from "../labels.js";
import { z } from "zod";
import { type ArgsOf, propertyRefInputs } from "./inputs.js";

function formatActivity(a: ActivityModel) {
  return {
    type: a.activity,
    source: formatActivitySource(a.source),
    time: a.time,
    tokenId: a.tokenId ?? null,
    amount: formatActivityAmount(a),
    txHash: a.transactionHash ?? null,
  };
}

export const getActivityInput = {
  tokenId: z.string().optional().describe("Property token ID (for property activity)"),
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
    return { error: "Provide tokenId, slug (for a property), or address (for a wallet)" };
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
    const page = activities.slice(0, limit);
    if (page.length === 0) {
      return { label, total: 0, events: [], message: `No${activityType ? ` "${activityType}"` : ""} activity found for ${label}.` };
    }
    return {
      label,
      total,
      showing: page.length < total ? `${page.length} of ${total}` : `${total}`,
      events: page.map(formatActivity),
    };
  } catch (e) {
    return { error: propertyLookupError(e, { tokenId, slug }, "get activity") };
  }
}
