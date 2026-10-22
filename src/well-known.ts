import type { ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { IS_MAINNET, NETWORK, NETWORK_LABEL } from "./config.js";
import type { McpHttpRequest } from "./http.js";
import { createServer } from "./server.js";

/**
 * Discovery documents for clients that start from the domain:
 *   GET /.well-known/mcp.json              where the server is, its transport and auth, the docs
 *   GET /.well-known/mcp/server-card.json  the same plus the tools, prompts and resource templates
 *   GET /.well-known/ai-catalog.json       the AI Catalog that domain-level discovery fetches first: both servers' cards
 *   GET /.well-known/openai-apps-challenge the ChatGPT plugin domain-verification token, plain text, from OPENAI_APPS_CHALLENGE
 * The card is read from a live in-process server, so it lists exactly what this deployment
 * registers (sign-request tools appear only where the store is configured) and cannot drift.
 * On Vercel the routes rewrite to /well-known?doc=…; a plain Node server passes the path.
 */

export const MAINNET_MCP_URL = "https://mcp.fabrica.land/mcp";
export const TESTNET_MCP_URL = "https://mcp-testnet.fabrica.land/mcp";
export const DOCS_URL = "https://docs.fabrica.land/docs/ai-agents";

/** Buyer vocabulary first, as in the directory one-liner and the registry entry; the card schema caps it at 100 characters. */
export const SERVER_DESCRIPTION = "US land for sale and any US parcel by address or APN: maps, Property checks, taxes, trust documents.";
export const SERVER_CARD_SCHEMA = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";
// Registered media types from the ext-server-card discovery doc; the manifest stays plain JSON.
const SERVER_CARD_MEDIA_TYPE = "application/mcp-server-card+json";
const AI_CATALOG_MEDIA_TYPE = "application/ai-catalog+json";
const REPOSITORY = { url: "https://github.com/fabrica-land/fabrica-mcp", source: "github" };

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function thisUrl(): string {
  return IS_MAINNET ? MAINNET_MCP_URL : TESTNET_MCP_URL;
}

function otherNetwork(): { network: string; url: string } {
  return IS_MAINNET
    ? { network: "Sepolia Testnet (test properties, a separate server)", url: TESTNET_MCP_URL }
    : { network: "Ethereum Mainnet (real parcels, a separate server)", url: MAINNET_MCP_URL };
}

export function mcpManifest(): object {
  return {
    name: IS_MAINNET ? "fabrica" : "fabrica-testnet",
    title: IS_MAINNET ? "Fabrica" : "Fabrica (Sepolia testnet)",
    description: SERVER_DESCRIPTION,
    network: NETWORK_LABEL,
    url: thisUrl(),
    transport: "streamable-http",
    authentication: { required: false, type: "none" },
    documentation: DOCS_URL,
    serverCard: new URL("/.well-known/mcp/server-card.json", thisUrl()).toString(),
    skill: new URL("/skill.md", thisUrl()).toString(),
    otherServers: [otherNetwork()],
  };
}

/** Both networks' cards, mainnet first; identifiers follow urn:air:{publisher}:{namespace}:{name} for land.fabrica/{name}. */
export function aiCatalog(): object {
  return {
    specVersion: "1.0",
    entries: [
      { name: "mcp", url: MAINNET_MCP_URL },
      { name: "mcp-testnet", url: TESTNET_MCP_URL },
    ].map(({ name, url }) => ({
      identifier: `urn:air:fabrica.land:mcp:${name}`,
      type: SERVER_CARD_MEDIA_TYPE,
      url: new URL("/.well-known/mcp/server-card.json", url).toString(),
    })),
  };
}

export async function serverCard(): Promise<object> {
  const server = createServer();
  const client = new Client({ name: "fabrica-server-card", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const info = client.getServerVersion();
    const [{ tools }, { prompts }, { resourceTemplates }] = await Promise.all([
      client.listTools(),
      client.listPrompts(),
      client.listResourceTemplates(),
    ]);
    // Identity, transport and protocol versions in the MCP Server Card v1 shape (the same name as the
    // registry entry); serverInfo, authentication and the primitives are what Smithery's scan reads.
    return {
      $schema: SERVER_CARD_SCHEMA,
      name: IS_MAINNET ? "land.fabrica/mcp" : "land.fabrica/mcp-testnet",
      version: info?.version,
      title: IS_MAINNET ? "Fabrica" : "Fabrica (Sepolia testnet)",
      description: SERVER_DESCRIPTION,
      websiteUrl: DOCS_URL,
      repository: REPOSITORY,
      remotes: [{ type: "streamable-http", url: thisUrl(), supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS }],
      serverInfo: { name: info?.name, title: info?.title, version: info?.version },
      network: NETWORK,
      authentication: { required: false },
      tools: tools.map((tool) => ({
        name: tool.name,
        title: tool.title ?? tool.annotations?.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      })),
      prompts: prompts.map((prompt) => ({ name: prompt.name, title: prompt.title, description: prompt.description, arguments: prompt.arguments })),
      resourceTemplates: resourceTemplates.map((template) => ({ name: template.name, uriTemplate: template.uriTemplate, description: template.description })),
    };
  } finally {
    await client.close();
    await server.close();
  }
}

type WellKnownDoc = "manifest" | "server-card" | "ai-catalog" | "openai-apps-challenge";
const DOCS: readonly WellKnownDoc[] = ["manifest", "server-card", "ai-catalog", "openai-apps-challenge"];

const MEDIA_TYPES: Record<WellKnownDoc, string> = {
  manifest: "application/json",
  "server-card": SERVER_CARD_MEDIA_TYPE,
  "ai-catalog": AI_CATALOG_MEDIA_TYPE,
  "openai-apps-challenge": "text/plain",
};

/** The token OpenAI's plugin dashboard issues for this host; unset means there is no challenge to answer. */
function openAiAppsChallenge(): string | null {
  return process.env.OPENAI_APPS_CHALLENGE?.trim() || null;
}

/** Which document a request asks for: the path when it names one, else the query the Vercel rewrite adds. */
export function parseWellKnownUrl(url: string | undefined): WellKnownDoc | null {
  const parsed = new URL(url ?? "/", "http://localhost");
  if (/^\/\.well-known\/mcp\.json$/.test(parsed.pathname)) return "manifest";
  if (/^\/\.well-known\/mcp\/server-card\.json$/.test(parsed.pathname)) return "server-card";
  if (/^\/\.well-known\/ai-catalog\.json$/.test(parsed.pathname)) return "ai-catalog";
  if (/^\/\.well-known\/openai-apps-challenge$/.test(parsed.pathname)) return "openai-apps-challenge";
  const doc = parsed.searchParams.get("doc");
  return DOCS.find((name) => name === doc) ?? null;
}

export async function handleWellKnownHttp(req: McpHttpRequest, res: ServerResponse): Promise<void> {
  for (const [name, value] of Object.entries(CORS_HEADERS)) res.setHeader(name, value);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const doc = parseWellKnownUrl(req.url);
  if (!doc) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "application/json", Allow: "GET, HEAD, OPTIONS" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }
  if (doc === "openai-apps-challenge") {
    // The verifier wants the bare token as the whole body: no JSON, no trailing newline, never cached.
    const token = openAiAppsChallenge();
    res.writeHead(token ? 200 : 404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" || !token ? undefined : token);
    return;
  }
  try {
    const body = doc === "manifest" ? mcpManifest() : doc === "ai-catalog" ? aiCatalog() : await serverCard();
    // The edge keeps a copy for an hour; a deploy starts a fresh cache.
    res.writeHead(200, { "Content-Type": `${MEDIA_TYPES[doc]}; charset=utf-8`, "Cache-Control": "public, max-age=300, s-maxage=3600" });
    res.end(req.method === "HEAD" ? undefined : JSON.stringify(body, null, 2));
  } catch (error) {
    console.error("Well-known document failed:", error);
    res.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "unavailable", message: "The discovery document could not be built. Retry shortly." }));
  }
}
