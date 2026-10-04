import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { searchProperties, getProperty, getPropertyMap } from "./tools/properties.js";
import { getLendingMarket } from "./tools/lending.js";
import { getPortfolio } from "./tools/portfolio.js";
import { getProtocolStats } from "./tools/protocol.js";
import { explainConfidenceScore } from "./tools/scoring.js";
import { getBorrowQuote } from "./tools/borrowing.js";
import { getActivity } from "./tools/activity.js";
import { getPropertyImage, getPortfolioImage } from "./tools/images.js";
import { NETWORK_LABEL, IS_MAINNET, MAINNET_LEGAL_NOTICE } from "./config.js";
import { PROPERTY_CARD_URI, registerPropertyCard } from "./ui/property-card.js";

const NETWORK_NOTICE = IS_MAINNET
  ? `\n\n${MAINNET_LEGAL_NOTICE}`
  : " Properties on this network are test tokens with no real-world legal or financial effect.";

export const SERVER_INSTRUCTIONS = `Fabrica MCP server: read-only access to tokenized US land on the Fabrica protocol, including property records, confidence scores, parcel boundaries and maps, the lending market, borrow quotes, wallet portfolios and activity. Network: ${NETWORK_LABEL}. Company overview: https://about.fabrica.land.${NETWORK_NOTICE}`;

/**
 * MCP Apps (the property card) ship testnet-first: on by default on Sepolia, and on mainnet
 * only when FABRICA_MCP_APPS=enabled. Read per server so a deployment's env decides.
 */
export function mcpAppsEnabled(): boolean {
  const flag = process.env.FABRICA_MCP_APPS?.toLowerCase();
  if (flag === "enabled") return true;
  if (flag === "disabled") return false;
  return !IS_MAINNET;
}

/** Every tool only reads public data from Fabrica's API and media service. */
function readOnly(title: string): ToolAnnotations {
  return { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
}

/** JSON tool result; results that carry an `error` are flagged so clients can tell failure from data. */
function jsonResult(result: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    ...("error" in result ? { isError: true } : {}),
  };
}

export function createServer(): McpServer {
  // `instructions` belongs in the SDK's ServerOptions (second argument), not in the
  // Implementation record. Passed in the first argument it rode along inside
  // `serverInfo`, where no client reads it, so the mainnet legal notice never
  // reached an agent.
  const server = new McpServer(
    {
      name: "fabrica-mcp",
      title: "Fabrica",
      version: "0.1.0",
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.registerTool(
    "search_properties",
    {
      title: "Search properties",
      description: `Search tokenized real properties on the Fabrica protocol (${NETWORK_LABEL}). Returns a list of properties matching the given filters.${IS_MAINNET ? " Each result is a real parcel of land in the US, held in a trust whose beneficial interest is an ERC-1155 token." : " These are test properties on Sepolia with no real-world effect."}`,
      inputSchema: {
        region: z.string().optional().describe("US state code (e.g. 'TX', 'CA', 'NV')"),
        minAcres: z.number().min(0).optional().describe("Minimum parcel size in acres"),
        maxAcres: z.number().min(0).optional().describe("Maximum parcel size in acres"),
        minScore: z.number().int().min(0).optional().describe("Minimum confidence score (integer). Defaults to 72032, the marketplace threshold, except when ownedBy is set (then every property in that wallet is listed). Any minimum also requires a verified deed. Max: 75342."),
        hasListings: z.boolean().optional().describe("Only show properties with active sale listings"),
        hasLoans: z.boolean().optional().describe("Only show properties with active loans"),
        ownedBy: z.string().optional().describe("Filter by owner wallet address"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20, max 100)"),
        offset: z.number().int().min(0).optional().describe("Pagination offset"),
      },
      annotations: readOnly("Search properties"),
    },
    async (args) => jsonResult(await searchProperties(args)),
  );

  const getPropertyConfig = {
    title: "Get property details",
    description: `Get comprehensive details about a specific tokenized property on Fabrica (${NETWORK_LABEL}), including legal description, valuation, confidence score breakdown, current ownership and holders, active loans, marketplace listings and offers, recent activity, photos and a parcel map image link. Boundary geometry is returned by get_property_map.${IS_MAINNET ? " The response includes the URL of the operating agreement (the trust instrument) that governs the token." : ""}`,
    inputSchema: {
      tokenId: z.string().optional().describe("The token ID of the property"),
      slug: z.string().optional().describe("Property slug from the URL (e.g. 'us/nevada/elko-county/elko/apn-063025003')"),
    },
    annotations: readOnly("Get property details"),
  };
  const getPropertyCallback = async (args: { tokenId?: string; slug?: string }): Promise<CallToolResult> => {
    const result = await getProperty(args);
    return { ...jsonResult(result), structuredContent: result };
  };
  if (mcpAppsEnabled()) {
    // MCP App: hosts that support MCP Apps render the property card from structuredContent;
    // other clients read the same data as JSON text.
    registerAppTool(server, "get_property", { ...getPropertyConfig, _meta: { ui: { resourceUri: PROPERTY_CARD_URI } } }, getPropertyCallback);
    registerPropertyCard(server);
  } else {
    server.registerTool("get_property", getPropertyConfig, getPropertyCallback);
  }

  server.registerTool(
    "get_lending_market",
    {
      title: "Get lending market",
      description: "Get an overview of the Fabrica lending market: loan counts, loans, Fabrica lending pool liquidity and utilization, average APR, and recent loan events. Owners borrow against their properties through the Fabrica lending pool (pool-based lending). Loan records also include historical peer-to-peer loans made through a former integration that is now retired.",
      inputSchema: {
        status: z.enum(["active", "repaid", "liquidated", "all"]).optional().describe("Filter loans by status (default: 'all')"),
        borrower: z.string().optional().describe("Filter by borrower wallet address"),
        lender: z.string().optional().describe("Filter by lender wallet address"),
        since: z.string().optional().describe("ISO date. Only return loans started after this date."),
        limit: z.number().int().min(1).max(100).optional().describe("Max loan results (default 20, max 100)"),
      },
      annotations: readOnly("Get lending market"),
    },
    async (args) => jsonResult(await getLendingMarket(args)),
  );

  server.registerTool(
    "get_portfolio",
    {
      title: "Get wallet portfolio",
      description: "Get a wallet's complete Fabrica portfolio: properties owned, active loans (as borrower or lender), marketplace orders, credit history, and total portfolio value.",
      inputSchema: {
        address: z.string().describe("Ethereum wallet address (0x...)"),
      },
      annotations: readOnly("Get wallet portfolio"),
    },
    async (args) => jsonResult(await getPortfolio(args)),
  );

  server.registerTool(
    "get_protocol_stats",
    {
      title: "Get protocol stats",
      description: "Get protocol-wide statistics for the Fabrica real property tokenization platform: total properties, estimated value, lending volume and loan counts, Fabrica lending pool TVL and utilization, geographic distribution, and contract addresses.",
      inputSchema: {},
      annotations: readOnly("Get protocol stats"),
    },
    async () => jsonResult(await getProtocolStats()),
  );

  server.registerTool(
    "get_property_map",
    {
      title: "Get property boundary (GeoJSON)",
      description: "Get GeoJSON boundary data for a tokenized property and its county, for mapping, spatial analysis, and visualization.",
      inputSchema: {
        tokenId: z.string().optional().describe("The token ID of the property"),
        slug: z.string().optional().describe("Property slug from the URL"),
        includeCountyBounds: z.boolean().optional().describe("Also return the county boundary polygon (default: true)"),
      },
      annotations: readOnly("Get property boundary (GeoJSON)"),
    },
    async (args) => jsonResult(await getPropertyMap(args)),
  );

  server.registerTool(
    "explain_confidence_score",
    {
      title: "Explain confidence score",
      description: "Explain a Fabrica property's confidence score breakdown. The score is a 5-digit positional number where each digit represents a different verification category: recovery status (ten-thousands), past title (thousands), ownership (hundreds), onchain history (tens), basic validation (ones). Max score: 75342.",
      inputSchema: {
        tokenId: z.string().optional().describe("Look up and explain the score for this property"),
        score: z.number().int().min(0).optional().describe("Raw confidence score integer to explain (e.g. 73242)"),
      },
      annotations: readOnly("Explain confidence score"),
    },
    async (args) => jsonResult(await explainConfidenceScore(args)),
  );

  server.registerTool(
    "get_borrow_quote",
    {
      title: "Get borrow quote",
      description: "Get borrowing options for a specific tokenized property: Fabrica lending pool liquidity (max loan amount, durations) and existing loan status. Answers questions such as 'How much can I borrow against this property?'. The amount is an estimate; the rate is set by a live quote when borrowing.",
      inputSchema: {
        tokenId: z.string().optional().describe("The token ID of the property"),
        slug: z.string().optional().describe("Property slug from the URL"),
      },
      annotations: readOnly("Get borrow quote"),
    },
    async (args) => jsonResult(await getBorrowQuote(args)),
  );

  server.registerTool(
    "get_activity",
    {
      title: "Get activity history",
      description: "Get the activity feed for a property or wallet: mints, transfers, sales, loans started/repaid/liquidated, configuration changes, and more. Covers transaction history and event timelines.",
      inputSchema: {
        tokenId: z.string().optional().describe("Property token ID (for property activity)"),
        slug: z.string().optional().describe("Property slug (for property activity)"),
        address: z.string().optional().describe("Wallet address (for wallet activity)"),
        type: z.string().optional().describe("Filter by activity type (e.g. 'loan', 'transfer', 'sale', 'mint')"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20, max 100)"),
      },
      annotations: readOnly("Get activity history"),
    },
    async (args) => jsonResult(await getActivity(args)),
  );

  server.registerTool(
    "get_property_image",
    {
      title: "Get property map image",
      description: "Get a static map image of a tokenized property showing its parcel boundary (or a pin marker if no boundary is available). Returns an inline image. Supports dark/light themes and custom dimensions.",
      inputSchema: {
        tokenId: z.string().optional().describe("The token ID of the property"),
        slug: z.string().optional().describe("Property slug from the URL"),
        theme: z.enum(["dark", "light"]).optional().describe("Map theme (default: 'dark')"),
        width: z.number().int().min(100).max(1280).optional().describe("Image width in pixels (100-1280, default 640)"),
        height: z.number().int().min(100).max(1280).optional().describe("Image height in pixels (100-1280, default 640)"),
      },
      annotations: readOnly("Get property map image"),
    },
    async (args) => {
      const result = await getPropertyImage(args);
      if ("error" in result) return jsonResult(result);
      return {
        content: [
          { type: "text", text: `Property: ${result.name} (${result.tokenId})` },
          { type: "image", data: result.image.data, mimeType: result.image.mimeType },
        ],
      };
    },
  );

  server.registerTool(
    "get_portfolio_image",
    {
      title: "Get portfolio map image",
      description: "Get a static map image showing all properties owned by a wallet, plotted as points on a single map. Returns an inline image. Supports dark/light themes and custom dimensions.",
      inputSchema: {
        address: z.string().describe("Ethereum wallet address (0x...)"),
        theme: z.enum(["dark", "light"]).optional().describe("Map theme (default: 'dark')"),
        width: z.number().int().min(100).max(1280).optional().describe("Image width in pixels (100-1280, default 640)"),
        height: z.number().int().min(100).max(1280).optional().describe("Image height in pixels (100-1280, default 640)"),
      },
      annotations: readOnly("Get portfolio map image"),
    },
    async (args) => {
      const result = await getPortfolioImage(args);
      if ("error" in result) return jsonResult(result);
      return {
        content: [
          { type: "text", text: `Portfolio map for ${result.address}` },
          { type: "image", data: result.image.data, mimeType: result.image.mimeType },
        ],
      };
    },
  );
  return server;
}
