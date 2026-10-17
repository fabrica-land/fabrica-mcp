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
import { getValuation } from "./tools/valuation.js";
import { getActivity } from "./tools/activity.js";
import { getOrderBook } from "./tools/marketplace.js";
import { getPropertyImage, getPortfolioImage } from "./tools/images.js";
import { getTrustDocuments } from "./tools/documents.js";
import { getTaxStatus } from "./tools/tax.js";
import { askFabrica, ASK_FABRICA_SOURCES } from "./tools/knowledge.js";
import { NETWORK_LABEL, IS_MAINNET, MAINNET_LEGAL_NOTICE } from "./config.js";
import { PROPERTY_CARD_URI, registerPropertyCard } from "./ui/property-card.js";
import { registerKnowledgeResources } from "./resources/knowledge.js";

const NETWORK_NOTICE = IS_MAINNET
  ? `\n\n${MAINNET_LEGAL_NOTICE}`
  : " Properties on this network are test tokens with no real-world legal or financial effect.";

export const SERVER_INSTRUCTIONS = `Fabrica MCP server: read-only access to tokenized US land on the Fabrica protocol, including property records, trust documents, Property checks, parcel boundaries and maps, the lending market, borrow quotes, wallet portfolios and activity. Network: ${NETWORK_LABEL}. Company overview: https://about.fabrica.land. For questions about how Fabrica works (the trust, fees, Property checks, lending, taxes, the onramp, the legal framework) call ask_fabrica and cite the URL of the passage you relied on. When ask_fabrica returns no matching passage, say so and point to https://help.fabrica.land or questions@fabrica.land instead of guessing.${NETWORK_NOTICE}`;

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
      description: `Search tokenized real properties on the Fabrica protocol (${NETWORK_LABEL}). Returns a list of properties matching the given filters, or counts per state or county with groupBy. When a state or county is given, the response includes the link to that location's page on fabrica.land.${IS_MAINNET ? " Each result is a real parcel of land in the US, held in a trust whose beneficial interest is an ERC-1155 token." : " These are test properties on Sepolia with no real-world effect."}`,
      inputSchema: {
        region: z.string().optional().describe("US state code (e.g. 'TX', 'CA', 'NV')"),
        county: z.string().optional().describe("County name, case-insensitive, the 'County' suffix optional (e.g. 'Costilla' or 'Mohave County'). Combine with region when the name exists in more than one state."),
        groupBy: z.enum(["state", "county"]).optional().describe("Return one row per state or county (property count, count for sale, total acres, location page link) instead of property rows. limit and offset page through the groups."),
        minAcres: z.number().min(0).optional().describe("Minimum parcel size in acres"),
        maxAcres: z.number().min(0).optional().describe("Maximum parcel size in acres"),
        minScore: z.number().int().min(0).optional().describe("Minimum Property checks number: the 5-digit numeric encoding of Property checks, an integer. Defaults to 72032, the marketplace threshold, except when ownedBy is set (then every property in that wallet is listed). Any minimum also requires a verified deed. Max: 75342."),
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
    description: `Get comprehensive details about a specific tokenized property on Fabrica (${NETWORK_LABEL}), including legal description, valuation, property tax status, Property checks (with their 5-digit numeric encoding), current ownership and holders, active loans, marketplace listings and offers, recent activity, photos and a parcel map image link. Also its lifecycle stage (premint, minted, removal in progress), fees assessed on the token with approval and payment state, and flags for a duplicate parcel claim or the marketplace screen. An old premint ID that was replaced by a minted token returns the successor. Boundary geometry is returned by get_property_map.${IS_MAINNET ? " The response includes the URL of the operating agreement (the trust instrument) that governs the token; get_trust_documents returns the full legal record." : ""}`,
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
      description: "Get an overview of the Fabrica lending market: loan counts, loans, DeFi lending pool liquidity and utilization, average APR, and recent loan events. Owners borrow against their properties through the DeFi lending pool (pool-based lending). Loan records also include historical peer-to-peer loans made through a former integration that is now retired.",
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
      description: "Get a wallet's Fabrica portfolio: properties owned (paged), active loans (as borrower or lender), marketplace orders, credit history, and total portfolio value. Counts and totals always cover the whole wallet.",
      inputSchema: {
        address: z.string().describe("Ethereum wallet address (0x...)"),
        limit: z.number().int().min(1).max(200).optional().describe("Max properties to list (default 50, max 200)"),
        offset: z.number().int().min(0).optional().describe("Properties to skip, for paging (propertiesPage.nextOffset)"),
      },
      annotations: readOnly("Get wallet portfolio"),
    },
    async (args) => jsonResult(await getPortfolio(args)),
  );

  server.registerTool(
    "get_protocol_stats",
    {
      title: "Get protocol stats",
      description: "Get protocol-wide statistics for the Fabrica real property tokenization platform: total properties, estimated value, lending volume and loan counts, DeFi lending pool TVL and utilization, geographic distribution, and contract addresses.",
      inputSchema: {},
      annotations: readOnly("Get protocol stats"),
    },
    async () => jsonResult(await getProtocolStats()),
  );

  server.registerTool(
    "get_property_map",
    {
      title: "Get property boundary (GeoJSON)",
      description: "Get GeoJSON boundary data for a tokenized property, for mapping, spatial analysis, and visualization. The county boundary is added only with includeCountyBounds: true.",
      inputSchema: {
        tokenId: z.string().optional().describe("The token ID of the property"),
        slug: z.string().optional().describe("Property slug from the URL"),
        includeCountyBounds: z.boolean().optional().describe("Also return the county boundary polygon, a large decorative layer (default: false)"),
      },
      annotations: readOnly("Get property boundary (GeoJSON)"),
    },
    async (args) => jsonResult(await getPropertyMap(args)),
  );

  server.registerTool(
    "get_trust_documents",
    {
      title: "Get trust documents",
      description: `Get the legal record of a tokenized property: the trust that holds it (holding entity, formation date), the trust agreement that governs the token (name, version, link), the legal description, the parcel identifiers (FIPS, APN, county, state), the recorded deed reference and grantor, and documents the owner uploaded. The agreement text is included only when includeAgreementText is true (it is long). Property checks are not a title search or title insurance.${IS_MAINNET ? " The token represents the beneficial interest in the trust; the trustee is designated by the token holder and is, by default, the holder." : ""}`,
      inputSchema: {
        tokenId: z.string().optional().describe("The token ID of the property"),
        slug: z.string().optional().describe("Property slug from the URL"),
        includeAgreementText: z.boolean().optional().describe("Also return the full text of the trust agreement, about 150 KB (default: false; the link is always returned)"),
      },
      annotations: readOnly("Get trust documents"),
    },
    async (args) => jsonResult(await getTrustDocuments(args)),
  );

  server.registerTool(
    "get_tax_status",
    {
      title: "Get property tax status",
      description: "Get whether a tokenized property's taxes are current, past due or unknown, according to Fabrica's Property checks: the status, which signal it comes from (the Property Taxes Current check, the DeFi lending pool's block reason, both, or a note that they disagree), when it was checked and when the checks expire, and whether it limits borrowing. It is a data lookup, not the county's own statement; the amount due and the due date are not available.",
      inputSchema: {
        tokenId: z.string().optional().describe("The token ID of the property"),
        slug: z.string().optional().describe("Property slug from the URL"),
      },
      annotations: readOnly("Get property tax status"),
    },
    async (args) => jsonResult(await getTaxStatus(args)),
  );

  server.registerTool(
    "explain_confidence_score",
    {
      title: "Explain Property checks",
      description: "Explain a Fabrica property's Property checks from their numeric encoding (formerly called the confidence score; the tool name keeps it). The encoding is a 5-digit positional number where each digit represents a different verification group: recovery status (ten-thousands), past title (thousands), ownership (hundreds), onchain history (tens), basic validation (ones). Max score: 75342.",
      inputSchema: {
        tokenId: z.string().optional().describe("Look up and explain the score for this property"),
        score: z.number().int().min(0).optional().describe("The 5-digit Property checks number to explain, as an integer (e.g. 73242)"),
      },
      annotations: readOnly("Explain Property checks"),
    },
    async (args) => jsonResult(await explainConfidenceScore(args)),
  );

  server.registerTool(
    "get_borrow_quote",
    {
      title: "Get borrow quote",
      description: "Get borrowing options for a specific tokenized property: DeFi lending pool liquidity (max loan amount, durations), existing loan status, and the reasons when the pool shows no capacity (tax status, price oracle checks). Answers questions such as 'How much can I borrow against this property?'. The amount is an estimate; the rate is set by a live quote when borrowing.",
      inputSchema: {
        tokenId: z.string().optional().describe("The token ID of the property"),
        slug: z.string().optional().describe("Property slug from the URL"),
      },
      annotations: readOnly("Get borrow quote"),
    },
    async (args) => jsonResult(await getBorrowQuote(args)),
  );

  server.registerTool(
    "get_valuation",
    {
      title: "Get valuation sources",
      description: "Get every value the Fabrica API holds for a property, each with its source, date and confidence: the estimate and the sources it comes from, the Fabrica AVM, Prycd and county assessor figures, the signed valuations the DeFi lending pool reads, the pool's oracle state (feed freshness, onchain price, usable price) with the reason when a price is missing, and the valuation report link. Presents data with its provenance; it suggests no price.",
      inputSchema: {
        tokenId: z.string().optional().describe("The token ID of the property"),
        slug: z.string().optional().describe("Property slug from the URL"),
      },
      annotations: readOnly("Get valuation sources"),
    },
    async (args) => jsonResult(await getValuation(args)),
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
    "get_order_book",
    {
      title: "Get order book",
      description: "Get the marketplace order book for one property: the lowest active listing, all listings, and offers sorted from highest to lowest, each with price in USD and in its currency, seller or buyer, expiry (ISO 8601 and relative), any buyer restriction and disclosure documents. Shows whether the property is a premint and whether it is collateral for an active loan, with what that means for a sale. Expired, canceled and filled orders are left out unless status is 'all'. Links to the property page, where offers are made.",
      inputSchema: {
        tokenId: z.string().optional().describe("The token ID of the property"),
        slug: z.string().optional().describe("Property slug from the URL"),
        status: z.enum(["active", "all"]).optional().describe("'active' (default): live orders only. 'all': also expired, canceled and filled orders."),
        minOfferUsd: z.number().min(0).optional().describe("Only return offers at or above this USD amount"),
      },
      annotations: readOnly("Get order book"),
    },
    async (args) => jsonResult(await getOrderBook(args)),
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
  server.registerTool(
    "ask_fabrica",
    {
      title: "Ask Fabrica",
      description:
        "Answer questions about how Fabrica works from Fabrica's own published documents: docs.fabrica.land, the help center and the US trust agreement. Returns the best matching passages with their URLs, so an answer can be cited. Covers the trust structure, fees, Property checks, lending, property taxes, the onramp and offramp, the legal framework, the glossary and the MCP server itself. When the question names a specific property, wallet or listing, the result also suggests which lookup tool to call. Retrieval is lexical over a committed index, with no external call.",
      inputSchema: {
        question: z.string().min(3).max(1000).describe("The question in plain language, e.g. 'Who is the trustee of the trust that holds my property?'"),
        maxPassages: z.number().int().min(1).max(10).optional().describe("How many passages to return (1-10, default 5)"),
        source: z.enum(ASK_FABRICA_SOURCES).optional().describe("Restrict to one source: 'docs', 'help' (help center), 'trust-agreement', or 'all' (default)"),
      },
      annotations: readOnly("Ask Fabrica"),
    },
    async (args) => jsonResult(await askFabrica(args)),
  );
  registerKnowledgeResources(server);
  return server;
}
