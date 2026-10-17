// Typed fixture builders for the test suite.
//
// Each builder returns a complete object of the real result type (src/types/index.ts, derived
// from the generated operation types) with plain defaults, and takes a Partial override. A test
// that mocks a client function builds its fixture here instead of casting a shape by hand, so a
// query change that drops or renames a field fails typecheck in the tests too.
import type {
  ActivityModel,
  BalanceModel,
  LoanCollateralToken,
  LoanModel,
  MarketplaceOrderModel,
  PoolLendingLiquidityModel,
  PoolLendingLiquidityWithOracle,
  PoolLendingPoolWithTicks,
  TokenDetail,
  TokenDetailWithPoolOracle,
  TokenListItem,
  TokenValuationModel,
  ValuationPricing,
  WalletCreditHistory,
  WalletModel,
  WalletToken,
} from "../types/index.js";

export const FABRICA_TOKEN_CONTRACT = "0x5cbeb7A0df7Ed85D82a472FD56d81ed550f3Ea95";

/** One row of a token list (what getTokens returns). */
export function tokenListItem(overrides: Partial<TokenListItem> = {}): TokenListItem {
  return {
    tokenId: "1",
    name: "Test Ranch",
    vanityName: null,
    slug: "us/texas/travis/test-ranch",
    propertyLink: "https://fabrica.land/property/ethereum/1",
    acres: "10",
    region: "Texas",
    regionCode: "TX",
    district: "Travis County",
    place: "Austin",
    country: "US",
    countryCode: "US",
    score: 73242,
    estimatedValue: "100000",
    cardDisplayValuation: "$100,000",
    marketplacePrice: null,
    marketplaceBidCount: 0,
    imageUrlDark: null,
    imageUrlLight: null,
    supply: "1",
    supplyUnderLoan: "0",
    isPremint: false,
    isBurned: false,
    claimState: null,
    supersededByTokenId: null,
    offRampStatus: null,
    mintedAt: "2025-01-01T00:00:00.000Z",
    majorityOwnerAddress: null,
    coordinates: { lat: 30.267, lon: -97.743 },
    ...overrides,
  };
}

/** One token in full (what getToken returns without the pool oracle). */
export function tokenDetail(overrides: Partial<TokenDetail> = {}): TokenDetail {
  return {
    tokenId: "12345",
    network: "ethereum",
    contractAddress: FABRICA_TOKEN_CONTRACT,
    name: "Test Ranch",
    vanityName: null,
    slug: "us/texas/travis/test-ranch",
    propertyLink: "https://fabrica.land/property/ethereum/12345",
    geoJson: null,
    acres: "40.5",
    country: "US",
    countryCode: "US",
    region: "Texas",
    regionCode: "TX",
    postCode: null,
    district: "Travis County",
    place: "Austin",
    locality: null,
    neighborhood: null,
    street: null,
    address: null,
    supply: "1",
    supplyUnderLoan: "0",
    supplyLiquidating: "0",
    supplyInDefault: "0",
    isPremint: false,
    isClaimedPremint: false,
    claimState: null,
    supersededByTokenId: null,
    offRampStatus: null,
    isBurned: false,
    fishy: false,
    duplicateParcelCount: 0,
    score: 73242,
    validator: null,
    estimatedValue: "1000",
    cardDisplayValuation: "$1,000",
    marketplacePrice: null,
    marketplaceBidCount: 0,
    imageUrlDark: null,
    imageUrlLight: null,
    mintedAt: null,
    operatingAgreementName: null,
    operatingAgreementUrl: null,
    majorityOwnerAddress: null,
    coordinates: { lat: 30.267, lon: -97.743 },
    fees: { totalAmount: "0", fees: [] },
    scoringCheckResults: [],
    majorityOwner: null,
    lastOwner: null,
    balances: [],
    pricing: [],
    configuration: null,
    definition: null,
    loans: [],
    poolLendingLiquidity: null,
    marketplaceListings: [],
    marketplaceBids: [],
    activity: [],
    transfers: [],
    ...overrides,
  };
}

/** The token as getToken(..., { poolOracle: true }) returns it: pool liquidity carries each pool's oracle state. */
export function tokenDetailWithPoolOracle(overrides: Partial<TokenDetailWithPoolOracle> = {}): TokenDetailWithPoolOracle {
  return { ...tokenDetail(), poolLendingLiquidity: null, ...overrides };
}

export function poolLendingLiquidity(overrides: Partial<PoolLendingLiquidityModel> = {}): PoolLendingLiquidityModel {
  return {
    appraisalBlockReason: null,
    maxPrincipalScaled: "0",
    maxPrincipalUsdc: "0",
    durations: [],
    activeLoan: null,
    ...overrides,
  };
}

export function poolLendingLiquidityWithOracle(overrides: Partial<PoolLendingLiquidityWithOracle> = {}): PoolLendingLiquidityWithOracle {
  return { ...poolLendingLiquidity(), pools: [], ...overrides };
}

/** One pool's oracle state inside poolLendingLiquidity.pools. */
export function oraclePool(overrides: Partial<PoolLendingPoolWithTicks> = {}): PoolLendingPoolWithTicks {
  return {
    address: "0x842Ffbf1AD5314503904626122376f71603A3Cf9",
    pricing: "SignedQuote",
    oracleValuation: null,
    onchainPrice: null,
    oracleFeed: null,
    onchainValuation: null,
    ticks: [],
    ...overrides,
  };
}

/** The token as getTokenValuation returns it. */
export function valuationToken(overrides: Partial<TokenValuationModel> = {}): TokenValuationModel {
  return {
    tokenId: "100",
    name: "Test Ranch",
    vanityName: null,
    isPremint: false,
    estimatedValue: "0.00",
    cardDisplayValuation: "0.00",
    valuationReportUrl: null,
    pricing: [],
    poolLendingLiquidity: null,
    ...overrides,
  };
}

export function valuationPricing(overrides: Partial<ValuationPricing> = {}): ValuationPricing {
  return {
    source: "fabrica-avm",
    scope: "land",
    value: null,
    currency: "usd",
    confidence: null,
    timestamp: "2026-09-27T06:09:36.614Z",
    modelVersion: "",
    ...overrides,
  };
}

const EMPTY_LOAN_BUCKET = { loanCount: "0", totalPrincipalValue: "0", totalPaidValue: "0", averageDurationDays: "0" };

export function walletCreditHistory(overrides: Partial<WalletCreditHistory> = {}): WalletCreditHistory {
  return {
    activeLoans: EMPTY_LOAN_BUCKET,
    defaultedLoans: EMPTY_LOAN_BUCKET,
    liquidatedLoans: EMPTY_LOAN_BUCKET,
    repaidLoans: EMPTY_LOAN_BUCKET,
    totalLoans: EMPTY_LOAN_BUCKET,
    tokens: { tokenCount: "0", totalEstimatedValue: "0" },
    ...overrides,
  };
}

/** A wallet as getWallet returns it: no holdings, no loans, an empty credit history. */
export function wallet(overrides: Partial<WalletModel> = {}): WalletModel {
  return {
    address: "0x1234567890abcdef1234567890abcdef12345678",
    user: { displayName: "", profilePath: null, avatarUrl: null },
    tokens: [],
    tokenCount: "0",
    totalValue: "0",
    totalAcres: "0",
    totalCollateralValue: "0",
    totalOutstandingLoansUSDC: null,
    propertyCountUnderLoan: "0",
    creditHistory: walletCreditHistory(),
    activity: [],
    loansTaken: [],
    loansMade: [],
    marketplaceOffersMade: [],
    ...overrides,
  };
}

/** One of a wallet's holdings (wallet.tokens). */
export function walletToken(overrides: Partial<WalletToken> = {}): WalletToken {
  return {
    tokenId: "1",
    name: "Lot 1",
    vanityName: null,
    acres: "10",
    region: "Texas",
    regionCode: "TX",
    district: "Travis County",
    estimatedValue: "1000",
    score: 73242,
    marketplacePrice: null,
    supplyUnderLoan: "0",
    ...overrides,
  };
}

/** The collateral summary a lending-market loan carries (loan.token). */
export function loanToken(overrides: Partial<LoanCollateralToken> = {}): LoanCollateralToken {
  return {
    tokenId: "1",
    name: "Lot 1",
    acres: "10",
    region: "Texas",
    regionCode: "TX",
    district: "Travis County",
    estimatedValue: "1000",
    ...overrides,
  };
}

/** One lending-market loan (what getLoans and getAllLoans return). */
export function loan(overrides: Partial<LoanModel> = {}): LoanModel {
  return {
    loanId: "1",
    loanStatus: "Active",
    loanProvider: "PoolLending",
    loanType: "Fixed",
    loanContract: "0x842ffbf1ad5314503904626122376f71603a3cf9",
    principalScaled: "1000",
    currencySymbol: "USDC",
    aprPercent: 12,
    interestForDurationPercent: 1,
    durationFormatted: "30 days",
    maturityDate: "2026-10-01T00:00:00Z",
    startTime: "2026-09-01T00:00:00Z",
    maxRepaymentScaled: "1010",
    collateralId: "1",
    collateralContract: FABRICA_TOKEN_CONTRACT,
    networkName: "ethereum",
    amountPaidToLenderScaled: null,
    loanRepaidDate: null,
    loanLiquidationDate: null,
    borrower: { address: "0x1111111111111111111111111111111111111111", user: { displayName: "" } },
    lender: null,
    token: null,
    ...overrides,
  };
}

/** One holder row of a token (token.balances). */
export function balance(overrides: Partial<BalanceModel> = {}): BalanceModel {
  return {
    balance: "1",
    tokenId: "12345",
    holder: { address: "0x1234567890abcdef1234567890abcdef12345678", user: { displayName: "" } },
    ...overrides,
  };
}

/** A listing or offer as a token carries it (token.marketplaceListings, token.marketplaceBids). */
export function marketplaceOrder(overrides: Partial<MarketplaceOrderModel> = {}): MarketplaceOrderModel {
  return {
    marketplaceId: "m",
    side: "sell",
    status: "active",
    price: "100",
    usdPrice: "100",
    symbol: "USDC",
    supply: "1",
    makerAddress: "0x1234567890abcdef1234567890abcdef12345678",
    startTime: "2026-01-01T00:00:00Z",
    endTime: null,
    encumbrance: null,
    ...overrides,
  };
}

/** One row of a token's activity feed (token.activity). */
export function activity(overrides: Partial<ActivityModel> = {}): ActivityModel {
  return {
    activity: "ScoreChanged",
    source: "Fabrica",
    time: "2026-10-01T00:00:00Z",
    timestamp: 0,
    network: "ethereum",
    tokenId: "1",
    transactionHash: null,
    currencyAmount: null,
    currencyDecimals: null,
    currencySymbol: null,
    usdAmount: null,
    newValue: null,
    ...overrides,
  };
}
