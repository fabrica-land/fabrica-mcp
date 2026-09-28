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
});
