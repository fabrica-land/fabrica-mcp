import { ClientError, GraphQLClient, gql } from "graphql-request";
import type {
  TokenModel,
  WalletModel,
  LoanModel,
  LoanStartedEvent,
  LoanRepaidEvent,
  LoanLiquidatedEvent,
  CountyBoundsModel,
} from "../types/index.js";
import { CONTRACTS, IS_MAINNET, NETWORK } from "../config.js";

const DEFAULT_API_URL = "https://api.fabrica.land/graphql";

/**
 * Default minimum confidence score for public listings and protocol stats. Matches the
 * frontend's marketplace threshold (72032): a normal recovery status plus enough checks
 * passing. The API pairs any `minScore` with a verified-deed requirement, so this default
 * leaves out properties the marketplace would not sell, including ones whose recovery
 * status is not Normal (Void, Stolen, Recovery pending, Distressed).
 */
export const DEFAULT_MIN_SCORE = 72032;

/** Token names that indicate spam or errored metadata */
const SPAM_NAME_PATTERNS = ["SyntaxError", "Error", "BadGatewayException"];

const client = new GraphQLClient(
  process.env.FABRICA_API_URL ?? DEFAULT_API_URL,
);

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

/** Filter out tokens with spam/error names that indicate bad metadata */
export function filterSpamTokens(tokens: TokenModel[]): TokenModel[] {
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
    majorityOwnerAddress
    loanOfferCount
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
  const data = await request<{ tokens: TokenModel[] }>(GET_TOKENS_QUERY, variables);
  return data.tokens;
}

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
    isBurned
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
    operatingAgreement
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
    loanOfferCount
    poolLendingLiquidity { maxPrincipalScaled maxPrincipalUsdc durations activeLoan { id principal repayment duration maturity } }
    marketplaceListings { marketplaceId side status price usdPrice symbol supply makerAddress startTime endTime }
    marketplaceBids { marketplaceId side status price usdPrice symbol supply makerAddress startTime endTime }
    activity { activity source time timestamp network tokenId transactionHash currencyAmount currencySymbol usdAmount }
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

export async function getToken(
  params: { tokenId?: string; slug?: string; network?: string },
): Promise<TokenModel | null> {
  const data = await request<{ token: TokenModel | null }>(GET_TOKEN_QUERY, {
    tokenId: params.tokenId,
    slug: params.slug,
    network: params.network ?? NETWORK,
  });
  return data.token;
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
    activity { activity source time timestamp network tokenId transactionHash currencyAmount currencySymbol usdAmount }
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

export async function getWallet(walletAddress: string): Promise<WalletModel | null> {
  // Scope the wallet (its tokens, loans and orders) to this deployment's network and
  // contract, so a Sepolia server never returns mainnet records and vice versa.
  const data = await request<{ wallet: WalletModel | null }>(GET_WALLET_QUERY, {
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

export async function getLoans(
  filters: { network?: string; first?: number; skip?: number } = {},
): Promise<LoanModel[]> {
  const data = await request<{ loans: LoanModel[] }>(GET_LOANS_QUERY, {
    network: filters.network ?? NETWORK,
    first: filters.first ?? 100,
    skip: filters.skip ?? 0,
  });
  return data.loans;
}

/** Fetch all loans by paginating through the API */
export async function getAllLoans(network = NETWORK): Promise<LoanModel[]> {
  const pageSize = 100;
  const allLoans: LoanModel[] = [];
  let skip = 0;
  for (;;) {
    const batch = await getLoans({ network, first: pageSize, skip });
    allLoans.push(...batch);
    if (batch.length < pageSize) break;
    skip += pageSize;
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

export async function getCountyBounds(fips: string): Promise<CountyBoundsModel | null> {
  const data = await request<{ countyBounds: CountyBoundsModel | null }>(GET_COUNTY_BOUNDS_QUERY, { fips });
  return data.countyBounds;
}

/**
 * Every document this client sends to the Fabrica API, for the schema-drift test.
 * A query that is not listed here is not covered — add new documents as they are written.
 */
export const API_DOCUMENTS: ReadonlyArray<{ name: string; document: string }> = [
  { name: "GetTokens", document: GET_TOKENS_QUERY },
  { name: "GetToken", document: GET_TOKEN_QUERY },
  { name: "GetWallet", document: GET_WALLET_QUERY },
  { name: "GetLoans", document: GET_LOANS_QUERY },
  { name: "GetLoanStartedEvents", document: GET_LOAN_STARTED_EVENTS_QUERY },
  { name: "GetLoanRepaidEvents", document: GET_LOAN_REPAID_EVENTS_QUERY },
  { name: "GetLoanLiquidatedEvents", document: GET_LOAN_LIQUIDATED_EVENTS_QUERY },
  { name: "GetCountyBounds", document: GET_COUNTY_BOUNDS_QUERY },
];
