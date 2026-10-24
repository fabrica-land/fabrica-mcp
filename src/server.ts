import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { searchProperties, getProperty, getPropertyMap, searchPropertiesInput, getPropertyInput, getPropertyMapInput, type GetPropertyArgs } from "./tools/properties.js";
import { getLendingMarket, getLendingMarketInput } from "./tools/lending.js";
import { getLoanBook, getLoanBookInput } from "./tools/loan-book.js";
import { getPortfolio, getPortfolioInput, type GetPortfolioArgs } from "./tools/portfolio.js";
import { getProtocolStats } from "./tools/protocol.js";
import { explainConfidenceScore, explainConfidenceScoreInput } from "./tools/scoring.js";
import { getBorrowQuote, getBorrowQuoteInput } from "./tools/borrowing.js";
import { getValuation, getValuationInput } from "./tools/valuation.js";
import { getActivity, getActivityInput } from "./tools/activity.js";
import { getOrderBook, getOrderBookInput } from "./tools/marketplace.js";
import { getPropertyImage, getPortfolioImage, getPropertyImageInput, getPortfolioImageInput, type GetPortfolioImageArgs } from "./tools/images.js";
import { ownWalletArg, walletIfMe, walletOrOwn } from "./tools/own-wallet.js";
import { getTrustDocuments, getTrustDocumentsInput } from "./tools/documents.js";
import { getTaxStatus, getTaxStatusInput } from "./tools/tax.js";
import { askFabrica, askFabricaInput } from "./tools/knowledge.js";
import { findParcelInput, findParcelWithUsage, MAX_BATCH_QUERIES } from "./tools/parcels.js";
import { checkCoverage, checkCoverageInput, COVERAGE_AS_OF } from "./tools/coverage.js";
import { registerPrompts } from "./prompts.js";
import { contactSupport, contactSupportInput } from "./tools/support.js";
import {
  acceptOffer,
  buy,
  cancelOrder,
  getSignRequest,
  getSignRequestInput,
  listForSale,
  listForSaleInput,
  makeOffer,
  makeOfferInput,
  orderActionInput,
} from "./tools/sign-requests.js";
import { getTransactionStatus, getTransactionStatusInput } from "./tools/transactions.js";
import { borrowAgainstLand, borrowInput, getLoan, getLoanInput, repayInput, repayLandLoan } from "./tools/loans.js";
import { NETWORK_LABEL, IS_MAINNET, MAINNET_LEGAL_NOTICE } from "./config.js";
import { PROPERTY_CARD_URI, registerPropertyCard } from "./ui/property-card.js";
import { registerKnowledgeResources } from "./resources/knowledge.js";
import type { AccountAuth } from "./auth/token.js";
import { getMyAccount, getMyProperties, getMyPropertiesInput } from "./tools/account.js";
import { getMyOnRamps, getOnRampStatus, getOnRampStatusInput } from "./tools/onramps.js";
import { getMyOffers, getMyOffersInput } from "./tools/offers.js";
import { getMyLoans } from "./tools/my-loans.js";
import { ATTENTION_TOKEN_BUDGET, whatNeedsAttention } from "./tools/attention.js";
import { LENDING_POOL_NAME } from "./labels.js";

const NETWORK_NOTICE = IS_MAINNET
  ? `\n\n${MAINNET_LEGAL_NOTICE}`
  : " Properties on this network are test tokens with no real-world legal or financial effect.";

export const SERVER_INSTRUCTIONS = `Fabrica MCP server: read-only access to tokenized US land on the Fabrica protocol, including property records, trust documents, US parcel lookup by address or parcel number, Property checks, parcel boundaries and maps, the lending market, borrow quotes, wallet portfolios and activity. Network: ${NETWORK_LABEL}. Company overview: https://about.fabrica.land. For questions about how Fabrica works (the trust, fees, Property checks, lending, taxes, adding and removing a property, the legal framework) call ask_fabrica and cite the URL of the passage you relied on. When ask_fabrica returns no matching passage, say so and call contact_fabrica_support (or point to https://help.fabrica.land or questions@fabrica.land) instead of guessing; contact_fabrica_support sends nothing, so tell the person the email is theirs to send.${NETWORK_NOTICE}`;

/** Added to the instructions where the sign-request tools are on. */
export const SIGN_REQUEST_INSTRUCTIONS = " make_land_offer, list_land_for_sale, accept_land_offer, buy_land and cancel_land_order prepare a marketplace action, and borrow_against_land and repay_land_loan a DeFi lending pool loan or its payoff, as a sign request: they check the live data and return a summary, warnings and a sign link to fabrica.land, where the person reviews and signs with their own wallet. The server holds no keys and submits nothing; a prepared request is not sent until the person signs. get_sign_request reports whether it was signed; get_transaction_status follows an onchain transaction.";

/** Added to the instructions on the signed-in endpoint (/mcp/account). */
export const ACCOUNT_INSTRUCTIONS = " This is the signed-in endpoint: the person connected their Fabrica account to this client. get_my_account reads that person's own account (email, linked accounts, verification status, and what the connection may read) get_my_properties lists their own properties, get_my_offers lists the offers they made and the ones waiting on their properties, get_my_loans lists their loans and pool deposits, get_my_properties_being_added and get_adding_status read the properties they are adding to Fabrica (each step, who acts next, and the link to do it), and what_needs_attention ranks everything waiting on them; every other tool reads public data only, as on the anonymous endpoint, except that get_land_portfolio and get_land_portfolio_map_image read the connected person's own wallet when address is left out, and get_land_activity (address) and search_land (ownedBy) take 'me' for it. Personal data on this endpoint belongs to the connected person and is private to them.";

/**
 * Sign requests ship testnet-first: on by default on Sepolia, and on mainnet only
 * when FABRICA_SIGN_REQUESTS=enabled. Read per server so a deployment's env decides.
 */
export function signRequestsEnabled(): boolean {
  const flag = process.env.FABRICA_SIGN_REQUESTS?.toLowerCase();
  if (flag === "enabled") return true;
  if (flag === "disabled") return false;
  return !IS_MAINNET;
}

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

/** Prepares a sign request: writes a short-lived record to the server's own store, changes nothing onchain or in the API. */
function prepares(title: string): ToolAnnotations {
  return { title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
}

/** JSON tool result; results that carry an `error` are flagged so clients can tell failure from data. */
function jsonResult(result: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    ...("error" in result ? { isError: true } : {}),
  };
}

export interface ServerHooks {
  /** Receives, per find_us_parcel call, whether each settled query named a parcel on Fabrica (the usage log's split). */
  onFindParcel?: (onFabrica: readonly boolean[]) => void;
  /** The connected user on the signed-in endpoint; adds the personal tools. Absent on the anonymous endpoint. */
  account?: AccountAuth;
}

/** A tool's arguments with its wallet argument optional, as on the signed-in endpoint. */
type OwnWalletArgs<A, K extends keyof A> = Omit<A, K> & { [P in K]?: string };

export function createServer(hooks: ServerHooks = {}): McpServer {
  // `instructions` belongs in the SDK's ServerOptions (second argument), not in the
  // Implementation record. Passed in the first argument it rode along inside
  // `serverInfo`, where no client reads it, so the mainnet legal notice never
  // reached an agent.
  const server = new McpServer(
    {
      name: "fabrica-mcp",
      title: "Fabrica",
      version: "0.2.0",
    },
    {
      instructions: SERVER_INSTRUCTIONS
        + (signRequestsEnabled() ? SIGN_REQUEST_INSTRUCTIONS : "")
        + (hooks.account ? ACCOUNT_INSTRUCTIONS : ""),
    },
  );

  // On the signed-in endpoint the wallet-scoped tools default to the person's own wallet
  // (own-wallet.ts); on the anonymous endpoint they are unchanged.
  const account = hooks.account;
  const ownOrGiven = <R extends object>(value: string | undefined, run: (address: string) => Promise<R>) => {
    if (account) return walletOrOwn(account, value, run);
    return value === undefined ? Promise.resolve({ error: "address is required (Ethereum wallet address)" }) : run(value);
  };
  const meOrGiven = <R extends object>(value: string | undefined, run: (address: string | undefined) => Promise<R>) =>
    (account ? walletIfMe(account, value, run) : run(value));
  const ownNote = (omittedMeansOwn: boolean, key: string) => (account
    ? ` On this signed-in endpoint, ${omittedMeansOwn ? `leave ${key} out` : `pass ${key} "me"`} to read the connected person's own wallet; walletUsed says which one.`
    : "");

  server.registerTool(
    "search_land",
    {
      title: "Search land",
      description: `Search US land on Fabrica (${NETWORK_LABEL}): land for sale and every other property on the network, mostly vacant lots and acreage. Returns a list of properties matching the given filters (location, size, Property checks, listing status, listing price and price per acre, distance from a point), sorted by price, price per acre, acres, estimated value, Property checks, date added or distance; each row carries its price per acre (listing or estimate, labeled) and, with near, its straight-line distance. Or counts per state or county with groupBy. When a state or county is given, the response includes the link to that location's page on fabrica.land.${IS_MAINNET ? " Each result is a real parcel of land in the US, held in a trust whose beneficial interest is an ERC-1155 token." : " These are test properties on Sepolia with no real-world effect."}${ownNote(false, "ownedBy")}`,
      inputSchema: account ? { ...searchPropertiesInput, ownedBy: ownWalletArg("Filter by owner wallet address", false) } : searchPropertiesInput,
      annotations: readOnly("Search land"),
    },
    async ({ ownedBy, ...rest }) => jsonResult(await meOrGiven(ownedBy, (owner) => searchProperties({ ...rest, ownedBy: owner }))),
  );

  const getPropertyConfig = {
    title: "Get land property details",
    description: `Get the full record of one property on Fabrica (${NETWORK_LABEL}), including legal description, valuation, property tax status, Property checks (with their 5-digit numeric encoding), current ownership and holders, active loans, marketplace listings and offers, recent activity, photos and a parcel map image link. Also its lifecycle stage (unclaimed, being added, replaced, live, removal in progress, removed, retired), fees assessed on the token with approval and payment state (fees is null when none are assessed), and flags for a duplicate parcel claim or the marketplace screen (an empty list when none apply). A token ID that was replaced when the property's token was issued returns that issued token. Boundary geometry is returned by get_land_boundary.${IS_MAINNET ? " The response includes the URL of the operating agreement (the trust instrument) that governs the token; get_land_trust_documents returns the full legal record." : ""} Pass display: "fullscreen" to ask a host that renders the property card to open it fullscreen (the host may decline). Owner names: the majority holder's chosen display name is returned; the deed grantor from Fabrica's own records is in get_land_trust_documents; owner names from third-party parcel data are never returned.`,
    inputSchema: getPropertyInput,
    annotations: readOnly("Get land property details"),
  };
  const getPropertyCallback = async (args: GetPropertyArgs): Promise<CallToolResult> => {
    const result = await getProperty(args);
    return { ...jsonResult(result), structuredContent: result };
  };
  if (mcpAppsEnabled()) {
    // MCP App: hosts that support MCP Apps render the property card from structuredContent;
    // other clients read the same data as JSON text.
    registerAppTool(server, "get_land_property", { ...getPropertyConfig, _meta: { ui: { resourceUri: PROPERTY_CARD_URI } } }, getPropertyCallback);
    registerPropertyCard(server);
  } else {
    server.registerTool("get_land_property", getPropertyConfig, getPropertyCallback);
  }

  server.registerTool(
    "get_fabrica_lending_market",
    {
      title: "Get lending market",
      description: "Get an overview of the Fabrica lending market: loan counts, loans, DeFi lending pool liquidity and utilization, average APR, and recent loan events (the distribution of the whole history, by loan-to-value, state and outcome, is in get_fabrica_loan_book). Owners borrow against their properties through the DeFi lending pool (pool-based lending). Loan records also include historical peer-to-peer loans made through a former integration that is now retired.",
      inputSchema: getLendingMarketInput,
      annotations: readOnly("Get lending market"),
    },
    async (args) => jsonResult(await getLendingMarket(args)),
  );

  server.registerTool(
    "get_fabrica_loan_book",
    {
      title: "Get loan book",
      description: "Get the lending history of the Fabrica protocol as a distribution: loan counts and principal by status and provider, loan-to-value bands against today's property estimates, exposure by state and acreage, APR and duration spread, repaid and liquidated counts, originations by month for the last 12 months, and the largest loans with their property pages. Covers DeFi lending pool loans and historical peer-to-peer loans. Counts come from the loan records; where the pool data source's counters differ, both are shown.",
      inputSchema: getLoanBookInput,
      annotations: readOnly("Get loan book"),
    },
    async (args) => jsonResult(await getLoanBook(args)),
  );

  server.registerTool(
    "get_land_portfolio",
    {
      title: "Get wallet portfolio",
      description: `Get a wallet's land portfolio on Fabrica: properties owned (paged), active loans (as borrower or lender), listings and offers, credit history, and total portfolio value. Counts and totals always cover the whole wallet.${ownNote(true, "address")}`,
      inputSchema: account ? { ...getPortfolioInput, address: ownWalletArg("Ethereum wallet address", true) } : getPortfolioInput,
      annotations: readOnly("Get wallet portfolio"),
    },
    async ({ address, ...rest }: OwnWalletArgs<GetPortfolioArgs, "address">) => jsonResult(await ownOrGiven(address, (wallet) => getPortfolio({ ...rest, address: wallet }))),
  );

  server.registerTool(
    "get_fabrica_stats",
    {
      title: "Get Fabrica stats",
      description: "Get network-wide statistics for Fabrica, where US land is held in trusts represented by tokens: total properties, estimated value, lending volume and loan counts, DeFi lending pool TVL and utilization, geographic distribution, and contract addresses.",
      inputSchema: {},
      annotations: readOnly("Get Fabrica stats"),
    },
    async () => jsonResult(await getProtocolStats()),
  );

  server.registerTool(
    "get_land_boundary",
    {
      title: "Get land parcel boundary (GeoJSON)",
      description: "Get the parcel boundary of a property on Fabrica as GeoJSON, for mapping, spatial analysis, and visualization. The county boundary is added only with includeCountyBounds: true.",
      inputSchema: getPropertyMapInput,
      annotations: readOnly("Get land parcel boundary (GeoJSON)"),
    },
    async (args) => jsonResult(await getPropertyMap(args)),
  );

  server.registerTool(
    "get_land_trust_documents",
    {
      title: "Get trust documents",
      description: `Get the legal record of a tokenized property: the trust that holds it (holding entity, formation date), the trust agreement that governs the token (name, version, link), the legal description, the parcel identifiers (FIPS, APN, county, state), the recorded deed reference and grantor, and documents the owner uploaded. The agreement text is included only when includeAgreementText is true (it is long); trust.agreementResource is the MCP resource with this token's own agreement. Owner names: the deed grantor from Fabrica's own records is returned; a holder's chosen display name is in get_land_property; owner names from third-party parcel data are never returned. Property checks are not a title search or title insurance.${IS_MAINNET ? " The token represents the beneficial interest in the trust; the trustee is designated by the token holder and is, by default, the holder." : ""}`,
      inputSchema: getTrustDocumentsInput,
      annotations: readOnly("Get trust documents"),
    },
    async (args) => jsonResult(await getTrustDocuments(args)),
  );

  server.registerTool(
    "get_land_tax_status",
    {
      title: "Get property tax status",
      description: "Get whether a property's taxes are current, past due or unknown, according to Fabrica's Property checks: the status, which signal it comes from (the Property Taxes Current check, the DeFi lending pool's block reason, both, or a note that they disagree), when it was checked and when the checks expire, and whether it limits borrowing. It is a data lookup, not the county's own statement; the amount due and the due date are not available.",
      inputSchema: getTaxStatusInput,
      annotations: readOnly("Get property tax status"),
    },
    async (args) => jsonResult(await getTaxStatus(args)),
  );

  server.registerTool(
    "explain_property_checks",
    {
      title: "Explain Property checks",
      description: "Explain a Fabrica property's Property checks from their numeric encoding (formerly called the confidence score). The encoding is a 5-digit positional number where each digit represents a different verification group: recovery status (ten-thousands), past title (thousands), ownership (hundreds), onchain history (tens), basic validation (ones). Each digit is a category value, not a count; with a tokenId the response also counts the individual checks that pass. Max: 75342. Property checks are a starting point for your own research, not a title search or title insurance.",
      inputSchema: explainConfidenceScoreInput,
      annotations: readOnly("Explain Property checks"),
    },
    async (args) => jsonResult(await explainConfidenceScore(args)),
  );

  server.registerTool(
    "estimate_land_borrowing",
    {
      title: "Estimate borrowing against land",
      description: "Estimate how much can be borrowed against a property on Fabrica: DeFi lending pool liquidity (max loan amount, durations), existing loan status, the reasons when the pool shows no capacity (tax status, price oracle checks), and in limits what binds the amount (limitedBy: pool_liquidity, ltv, pool_limit, tax_status, oracle, existing_loan or unknown) with the collateral price, the pool's free liquidity and the highest loan-to-value. The oracle block shows how the collateral price is derived from the valuation sources. toRaise lists what would raise the amount, one entry per lever (setup, tax_status, deed_check, fees, existing_loan, price, ltv, pool_liquidity), each with where it stands today, what the pool would allow once it moves (wouldAllow, USD where computable) and the step or mechanism that moves it; pass amountUsd to test a loan amount. Answers questions such as 'How much can I borrow against this property?'. The amount is an estimate; the rate is set by a live quote when borrowing.",
      inputSchema: getBorrowQuoteInput,
      annotations: readOnly("Estimate borrowing against land"),
    },
    async (args) => jsonResult(await getBorrowQuote(args)),
  );

  server.registerTool(
    "get_land_loan",
    {
      title: "Get a loan against land",
      description: "Get one loan against a property on Fabrica: status (active, repaid, liquidated), provider, principal, APR, start, maturity, the full repayment and, for an active loan, the payoff today, with the borrower and lender wallets shortened and the property link. Give a property (tokenId or slug) for its active or latest loan, add loanId for a specific one, or give loanId alone to look it up across the network. otherLoans lists the property's other loans.",
      inputSchema: getLoanInput,
      annotations: readOnly("Get a loan against land"),
    },
    async (args) => jsonResult(await getLoan(args)),
  );

  server.registerTool(
    "get_land_valuation",
    {
      title: "Get valuation sources",
      description: "Get every value the Fabrica API holds for a property, each with its source, date and confidence: the estimate and the sources it comes from, the Fabrica AVM, Prycd and county assessor figures, the signed valuations the DeFi lending pool reads, the pool's oracle state (feed freshness, onchain price, usable price) with the reason when a price is missing, and the valuation report link. Presents data with its provenance; it suggests no price.",
      inputSchema: getValuationInput,
      annotations: readOnly("Get valuation sources"),
    },
    async (args) => jsonResult(await getValuation(args)),
  );

  server.registerTool(
    "get_land_activity",
    {
      title: "Get activity history",
      description: `Get the activity feed for a property or wallet, or, with no tokenId, slug or address, the most recent activity across every property on the network: properties added, transfers, sales, listings, loans started, repaid or liquidated, configuration changes, and more. Covers transaction history and event timelines.${ownNote(false, "address")}`,
      inputSchema: account ? { ...getActivityInput, address: ownWalletArg("Wallet address (for wallet activity)", false) } : getActivityInput,
      annotations: readOnly("Get activity history"),
    },
    async ({ address, ...rest }) => jsonResult(await meOrGiven(address, (wallet) => getActivity({ ...rest, address: wallet }))),
  );

  server.registerTool(
    "get_land_order_book",
    {
      title: "Get order book",
      description: "Get the listings and offers on one property on Fabrica: the lowest active listing, all listings, and offers sorted from highest to lowest, each with price in USD and in its currency, seller or buyer, expiry (ISO 8601 and relative), any buyer restriction and disclosure documents. Shows whether the property is still being added to Fabrica and whether it is collateral for an active loan, with what that means for a sale. Expired, canceled and filled listings and offers are left out unless status is 'all'. Links to the property page, where offers are made.",
      inputSchema: getOrderBookInput,
      annotations: readOnly("Get order book"),
    },
    async (args) => jsonResult(await getOrderBook(args)),
  );

  server.registerTool(
    "get_land_map_image",
    {
      title: "Get property map image",
      description: "Get a static map image of a property on Fabrica showing its parcel boundary (or a pin marker if no boundary is available). Returns an inline image. Supports dark/light themes and custom dimensions.",
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
    "get_land_portfolio_map_image",
    {
      title: "Get portfolio map image",
      description: `Get a static map image showing all properties a wallet owns on Fabrica, plotted as points on a single map. Returns an inline image. Supports dark/light themes and custom dimensions.${ownNote(true, "address")}`,
      inputSchema: account ? { ...getPortfolioImageInput, address: ownWalletArg("Ethereum wallet address", true) } : getPortfolioImageInput,
      annotations: readOnly("Get portfolio map image"),
    },
    async ({ address, ...rest }: OwnWalletArgs<GetPortfolioImageArgs, "address">): Promise<CallToolResult> => {
      const result = await ownOrGiven(address, (wallet) => getPortfolioImage({ ...rest, address: wallet }));
      if ("error" in result) return jsonResult(result);
      return {
        content: [
          { type: "text", text: `Portfolio map for ${result.address}` },
          { type: "image", data: result.image.data, mimeType: result.image.mimeType },
          // Which wallet was read, with the account's other addresses, so the agent can map those too.
          ...("walletUsed" in result && result.walletUsed ? [{ type: "text" as const, text: JSON.stringify({ walletUsed: result.walletUsed }) }] : []),
        ],
      };
    },
  );
  server.registerTool(
    "ask_fabrica",
    {
      title: "Ask Fabrica",
      description:
        "Answer questions about how Fabrica works from Fabrica's own published documents: docs.fabrica.land, the help center and the US trust agreement. Returns the best matching passages with their URLs, so an answer can be cited. Covers the trust structure, fees, Property checks, lending, property taxes, adding and removing a property, the legal framework, the glossary and the MCP server itself. When the question names a specific property, wallet or listing, the result also suggests which lookup tool to call. Retrieval is lexical over a committed index, with no external call.",
      inputSchema: askFabricaInput,
      annotations: readOnly("Ask Fabrica"),
    },
    async (args) => jsonResult(await askFabrica(args)),
  );
  server.registerTool(
    "find_us_parcel",
    {
      title: "Find a US parcel",
      description: `Look up any US land parcel by street address or parcel number (APN): address, place, APN, state and county, and whether it is already on Fabrica (token ID and property link). For a parcel not on Fabrica, links.addToFabrica is the fabrica.land link to add that parcel; it starts adding it only when a person opens it and decides there. The tool itself creates nothing. An ambiguous query returns up to 5 candidates, whose Fabrica status is matched by parcel number only; state and county narrow it to one, which gets the full check. When the US parcel search is not answering, properties already on Fabrica that the query names come back from Fabrica's own records as unconfirmed candidates (match: unconfirmed, matchSource: fabrica-index); present them as likely, not confirmed. Owner names from parcel data are never returned. For a list, queries takes up to ${MAX_BATCH_QUERIES} addresses or parcel numbers under one state and county scope and returns one row per resolved query (onFabrica, tokenId or addToFabrica, coverage) plus an unresolved list with the reason. Limited to 30 lookups per minute per client; each query in a list counts as one.`,
      inputSchema: findParcelInput,
      annotations: readOnly("Find a US parcel"),
    },
    async (args) => {
      const { result, onFabrica } = await findParcelWithUsage(args);
      hooks.onFindParcel?.(onFabrica);
      return jsonResult(result);
    },
  );
  server.registerTool(
    "check_county_coverage",
    {
      title: "Check county coverage",
      description: `Whether a US county (or a whole state) can be added to Fabrica online: supported, notConfigured or unsupported, and for a supported county the deed and forms the owner signs (and which are notarized), witness requirements, the questions the owner is asked, and the steps to add a property. Answers from a table of Fabrica's rules for adding property as of ${COVERAGE_AS_OF}, refreshed by hand, so each answer carries that date; the add-property page on fabrica.land is the live answer. Give a 5-digit county FIPS, or a two-letter state with or without a county. No fee amounts (ask_fabrica has them) and no owner data.`,
      inputSchema: checkCoverageInput,
      annotations: { ...readOnly("Check county coverage"), openWorldHint: false },
    },
    async (args) => jsonResult(checkCoverage(args)),
  );
  server.registerTool(
    "contact_fabrica_support",
    {
      title: "Contact Fabrica support",
      description: "Hand a question to Fabrica's support team when the documents (ask_fabrica) do not answer it or a person is needed: adding a property that is stuck, a document question, a dispute. Returns the help center section for the topic, the support email address, and a mailto link that drafts an email with the summary and the property link (the same fabrica.land page the other tools link). subject sets the subject in the person's words; a line saying an AI agent drafted it is added unless discloseAgent is false. Nothing is sent by this tool; the person sends the email and replies come back by email. Summaries containing a private key or seed phrase are refused.",
      inputSchema: contactSupportInput,
      annotations: readOnly("Contact Fabrica support"),
    },
    async (args) => jsonResult(await contactSupport(args)),
  );
  if (signRequestsEnabled()) registerSignRequestTools(server);
  if (hooks.account) registerAccountTools(server, hooks.account);
  registerKnowledgeResources(server);
  registerPrompts(server);
  return server;
}

const SIGN_LINK_NOTE = "Prepared, not sent: returns a signRequest (summary, warnings, signLink to fabrica.land, expiresAt 15 minutes out, payload null for now) and stores it so the sign page can load it. The person opens the link, signs in with that wallet and signs; nothing happens until then. The server holds no keys and submits nothing. wallet is the address that will sign.";

function registerSignRequestTools(server: McpServer): void {
  server.registerTool(
    "make_land_offer",
    {
      title: "Prepare an offer",
      description: `Prepare an offer to buy a live property on Fabrica (${NETWORK_LABEL}) at a USD amount paid in USDC, open for expiresDays (default 14). Checks first that the property is live and the wallet does not already hold it, and warns when the amount is far from Fabrica's estimate, when a listing is at or below it, or when the property is collateral for a loan. ${SIGN_LINK_NOTE}`,
      inputSchema: makeOfferInput,
      annotations: prepares("Prepare an offer"),
    },
    async (args) => jsonResult(await makeOffer(args)),
  );
  server.registerTool(
    "list_land_for_sale",
    {
      title: "Prepare a listing",
      description: `Prepare a listing of a property the wallet holds on Fabrica (${NETWORK_LABEL}) at a USD price paid in USDC, open for expiresDays (default 180). Checks first that the wallet holds the token, and warns when the price is far from Fabrica's estimate, when the wallet already lists it, when an offer is at or above the price, or when the property is collateral for a loan. ${SIGN_LINK_NOTE}`,
      inputSchema: listForSaleInput,
      annotations: prepares("Prepare a listing"),
    },
    async (args) => jsonResult(await listForSale(args)),
  );
  server.registerTool(
    "accept_land_offer",
    {
      title: "Prepare accepting an offer",
      description: `Prepare accepting an open offer (orderHash: orderId from get_land_order_book) on a property the wallet holds (${NETWORK_LABEL}). Checks first that the offer is open and the wallet holds the token, and warns when it expires within a day, is far from Fabrica's estimate, or the property is collateral for a loan. Signing sells the property. ${SIGN_LINK_NOTE}`,
      inputSchema: orderActionInput,
      annotations: prepares("Prepare accepting an offer"),
    },
    async (args) => jsonResult(await acceptOffer(args)),
  );
  server.registerTool(
    "buy_land",
    {
      title: "Prepare a purchase",
      description: `Prepare buying a property at its open listing (orderHash: orderId from get_land_order_book) on ${NETWORK_LABEL}. Checks first that the listing is open, buyable (a listing on a property under a loan may not be yet), not the wallet's own and not reserved for other buyers, and lists the seller's disclosure documents. Signing sends an onchain transaction from the person's wallet; get_transaction_status follows it. ${SIGN_LINK_NOTE}`,
      inputSchema: orderActionInput,
      annotations: prepares("Prepare a purchase"),
    },
    async (args) => jsonResult(await buy(args)),
  );
  server.registerTool(
    "cancel_land_order",
    {
      title: "Prepare canceling a listing or offer",
      description: `Prepare canceling the wallet's own open listing or offer (orderHash: orderId from get_land_order_book) on ${NETWORK_LABEL}. Checks first that the listing or offer is open and the wallet made it. Canceling is a confirmation on the sign page, with no transaction. ${SIGN_LINK_NOTE}`,
      inputSchema: orderActionInput,
      annotations: prepares("Prepare canceling a listing or offer"),
    },
    async (args) => jsonResult(await cancelOrder(args)),
  );
  server.registerTool(
    "borrow_against_land",
    {
      title: "Prepare a loan against land",
      description: `Prepare borrowing USDC from the DeFi lending pool against a property the wallet holds (${NETWORK_LABEL}), for amountUsd over durationDays (the pool's offered length closest to it, default about 30 days). Checks first that the wallet holds the token, the property backs no active loan, the pool lends against it and the amount is within the pool's current maximum (estimate_land_borrowing shows it). The rate and repayment come from the pool's live quote on the sign page.${IS_MAINNET ? " A loan is a real obligation: a loan not repaid by maturity lets the lender take the property through the pool's auction." : " This is a test loan on Sepolia with no real-world effect."} ${SIGN_LINK_NOTE}`,
      inputSchema: borrowInput,
      annotations: prepares("Prepare a loan against land"),
    },
    async (args) => jsonResult(await borrowAgainstLand(args)),
  );
  server.registerTool(
    "repay_land_loan",
    {
      title: "Prepare paying off a loan",
      description: `Prepare paying off the open DeFi lending pool loan on a property (${NETWORK_LABEL}), or the one named by loanId, with the payoff amount today. A loan is open while active and, past maturity, in default until the pool's auction starts. Checks first that the loan is open and the wallet is its borrower, and warns when it is past maturity. Paying off returns the token to the wallet, free of the loan. ${SIGN_LINK_NOTE}`,
      inputSchema: repayInput,
      annotations: prepares("Prepare paying off a loan"),
    },
    async (args) => jsonResult(await repayLandLoan(args)),
  );
  server.registerTool(
    "get_sign_request",
    {
      title: "Get sign request status",
      description: "Get a sign request a prepare tool returned (make_land_offer, list_land_for_sale, accept_land_offer, buy_land, cancel_land_order, borrow_against_land, repay_land_loan) by its id: pending or completed, with the order hash, transaction hash or loan id once signed. A pending request is also checked against the live order book, or the property's loans for a borrow or payoff. Requests expire 15 minutes after they are prepared; an expired id is reported as unknown.",
      inputSchema: getSignRequestInput,
      annotations: readOnly("Get sign request status"),
    },
    async (args) => jsonResult(await getSignRequest(args)),
  );
  server.registerTool(
    "get_transaction_status",
    {
      title: "Get transaction status",
      description: `Get the status of an Ethereum transaction on ${NETWORK_LABEL} by hash: not_found, pending, succeeded or failed, with the block, confirmations, sender, recipient and a block explorer link. Reads the chain only.`,
      inputSchema: getTransactionStatusInput,
      annotations: readOnly("Get transaction status"),
    },
    async (args) => jsonResult(await getTransactionStatus(args)),
  );
}

/** Personal reads for the connected user: only on the signed-in endpoint, each with the user's token. */
function registerAccountTools(server: McpServer, account: AccountAuth): void {
  server.registerTool(
    "get_my_account",
    {
      title: "Get my Fabrica account",
      description: `Get the connected person's own Fabrica account on ${NETWORK_LABEL}: their email, their linked accounts (the wallet addresses on the account: the one Fabrica created at sign-up and any they connected), their verification status, and what this connection may read (its scopes and when its access token expires). Takes no input: it always answers for the person who connected, never for anyone else.`,
      inputSchema: {},
      annotations: readOnly("Get my Fabrica account"),
    },
    async () => jsonResult(await getMyAccount(account)),
  );
  server.registerTool(
    "get_my_properties",
    {
      title: "Get my properties",
      description: `List the connected person's own properties on Fabrica (${NETWORK_LABEL}), across every wallet on their account: the properties they are adding to Fabrica first, then their live properties by estimated value. Each row has its stage and status, location, acres, listing price, offers waiting, whether it is under a loan, Property checks encoding, estimated value and the property page link; totals cover the count, acres, listings, offers waiting and the estimated value of the live properties. Needs the connection's portfolio:read grant. get_land_portfolio lists any wallet address instead.`,
      inputSchema: getMyPropertiesInput,
      annotations: readOnly("Get my properties"),
    },
    async (args) => jsonResult(await getMyProperties(account, args)),
  );
  server.registerTool(
    "get_my_offers",
    {
      title: "Get my offers",
      description: `List the connected person's offers on Fabrica (${NETWORK_LABEL}), across every wallet on their account: received, the offers waiting on their properties (per property, highest first, with whether the property is under a loan and the property page where an offer is accepted), and made, the offers they placed on other properties. Each offer has its USD price and amount, buyer, expiry, and expiringSoon when it ends within 3 days. Live offers only unless status is 'all'. Needs the connection's portfolio:read grant. get_land_order_book reads any one property's listings and offers.`,
      inputSchema: getMyOffersInput,
      annotations: readOnly("Get my offers"),
    },
    async (args) => jsonResult(await getMyOffers(account, args)),
  );
  server.registerTool(
    "get_my_loans",
    {
      title: "Get my loans",
      description: `List the connected person's lending on Fabrica (${NETWORK_LABEL}), across every wallet on their account: taken, the loans against their properties (active first, with maturity date, days to maturity, maturingSoon within 14 days, payoff today and its as-of time, APR and the property page where it is repaid); made, loans they funded; deposits, their position in the ${LENDING_POOL_NAME} (value at current pool prices, amount deposited, pending redemptions, pool page link); and their loan counts. Prepares nothing: repaying and depositing happen on fabrica.land. Needs the connection's portfolio:read grant.`,
      inputSchema: {},
      annotations: readOnly("Get my loans"),
    },
    async () => jsonResult(await getMyLoans(account)),
  );
  server.registerTool(
    "what_needs_attention",
    {
      title: "What needs my attention on Fabrica",
      description: `One ranked list of everything waiting on the connected person on Fabrica (${NETWORK_LABEL}): loans past or near maturity and offers waiting on their properties first, then steps of properties they are adding that wait on them, then fees to approve, then checks on their live properties (property taxes, owner contact, recovery status) and removals in progress. Each item has its kind, property, title, why, due date when known, the link where it is done and who acts. Fees and checks cover up to ${ATTENTION_TOKEN_BUDGET} live properties per call. checked lists what was read, so an empty list means nothing was found there. Reads only; uses the portfolio:read and onramp:read grants and skips what the connection lacks.`,
      inputSchema: {},
      annotations: readOnly("What needs my attention on Fabrica"),
    },
    async () => jsonResult(await whatNeedsAttention(account)),
  );
  server.registerTool(
    "get_my_properties_being_added",
    {
      title: "Get the properties I'm adding",
      description: `List the properties the connected person is adding to Fabrica (${NETWORK_LABEL}), across every wallet on their account, those waiting on them first. Each has its address, county and parcel number, status, how many steps are done, the next step with who acts (the owner, Fabrica, or the county recorder), what it asks and the link to do it, any required details still missing, and the live token once it is live. Needs the connection's onramp:read grant. get_adding_status gives one in full.`,
      inputSchema: {},
      annotations: readOnly("Get the properties I'm adding"),
    },
    async () => jsonResult(await getMyOnRamps(account)),
  );
  server.registerTool(
    "get_adding_status",
    {
      title: "Get where a property I'm adding stands",
      description: `Get one property the connected person is adding to Fabrica (${NETWORK_LABEL}) in full: every step with its status and dates, the next step and who acts, the actions open on it with the owner's own links, and what the owner entered so far (the owners named on the deed and the details the county asks for). Answers only for a property this account is adding. Needs the connection's onramp:read grant.`,
      inputSchema: getOnRampStatusInput,
      annotations: readOnly("Get where a property I'm adding stands"),
    },
    async (args) => jsonResult(await getOnRampStatus(account, args)),
  );
}
