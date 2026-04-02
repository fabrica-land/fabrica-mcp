import { GraphQLClient, gql } from "graphql-request";
import type {
  TokenModel,
  WalletModel,
  LoanModel,
  LoanStartedEvent,
  LoanRepaidEvent,
  LoanLiquidatedEvent,
  CountyBoundsModel,
} from "../types/index.js";

const DEFAULT_API_URL = "https://api.fabrica.land/graphql";

/** Minimum confidence score to filter out spam/invalid tokens. Matches the frontend threshold. */
export const DEFAULT_MIN_SCORE = 2142;

/** Token names that indicate spam or errored metadata */
const SPAM_NAME_PATTERNS = ["SyntaxError", "Error", "BadGatewayException"];

const client = new GraphQLClient(
  process.env.FABRICA_API_URL ?? DEFAULT_API_URL,
);

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

export async function getTokens(filters: TokenFilters): Promise<TokenModel[]> {
  const variables: Record<string, unknown> = {};
  if (filters.minScore !== undefined) variables.minScore = filters.minScore;
  if (filters.hasListings) variables.minListings = 1;
  if (filters.ownedBy) variables.ownedBy = filters.ownedBy;
  if (filters.burned !== undefined) variables.burned = filters.burned;
  if (filters.premints !== undefined) variables.premints = filters.premints;
  if (filters.sort) variables.sort = filters.sort;
  const query = gql`
    ${TOKENS_LIST_FIELDS}
    query GetTokens(
      $burned: Boolean
      $premints: Boolean
      $minListings: Int
      $minScore: Int
      $ownedBy: String
      $sort: TokenSortField
    ) {
      tokens(
        burned: $burned
        premints: $premints
        minListings: $minListings
        minScore: $minScore
        ownedBy: $ownedBy
        sort: $sort
      ) {
        ...TokenListFields
      }
    }
  `;
  const data = await client.request<{ tokens: TokenModel[] }>(query, variables);
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
    configuration { holdingEntityDate propertyNickName userDescription proofOfTitle { document documentName source } }
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
    loanOffers { offerId principalScaled currencySymbol durationFormatted aprPercent lender { address } }
    loanOfferCount
    metaStreetLiquidity { maxPrincipalScaled maxPrincipalUsdc durations activeLoan { id principal repayment duration maturity } }
    marketplaceListings { marketplaceId side status price usdPrice symbol supply makerAddress startTime endTime }
    marketplaceBids { marketplaceId side status price usdPrice symbol supply makerAddress startTime endTime }
    activity { activity source time timestamp network tokenId transactionHash currencyAmount currencySymbol usdAmount }
    transfers { from { address } to { address } value transactionHash blockTimestamp }
  }
`;

export async function getToken(
  params: { tokenId?: string; slug?: string; network?: string },
): Promise<TokenModel | null> {
  const query = gql`
    ${TOKEN_DETAIL_FIELDS}
    query GetToken($tokenId: String, $slug: String, $network: String) {
      token(tokenId: $tokenId, slug: $slug, network: $network) {
        ...TokenDetailFields
      }
    }
  `;
  try {
    const data = await client.request<{ token: TokenModel }>(query, {
      tokenId: params.tokenId,
      slug: params.slug,
      network: params.network ?? "ethereum",
    });
    return data.token;
  } catch {
    return null;
  }
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
    loansTaken {
      loanId loanStatus loanProvider principalScaled currencySymbol
      aprPercent durationFormatted maturityDate startTime
      collateralId
      lender { address }
      amountPaidToLenderScaled loanRepaidDate
    }
    loansMade {
      loanId loanStatus loanProvider principalScaled currencySymbol
      aprPercent durationFormatted maturityDate startTime
      collateralId
      borrower { address }
      amountPaidToLenderScaled loanRepaidDate
    }
    marketplaceOffersMade { marketplaceId tokenId side status price symbol }
    activity { activity source time timestamp network tokenId transactionHash currencyAmount currencySymbol usdAmount }
  }
`;

export async function getWallet(walletAddress: string): Promise<WalletModel | null> {
  const query = gql`
    ${WALLET_FIELDS}
    query GetWallet($walletAddress: String!) {
      wallet(walletAddress: $walletAddress) {
        ...WalletFields
      }
    }
  `;
  const data = await client.request<{ wallet: WalletModel | null }>(query, { walletAddress });
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

export async function getLoans(
  filters: { network?: string; first?: number; skip?: number } = {},
): Promise<LoanModel[]> {
  const query = gql`
    ${LOAN_FIELDS}
    query GetLoans($network: String, $networkIn: [String!], $first: Int, $skip: Int) {
      loans(network: $network, networkIn: $networkIn, first: $first, skip: $skip) {
        ...LoanFields
      }
    }
  `;
  const data = await client.request<{ loans: LoanModel[] }>(query, {
    network: filters.network ?? "ethereum",
    first: filters.first ?? 100,
    skip: filters.skip ?? 0,
  });
  return data.loans;
}

/** Fetch all loans by paginating through the API */
export async function getAllLoans(network = "ethereum"): Promise<LoanModel[]> {
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

export async function getLoanStartedEvents(
  first = 10,
  skip = 0,
): Promise<LoanStartedEvent[]> {
  const query = gql`
    query GetLoanStartedEvents($first: Int!, $skip: Int!, $networkIn: [String!]) {
      loanStartedEvents(first: $first, skip: $skip, networkIn: $networkIn) {
        loanId borrower lender loanPrincipalAmount loanDuration loanStartTime
        loanInterestRateForDurationInBasisPoints loanProvider
        nftCollateralId transactionHash blockTimestamp
      }
    }
  `;
  const data = await client.request<{ loanStartedEvents: LoanStartedEvent[] }>(query, {
    first,
    skip,
    networkIn: ["ethereum"],
  });
  return data.loanStartedEvents;
}

export async function getLoanRepaidEvents(
  first = 10,
  skip = 0,
): Promise<LoanRepaidEvent[]> {
  const query = gql`
    query GetLoanRepaidEvents($first: Int!, $skip: Int!, $networkIn: [String!]) {
      loanRepaidEvents(first: $first, skip: $skip, networkIn: $networkIn) {
        loanId borrower lender loanPrincipalAmount amountPaidToLender adminFee
        nftCollateralId transactionHash blockTimestamp
      }
    }
  `;
  const data = await client.request<{ loanRepaidEvents: LoanRepaidEvent[] }>(query, {
    first,
    skip,
    networkIn: ["ethereum"],
  });
  return data.loanRepaidEvents;
}

export async function getLoanLiquidatedEvents(
  first = 10,
  skip = 0,
): Promise<LoanLiquidatedEvent[]> {
  const query = gql`
    query GetLoanLiquidatedEvents($first: Int!, $skip: Int!, $networkIn: [String!]) {
      loanLiquidatedEvents(first: $first, skip: $skip, networkIn: $networkIn) {
        loanId borrower lender loanPrincipalAmount loanLiquidationDate
        nftCollateralId transactionHash blockTimestamp
      }
    }
  `;
  const data = await client.request<{ loanLiquidatedEvents: LoanLiquidatedEvent[] }>(query, {
    first,
    skip,
    networkIn: ["ethereum"],
  });
  return data.loanLiquidatedEvents;
}

// --- County bounds ---

export async function getCountyBounds(fips: string): Promise<CountyBoundsModel | null> {
  const query = gql`
    query GetCountyBounds($fips: String!) {
      countyBounds(fips: $fips) {
        geoJson
      }
    }
  `;
  try {
    const data = await client.request<{ countyBounds: CountyBoundsModel | null }>(query, { fips });
    return data.countyBounds;
  } catch {
    return null;
  }
}
