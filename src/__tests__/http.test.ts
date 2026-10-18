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
      "get_valuation",
      "get_property_image",
      "get_order_book",
      "contact_support",
      "check_coverage",
      "get_loan_book",
    ]));
    expect(tools).toHaveLength(20);
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

  it("keeps the sign-request tools off on mainnet unless FABRICA_SIGN_REQUESTS=enabled, and marks them as prepare tools", async () => {
    const offClient = new Client({ name: "http-test", version: "0.0.0" });
    await offClient.connect(new StreamableHTTPClientTransport(new URL(url)));
    expect((await offClient.listTools()).tools.map((tool) => tool.name)).not.toContain("make_offer");
    await offClient.close();
    const previous = process.env.FABRICA_SIGN_REQUESTS;
    process.env.FABRICA_SIGN_REQUESTS = "enabled";
    try {
      const client = new Client({ name: "http-test", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(26);
      const prepareTools = ["make_offer", "list_for_sale", "accept_offer", "buy", "cancel_order"];
      for (const tool of tools) {
        expect(tool.title, tool.name).toBeTruthy();
        expect(tool.annotations?.readOnlyHint, tool.name).toBe(!prepareTools.includes(tool.name));
        expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
        expect(tool.description ?? "", tool.name).not.toMatch(/\bMUST\b|—/);
      }
      expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([...prepareTools, "get_sign_request", "get_transaction_status"]));
      expect(client.getInstructions()).toContain("holds no keys");
      await client.close();
    } finally {
      if (previous === undefined) delete process.env.FABRICA_SIGN_REQUESTS;
      else process.env.FABRICA_SIGN_REQUESTS = previous;
    }
  });

  it("keeps the property card off on mainnet unless FABRICA_MCP_APPS=enabled", async () => {
    const client = new Client({ name: "http-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "get_property")?._meta?.ui).toBeUndefined();
    await client.close();
  });

  it("links get_property to the property card MCP App and serves it self-contained", async () => {
    const previous = process.env.FABRICA_MCP_APPS;
    process.env.FABRICA_MCP_APPS = "enabled";
    try {
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
    } finally {
      if (previous === undefined) delete process.env.FABRICA_MCP_APPS;
      else process.env.FABRICA_MCP_APPS = previous;
    }
  });
});
