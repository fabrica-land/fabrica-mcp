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
  isBurned: boolean;
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
  loanOffers: LoanOfferModel[];
  loanOfferCount: number;
  loans: LoanModel[];
  metaStreetLiquidity: MetaStreetLiquidityModel | null;
  configuration: ConfigurationModel | null;
  definition: DefinitionModel | null;
  operatingAgreement: string | null;
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

export interface WalletModel {
  address: string;
  user: UserModel;
  tokens: TokenModel[];
  tokenCount: string;
  totalValue: string;
  totalAcres: string;
  totalCollateralValue: string;
  totalOutstandingLoansUSDC: string;
  propertyCountUnderLoan: string;
  creditHistory: WalletCreditHistory;
  activity: ActivityModel[];
  loansTaken: LoanModel[] | null;
  loansMade: LoanModel[] | null;
  loanOffersMade: LoanOfferModel[] | null;
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
  loanProvider: "MetaStreet" | "NFTfi";
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
  status: "active" | "canceled" | "expired" | "filled" | "pending";
  price: string;
  usdPrice: string | null;
  symbol: string;
  supply: string;
  maker: WalletModel;
  makerAddress: string;
  startTime: string;
  endTime: string | null;
}

export interface LoanOfferModel {
  offerId: string;
  lender: WalletModel;
  loanProvider: "MetaStreet" | "NFTfi";
  principalScaled: string;
  currencySymbol: string | null;
  durationFormatted: string;
  aprPercent: number | null;
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

export interface ConfigurationMedia {
  url: string;
  type: string;
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

export interface MetaStreetLiquidityModel {
  maxPrincipalScaled: string;
  maxPrincipalUsdc: string;
  durations: string[];
  activeLoan: MetaStreetLoanModel | null;
}

export interface MetaStreetLoanModel {
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
  trait_type: string;
  value: boolean;
}

export interface TraitDecimal {
  trait_type: string;
  value: number;
}

export interface TraitString {
  trait_type: string;
  value: string;
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
