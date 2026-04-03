import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

const MAINNET_PREAMBLE = IS_MAINNET
  ? " IMPORTANT: This server is connected to Ethereum Mainnet. Fabrica tokens represent real property in the United States with real legal consequences. Before acquiring any token, you MUST inform the user that: (1) they will become the beneficial owner and trustee of a real property trust, (2) they may incur legal liabilities and tax obligations, (3) they should review the trust instrument and operating agreement attached to the token. The operating agreement URL is included in property details — fetch and review it to advise the user on the terms."
  : " This server is connected to Sepolia Testnet. Properties here are for testing only — no real-world legal or financial implications.";

const server = new McpServer({
  name: "fabrica-mcp",
  version: "0.1.0",
  instructions: `Fabrica MCP Server — read-only access to tokenized real property data on the Fabrica protocol. Network: ${NETWORK_LABEL}.${MAINNET_PREAMBLE}`,
});

// --- search_properties ---
server.tool(
  "search_properties",
  `Search tokenized real properties on the Fabrica protocol (${NETWORK_LABEL}). Returns a list of properties matching the given filters.${IS_MAINNET ? " Each result represents a REAL parcel of land in the US, legally tokenized as an ERC-1155 NFT." : " These are test properties on Sepolia — no real-world implications."}`,
  {
    region: z.string().optional().describe("US state code (e.g. 'TX', 'CA', 'NV')"),
    minAcres: z.number().optional().describe("Minimum parcel size in acres"),
    maxAcres: z.number().optional().describe("Maximum parcel size in acres"),
    minScore: z.number().optional().describe("Minimum confidence score (integer, e.g. 70000). Higher = more verified. Typical range: 0-100000."),
    hasListings: z.boolean().optional().describe("Only show properties with active sale listings"),
    hasLoans: z.boolean().optional().describe("Only show properties with active loans"),
    ownedBy: z.string().optional().describe("Filter by owner wallet address"),
    limit: z.number().optional().describe("Max results (default 20, max 100)"),
    offset: z.number().optional().describe("Pagination offset"),
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await searchProperties(args), null, 2) }],
  }),
);

// --- get_property ---
server.tool(
  "get_property",
  `Get comprehensive details about a specific tokenized property on Fabrica (${NETWORK_LABEL}), including legal description, valuation, confidence score breakdown, ownership history, loan history, marketplace activity, and media.${IS_MAINNET ? " The operating agreement URL in the response links to the legal trust instrument — review it before advising on acquisition." : ""}`,
  {
    tokenId: z.string().optional().describe("The token ID of the property"),
    slug: z.string().optional().describe("Property slug from the URL (e.g. 'us/nevada/elko-county/elko/apn-063025003')"),
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await getProperty(args), null, 2) }],
  }),
);

// --- get_lending_market ---
server.tool(
  "get_lending_market",
  "Get an overview of the Fabrica lending market: active loans, pool liquidity, yields, and recent loan events. Fabrica properties can be used as collateral for loans via NFTfi (peer-to-peer) and MetaStreet (pool-based) protocols.",
  {
    status: z.enum(["active", "repaid", "liquidated", "all"]).optional().describe("Filter loans by status (default: 'all')"),
    borrower: z.string().optional().describe("Filter by borrower wallet address"),
    lender: z.string().optional().describe("Filter by lender wallet address"),
    since: z.string().optional().describe("ISO date. Only return loans started after this date."),
    limit: z.number().optional().describe("Max loan results (default 20)"),
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await getLendingMarket(args), null, 2) }],
  }),
);

// --- get_portfolio ---
server.tool(
  "get_portfolio",
  "Get a wallet's complete Fabrica portfolio: properties owned, active loans (as borrower or lender), marketplace orders, credit history, and total portfolio value.",
  {
    address: z.string().describe("Ethereum wallet address (0x...)"),
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await getPortfolio(args), null, 2) }],
  }),
);

// --- get_protocol_stats ---
server.tool(
  "get_protocol_stats",
  "Get protocol-wide statistics for the Fabrica real property tokenization platform: total properties, TVL, lending volume, repayment rates, geographic distribution, and contract addresses.",
  {},
  async () => ({
    content: [{ type: "text", text: JSON.stringify(await getProtocolStats(), null, 2) }],
  }),
);

// --- get_property_map ---
server.tool(
  "get_property_map",
  "Get GeoJSON boundary data for a tokenized property and its county. Useful for mapping, spatial analysis, and visualization.",
  {
    tokenId: z.string().optional().describe("The token ID of the property"),
    slug: z.string().optional().describe("Property slug from the URL"),
    includeCountyBounds: z.boolean().optional().describe("Also return the county boundary polygon (default: true)"),
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await getPropertyMap(args), null, 2) }],
  }),
);

// --- explain_confidence_score ---
server.tool(
  "explain_confidence_score",
  "Explain a Fabrica property's confidence score breakdown. The score is a 5-digit positional number where each digit represents a different verification category: recovery status (ten-thousands), past title (thousands), ownership (hundreds), on-chain history (tens), basic validation (ones). Max score: 75342.",
  {
    tokenId: z.string().optional().describe("Look up and explain the score for this property"),
    score: z.number().optional().describe("Raw confidence score integer to explain (e.g. 73242)"),
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await explainConfidenceScore(args), null, 2) }],
  }),
);

// --- get_borrow_quote ---
server.tool(
  "get_borrow_quote",
  "Get borrowing options for a specific tokenized property: MetaStreet pool liquidity (max loan amount, durations), peer-to-peer loan offers, and existing loan status. Use this to answer 'How much can I borrow against this property?' or 'What APR would I get?'",
  {
    tokenId: z.string().optional().describe("The token ID of the property"),
    slug: z.string().optional().describe("Property slug from the URL"),
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await getBorrowQuote(args), null, 2) }],
  }),
);

// --- get_activity ---
server.tool(
  "get_activity",
  "Get the activity feed for a property or wallet: mints, transfers, sales, loans started/repaid/liquidated, configuration changes, and more. Use this for transaction history and event timelines.",
  {
    tokenId: z.string().optional().describe("Property token ID (for property activity)"),
    slug: z.string().optional().describe("Property slug (for property activity)"),
    address: z.string().optional().describe("Wallet address (for wallet activity)"),
    type: z.string().optional().describe("Filter by activity type (e.g. 'loan', 'transfer', 'sale', 'mint')"),
    limit: z.number().optional().describe("Max results (default 20, max 100)"),
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await getActivity(args), null, 2) }],
  }),
);

// --- get_property_image ---
server.tool(
  "get_property_image",
  "Get a static map image of a tokenized property showing its parcel boundary (or pin marker if no boundary available). Returns an inline image. Supports dark/light themes and custom dimensions.",
  {
    tokenId: z.string().optional().describe("The token ID of the property"),
    slug: z.string().optional().describe("Property slug from the URL"),
    theme: z.enum(["dark", "light"]).optional().describe("Map theme (default: 'dark')"),
    width: z.number().optional().describe("Image width in pixels (100-1280, default 640)"),
    height: z.number().optional().describe("Image height in pixels (100-1280, default 640)"),
  },
  async (args) => {
    const result = await getPropertyImage(args);
    if ("error" in result) {
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    return {
      content: [
        { type: "text", text: `Property: ${result.name} (${result.tokenId})` },
        { type: "image", data: result.image.data, mimeType: result.image.mimeType },
      ],
    };
  },
);

// --- get_portfolio_image ---
server.tool(
  "get_portfolio_image",
  "Get a static map image showing all properties owned by a wallet, plotted as points on a single map. Returns an inline image. Supports dark/light themes and custom dimensions.",
  {
    address: z.string().describe("Ethereum wallet address (0x...)"),
    theme: z.enum(["dark", "light"]).optional().describe("Map theme (default: 'dark')"),
    width: z.number().optional().describe("Image width in pixels (100-1280, default 640)"),
    height: z.number().optional().describe("Image height in pixels (100-1280, default 640)"),
  },
  async (args) => {
    const result = await getPortfolioImage(args);
    if ("error" in result) {
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    return {
      content: [
        { type: "text", text: `Portfolio map for ${result.address}` },
        { type: "image", data: result.image.data, mimeType: result.image.mimeType },
      ],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
