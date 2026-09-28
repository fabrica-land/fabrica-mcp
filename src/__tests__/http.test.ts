import { createServer as createHttpServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleMcpHttpRequest } from "../http.js";

describe("hosted HTTP transport", () => {
  let httpServer: Server;
  let url: string;

  beforeAll(async () => {
    httpServer = createHttpServer((req, res) => void handleMcpHttpRequest(req, res));
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (address === null || typeof address === "string") throw new Error("HTTP test server has no port");
    url = `http://127.0.0.1:${address.port}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("answers CORS preflight", async () => {
    const response = await fetch(url, { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("rejects GET because the server is stateless", async () => {
    const response = await fetch(url);
    expect(response.status).toBe(405);
  });

  it("rejects a body that is not JSON", async () => {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    expect(response.status).toBe(400);
  });

  it("serves the full tool list to an MCP client", async () => {
    const client = new Client({ name: "http-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "search_properties",
      "get_property",
      "get_borrow_quote",
      "get_property_image",
    ]));
    expect(tools).toHaveLength(11);
    expect(client.getInstructions()).toContain("Network:");
    await client.close();
  });

  it("marks every tool read-only with a title, as the Claude connectors directory requires", async () => {
    const client = new Client({ name: "http-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.annotations?.title, tool.name).toBeTruthy();
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
      expect(tool.description ?? "", tool.name).not.toMatch(/\bMUST\b|—/);
    }
    expect(client.getInstructions() ?? "").not.toMatch(/\bMUST\b|\binform the user\b|—/);
    await client.close();
  });

  it("keeps the property card off on mainnet unless FABRICA_MCP_APPS=enabled", async () => {
    const client = new Client({ name: "http-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "get_property")?._meta?.ui).toBeUndefined();
    await client.close();
  });

  it("links get_property to the property card MCP App and serves it self-contained", async () => {
    process.env.FABRICA_MCP_APPS = "enabled";
    const client = new Client({ name: "http-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const { tools } = await client.listTools();
    const getProperty = tools.find((tool) => tool.name === "get_property");
    const ui = getProperty?._meta?.ui;
    expect(typeof ui === "object" && ui !== null && "resourceUri" in ui ? ui.resourceUri : null).toBe("ui://fabrica/property-card");
    const { contents } = await client.readResource({ uri: "ui://fabrica/property-card" });
    const [card] = contents;
    expect(card?.mimeType).toBe("text/html;profile=mcp-app");
    const html = card && "text" in card ? card.text : "";
    expect(html).toContain("View on Fabrica");
    expect(html).toContain('<script type="module">');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(JSON.stringify(card?._meta)).toContain("https://ipfs.fabrica.land");
    await client.close();
    delete process.env.FABRICA_MCP_APPS;
  });
});
