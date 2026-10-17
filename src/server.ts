import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { searchProperties, getProperty, getPropertyMap, searchPropertiesInput, getPropertyInput, getPropertyMapInput, type GetPropertyArgs } from "./tools/properties.js";
import { getLendingMarket, getLendingMarketInput } from "./tools/lending.js";
import { getPortfolio, getPortfolioInput } from "./tools/portfolio.js";
import { getProtocolStats } from "./tools/protocol.js";
import { explainConfidenceScore, explainConfidenceScoreInput } from "./tools/scoring.js";
import { getBorrowQuote, getBorrowQuoteInput } from "./tools/borrowing.js";
import { getValuation, getValuationInput } from "./tools/valuation.js";
import { getActivity, getActivityInput } from "./tools/activity.js";
import { getOrderBook, getOrderBookInput } from "./tools/marketplace.js";
import { getPropertyImage, getPortfolioImage, getPropertyImageInput, getPortfolioImageInput } from "./tools/images.js";
import { getTrustDocuments, getTrustDocumentsInput } from "./tools/documents.js";
import { getTaxStatus, getTaxStatusInput } from "./tools/tax.js";
import { askFabrica, askFabricaInput } from "./tools/knowledge.js";
import { findParcel, findParcelInput } from "./tools/parcels.js";
import { checkCoverage, checkCoverageInput, COVERAGE_AS_OF } from "./tools/coverage.js";
import { registerPrompts } from "./prompts.js";
import { contactSupport, contactSupportInput } from "./tools/support.js";
import { NETWORK_LABEL, IS_MAINNET, MAINNET_LEGAL_NOTICE } from "./config.js";
import { PROPERTY_CARD_URI, registerPropertyCard } from "./ui/property-card.js";
import { registerKnowledgeResources } from "./resources/knowledge.js";

const NETWORK_NOTICE = IS_MAINNET
  ? `\n\n${MAINNET_LEGAL_NOTICE}`
  : " Properties on this network are test tokens with no real-world legal or financial effect.";

export const SERVER_INSTRUCTIONS = `Fabrica MCP server: read-only access to tokenized US land on the Fabrica protocol, including property records, trust documents, US parcel lookup by address or parcel number, Property checks, parcel boundaries and maps, the lending market, borrow quotes, wallet portfolios and activity. Network: ${NETWORK_LABEL}. Company overview: https://about.fabrica.land. For questions about how Fabrica works (the trust, fees, Property checks, lending, taxes, the onramp, the legal framework) call ask_fabrica and cite the URL of the passage you relied on. When ask_fabrica returns no matching passage, say so and call contact_support (or point to https://help.fabrica.land or questions@fabrica.land) instead of guessing; contact_support sends nothing, so tell the person the email is theirs to send.${NETWORK_NOTICE}`;

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
      description: `Search tokenized real properties on the Fabrica protocol (${NETWORK_LABEL}). Returns a list of properties matching the given filters (location, size, Property checks, listing status, listing price and price per acre, distance from a point), sorted by price, price per acre, acres, estimated value, Property checks, mint date or distance; each row carries its price per acre (listing or estimate, labelled) and, with near, its straight-line distance. Or counts per state or county with groupBy. When a state or county is given, the response includes the link to that location's page on fabrica.land.${IS_MAINNET ? " Each result is a real parcel of land in the US, held in a trust whose beneficial interest is an ERC-1155 token." : " These are test properties on Sepolia with no real-world effect."}`,
      inputSchema: searchPropertiesInput,
      annotations: readOnly("Search properties"),
    },
    async (args) => jsonResult(await searchProperties(args)),
  );

  const getPropertyConfig = {
    title: "Get property details",
    description: `Get comprehensive details about a specific tokenized property on Fabrica (${NETWORK_LABEL}), including legal description, valuation, property tax status, Property checks (with their 5-digit numeric encoding), current ownership and holders, active loans, marketplace listings and offers, recent activity, photos and a parcel map image link. Also its lifecycle stage (premint, minted, removal in progress), fees assessed on the token with approval and payment state (fees is null when none are assessed), and flags for a duplicate parcel claim or the marketplace screen (an empty list when none apply). An old premint ID that was replaced by a minted token returns the successor. Boundary geometry is returned by get_property_map.${IS_MAINNET ? " The response includes the URL of the operating agreement (the trust instrument) that governs the token; get_trust_documents returns the full legal record." : ""} Pass display: "fullscreen" to ask a host that renders the property card to open it fullscreen (the host may decline). Owner names: the majority holder's chosen display name is returned; the deed grantor from Fabrica's own records is in get_trust_documents; owner names from third-party parcel data are never returned.`,
    inputSchema: getPropertyInput,
    annotations: readOnly("Get property details"),
  };
  const getPropertyCallback = async (args: GetPropertyArgs): Promise<CallToolResult> => {
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
      inputSchema: getLendingMarketInput,
      annotations: readOnly("Get lending market"),
    },
    async (args) => jsonResult(await getLendingMarket(args)),
  );

  server.registerTool(
    "get_portfolio",
    {
      title: "Get wallet portfolio",
      description: "Get a wallet's Fabrica portfolio: properties owned (paged), active loans (as borrower or lender), marketplace orders, credit history, and total portfolio value. Counts and totals always cover the whole wallet.",
      inputSchema: getPortfolioInput,
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
      inputSchema: getPropertyMapInput,
      annotations: readOnly("Get property boundary (GeoJSON)"),
    },
    async (args) => jsonResult(await getPropertyMap(args)),
  );

  server.registerTool(
    "get_trust_documents",
    {
      title: "Get trust documents",
      description: `Get the legal record of a tokenized property: the trust that holds it (holding entity, formation date), the trust agreement that governs the token (name, version, link), the legal description, the parcel identifiers (FIPS, APN, county, state), the recorded deed reference and grantor, and documents the owner uploaded. The agreement text is included only when includeAgreementText is true (it is long); trust.agreementResource is the MCP resource with this token's own agreement. Owner names: the deed grantor from Fabrica's own records is returned; a holder's chosen display name is in get_property; owner names from third-party parcel data are never returned. Property checks are not a title search or title insurance.${IS_MAINNET ? " The token represents the beneficial interest in the trust; the trustee is designated by the token holder and is, by default, the holder." : ""}`,
      inputSchema: getTrustDocumentsInput,
      annotations: readOnly("Get trust documents"),
    },
    async (args) => jsonResult(await getTrustDocuments(args)),
  );

  server.registerTool(
    "get_tax_status",
    {
      title: "Get property tax status",
      description: "Get whether a tokenized property's taxes are current, past due or unknown, according to Fabrica's Property checks: the status, which signal it comes from (the Property Taxes Current check, the DeFi lending pool's block reason, both, or a note that they disagree), when it was checked and when the checks expire, and whether it limits borrowing. It is a data lookup, not the county's own statement; the amount due and the due date are not available.",
      inputSchema: getTaxStatusInput,
      annotations: readOnly("Get property tax status"),
    },
    async (args) => jsonResult(await getTaxStatus(args)),
  );

  server.registerTool(
    "explain_confidence_score",
    {
      title: "Explain Property checks",
      description: "Explain a Fabrica property's Property checks from their numeric encoding (formerly called the confidence score; the tool name keeps it). The encoding is a 5-digit positional number where each digit represents a different verification group: recovery status (ten-thousands), past title (thousands), ownership (hundreds), onchain history (tens), basic validation (ones). Each digit is a category value, not a count; with a tokenId the response also counts the individual checks that pass. Max: 75342. Property checks are a starting point for your own research, not a title search or title insurance.",
      inputSchema: explainConfidenceScoreInput,
      annotations: readOnly("Explain Property checks"),
    },
    async (args) => jsonResult(await explainConfidenceScore(args)),
  );

  server.registerTool(
    "get_borrow_quote",
    {
      title: "Get borrow quote",
      description: "Get borrowing options for a specific tokenized property: DeFi lending pool liquidity (max loan amount, durations), existing loan status, the reasons when the pool shows no capacity (tax status, price oracle checks), and in limits what binds the amount (limitedBy: pool_liquidity, ltv, pool_limit, tax_status, oracle, existing_loan or unknown) with the collateral price, the pool's free liquidity and the highest loan-to-value. The oracle block shows how the collateral price is derived from the valuation sources. toRaise lists what would raise the amount, one entry per lever (onramp, tax_status, deed_check, fees, existing_loan, price, ltv, pool_liquidity), each with where it stands today, what the pool would allow once it moves (wouldAllow, USD where computable) and the step or mechanism that moves it; pass amountUsd to test a loan amount. Answers questions such as 'How much can I borrow against this property?'. The amount is an estimate; the rate is set by a live quote when borrowing.",
      inputSchema: getBorrowQuoteInput,
      annotations: readOnly("Get borrow quote"),
    },
    async (args) => jsonResult(await getBorrowQuote(args)),
  );

  server.registerTool(
    "get_valuation",
    {
      title: "Get valuation sources",
      description: "Get every value the Fabrica API holds for a property, each with its source, date and confidence: the estimate and the sources it comes from, the Fabrica AVM, Prycd and county assessor figures, the signed valuations the DeFi lending pool reads, the pool's oracle state (feed freshness, onchain price, usable price) with the reason when a price is missing, and the valuation report link. Presents data with its provenance; it suggests no price.",
      inputSchema: getValuationInput,
      annotations: readOnly("Get valuation sources"),
    },
    async (args) => jsonResult(await getValuation(args)),
  );

  server.registerTool(
    "get_activity",
    {
      title: "Get activity history",
      description: "Get the activity feed for a property or wallet, or, with no tokenId, slug or address, the most recent activity across every property on the network: mints, transfers, sales, listings, loans started/repaid/liquidated, configuration changes, and more. Covers transaction history and event timelines.",
      inputSchema: getActivityInput,
      annotations: readOnly("Get activity history"),
    },
    async (args) => jsonResult(await getActivity(args)),
  );

  server.registerTool(
    "get_order_book",
    {
      title: "Get order book",
      description: "Get the marketplace order book for one property: the lowest active listing, all listings, and offers sorted from highest to lowest, each with price in USD and in its currency, seller or buyer, expiry (ISO 8601 and relative), any buyer restriction and disclosure documents. Shows whether the property is a premint and whether it is collateral for an active loan, with what that means for a sale. Expired, canceled and filled orders are left out unless status is 'all'. Links to the property page, where offers are made.",
      inputSchema: getOrderBookInput,
      annotations: readOnly("Get order book"),
    },
    async (args) => jsonResult(await getOrderBook(args)),
  );

  server.registerTool(
    "get_property_image",
    {
      title: "Get property map image",
      description: "Get a static map image of a tokenized property showing its parcel boundary (or a pin marker if no boundary is available). Returns an inline image. Supports dark/light themes and custom dimensions.",
      inputSchema: getPropertyImageInput,
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
      inputSchema: getPortfolioImageInput,
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
      inputSchema: askFabricaInput,
      annotations: readOnly("Ask Fabrica"),
    },
    async (args) => jsonResult(await askFabrica(args)),
  );
  server.registerTool(
    "find_parcel",
    {
      title: "Find a US parcel",
      description: "Resolve any US street address or parcel number (APN) to a parcel: address, place, APN, state and county, and whether it is already on Fabrica (token ID and property link). For a parcel not on Fabrica, links.addToFabrica is the fabrica.land on-ramp link for that parcel; it starts an on-ramp only when a person opens it and decides there. The tool itself creates nothing. An ambiguous query returns up to 5 candidates, whose Fabrica status is matched by parcel number only; state and county narrow it to one, which gets the full check. When the US parcel search is not answering, properties already on Fabrica that the query names come back from Fabrica's own records as unconfirmed candidates (match: unconfirmed, matchSource: fabrica-index); present them as likely, not confirmed. Owner names from parcel data are never returned. Limited to 30 lookups per minute per client.",
      inputSchema: findParcelInput,
      annotations: readOnly("Find a US parcel"),
    },
    async (args) => jsonResult(await findParcel(args)),
  );
  server.registerTool(
    "check_coverage",
    {
      title: "Check on-ramp coverage for a county",
      description: `Whether a US county (or a whole state) can be added to Fabrica through the on-ramp: supported, notConfigured or unsupported, and for a supported county the deed and forms the owner signs (and which are notarized), witness requirements, the questions the owner is asked, and the on-ramp steps. Answers from a table of Fabrica's on-ramp rules as of ${COVERAGE_AS_OF}, refreshed by hand, so each answer carries that date; the on-ramp page is the live answer. Give a 5-digit county FIPS, or a two-letter state with or without a county. No fee amounts (ask_fabrica has them) and no owner data.`,
      inputSchema: checkCoverageInput,
      annotations: { ...readOnly("Check on-ramp coverage for a county"), openWorldHint: false },
    },
    async (args) => jsonResult(checkCoverage(args)),
  );
  server.registerTool(
    "contact_support",
    {
      title: "Contact Fabrica support",
      description: "Hand a question to Fabrica's support team when the documents (ask_fabrica) do not answer it or a person is needed: a stuck onramp, a document question, a dispute. Returns the help center section for the topic, the support email address, and a mailto link that drafts an email with the summary and the property link (the same fabrica.land page the other tools link). subject sets the subject in the person's words; a line saying an AI agent drafted it is added unless discloseAgent is false. Nothing is sent by this tool; the person sends the email and replies come back by email. Summaries containing a private key or seed phrase are refused.",
      inputSchema: contactSupportInput,
      annotations: readOnly("Contact Fabrica support"),
    },
    async (args) => jsonResult(await contactSupport(args)),
  );
  registerKnowledgeResources(server);
  registerPrompts(server);
  return server;
}
