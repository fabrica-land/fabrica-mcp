// Fabrica GraphQL API types — derived from live schema introspection

export interface Coordinates {
  lat: number;
  lon: number;
}

export interface TokenModel {
  tokenId: string;
  network: string;
  contractAddress: string;
  name: string | null;
  vanityName: string | null;
  slug: string;
  propertyLink: string;
  coordinates: Coordinates;
  geoJson: Record<string, unknown> | null;
  supply: string;
  supplyUnderLoan: string;
  supplyLiquidating: string;
  supplyInDefault: string;
  isPremint: boolean;
  isClaimedPremint: boolean;
  claimState?: "CLAIMED" | "UNCLAIMED" | null;
  supersededByTokenId?: string | null;
  offRampStatus?: string | null;
  isBurned: boolean;
  fishy?: boolean;
  duplicateParcelCount?: number | null;
  fees?: TokenFees;
  lastOwner: WalletModel | null;
  majorityOwner: UserModel | null;
  majorityOwnerAddress: string | null;
  balances: BalanceModel[] | null;
  transfers: TransferModel[] | null;
  score: number | null;
  scoringCheckResults: ScoringCheckResult[];
  validator: string | null;
  marketplaceBids: MarketplaceOrderModel[] | null;
  marketplaceListings: MarketplaceOrderModel[] | null;
  marketplaceBidCount: number;
  marketplacePrice: string | null;
  pricing: PricingModel[];
  estimatedValue: string;
  cardDisplayValuation: string;
  loans: LoanModel[];
  poolLendingLiquidity: PoolLendingLiquidityModel | null;
  configuration: ConfigurationModel | null;
  definition: DefinitionModel | null;
  operatingAgreementName: string | null;
  operatingAgreementUrl: string | null;
  imageUrlDark: string | null;
  imageUrlLight: string | null;
  mintedAt: string | null;
  booleanTraits: TraitBoolean[] | null;
  decimalTraits: TraitDecimal[] | null;
  stringTraits: TraitString[] | null;
  activity: ActivityModel[];
  acres: string | null;
  country: string | null;
  countryCode: string | null;
  region: string | null;
  regionCode: string | null;
  postCode: string | null;
  district: string | null;
  place: string | null;
  locality: string | null;
  neighborhood: string | null;
  street: string | null;
  address: string | null;
}

export interface TokenFee {
  type: string;
  createdAt: string;
  currency: string;
  amount: string;
  approved: boolean;
  approvedAt: string | null;
  paid: boolean;
  paidAt: string | null;
}

export interface TokenFees {
  totalAmount: string;
  fees: TokenFee[];
}

export interface WalletModel {
  address: string;
  user: UserModel;
  tokens: TokenModel[];
  tokenCount: string;
  totalValue: string;
  totalAcres: string;
  totalCollateralValue: string;
  totalOutstandingLoansUSDC: string | null;
  propertyCountUnderLoan: string;
  creditHistory: WalletCreditHistory;
  activity: ActivityModel[];
  loansTaken: LoanModel[] | null;
  loansMade: LoanModel[] | null;
  marketplaceOffersMade: MarketplaceOrderModel[] | null;
}

export interface UserModel {
  displayName: string;
  profilePath: string | null;
  profileUrl: string | null;
  avatarUrl: string | null;
}

export interface LoanModel {
  loanId: string;
  loanStatus: "Active" | "Default" | "Liquidated" | "Liquidating" | "Repaid";
  loanProvider: "PoolLending" | "NFTfi";
  loanType: "Fixed" | "Prorated";
  principal: string;
  principalScaled: string;
  currency: string;
  currencySymbol: string | null;
  interestForDurationBps: number;
  interestForDurationPercent: number;
  aprBps: number | null;
  aprPercent: number | null;
  durationSeconds: string;
  durationFormatted: string;
  maturityDate: string;
  startTime: string;
  maxRepayment: string;
  maxRepaymentScaled: string;
  collateralId: string;
  collateralContract: string;
  borrower: WalletModel;
  lender: WalletModel | null;
  token: TokenModel | null;
  loanContract: string;
  networkName: string;
  amountPaidToLender: string | null;
  amountPaidToLenderScaled: string | null;
  loanRepaidDate: string | null;
  loanLiquidationDate: string | null;
}

export interface MarketplaceOrderModel {
  marketplaceId: string;
  tokenId: string;
  contractAddress: string;
  network: string;
  side: "buy" | "sell";
  status: "active" | "canceled" | "encumbered" | "expired" | "filled" | "pending";
  price: string;
  usdPrice: string | null;
  symbol: string;
  supply: string;
  maker: WalletModel;
  makerAddress: string;
  startTime: string;
  endTime: string | null;
}

export interface ScoringCheckResult {
  checkName: string;
  group: string;
  title: string;
  value: boolean;
}

export interface PricingModel {
  source: string;
  scope: string;
  currency: string;
  value: string | null;
  confidence: string | null;
  timestamp: string;
}

export interface ConfigurationModel {
  holdingEntityDate: string | null;
  media: ConfigurationMedia[] | null;
  partner: string | null;
  proofOfTitle: ProofOfTitle | null;
  propertyNickName: string | null;
  userDescription: string | null;
}

export interface ConfigurationDocument {
  type: string;
  source: string;
  description: string | null;
  order: string | null;
}

export interface ConfigurationMedia {
  source: string;
  type: string | null;
  description: string | null;
  order: string | null;
}

export interface ProofOfTitle {
  document: string | null;
  documentName: string | null;
  source: string | null;
}

export interface DefinitionModel {
  claim: string;
  coordinates: Coordinates;
  geoJson: Record<string, unknown> | null;
  holdingEntity: string;
  offchainRegistrar: OffchainRegistrar;
}

export interface OffchainRegistrar {
  admin: string;
  country: string;
  propertyId: string;
}

export interface PoolLendingLiquidityModel {
  maxPrincipalScaled: string;
  maxPrincipalUsdc: string;
  durations: number[];
  activeLoan: PoolLendingLoanModel | null;
  /** Selected on single-token queries only. */
  appraisalBlockReason?: AppraisalBlockReason | null;
  /** Selected on single-token queries only. */
  pools?: PoolLendingPoolValuation[];
}

export interface PoolLendingLoanModel {
  id: string;
  poolAddress: string;
  borrowerAddress: string;
  principal: string;
  repayment: string;
  duration: string;
  maturity: string;
}

export interface ActivityModel {
  activity: string;
  source: string;
  time: string;
  timestamp: number;
  network: string;
  tokenId: string | null;
  transactionHash: string | null;
  currencyAmount: string | null;
  currencyDecimals: number | null;
  currencySymbol: string | null;
  usdAmount: string | null;
  durationSeconds: string | null;
}

export interface BalanceModel {
  balance: string;
  holder: WalletModel;
  tokenId: string;
}

export interface TransferModel {
  from: WalletModel | null;
  to: WalletModel | null;
  value: string;
  transactionHash: string;
  blockTimestamp: string;
}

export interface TraitBoolean {
  key: string;
  displayName: string;
  value: boolean | null;
}

export interface TraitDecimal {
  key: string;
  displayName: string;
  value: number | null;
}

export interface TraitString {
  key: string;
  displayName: string;
  value: string | null;
}

export interface WalletCreditHistory {
  activeLoans: WalletLoanCreditBucket;
  defaultedLoans: WalletLoanCreditBucket;
  liquidatedLoans: WalletLoanCreditBucket;
  repaidLoans: WalletLoanCreditBucket;
  totalLoans: WalletLoanCreditBucket;
  tokens: WalletTokenCreditBucket;
}

export interface WalletLoanCreditBucket {
  loanCount: string;
  totalPrincipalValue: string;
  totalPaidValue: string;
  averageDurationDays: string;
}

export interface WalletTokenCreditBucket {
  tokenCount: string;
  totalEstimatedValue: string;
}

export interface LoanStartedEvent {
  loanId: string;
  borrower: string;
  lender: string | null;
  loanPrincipalAmount: string;
  loanDuration: string;
  loanStartTime: string;
  loanInterestRateForDurationInBasisPoints: number;
  loanProvider: string;
  nftCollateralId: string;
  transactionHash: string;
  blockTimestamp: string;
}

export interface LoanRepaidEvent {
  loanId: string;
  borrower: string;
  lender: string | null;
  loanPrincipalAmount: string;
  amountPaidToLender: string;
  adminFee: string;
  nftCollateralId: string;
  transactionHash: string;
  blockTimestamp: string;
}

export interface LoanLiquidatedEvent {
  loanId: string;
  borrower: string;
  lender: string | null;
  loanPrincipalAmount: string;
  loanLiquidationDate: string;
  nftCollateralId: string;
  transactionHash: string;
  blockTimestamp: string;
}

export interface CountyBoundsModel {
  geoJson: Record<string, unknown>;
}

// Valuation and pool oracle types (get_valuation, get_borrow_quote)

export type AppraisalBlockReason = "TAX_DELINQUENT" | "TAX_STATUS_UNKNOWN" | "OTHER";

export interface PoolLendingQuote {
  price: string;
  currency: string;
  timestamp: number;
  duration: number;
}

export interface PoolLendingPoolValuation {
  address: string;
  pricing: "SignedQuote" | "OnchainOracle";
  oracleValuation: { quote: PoolLendingQuote; signature: string | null } | null;
  onchainPrice: {
    priceUsdc6: string | null;
    confidenceScore: number | null;
    cycle: string | null;
    valuedAt: string | null;
    sourceId: number | null;
  } | null;
  oracleFeed: {
    lastHeartbeat: string | null;
    maxSilence: string;
    isStale: boolean;
    currentCycle: string | null;
    minValidCycle: string | null;
    indexerUnavailableReason: string | null;
  } | null;
  onchainValuation: {
    usablePriceUsdc6: string | null;
    capacityBlockReason: string | null;
    failedCheck: string | null;
  } | null;
}

export interface ValuationPricing {
  source: string;
  scope: string;
  currency: string;
  value: string | null;
  confidence: string | null;
  timestamp: string;
  modelVersion: string;
}

export interface TokenValuationModel {
  tokenId: string;
  name: string | null;
  vanityName: string | null;
  isPremint: boolean;
  estimatedValue: string;
  cardDisplayValuation: string;
  valuationReportUrl: string | null;
  pricing: ValuationPricing[];
  poolLendingLiquidity: PoolLendingLiquidityModel | null;
}

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

// Goldsky MetaStreet Pool subgraph types

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
}

// Order book (get_order_book): the marketplace fields of one token, nothing else

export interface OrderBookOrder {
  marketplaceId: string;
  side: "buy" | "sell";
  status: "active" | "canceled" | "encumbered" | "expired" | "filled" | "pending";
  price: string;
  usdPrice: string | null;
  symbol: string;
  decimals: number;
  feeBps: string;
  supply: string;
  startTime: string;
  endTime: string | null;
  makerAddress: string;
  maker: { user: { displayName: string | null } | null } | null;
  restrictedToAddresses: string[] | null;
  disclosurePackage: { name: string; url: string }[] | null;
  encumbrance: { buyable: boolean; blockReason: "AWAITING_ALLOWANCE" | "LEGACY_POOL" | "UNDERWATER" | null; loanId: string } | null;
}

export interface OrderBookToken {
  tokenId: string;
  name: string | null;
  vanityName: string | null;
  propertyLink: string;
  isPremint: boolean;
  claimState: "CLAIMED" | "UNCLAIMED" | null;
  supersededByTokenId: string | null;
  offRampStatus: string | null;
  isBurned: boolean;
  supply: string;
  supplyUnderLoan: string;
  marketplaceListings: OrderBookOrder[] | null;
  marketplaceBids: OrderBookOrder[] | null;
}

/** The legal record of one token, as selected by GetTrustDocuments (single-token query only). */
export interface TrustDocumentsToken {
  tokenId: string;
  network: string;
  contractAddress: string;
  name: string | null;
  vanityName: string | null;
  propertyLink: string;
  isPremint: boolean;
  district: string | null;
  regionCode: string | null;
  validator: string | null;
  metadataUri: string | null;
  operatingAgreementName: string | null;
  operatingAgreementUrl: string | null;
  operatingAgreement?: string | null;
  definition: {
    claim: string;
    holdingEntity: string;
    offchainRegistrar: { admin: string; adminId: string; country: string; propertyId: string };
  } | null;
  configuration: {
    holdingEntityDate: string | null;
    proofOfTitle: { document: string | null; documentId: string | null; documentName: string | null; grantor: string | null; source: string | null } | null;
    documents: ConfigurationDocument[] | null;
    media: { type: string | null }[] | null;
  } | null;
}
