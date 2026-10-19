import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// NETWORK and IS_MAINNET are module constants read from the environment at import time, so
// every case stubs FABRICA_NETWORK, resets the module registry and imports afresh.

const PROPERTY_CARD_URI = "ui://fabrica/property-card";
const TESTNET_SENTENCE = "Properties on this network are test tokens with no real-world legal or financial effect.";

interface Deployment {
  network: "ethereum" | "sepolia";
  isMainnet: boolean;
  label: string;
  webBase: string;
  fabricaToken: string;
  subgraphPath: string;
  appsOnByDefault: boolean;
}

const DEPLOYMENTS: Deployment[] = [
  {
    network: "ethereum",
    isMainnet: true,
    label: "Ethereum Mainnet",
    webBase: "https://fabrica.land",
    fabricaToken: "0x5cbeb7A0df7Ed85D82a472FD56d81ed550f3Ea95",
    subgraphPath: "/subgraphs/v2-pools-mainnet/3.13.2/gn",
    appsOnByDefault: false,
  },
  {
    network: "sepolia",
    isMainnet: false,
    label: "Sepolia Testnet",
    webBase: "https://testnets.fabrica.land",
    fabricaToken: "0xb52ED2Dc8EBD49877De57De3f454Fd71b75bc1fD",
    subgraphPath: "/subgraphs/v2-pools-sepolia/3.13.1/gn",
    appsOnByDefault: true,
  },
];

/** Answer every fetch with the given GraphQL body and remember the request URL. */
function stubFetch(body: unknown): { urls: () => string[] } {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    calls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return { urls: () => calls };
}

async function connectedClient(server: { connect: (transport: InMemoryTransport) => Promise<void> }): Promise<Client> {
  const client = new Client({ name: "network-matrix-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe.each(DEPLOYMENTS)("deployment on $network", (deployment) => {
  function useNetwork(): void {
    vi.stubEnv("FABRICA_NETWORK", deployment.network);
    vi.stubEnv("FABRICA_WEB_URL", undefined);
    vi.stubEnv("FABRICA_METASTREET_SUBGRAPH_URL", undefined);
    vi.resetModules();
  }

  it("resolves the network, its label, web origin and token contract from FABRICA_NETWORK", async () => {
    useNetwork();
    const config = await import("../config.js");
    expect(config.NETWORK).toBe(deployment.network);
    expect(config.IS_MAINNET).toBe(deployment.isMainnet);
    expect(config.NETWORK_LABEL).toBe(deployment.label);
    expect(config.WEB_BASE).toBe(deployment.webBase);
    expect(config.CONTRACTS.fabricaToken).toBe(deployment.fabricaToken);
    expect(config.MAINNET_WARNING === null).toBe(!deployment.isMainnet);
  });

  it("reads MetaStreet pools from this network's subgraph with the token contract lowercased", async () => {
    useNetwork();
    const fetched = stubFetch({ data: { pools: [] } });
    const subgraph = await import("../clients/subgraph.js");
    expect(subgraph.FABRICA_TOKEN_ADDRESS).toBe(deployment.fabricaToken.toLowerCase());
    await expect(subgraph.getFabricaPools()).resolves.toEqual([]);
    const [url] = fetched.urls();
    expect(url).toContain("https://api.goldsky.com/api/public/");
    expect(url?.endsWith(deployment.subgraphPath)).toBe(true);
  });

  it("carries the legal notice in the server instructions only on mainnet and the testnet sentence only on Sepolia", async () => {
    useNetwork();
    const { SERVER_INSTRUCTIONS } = await import("../server.js");
    const { MAINNET_LEGAL_NOTICE } = await import("../config.js");
    expect(SERVER_INSTRUCTIONS).toContain(`Network: ${deployment.label}.`);
    expect(SERVER_INSTRUCTIONS.includes(MAINNET_LEGAL_NOTICE)).toBe(deployment.isMainnet);
    expect(SERVER_INSTRUCTIONS.includes(TESTNET_SENTENCE)).toBe(!deployment.isMainnet);
  });

  it.each([
    ["unset", undefined, deployment.appsOnByDefault],
    ["enabled", "enabled", true],
    ["disabled", "disabled", false],
    ["Enabled in capitals", "ENABLED", true],
  ])("resolves the property card flag when FABRICA_MCP_APPS is %s", async (_name, flag, expected) => {
    useNetwork();
    vi.stubEnv("FABRICA_MCP_APPS", flag);
    const { mcpAppsEnabled } = await import("../server.js");
    expect(mcpAppsEnabled()).toBe(expected);
  });
});

/**
 * What a client sees for each flag state. http.test.ts covers mainnet with the flag unset
 * and with it enabled over the hosted transport; the remaining combinations are here.
 */
describe.each([
  { network: "ethereum", flag: "disabled", cardExpected: false },
  { network: "sepolia", flag: undefined, cardExpected: true },
  { network: "sepolia", flag: "enabled", cardExpected: true },
  { network: "sepolia", flag: "disabled", cardExpected: false },
])("get_land_property on $network with FABRICA_MCP_APPS $flag", ({ network, flag, cardExpected }) => {
  it(cardExpected ? "links get_land_property to the property card and registers the card resource" : "serves get_land_property as plain JSON and registers no card resource", async () => {
    vi.stubEnv("FABRICA_NETWORK", network);
    vi.stubEnv("FABRICA_MCP_APPS", flag);
    vi.resetModules();
    const { createServer } = await import("../server.js");
    const client = await connectedClient(createServer());
    const { tools } = await client.listTools();
    const getProperty = tools.find((tool) => tool.name === "get_land_property");
    expect(getProperty).toBeDefined();
    const ui = getProperty?._meta?.ui;
    const resourceUri = typeof ui === "object" && ui !== null && "resourceUri" in ui ? ui.resourceUri : undefined;
    expect(resourceUri).toBe(cardExpected ? PROPERTY_CARD_URI : undefined);
    const { resources } = await client.listResources();
    expect(resources.some((resource) => resource.uri === PROPERTY_CARD_URI)).toBe(cardExpected);
    const instructions = client.getInstructions() ?? "";
    expect(instructions.includes(TESTNET_SENTENCE)).toBe(network === "sepolia");
    await client.close();
  });
});
