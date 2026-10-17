import { describe, expect, it, vi } from "vitest";
import type { ActivityModel } from "../types/index.js";

vi.mock("../clients/graphql.js", () => ({
  getToken: vi.fn(),
  getWallet: vi.fn(),
  getNetworkActivity: vi.fn(),
  propertyLookupError: vi.fn(() => "lookup failed"),
}));

const { getNetworkActivity } = await import("../clients/graphql.js");
const { getActivity } = await import("../tools/activity.js");

function event(activity: ActivityModel["activity"], timestamp: number, network = "ethereum"): ActivityModel {
  return {
    activity, source: "Fabrica", time: new Date(timestamp * 1000).toISOString(), timestamp, network,
    tokenId: null, transactionHash: null, currencyAmount: null, currencyDecimals: null, currencySymbol: null, usdAmount: null, newValue: null,
  };
}

vi.mocked(getNetworkActivity).mockResolvedValue([
  { tokenId: "1", name: "Lot One", vanityName: null, activity: [event("Mint", 100), event("ScoreChanged", 400), event("LoanStarted", 300)] },
  { tokenId: "2", name: null, vanityName: "Lot Two", activity: [event("Transfer", 200), event("MarketplaceSold", 500, "sepolia")] },
]);

describe("get_activity with no filter", () => {
  it("merges every property's feed, newest first, naming the property and leaving out score recalculations", async () => {
    const result = await getActivity({});
    expect(result).toMatchObject({ total: 3, showing: "3" });
    const events = ("events" in result ? result.events : undefined) ?? [];
    expect(events.map((e) => [e.type, e.tokenId])).toEqual([["LoanStarted", "1"], ["Transfer", "2"], ["Mint", "1"]]);
    expect(events[1]).toMatchObject({ property: "Lot Two" });
    expect(events[0]).not.toHaveProperty("timestamp");
  });

  it("lists score recalculations when the type asks for them, and pages with limit", async () => {
    expect(await getActivity({ type: "ScoreChanged" })).toMatchObject({ total: 1, events: [{ type: "ScoreChanged" }] });
    expect(await getActivity({ limit: 1 })).toMatchObject({ total: 3, showing: "1 of 3" });
  });

  it("pairs each score change with the property's previous one", async () => {
    const score = (timestamp: number, newValue: string) => ({ ...event("ScoreChanged", timestamp), newValue });
    vi.mocked(getNetworkActivity).mockResolvedValueOnce([
      { tokenId: "1", name: "Lot One", vanityName: null, activity: [score(400, "73342"), score(100, "72342")] },
    ]);
    const result = await getActivity({ type: "ScoreChanged" });
    const events = ("events" in result ? result.events : undefined) ?? [];
    expect(events[0]).toMatchObject({ propertyChecks: { previousEncoding: 72342, changed: ["Past Title & Load 2 to 3 (of 5)"] } });
  });

  it("reports a failure as an error", async () => {
    vi.mocked(getNetworkActivity).mockRejectedValueOnce(new Error("boom"));
    expect(await getActivity({})).toMatchObject({ error: expect.stringContaining("boom") });
  });
});
