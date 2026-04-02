import { getToken, getWallet } from "../clients/graphql.js";
import type { ActivityModel } from "../types/index.js";

function formatUsd(value: string | null | undefined): string | null {
  if (!value) return null;
  const num = parseFloat(value);
  if (isNaN(num)) return null;
  return `$${num.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function formatActivity(a: ActivityModel) {
  return {
    type: a.activity,
    source: a.source,
    time: a.time,
    tokenId: a.tokenId ?? null,
    amount: a.usdAmount ? formatUsd(a.usdAmount) : (a.currencyAmount ? `${a.currencyAmount} ${a.currencySymbol ?? ""}`.trim() : null),
    txHash: a.transactionHash ?? null,
  };
}

export async function getActivity(args: Record<string, unknown>) {
  const tokenId = args.tokenId as string | undefined;
  const slug = args.slug as string | undefined;
  const address = args.address as string | undefined;
  const activityType = args.type as string | undefined;
  const limit = Math.min((args.limit as number | undefined) ?? 20, 100);
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
    return { error: `Failed to get activity: ${e instanceof Error ? e.message : String(e)}` };
  }
}
