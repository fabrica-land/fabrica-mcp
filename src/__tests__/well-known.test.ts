import { describe, expect, it, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ServerResponse } from "node:http";
import type { McpHttpRequest } from "../http.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function registeredToolNames(): Promise<string[]> {
  const { createServer } = await import("../server.js");
  const server = createServer();
  const client = new Client({ name: "well-known-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((tool) => tool.name);
}

function fakeResponse(): { res: ServerResponse; result: () => { status: number; headers: Record<string, unknown>; body: string } } {
  let status = 0;
  let body = "";
  const headers: Record<string, unknown> = {};
  const res = {
    setHeader: (name: string, value: unknown) => { headers[name.toLowerCase()] = value; },
    writeHead: (code: number, extra?: Record<string, unknown>) => {
      status = code;
      for (const [name, value] of Object.entries(extra ?? {})) headers[name.toLowerCase()] = value;
    },
    end: (chunk?: string) => { body = chunk ?? ""; },
  } as unknown as ServerResponse;
  return { res, result: () => ({ status, headers, body }) };
}

async function get(url: string, method = "GET") {
  const { handleWellKnownHttp } = await import("../well-known.js");
  const { res, result } = fakeResponse();
  await handleWellKnownHttp({ url, method, headers: {} } as McpHttpRequest, res);
  return result();
}

describe.each([
  { network: "ethereum", url: "https://mcp.fabrica.land/mcp", other: "https://mcp-testnet.fabrica.land/mcp" },
  { network: "sepolia", url: "https://mcp-testnet.fabrica.land/mcp", other: "https://mcp.fabrica.land/mcp" },
])("well-known documents on $network", ({ network, url, other }) => {
  function useNetwork(): void {
    vi.stubEnv("FABRICA_NETWORK", network);
    vi.resetModules();
  }

  it("serves /.well-known/mcp.json with this server's URL, no auth, the docs and the other network", async () => {
    useNetwork();
    for (const path of ["/.well-known/mcp.json", "/well-known?doc=manifest"]) {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toMatch(/^application\/json/);
      expect(response.headers["access-control-allow-origin"]).toBe("*");
      expect(response.headers["cache-control"]).toMatch(/public/);
      const manifest = JSON.parse(response.body);
      expect(manifest).toMatchObject({
        url,
        transport: "streamable-http",
        authentication: { required: false },
        documentation: "https://docs.fabrica.land/docs/ai-agents",
      });
      expect(manifest.otherServers).toEqual([expect.objectContaining({ url: other })]);
    }
  });

  it("lists exactly the tools the server registers in the server card", async () => {
    useNetwork();
    const expected = await registeredToolNames();
    const response = await get("/.well-known/mcp/server-card.json");
    expect(response.status).toBe(200);
    const card = JSON.parse(response.body);
    expect(card.url).toBe(url);
    expect(card.serverInfo.name).toBe("fabrica-mcp");
    expect(card.tools.map((tool: { name: string }) => tool.name)).toEqual(expected);
    for (const tool of card.tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.annotations).toBeDefined();
    }
    expect(card.prompts.length).toBeGreaterThan(0);
  });
});

describe("well-known routing", () => {
  it("answers unknown paths with 404 and writes with 405", async () => {
    expect((await get("/.well-known/other.json")).status).toBe(404);
    expect((await get("/.well-known/mcp.json", "POST")).status).toBe(405);
    expect((await get("/.well-known/mcp.json", "OPTIONS")).status).toBe(204);
  });

  it("keeps the description in buyer vocabulary and inside the wording rules", async () => {
    const { SERVER_DESCRIPTION } = await import("../well-known.js");
    expect(SERVER_DESCRIPTION).toMatch(/land for sale/);
    expect(SERVER_DESCRIPTION).not.toMatch(/—|land loan|600\+/);
  });
});
