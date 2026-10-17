import { ClientError, GraphQLClient, gql } from "graphql-request";
import type {
  TokenModel,
  WalletModel,
  LoanModel,
  LoanStartedEvent,
  LoanRepaidEvent,
  LoanLiquidatedEvent,
  CountyBoundsModel,
  OrderBookToken,
  TrustDocumentsToken,
  SignedValuationPanel,
  TokenValuationModel,
  TaxStatusToken,
  ScoreRecord,
} from "../types/index.js";
import { CONTRACTS, IS_MAINNET, NETWORK } from "../config.js";
import { TtlCache } from "./cache.js";
import { LOAN_PAGE_BUDGET, LOAN_PAGE_SIZE } from "./budgets.js";

const DEFAULT_API_URL = "https://api.fabrica.land/graphql";

/**
 * Default minimum numeric encoding of Property checks for public listings and protocol stats. Matches the
 * frontend's marketplace threshold (72032): a normal recovery status plus enough checks
 * passing. The API pairs any `minScore` with a verified-deed requirement, so this default
 * leaves out properties the marketplace would not sell, including ones whose recovery
 * status is not Normal (Void, Reported stolen, Recovery pending, Tax sale or foreclosure).
 */
export const DEFAULT_MIN_SCORE = 72032;

/** Token names that indicate spam or errored metadata */
const SPAM_NAME_PATTERNS = ["SyntaxError", "Error", "BadGatewayException"];

const API_URL = process.env.FABRICA_API_URL ?? DEFAULT_API_URL;

const client = new GraphQLClient(API_URL);

/**
 * The API answered with a GraphQL `errors[]` payload. This means the request itself
 * is wrong — a selection set that has drifted from the schema, a bad variable type,
 * a server-side resolver failure. It NEVER means "the record does not exist": a
 * missing record comes back as a successful response with a null field. Callers must
 * keep the two apart, or a schema break gets reported to the agent as "not found".
 */
export class FabricaApiError extends Error {
  readonly graphQLErrors: readonly string[];
  constructor(messages: readonly string[]) {
    super(`Fabrica API rejected the query: ${messages.join("; ")}`);
    this.name = "FabricaApiError";
    this.graphQLErrors = messages;
  }
}

/**
 * Issue a request, converting graphql-request's `ClientError` into a `FabricaApiError`
 * whose message is the API's own error text rather than a serialized request dump.
 * Anything else (network, timeout) propagates unchanged.
 */
const API_TIMEOUT_MS = 20_000;

async function request<T>(
  document: string,
  variables: Record<string, unknown>,
): Promise<T> {
  try {
    return await client.request<T>({ document, variables, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  } catch (error) {
    if (error instanceof ClientError) {
      const messages = error.response.errors?.map(e => e.message) ?? [];
      if (messages.length > 0) throw new FabricaApiError(messages);
      // No GraphQL errors: an HTTP-level failure. ClientError's own message embeds the
      // serialized query and response, which is noise to an agent; keep it out.
      throw new Error(`Fabrica API request failed (HTTP ${error.response.status}). Try again shortly.`);
    }
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(`Fabrica API did not respond within ${API_TIMEOUT_MS / 1000} s. Try again shortly.`);
    }
    throw error;
  }
}

/**
 * `request` through a short-TTL cache: identical reads within the TTL, and concurrent identical
 * reads, cost one upstream call. Cached results are shared, so callers never mutate them.
 */
function cachedRequest<T>(
  cache: TtlCache<T>,
  document: string,
  variables: Record<string, unknown>,
): Promise<T> {
  return cache.get(`${document}\n${JSON.stringify(variables)}`, () => request<T>(document, variables));
}

/** Filter out tokens with spam/error names that indicate bad metadata */
export function filterSpamTokens<T extends { name?: string | null; vanityName?: string | null }>(tokens: T[]): T[] {
  return tokens.filter(t => {
    const name = t.name ?? t.vanityName ?? "";
    return !SPAM_NAME_PATTERNS.some(pattern => name.includes(pattern));
  });
}

// --- Token queries ---

interface TokenFilters {
  region?: string;
  minScore?: number;
  hasListings?: boolean;
  ownedBy?: string;
  burned?: boolean;
  premints?: boolean;
  testnets?: boolean;
  contractAddress?: string;
  sort?: string;
}

const TOKENS_LIST_FIELDS = gql`
  fragment TokenListFields on TokenModel {
    tokenId
    name
    vanityName
    slug
    propertyLink
    coordinates { lat lon }
    acres
    region
    regionCode
    district
    place
    country
    countryCode
    score
    estimatedValue
    cardDisplayValuation
    marketplacePrice
    marketplaceBidCount
    imageUrlDark
    imageUrlLight
    supply
    supplyUnderLoan
    isPremint
    isBurned
    claimState
    supersededByTokenId
    offRampStatus
    majorityOwnerAddress
  }
`;

const GET_TOKENS_QUERY = gql`
  ${TOKENS_LIST_FIELDS}
  query GetTokens(
    $burned: Boolean
    $premints: Boolean
    $testnets: Boolean
    $contractAddress: String
    $minListings: Int
    $minScore: Int
    $ownedBy: String
    $sort: TokenSortField
  ) {
    tokens(
      burned: $burned
      premints: $premints
      testnets: $testnets
      contractAddress: $contractAddress
      minListings: $minListings
      minScore: $minScore
      ownedBy: $ownedBy
      sort: $sort
    ) {
      ...TokenListFields
    }
  }
`;

const tokensCache = new TtlCache<{ tokens: TokenModel[] }>();

export async function getTokens(filters: TokenFilters): Promise<TokenModel[]> {
  const variables: Record<string, unknown> = {};
  if (filters.minScore !== undefined) variables.minScore = filters.minScore;
  if (filters.hasListings) variables.minListings = 1;
  if (filters.ownedBy) variables.ownedBy = filters.ownedBy;
  if (filters.burned !== undefined) variables.burned = filters.burned;
  if (filters.premints !== undefined) variables.premints = filters.premints;
  if (filters.testnets !== undefined) variables.testnets = filters.testnets;
  if (filters.contractAddress) variables.contractAddress = filters.contractAddress;
  if (filters.sort) variables.sort = filters.sort;
  const data = await cachedRequest(tokensCache, GET_TOKENS_QUERY, variables);
  return data.tokens;
}

/** Why a pool lends what it lends: the appraisal block, and each pool's oracle state. */
const POOL_ORACLE_FIELDS = gql`
  fragment PoolOracleFields on PoolLendingLiquidityModel {
    appraisalBlockReason
    pools {
      address
      pricing
      oracleValuation { quote { price currency timestamp duration } signature }
      onchainPrice { priceUsdc6 confidenceScore cycle valuedAt sourceId }
      oracleFeed { lastHeartbeat maxSilence isStale currentCycle minValidCycle indexerUnavailableReason }
      onchainValuation { usablePriceUsdc6 capacityBlockReason failedCheck }
    }
  }
`;

const TOKEN_DETAIL_FIELDS = gql`
  fragment TokenDetailFields on TokenModel {
    tokenId
    network
    contractAddress
    name
    vanityName
    slug
    propertyLink
    coordinates { lat lon }
    geoJson
    acres
    country
    countryCode
    region
    regionCode
    postCode
    district
    place
    locality
    neighborhood
    street
    address
    supply
    supplyUnderLoan
    supplyLiquidating
    supplyInDefault
    isPremint
    isClaimedPremint
    claimState
    supersededByTokenId
    offRampStatus
    isBurned
    fishy
    duplicateParcelCount
    fees { totalAmount fees { type createdAt currency amount approved approvedAt paid paidAt } }
    score
    scoringCheckResults { checkName group title value }
    validator
    estimatedValue
    cardDisplayValuation
    marketplacePrice
    marketplaceBidCount
    imageUrlDark
    imageUrlLight
    mintedAt
    operatingAgreementName
    operatingAgreementUrl
    majorityOwnerAddress
    majorityOwner { displayName profilePath }
    lastOwner { address user { displayName } }
    balances { balance holder { address user { displayName } } tokenId }
    pricing { source scope currency value confidence timestamp }
    configuration { holdingEntityDate propertyNickName userDescription proofOfTitle { document documentName source } media { source type description order } }
    definition { claim holdingEntity coordinates { lat lon } geoJson offchainRegistrar { admin country propertyId } }
    loans {
      loanId loanStatus loanProvider loanType
      principalScaled currencySymbol
      aprPercent interestForDurationPercent
      durationFormatted maturityDate startTime
      maxRepaymentScaled
      borrower { address user { displayName } }
      lender { address user { displayName } }
      collateralId
      amountPaidToLenderScaled loanRepaidDate loanLiquidationDate
    }
    poolLendingLiquidity { appraisalBlockReason maxPrincipalScaled maxPrincipalUsdc durations activeLoan { id principal repayment duration maturity } }
    marketplaceListings { marketplaceId side status price usdPrice symbol supply makerAddress startTime endTime }
    marketplaceBids { marketplaceId side status price usdPrice symbol supply makerAddress startTime endTime }
    activity { activity source time timestamp network tokenId transactionHash currencyAmount currencyDecimals currencySymbol usdAmount }
    transfers { from { address } to { address } value transactionHash blockTimestamp }
  }
`;

const GET_TOKEN_QUERY = gql`
  ${TOKEN_DETAIL_FIELDS}
  query GetToken($tokenId: String, $slug: String, $network: String) {
    token(tokenId: $tokenId, slug: $slug, network: $network) {
      ...TokenDetailFields
    }
  }
`;

/** GetToken plus each pool's oracle state; only get_borrow_quote asks for it. */
const GET_TOKEN_WITH_POOL_ORACLE_QUERY = gql`
  ${POOL_ORACLE_FIELDS}
  ${TOKEN_DETAIL_FIELDS}
  query GetTokenWithPoolOracle($tokenId: String, $slug: String, $network: String) {
    token(tokenId: $tokenId, slug: $slug, network: $network) {
      ...TokenDetailFields
      poolLendingLiquidity { ...PoolOracleFields }
    }
  }
`;

const tokenCache = new TtlCache<{ token: TokenModel | null }>();

export async function getToken(
  params: { tokenId?: string; slug?: string; network?: string },
  options: { poolOracle?: boolean } = {},
): Promise<TokenModel | null> {
  const document = options.poolOracle ? GET_TOKEN_WITH_POOL_ORACLE_QUERY : GET_TOKEN_QUERY;
  const data = await cachedRequest(tokenCache, document, {
    tokenId: params.tokenId,
    slug: params.slug,
    network: params.network ?? NETWORK,
  });
  return data.token;
}

// --- Valuation query ---

const GET_VALUATION_QUERY = gql`
  ${POOL_ORACLE_FIELDS}
  query GetValuation($tokenId: String, $slug: String, $network: String) {
    token(tokenId: $tokenId, slug: $slug, network: $network) {
      tokenId
      name
      vanityName
      isPremint
      estimatedValue
      cardDisplayValuation
      valuationReportUrl
      pricing { source scope currency value confidence timestamp modelVersion }
      poolLendingLiquidity { maxPrincipalScaled maxPrincipalUsdc durations activeLoan { id principal repayment duration maturity } ...PoolOracleFields }
    }
  }
`;

// --- Operating agreement (trust instrument) for one token ---

const GET_OPERATING_AGREEMENT_QUERY = gql`
  query GetOperatingAgreement($tokenId: String, $network: String) {
    token(tokenId: $tokenId, network: $network) {
      tokenId
      operatingAgreementName
      operatingAgreementUrl
      operatingAgreement
    }
  }
`;

const valuationCache = new TtlCache<{ token: TokenValuationModel | null }>();

export async function getTokenValuation(
  params: { tokenId?: string; slug?: string },
): Promise<TokenValuationModel | null> {
  const data = await cachedRequest(valuationCache, GET_VALUATION_QUERY, {
    tokenId: params.tokenId,
    slug: params.slug,
    network: NETWORK,
  });
  return data.token;
}

const SIGNED_VALUATION_TIMEOUT_MS = 5_000;

/**
 * The signed valuation panel from the REST API (`/valuation/v1`), on the same host as the
 * GraphQL endpoint. Returns null on any failure (HTTP error, timeout, unexpected body): the
 * panel is supplementary and must never fail the tool that asks for it.
 */
const signedValuationsCache = new TtlCache<SignedValuationPanel>();

export async function getSignedValuations(tokenId: string): Promise<SignedValuationPanel | null> {
  try {
    return await signedValuationsCache.get(tokenId, () => fetchSignedValuations(tokenId));
  } catch {
    return null;
  }
}

/** Throws on any failure, so a failure is not cached. */
async function fetchSignedValuations(tokenId: string): Promise<SignedValuationPanel> {
  const base = API_URL.replace(/\/graphql\/?$/, "");
  const url = `${base}/valuation/v1/${NETWORK}/${CONTRACTS.fabricaToken}/${encodeURIComponent(tokenId)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(SIGNED_VALUATION_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (!isSignedValuationPanel(body)) throw new Error("unexpected valuation panel");
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSignedValuation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const quote = value.quote;
  const quoteOk = quote === null || (isRecord(quote)
    && typeof quote.price === "string" && typeof quote.currency === "string"
    && typeof quote.timestamp === "number" && typeof quote.duration === "number");
  return typeof value.source === "string" && typeof value.version === "string"
    && typeof value.signer === "string"
    && (value.signature === null || typeof value.signature === "string")
    && (value.reason === undefined || typeof value.reason === "string")
    && quoteOk;
}

/** The panel's shape, checked entry by entry: anything unexpected makes the whole panel null. */
function isSignedValuationPanel(body: unknown): body is SignedValuationPanel {
  return isRecord(body) && typeof body.asOf === "string"
    && Array.isArray(body.valuations) && body.valuations.every(isSignedValuation);
}

export interface OperatingAgreementModel {
  tokenId: string;
  operatingAgreementName: string | null;
  operatingAgreementUrl: string | null;
  operatingAgreement: string | null;
}

const agreementCache = new TtlCache<{ token: OperatingAgreementModel | null }>();

/** The trust instrument attached to one token, as text. Single-token only: the API refuses it on lists. */
export async function getOperatingAgreement(tokenId: string): Promise<OperatingAgreementModel | null> {
  const data = await cachedRequest(agreementCache, GET_OPERATING_AGREEMENT_QUERY, { tokenId, network: NETWORK });
  return data.token;
}

// --- Order book ---

const ORDER_BOOK_ORDER_FIELDS = gql`
  fragment OrderBookOrderFields on MarketplaceOrderModel {
    marketplaceId side status price usdPrice symbol decimals feeBps supply
    startTime endTime makerAddress maker { user { displayName } }
    restrictedToAddresses
    disclosurePackage { name url }
    encumbrance { buyable blockReason loanId }
  }
`;

const GET_ORDER_BOOK_QUERY = gql`
  ${ORDER_BOOK_ORDER_FIELDS}
  query GetOrderBook($tokenId: String, $slug: String, $network: String) {
    token(tokenId: $tokenId, slug: $slug, network: $network) {
      tokenId name vanityName propertyLink
      isPremint claimState supersededByTokenId offRampStatus isBurned
      supply supplyUnderLoan
      marketplaceListings { ...OrderBookOrderFields }
      marketplaceBids { ...OrderBookOrderFields }
    }
  }
`;

/** One token's listings and offers, every status: the tool filters, so `status: all` needs no second call. */
export async function getOrderBook(
  params: { tokenId?: string; slug?: string },
): Promise<OrderBookToken | null> {
  const data = await request<{ token: OrderBookToken | null }>(GET_ORDER_BOOK_QUERY, {
    tokenId: params.tokenId,
    slug: params.slug,
    network: NETWORK,
  });
  return data.token;
}

const GET_PREMINT_SUCCESSOR_QUERY = gql`
  query GetPremintSuccessor($network: String!, $tokenId: String!) {
    premintSuccessor(network: $network, tokenId: $tokenId) {
      tokenId
    }
  }
`;

/** The live token that replaced a premint, for an old premint ID that no longer loads. */
export async function getPremintSuccessor(tokenId: string): Promise<string | null> {
  const data = await request<{ premintSuccessor: { tokenId: string } | null }>(GET_PREMINT_SUCCESSOR_QUERY, {
    network: NETWORK,
    tokenId,
  });
  return data.premintSuccessor?.tokenId ?? null;
}

/** The API answers a non-null `token(...)` query for an unknown ID with this GraphQL error, not with null. */
export function isTokenNotFound(error: unknown): boolean {
  return error instanceof FabricaApiError && error.graphQLErrors.some(m => m.includes("No token or premint found"));
}

// --- Trust documents query ---

const GET_TRUST_DOCUMENTS_QUERY = gql`
  query GetTrustDocuments($tokenId: String, $slug: String, $network: String, $withText: Boolean!) {
    token(tokenId: $tokenId, slug: $slug, network: $network) {
      tokenId
      network
      contractAddress
      name
      vanityName
      propertyLink
      isPremint
      district
      regionCode
      validator
      metadataUri
      operatingAgreementName
      operatingAgreementUrl
      operatingAgreement @include(if: $withText)
      definition { claim holdingEntity offchainRegistrar { admin adminId country propertyId } }
      configuration {
        holdingEntityDate
        proofOfTitle { document documentId documentName grantor source }
        documents { type source description order }
        media { type }
      }
    }
  }
`;

/** The legal record of one token. The agreement text (about 150 KB) is fetched only when asked for. */
export async function getTrustDocuments(
  params: { tokenId?: string; slug?: string; withText: boolean },
): Promise<TrustDocumentsToken | null> {
  const data = await request<{ token: TrustDocumentsToken | null }>(GET_TRUST_DOCUMENTS_QUERY, {
    tokenId: params.tokenId,
    slug: params.slug,
    network: NETWORK,
    withText: params.withText,
  });
  return data.token;
}

// --- Tax status ---

const GET_TAX_STATUS_QUERY = gql`
  query GetTaxStatus($tokenId: String, $slug: String, $network: String) {
    token(tokenId: $tokenId, slug: $slug, network: $network) {
      tokenId
      network
      contractAddress
      name
      vanityName
      isPremint
      district
      regionCode
      poolLendingLiquidity { appraisalBlockReason }
    }
  }
`;

const taxStatusCache = new TtlCache<{ token: TaxStatusToken | null }>();

export async function getTaxStatusToken(
  params: { tokenId?: string; slug?: string },
): Promise<TaxStatusToken | null> {
  const data = await cachedRequest(taxStatusCache, GET_TAX_STATUS_QUERY, {
    tokenId: params.tokenId,
    slug: params.slug,
    network: NETWORK,
  });
  return data.token;
}


function isScoreRecord(value: unknown): value is ScoreRecord {
  return typeof value === "object" && value !== null && "checks" in value && typeof value.checks === "object" && value.checks !== null;
}

/** get_property waits on the score record inline, so a slow score API must not hold it for the full API timeout. */
const SCORE_RECORD_TIMEOUT_MS = 5_000;

const scoreRecordCache = new TtlCache<ScoreRecord | null>();

/**
 * The latest score record of an existing token, which carries the raw check values (the
 * GraphQL list reports an unverified check as false) and when the checks expire. Call it
 * only for a token the GraphQL API returned. Null when the API has no record (404).
 */
export function getScoreRecord(contractAddress: string, tokenId: string): Promise<ScoreRecord | null> {
  return scoreRecordCache.get(`${contractAddress}:${tokenId}`, () => fetchScoreRecord(contractAddress, tokenId));
}

/** Throws on an HTTP failure, so a failure is not cached. */
async function fetchScoreRecord(contractAddress: string, tokenId: string): Promise<ScoreRecord | null> {
  const base = API_URL.replace(/\/graphql\/?$/, "");
  const url = `${base}/${encodeURIComponent(NETWORK)}/${encodeURIComponent(contractAddress)}/${encodeURIComponent(tokenId)}/score`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(SCORE_RECORD_TIMEOUT_MS) });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(`Fabrica score API did not respond within ${SCORE_RECORD_TIMEOUT_MS / 1000} s.`);
    }
    throw error;
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Fabrica score API request failed (HTTP ${response.status})`);
  const body: unknown = await response.json();
  if (!isScoreRecord(body)) throw new Error("Fabrica score API returned an unexpected record shape");
  return {
    checks: body.checks,
    updatedAt: "updatedAt" in body && typeof body.updatedAt === "string" ? body.updatedAt : null,
    expiresAt: "expiresAt" in body && typeof body.expiresAt === "string" ? body.expiresAt : null,
  };
}

// --- Wallet query ---

const WALLET_FIELDS = gql`
  fragment WalletFields on WalletModel {
    address
    user { displayName profilePath avatarUrl }
    tokenCount
    totalValue
    totalAcres
    totalCollateralValue
    totalOutstandingLoansUSDC
    propertyCountUnderLoan
    creditHistory {
      activeLoans { loanCount totalPrincipalValue totalPaidValue averageDurationDays }
      defaultedLoans { loanCount totalPrincipalValue totalPaidValue averageDurationDays }
      liquidatedLoans { loanCount totalPrincipalValue totalPaidValue averageDurationDays }
      repaidLoans { loanCount totalPrincipalValue totalPaidValue averageDurationDays }
      totalLoans { loanCount totalPrincipalValue totalPaidValue averageDurationDays }
      tokens { tokenCount totalEstimatedValue }
    }
    tokens {
      tokenId name vanityName acres region regionCode district
      estimatedValue score marketplacePrice
      supplyUnderLoan
    }
    loansTaken(network: $network) {
      loanId loanStatus loanProvider principalScaled currencySymbol
      aprPercent durationFormatted maturityDate startTime
      collateralId
      lender { address }
      amountPaidToLenderScaled loanRepaidDate
    }
    loansMade(network: $network) {
      loanId loanStatus loanProvider principalScaled currencySymbol
      aprPercent durationFormatted maturityDate startTime
      collateralId
      borrower { address }
      amountPaidToLenderScaled loanRepaidDate
    }
    marketplaceOffersMade(network: $network) { marketplaceId tokenId side status price symbol }
    activity { activity source time timestamp network tokenId transactionHash currencyAmount currencyDecimals currencySymbol usdAmount }
  }
`;

const GET_WALLET_QUERY = gql`
  ${WALLET_FIELDS}
  query GetWallet($walletAddress: String!, $network: String!, $testnets: Boolean!, $contractAddress: String!) {
    wallet(walletAddress: $walletAddress, network: $network, testnets: $testnets, contractAddress: $contractAddress, burned: false) {
      ...WalletFields
    }
  }
`;

const walletCache = new TtlCache<{ wallet: WalletModel | null }>();

export async function getWallet(walletAddress: string): Promise<WalletModel | null> {
  // Scope the wallet (its tokens, loans and orders) to this deployment's network and
  // contract, so a Sepolia server never returns mainnet records and vice versa.
  const data = await cachedRequest(walletCache, GET_WALLET_QUERY, {
    walletAddress,
    network: NETWORK,
    testnets: !IS_MAINNET,
    contractAddress: CONTRACTS.fabricaToken,
  });
  return data.wallet;
}

// --- Loan queries ---

const LOAN_FIELDS = gql`
  fragment LoanFields on LoanModel {
    loanId loanStatus loanProvider loanType
    principalScaled currencySymbol
    aprPercent interestForDurationPercent
    durationFormatted maturityDate startTime
    maxRepaymentScaled
    borrower { address user { displayName } }
    lender { address user { displayName } }
    token { tokenId name acres region regionCode district estimatedValue }
    collateralId collateralContract
    networkName
    amountPaidToLenderScaled loanRepaidDate loanLiquidationDate
  }
`;

const GET_LOANS_QUERY = gql`
  ${LOAN_FIELDS}
  query GetLoans($network: String, $networkIn: [String!], $first: Int, $skip: Int) {
    loans(network: $network, networkIn: $networkIn, first: $first, skip: $skip) {
      ...LoanFields
    }
  }
`;

const loansCache = new TtlCache<{ loans: LoanModel[] }>();

export async function getLoans(
  filters: { network?: string; first?: number; skip?: number } = {},
): Promise<LoanModel[]> {
  const data = await cachedRequest(loansCache, GET_LOANS_QUERY, {
    network: filters.network ?? NETWORK,
    first: filters.first ?? 100,
    skip: filters.skip ?? 0,
  });
  return data.loans;
}

/** Fetch all loans by paginating through the API, up to the page budget. Pages are cached. */
export async function getAllLoans(network = NETWORK): Promise<LoanModel[]> {
  const allLoans: LoanModel[] = [];
  for (let page = 0; page < LOAN_PAGE_BUDGET; page++) {
    const batch = await getLoans({ network, first: LOAN_PAGE_SIZE, skip: page * LOAN_PAGE_SIZE });
    allLoans.push(...batch);
    if (batch.length < LOAN_PAGE_SIZE) break;
  }
  return allLoans;
}

// --- Loan event queries ---

const GET_LOAN_STARTED_EVENTS_QUERY = gql`
  query GetLoanStartedEvents($first: Int!, $skip: Int!, $networkIn: [String!]) {
    loanStartedEvents(first: $first, skip: $skip, networkIn: $networkIn) {
      loanId borrower lender loanPrincipalAmount loanDuration loanStartTime
      loanInterestRateForDurationInBasisPoints loanProvider
      nftCollateralId transactionHash blockTimestamp
    }
  }
`;

export async function getLoanStartedEvents(
  first = 10,
  skip = 0,
): Promise<LoanStartedEvent[]> {
  const data = await request<{ loanStartedEvents: LoanStartedEvent[] }>(GET_LOAN_STARTED_EVENTS_QUERY, {
    first,
    skip,
    networkIn: [NETWORK],
  });
  return data.loanStartedEvents;
}

const GET_LOAN_REPAID_EVENTS_QUERY = gql`
  query GetLoanRepaidEvents($first: Int!, $skip: Int!, $networkIn: [String!]) {
    loanRepaidEvents(first: $first, skip: $skip, networkIn: $networkIn) {
      loanId borrower lender loanPrincipalAmount amountPaidToLender adminFee
      nftCollateralId transactionHash blockTimestamp
    }
  }
`;

export async function getLoanRepaidEvents(
  first = 10,
  skip = 0,
): Promise<LoanRepaidEvent[]> {
  const data = await request<{ loanRepaidEvents: LoanRepaidEvent[] }>(GET_LOAN_REPAID_EVENTS_QUERY, {
    first,
    skip,
    networkIn: [NETWORK],
  });
  return data.loanRepaidEvents;
}

const GET_LOAN_LIQUIDATED_EVENTS_QUERY = gql`
  query GetLoanLiquidatedEvents($first: Int!, $skip: Int!, $networkIn: [String!]) {
    loanLiquidatedEvents(first: $first, skip: $skip, networkIn: $networkIn) {
      loanId borrower lender loanPrincipalAmount loanLiquidationDate
      nftCollateralId transactionHash blockTimestamp
    }
  }
`;

export async function getLoanLiquidatedEvents(
  first = 10,
  skip = 0,
): Promise<LoanLiquidatedEvent[]> {
  const data = await request<{ loanLiquidatedEvents: LoanLiquidatedEvent[] }>(GET_LOAN_LIQUIDATED_EVENTS_QUERY, {
    first,
    skip,
    networkIn: [NETWORK],
  });
  return data.loanLiquidatedEvents;
}

// --- County bounds ---

const GET_COUNTY_BOUNDS_QUERY = gql`
  query GetCountyBounds($fips: String!) {
    countyBounds(fips: $fips) {
      geoJson
    }
  }
`;

const countyBoundsCache = new TtlCache<{ countyBounds: CountyBoundsModel | null }>();

export async function getCountyBounds(fips: string): Promise<CountyBoundsModel | null> {
  const data = await cachedRequest(countyBoundsCache, GET_COUNTY_BOUNDS_QUERY, { fips });
  return data.countyBounds;
}

// --- Parcel matching (find_parcel) ---

const GET_PARCEL_INDEX_QUERY = gql`
  query GetParcelIndex($testnets: Boolean, $contractAddress: String) {
    tokens(burned: false, premints: false, testnets: $testnets, contractAddress: $contractAddress) {
      tokenId
      name
      vanityName
      slug
      propertyLink
      regionCode
      coordinates { lat lon }
      definition { offchainRegistrar { admin propertyId } }
    }
  }
`;

export interface ParcelIndexToken {
  tokenId: string;
  name?: string | null;
  vanityName?: string | null;
  slug?: string | null;
  propertyLink?: string | null;
  regionCode?: string | null;
  coordinates?: { lat: number; lon: number } | null;
  definition?: { offchainRegistrar?: { admin?: string | null; propertyId?: string | null } | null } | null;
}

/** Every minted, unburned token with its state, APN and coordinates: what find_parcel matches against. */
export async function getParcelIndex(): Promise<ParcelIndexToken[]> {
  const data = await request<{ tokens: ParcelIndexToken[] }>(GET_PARCEL_INDEX_QUERY, {
    testnets: !IS_MAINNET,
    contractAddress: CONTRACTS.fabricaToken,
  });
  return filterSpamTokens(data.tokens);
}

/**
 * Every document this client sends to the Fabrica API, for the schema-drift test.
 * A query that is not listed here is not covered — add new documents as they are written.
 */
export const API_DOCUMENTS: ReadonlyArray<{ name: string; document: string }> = [
  { name: "GetTokens", document: GET_TOKENS_QUERY },
  { name: "GetToken", document: GET_TOKEN_QUERY },
  { name: "GetTokenWithPoolOracle", document: GET_TOKEN_WITH_POOL_ORACLE_QUERY },
  { name: "GetValuation", document: GET_VALUATION_QUERY },
  { name: "GetOperatingAgreement", document: GET_OPERATING_AGREEMENT_QUERY },
  { name: "GetTrustDocuments", document: GET_TRUST_DOCUMENTS_QUERY },
  { name: "GetTaxStatus", document: GET_TAX_STATUS_QUERY },
  { name: "GetWallet", document: GET_WALLET_QUERY },
  { name: "GetLoans", document: GET_LOANS_QUERY },
  { name: "GetLoanStartedEvents", document: GET_LOAN_STARTED_EVENTS_QUERY },
  { name: "GetLoanRepaidEvents", document: GET_LOAN_REPAID_EVENTS_QUERY },
  { name: "GetLoanLiquidatedEvents", document: GET_LOAN_LIQUIDATED_EVENTS_QUERY },
  { name: "GetCountyBounds", document: GET_COUNTY_BOUNDS_QUERY },
  { name: "GetOrderBook", document: GET_ORDER_BOOK_QUERY },
  { name: "GetPremintSuccessor", document: GET_PREMINT_SUCCESSOR_QUERY },
  { name: "GetParcelIndex", document: GET_PARCEL_INDEX_QUERY },
];
