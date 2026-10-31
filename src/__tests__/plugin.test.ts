import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";

const plugin = JSON.parse(readFileSync("plugin/plugin.json", "utf8"));
const cursor = JSON.parse(readFileSync(".cursor-plugin/plugin.json", "utf8"));
const mcp = JSON.parse(readFileSync("plugin/mcp.json", "utf8"));
const openai = plugin.extensions["com.openai"];

async function registeredToolNames(): Promise<string[]> {
  const server = createServer();
  const client = new Client({ name: "plugin-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((tool) => tool.name);
}

describe("plugin package", () => {
  it("points every manifest at the hosted mainnet server", () => {
    expect(Object.values(mcp.mcpServers)).toEqual([{ type: "streamable-http", url: "https://mcp.fabrica.land/mcp" }]);
    expect(cursor.mcpServers).toBe("./plugin/mcp.json");
    expect(cursor.name).toBe(plugin.name);
  });

  it("keeps the ChatGPT listing inside its field limits and the wording rules", () => {
    const listing = openai.interface;
    expect(plugin.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(listing.displayName.length).toBeLessThanOrEqual(30);
    expect(listing.shortDescription.length).toBeLessThanOrEqual(30);
    expect(listing.longDescription.length).toBeLessThanOrEqual(4000);
    expect(listing.capabilities.length).toBeLessThanOrEqual(20);
    for (const prompt of listing.defaultPrompt) expect(prompt.length).toBeLessThanOrEqual(128);
    for (const key of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) expect(listing[key]).toMatch(/^https:\/\//);
    expect(JSON.stringify(plugin)).not.toMatch(/—|--|land loan|600\+/);
  });

  it("has five positive and three negative review cases on tools the server registers", async () => {
    const { positive, negative } = openai.review.test_cases;
    expect(positive).toHaveLength(5);
    expect(negative).toHaveLength(3);
    const tools = await registeredToolNames();
    for (const testCase of positive) {
      for (const tool of testCase.tools_triggered.split(",")) expect(tools).toContain(tool.trim());
    }
  });
});
