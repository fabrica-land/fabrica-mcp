import { createServer as createHttpServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleMcpHttpRequest, needsAccount } from "../http.js";
import { handleWellKnownHttp } from "../well-known.js";
import { oauthScopes } from "../auth/config.js";
import { accountToolNames, createServer } from "../server.js";

/**
 * Adding a property from the server: add_land is always listed, the write scopes are asked for at
 * sign-in, and answer_adding_questions is listed with Connect Fabrica and gated behind sign-in.
 */

const CALL = (name: string, args: object = {}) => JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });

describe("adding a property from the server", () => {
  let httpServer: Server;
  let base: string;

  beforeAll(async () => {
    httpServer = createHttpServer((req, res) => void (req.url?.startsWith("/.well-known/") ? handleWellKnownHttp(req, res) : handleMcpHttpRequest(req, res)));
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (address === null || typeof address === "string") throw new Error("HTTP test server has no port");
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });
  afterEach(() => vi.unstubAllEnvs());

  async function tools(): Promise<{ names: string[]; tools: Awaited<ReturnType<Client["listTools"]>>["tools"]; instructions: string }> {
    const client = new Client({ name: "add-land-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const listed = (await client.listTools()).tools;
    const instructions = client.getInstructions() ?? "";
    await client.close();
    return { names: listed.map((tool) => tool.name), tools: listed, instructions };
  }

  it("lists add_land (public, with the link) and, with Connect Fabrica, answer_adding_questions behind sign-in", async () => {
    const on = await tools();
    expect(on.names).toContain("add_land");
    expect(on.names).not.toContain("answer_adding_questions");
    expect(on.instructions).toContain("add_land starts adding a property");
    const jargon = /\bpre-?mints?\b|\bon-?ramp(s|ed|ing)?\b|\bmint(s|ed|ing)?\b|\btokenized\b|\bMUST\b|—/i;
    for (const tool of on.tools.filter((t) => t.name === "add_land" || t.name === "answer_adding_questions")) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(false);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
      expect(`${tool.title} ${tool.description}`, tool.name).not.toMatch(jargon);
    }
    // The server's own first line says "tokenized"; the added sentence must not.
    expect(on.instructions.slice(on.instructions.indexOf("add_land starts"))).not.toMatch(jargon);
    vi.stubEnv("FABRICA_OAUTH", "enabled");
    const connect = await tools();
    expect(connect.names).toEqual(expect.arrayContaining(["add_land", "answer_adding_questions"]));
    expect(oauthScopes()).toEqual(["profile:read", "portfolio:read", "onramp:read", "onramp:write", "premint:write"]);
    expect(accountToolNames()).toContain("answer_adding_questions");
    expect(needsAccount(JSON.parse(CALL("answer_adding_questions", { tokenId: "1" })))).toBe(true);
    expect(needsAccount(JSON.parse(CALL("add_land", { address: "1 Main St" })))).toBe(false);
    expect(needsAccount(JSON.parse(CALL("add_land", { listingUrl: "https://x.example/1" })))).toBe(true);
    const challenge = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: CALL("answer_adding_questions", { tokenId: "1" }) });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toMatch(/scope="profile:read portfolio:read onramp:read onramp:write premint:write"$/);
    const metadata = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json() as { scopes_supported: string[] };
    expect(metadata.scopes_supported).toEqual(["profile:read", "portfolio:read", "onramp:read", "onramp:write", "premint:write"]);
  });

  it("answers sign_in_required from answer_adding_questions on a transport with no HTTP gate", async () => {
    vi.stubEnv("FABRICA_OAUTH", "enabled");
    const server = createServer();
    const { Client: Local } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Local({ name: "add-land-test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: "answer_adding_questions", arguments: { tokenId: "1", email: "a@b.co" } });
    expect(JSON.stringify(result.content)).toMatch(/sign_in_required|sign in/i);
    await client.close();
  });
});
