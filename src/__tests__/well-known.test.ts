import { describe, expect, it, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer as createHttpServer, type Server } from "node:http";

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

/** Serve the handler from a fresh module graph (the network is read at import) on a local port. */
async function get(path: string, method = "GET"): Promise<{ status: number; headers: Headers; body: string }> {
  const { handleWellKnownHttp } = await import("../well-known.js");
  const httpServer: Server = createHttpServer((req, res) => void handleWellKnownHttp(req, res));
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  try {
    const address = httpServer.address();
    if (address === null || typeof address === "string") throw new Error("HTTP test server has no port");
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method });
    return { status: response.status, headers: response.headers, body: await response.text() };
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
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
      expect(response.headers.get("content-type")).toMatch(/^application\/json/);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("cache-control")).toMatch(/public/);
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
    expect(response.headers.get("content-type")).toMatch(/^application\/mcp-server-card\+json/);
    const card = JSON.parse(response.body);
    expect(card).toMatchObject({
      $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
      name: network === "ethereum" ? "land.fabrica/mcp" : "land.fabrica/mcp-testnet",
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      remotes: [expect.objectContaining({ type: "streamable-http", url })],
    });
    expect(card.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(card.description.length).toBeLessThanOrEqual(100);
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

  it("serves the document the path names, whatever the query says", async () => {
    const { parseWellKnownUrl } = await import("../well-known.js");
    expect(parseWellKnownUrl("/.well-known/mcp.json?doc=server-card")).toBe("manifest");
    expect(parseWellKnownUrl("/.well-known/mcp/server-card.json?doc=manifest")).toBe("server-card");
    expect(parseWellKnownUrl("/well-known?doc=server-card")).toBe("server-card");
  });

  it("keeps the description in buyer vocabulary and inside the wording rules", async () => {
    const { SERVER_DESCRIPTION } = await import("../well-known.js");
    expect(SERVER_DESCRIPTION).toMatch(/land for sale/);
    expect(SERVER_DESCRIPTION.length).toBeLessThanOrEqual(100);
    expect(SERVER_DESCRIPTION).not.toMatch(/—|land loan|600\+/);
  });
});
