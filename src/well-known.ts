import type { ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { IS_MAINNET, NETWORK, NETWORK_LABEL } from "./config.js";
import type { McpHttpRequest } from "./http.js";
import { createServer } from "./server.js";

/**
 * Discovery documents for clients that start from the domain (ENG-5139):
 *   GET /.well-known/mcp.json              where the server is, its transport and auth, the docs
 *   GET /.well-known/mcp/server-card.json  the same plus the tools, prompts and resource templates
 * The card is read from a live in-process server, so it lists exactly what this deployment
 * registers (sign-request tools appear only where the store is configured) and cannot drift.
 * On Vercel the routes rewrite to /well-known?doc=…; a plain Node server passes the path.
 */

export const MAINNET_MCP_URL = "https://mcp.fabrica.land/mcp";
export const TESTNET_MCP_URL = "https://mcp-testnet.fabrica.land/mcp";
export const DOCS_URL = "https://docs.fabrica.land/docs/ai-agents";

/** Buyer vocabulary first, as in the directory one-liner and the registry entry. */
export const SERVER_DESCRIPTION = "US land and property records: search land for sale, look up any US parcel by address or APN, parcel maps, Property checks, trust documents, tax status and borrowing estimates on Fabrica.";

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
    return {
      serverInfo: { name: info?.name, title: info?.title, version: info?.version },
      description: SERVER_DESCRIPTION,
      network: NETWORK,
      url: thisUrl(),
      transport: { type: "streamable-http", url: thisUrl() },
      authentication: { required: false },
      documentation: DOCS_URL,
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

/** Which document a request asks for, from the query (Vercel rewrite) or the path. */
export function parseWellKnownUrl(url: string | undefined): "manifest" | "server-card" | null {
  const parsed = new URL(url ?? "/", "http://localhost");
  const doc = parsed.searchParams.get("doc");
  if (doc === "manifest" || doc === "server-card") return doc;
  if (/^\/\.well-known\/mcp\.json$/.test(parsed.pathname)) return "manifest";
  if (/^\/\.well-known\/mcp\/server-card\.json$/.test(parsed.pathname)) return "server-card";
  return null;
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
  try {
    const body = doc === "manifest" ? mcpManifest() : await serverCard();
    // The edge keeps a copy for an hour; a deploy starts a fresh cache.
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300, s-maxage=3600" });
    res.end(req.method === "HEAD" ? undefined : JSON.stringify(body, null, 2));
  } catch (error) {
    console.error("Well-known document failed:", error);
    res.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "unavailable", message: "The discovery document could not be built. Retry shortly." }));
  }
}
