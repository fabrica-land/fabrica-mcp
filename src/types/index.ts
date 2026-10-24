// Types of what the Fabrica API returns to this server.
//
// Everything the GraphQL client reads is typed by the operation that fetches it: the types in
// src/clients/generated/operations.ts are generated (npm run codegen) from the schema snapshot
// and the documents in src/clients/graphql.ts, so a field is in a type exactly when the query
// selects it, with the schema's own nullability. The aliases below name those shapes the way
// the tools talk about them. The hand-written types at the end cover the REST and subgraph
// responses, which have no schema to generate from.
import type {
  GetCountyBoundsQuery,
  GetDepositPoolsQuery,
  GetPoolDepositsQuery,
  GetWalletLoansQuery,
  GetLoanLiquidatedEventsQuery,
  GetLoanRepaidEventsQuery,
  GetLoanStartedEventsQuery,
  GetNetworkActivityQuery,
  GetOperatingAgreementQuery,
  GetOrderBookQuery,
  GetSignContextQuery,
  GetLoanContextQuery,
  GetParcelIndexQuery,
  GetPremintSuccessorQuery,
  GetTaxStatusQuery,
  GetTokenWithPoolOracleQuery,
  GetTrustDocumentsQuery,
  GetValuationQuery,
  LoanFieldsFragment,
  PoolOracleFieldsFragment,
  TokenDetailFieldsFragment,
  TokenListFieldsFragment,
  WalletFieldsFragment,
} from "../clients/generated/operations.js";

export type {
  ActivitySource,
  ActivityType,
  AppraisalBlockReason,
  LoanProvider,
  LoanStatus,
  LoanType,
  MarketplaceOrderBlockReason,
  MarketplaceOrderSide,
  MarketplaceOrderStatus,
  PremintClaimState,
} from "../clients/generated/operations.js";

// --- Tokens ---

/** One row of a token list (GetTokens): what search_land and the protocol stats read. */
export type TokenListItem = TokenListFieldsFragment;

/** One token in full (GetToken): what get_land_property and the per-property tools read. */
export type TokenDetail = TokenDetailFieldsFragment;

/** GetToken with each pool's oracle state (GetTokenWithPoolOracle), for estimate_land_borrowing. */
export type TokenDetailWithPoolOracle = GetTokenWithPoolOracleQuery["token"];

/** The full token shape; `TokenDetail` under its historical name. */
export type TokenModel = TokenDetail;

export type Coordinates = TokenDetail["coordinates"];
export type TokenFees = TokenDetail["fees"];
export type TokenFee = TokenFees["fees"][number];
export type ScoringCheckResult = TokenDetail["scoringCheckResults"][number];
export type PricingModel = TokenDetail["pricing"][number];
export type ConfigurationModel = NonNullable<TokenDetail["configuration"]>;
export type ConfigurationMedia = NonNullable<ConfigurationModel["media"]>[number];
export type DefinitionModel = NonNullable<TokenDetail["definition"]>;
export type ActivityModel = TokenDetail["activity"][number];
export type BalanceModel = NonNullable<TokenDetail["balances"]>[number];
export type TransferModel = NonNullable<TokenDetail["transfers"]>[number];
/** A listing or offer as a token carries it; the order book selects more (OrderBookOrder). */
export type MarketplaceOrderModel = NonNullable<TokenDetail["marketplaceListings"]>[number];
/** A token's own loan rows; the lending market's rows are `LoanModel`. */
export type TokenLoan = TokenDetail["loans"][number];
export type PoolLendingLiquidityModel = NonNullable<TokenDetail["poolLendingLiquidity"]>;
export type PoolLendingLoanModel = NonNullable<PoolLendingLiquidityModel["activeLoan"]>;
/** Pool liquidity with each pool's oracle state: selected by GetTokenWithPoolOracle and GetValuation only. */
export type PoolLendingLiquidityWithOracle = NonNullable<TokenDetailWithPoolOracle["poolLendingLiquidity"]>;

// --- Wallets ---

export type WalletModel = WalletFieldsFragment;
export type WalletToken = WalletModel["tokens"][number];
export type WalletCreditHistory = WalletModel["creditHistory"];
export type WalletLoanCreditBucket = WalletCreditHistory["totalLoans"];
export type UserModel = WalletModel["user"];

// --- Loans and loan events (GetLoans and the event queries) ---

export type LoanModel = LoanFieldsFragment;
/** The collateral summary a lending-market loan carries (`loan.token`). */
export type LoanCollateralToken = NonNullable<LoanModel["token"]>;
export type LoanStartedEvent = GetLoanStartedEventsQuery["loanStartedEvents"][number];
export type LoanRepaidEvent = GetLoanRepaidEventsQuery["loanRepaidEvents"][number];
export type LoanLiquidatedEvent = GetLoanLiquidatedEventsQuery["loanLiquidatedEvents"][number];

// --- Single-token queries with their own selections ---

export type CountyBoundsModel = NonNullable<GetCountyBoundsQuery["countyBounds"]>;
export type OrderBookToken = GetOrderBookQuery["token"];
export type OrderBookOrder = NonNullable<OrderBookToken["marketplaceListings"]>[number];
/** A token as the sign-request prepare tools check it: state, holders, estimate and order book. */
export type SignContextToken = GetSignContextQuery["token"];
/** An order as the sign-request tools read it: the order book fields plus the transaction that filled it. */
export type SignContextOrder = NonNullable<SignContextToken["marketplaceListings"]>[number];
/** A token as the borrow and repay tools and get_land_loan read it: the pool's capacity and every loan on it. */
export type LoanContextToken = GetLoanContextQuery["token"];
export type LoanContextLoan = NonNullable<LoanContextToken["loans"]>[number];
export type PremintSuccessor = GetPremintSuccessorQuery["premintSuccessor"];
/** A wallet's loans as get_my_loans reads them, with the live payoff of an active loan. */
export type WalletLoans = GetWalletLoansQuery["wallet"];
export type WalletLoan = NonNullable<WalletLoans["loansTaken"]>[number];
/** A lending pool with its ticks' value and shares, to price a deposit. */
export type DepositPool = GetDepositPoolsQuery["poolLendingPools"]["pools"][number];
export type PoolDeposit = GetPoolDepositsQuery["user"]["poolLendingDeposits"][number];
export type TrustDocumentsToken = GetTrustDocumentsQuery["token"];
export type ConfigurationDocument = NonNullable<NonNullable<TrustDocumentsToken["configuration"]>["documents"]>[number];
export type TaxStatusToken = GetTaxStatusQuery["token"];
export type OperatingAgreementModel = GetOperatingAgreementQuery["token"];
export type ParcelIndexToken = GetParcelIndexQuery["tokens"][number];
export type NetworkActivityToken = GetNetworkActivityQuery["tokens"][number];

// --- Valuation and pool oracle (get_land_valuation, estimate_land_borrowing) ---

export type TokenValuationModel = GetValuationQuery["token"];
export type ValuationPricing = TokenValuationModel["pricing"][number];
export type PoolLendingPoolValuation = PoolOracleFieldsFragment["pools"][number];
/** A pool as estimate_land_borrowing reads it: the oracle fields plus the ticks that bound a loan. */
export type PoolLendingPoolWithTicks = NonNullable<NonNullable<GetTokenWithPoolOracleQuery["token"]>["poolLendingLiquidity"]>["pools"][number];
export type PoolLendingQuote = NonNullable<PoolLendingPoolValuation["oracleValuation"]>["quote"];

// --- REST responses (no schema; shapes checked at the boundary in the client) ---

/** One entry of the REST `/valuation/v1` panel: a signed valuation the lending pool can use. */
export interface SignedValuation {
  source: string;
  version: string;
  signer: string;
  signature: string | null;
  quote: { price: string; currency: string; timestamp: number; duration: number } | null;
  reason?: string;
}

export interface SignedValuationPanel {
  networkName: string;
  asOf: string;
  valuations: SignedValuation[];
}

/** The REST score record (GET /:network/:contract/:tokenId/score). Check values are 1, 0, true, false or null. */
export interface ScoreRecord {
  checks: Record<string, number | boolean | null>;
  updatedAt: string | null;
  expiresAt: string | null;
}

// --- Goldsky lending pool subgraph ---

export interface SubgraphPool {
  id: string;
  implementation: string;
  collateralToken: { id: string };
  currencyToken: { id: string; symbol: string; decimals: number };
  totalValueLocked: string;
  totalValueUsed: string;
  totalValueAvailable: string;
  durations: string[];
  rates: string[];
  maxBorrows: string[];
  loansOriginated: string;
  loansActive: string;
  loansRepaid: string;
  loansLiquidated: string;
  adminFeeRate: string;
  /** Per-tick deposits (18-decimal scaled), used when the pool totals read 0. */
  ticks?: { value: string; available: string }[];
  /** True when the totals above were derived from the ticks. */
  totalsFromTicks?: boolean;
}
