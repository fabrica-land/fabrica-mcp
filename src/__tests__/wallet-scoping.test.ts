import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityModel } from "../types/index.js";
import { tokenDetail, wallet } from "./fixtures.js";

// getWallet scopes the API query to this deployment's network and token contract, and
// get_activity keeps only events from this network. NETWORK, IS_MAINNET and CONTRACTS are
// module constants, so every case stubs FABRICA_NETWORK, resets modules and imports afresh.
// The API names a token's or event's network with the same strings as FABRICA_NETWORK
// ("ethereum", "sepolia"), checked against api.fabrica.land on 2026-10-17.

const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";

const DEPLOYMENTS = [
  { network: "ethereum", other: "sepolia", testnets: false, fabricaToken: "0x5cbeb7A0df7Ed85D82a472FD56d81ed550f3Ea95" },
  { network: "sepolia", other: "ethereum", testnets: true, fabricaToken: "0xb52ED2Dc8EBD49877De57De3f454Fd71b75bc1fD" },
];

interface GraphqlRequestBody {
  query: string;
  variables: Record<string, unknown>;
}

/** Answer every fetch with the given GraphQL data and keep the decoded request bodies. */
function stubApi(data: unknown): { bodies: () => GraphqlRequestBody[] } {
  const bodies: GraphqlRequestBody[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const raw = init?.body;
    if (typeof raw === "string") {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && "query" in parsed && "variables" in parsed) {
        const { query, variables } = parsed;
        if (typeof query === "string" && typeof variables === "object" && variables !== null) {
          bodies.push({ query, variables: Object.fromEntries(Object.entries(variables)) });
        }
      }
    }
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return { bodies: () => bodies };
}

/** One activity event of a token or wallet, complete as the API returns it. */
function activity(overrides: Partial<ActivityModel>): ActivityModel {
  return {
    activity: "MarketplaceSold",
    source: "Seaport",
    time: "2026-08-17T20:03:23.000Z",
    timestamp: 1787083403,
    network: "ethereum",
    tokenId: "1",
    transactionHash: "0xsale",
    currencyAmount: null,
    currencyDecimals: null,
    currencySymbol: null,
    usdAmount: null,
    newValue: null,
    ...overrides,
  };
}

/** Events on both networks for the same token, so a filter has something to drop. */
function mixedActivity(): ActivityModel[] {
  return [
    activity({ activity: "Mint", source: "Fabrica", network: "ethereum", transactionHash: "0xmint-mainnet", time: "2026-01-01T00:00:00.000Z" }),
    activity({ activity: "Mint", source: "Fabrica", network: "sepolia", transactionHash: "0xmint-sepolia", time: "2026-01-02T00:00:00.000Z" }),
    activity({ activity: "LoanStarted", source: "PoolLending", network: "ethereum", transactionHash: "0xloan-mainnet", time: "2026-01-03T00:00:00.000Z" }),
    activity({ activity: "LoanStarted", source: "PoolLending", network: "sepolia", transactionHash: "0xloan-sepolia", time: "2026-01-04T00:00:00.000Z" }),
    activity({ activity: "Transfer", source: "Fabrica", network: "sepolia", transactionHash: "0xtransfer-sepolia", time: "2026-01-05T00:00:00.000Z" }),
  ];
}

function txHashes(result: unknown): unknown[] {
  if (typeof result !== "object" || result === null || !("events" in result) || !Array.isArray(result.events)) return [];
  return result.events.map((event: unknown) => (typeof event === "object" && event !== null && "txHash" in event ? event.txHash : null));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe.each(DEPLOYMENTS)("wallet reads on $network", ({ network, other, testnets, fabricaToken }) => {
  function useNetwork(): void {
    vi.stubEnv("FABRICA_NETWORK", network);
    vi.resetModules();
  }

  it("asks the API for the wallet scoped to this network, its testnet flag and its token contract", async () => {
    useNetwork();
    const api = stubApi({ wallet: wallet({ address: ADDRESS }) });
    const { getWallet } = await import("../clients/graphql.js");
    const result = await getWallet(ADDRESS);
    expect(result?.address).toBe(ADDRESS);
    const [body] = api.bodies();
    expect(body?.query).toContain("query GetWallet");
    expect(body?.variables).toEqual({
      walletAddress: ADDRESS,
      network,
      testnets,
      contractAddress: fabricaToken,
    });
  });

  it("drops wallet activity from the other network", async () => {
    useNetwork();
    stubApi({ wallet: wallet({ address: ADDRESS, activity: mixedActivity() }) });
    const { getActivity } = await import("../tools/activity.js");
    const result = await getActivity({ address: ADDRESS });
    const expected = mixedActivity().filter((event) => event.network === network).map((event) => event.transactionHash);
    expect(txHashes(result)).toEqual(expected);
    expect(txHashes(result)).not.toContain(`0xmint-${other === "ethereum" ? "mainnet" : "sepolia"}`);
    expect(result).toMatchObject({ total: expected.length, showing: `${expected.length}` });
  });

  it("drops property activity from the other network", async () => {
    useNetwork();
    stubApi({ token: tokenDetail({ tokenId: "42", network, activity: mixedActivity() }) });
    const { getActivity } = await import("../tools/activity.js");
    const result = await getActivity({ tokenId: "42" });
    const expected = mixedActivity().filter((event) => event.network === network).map((event) => event.transactionHash);
    expect(txHashes(result)).toEqual(expected);
    for (const hash of txHashes(result)) expect(hash).not.toContain(other === "ethereum" ? "mainnet" : "sepolia");
  });

  it("reports no activity when every event belongs to the other network", async () => {
    useNetwork();
    const foreign = mixedActivity().filter((event) => event.network === other);
    stubApi({ wallet: wallet({ address: ADDRESS, activity: foreign }) });
    const { getActivity } = await import("../tools/activity.js");
    const result = await getActivity({ address: ADDRESS });
    expect(result).toMatchObject({ total: 0, events: [] });
  });

  it("applies the type filter after the network filter", async () => {
    useNetwork();
    stubApi({ wallet: wallet({ address: ADDRESS, activity: mixedActivity() }) });
    const { getActivity } = await import("../tools/activity.js");
    const result = await getActivity({ address: ADDRESS, type: "loan" });
    expect(txHashes(result)).toEqual([`0xloan-${network === "ethereum" ? "mainnet" : "sepolia"}`]);
  });
});
