import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AccountAuth } from "../auth/token.js";

const AUTH: AccountAuth = { token: "secret-token", subject: "s", clientId: "c", scopes: ["portfolio:read"], expiresAt: 4102444800 };
const SIGN_TOOLS = ["make_land_offer", "list_land_for_sale", "accept_land_offer", "buy_land", "cancel_land_order", "borrow_against_land", "repay_loan_against_land"];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function tools(account?: AccountAuth) {
  vi.stubEnv("FABRICA_NETWORK", "sepolia");
  vi.resetModules();
  const { createServer } = await import("../server.js");
  const client = new Client({ name: "account-signer-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([createServer(account ? { account } : {}).connect(serverTransport), client.connect(clientTransport)]);
  const { tools: list } = await client.listTools();
  await client.close();
  return list;
}

describe("sign request wallet on each endpoint", () => {
  it("is required on the anonymous endpoint and optional on the signed-in one", async () => {
    const anonymous = await tools();
    const signedIn = await tools(AUTH);
    for (const name of SIGN_TOOLS) {
      const open = anonymous.find(tool => tool.name === name);
      const mine = signedIn.find(tool => tool.name === name);
      expect(open?.inputSchema.required, name).toContain("wallet");
      expect(mine?.inputSchema.required ?? [], name).not.toContain("wallet");
      expect(mine?.description, name).toContain("signed-in endpoint wallet is optional");
      expect(open?.description, name).not.toContain("signed-in endpoint");
    }
  });
});

describe("getToken as the connected person", () => {
  it("sends the bearer only on the personal read, to the issuer, uncached", async () => {
    const calls: { url: string; authorization: string | null }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ data: { token: { tokenId: "1" } } }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    vi.stubEnv("FABRICA_NETWORK", "ethereum");
    vi.resetModules();
    const { getToken } = await import("../clients/graphql.js");
    await getToken({ tokenId: "1" }, { as: AUTH });
    await getToken({ tokenId: "1" }, { as: AUTH });
    await getToken({ tokenId: "1" });
    expect(calls).toEqual([
      { url: "https://api.fabrica.land/graphql", authorization: "Bearer secret-token" },
      { url: "https://api.fabrica.land/graphql", authorization: "Bearer secret-token" },
      { url: "https://api.fabrica.land/graphql", authorization: null },
    ]);
  });
});
