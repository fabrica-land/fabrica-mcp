/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
export type ActivitySource =
  | 'Fabrica'
  | 'NftFi'
  | 'PoolLending'
  | 'Seaport';

export type ActivityType =
  | 'AuctionBid'
  | 'AuctionClaimed'
  | 'AuctionEnded'
  | 'AuctionStarted'
  | 'Burn'
  | 'ConfigurationUpdated'
  | 'LoanDefaulted'
  | 'LoanLiquidated'
  | 'LoanRefinanced'
  | 'LoanRenegotiated'
  | 'LoanRepaid'
  | 'LoanStarted'
  | 'MarketplaceBidCanceled'
  | 'MarketplaceBidExpired'
  | 'MarketplaceBidStarted'
  | 'MarketplaceBidUpdated'
  | 'MarketplaceListingCanceled'
  | 'MarketplaceListingExpired'
  | 'MarketplaceListingStarted'
  | 'MarketplaceListingUpdated'
  | 'MarketplaceSold'
  | 'MediaChanged'
  | 'Mint'
  | 'OperatingAgreementUpdated'
  | 'ScoreChanged'
  | 'Transfer'
  | 'Unknown'
  | 'UserDescriptionChanged'
  | 'ValidatorUpdated';

/** Why Token.poolLendingLiquidity.appraisalBlockReason is non-null. Sanitized server-side: this field is publicly queryable without auth, so the ENG-3813 fraud/fishy gate is never distinguishable via this enum — it resolves to null, the same as no gate at all. */
export type AppraisalBlockReason =
  /** Reserved for a future internal reason explicitly judged safe to disclose. Not currently produced. */
  | 'OTHER'
  /** Tax status was verified and is past-due. */
  | 'TAX_DELINQUENT'
  /** Tax status was never verified, or a prior verification expired. */
  | 'TAX_STATUS_UNKNOWN';

export type EthereumCurrency =
  | 'DAI'
  | 'ETH'
  | 'USDC'
  | 'WETH';

export type FeeType =
  | 'OnRamp';

export type LoanProvider =
  | 'NFTfi'
  | 'PoolLending';

export type LoanStatus =
  | 'Active'
  | 'Default'
  | 'Liquidated'
  | 'Liquidating'
  | 'Repaid';

export type LoanType =
  | 'Fixed'
  | 'Prorated';

export type MarketplaceOrderBlockReason =
  | 'AWAITING_ALLOWANCE'
  | 'LEGACY_POOL'
  | 'UNDERWATER';

export type MarketplaceOrderSide =
  | 'buy'
  | 'sell';

export type MarketplaceOrderStatus =
  | 'active'
  | 'canceled'
  | 'encumbered'
  | 'expired'
  | 'filled'
  | 'pending';

/** How a pool values its collateral. Consumers must switch on this field. Inside `Token.poolLendingLiquidity` (borrower-side), SignedQuote pools populate `oracleValuation` while OnchainOracle pools leave `oracleValuation` null by design (ENG-3894) and populate `onchainPrice`, `oracleFeed` and `onchainValuation` instead. Depositor-side reads (`Query.poolLendingPools`) leave every valuation field unset. */
export type PoolLendingPricing =
  /** The pool's price oracle is a FabricaOracleAggregator that reads the on-chain fact store at execution time. No signed quote exists (the API never signs for such a pool), `oracleContext` is empty on borrow/refinance, and `oracleValuation` is null. `onchainPrice`, `oracleFeed` and `onchainValuation` are populated only inside `Token.poolLendingLiquidity`. */
  | 'OnchainOracle'
  /** The API returns an EIP-712 appraisal quote (`oracleValuation.quote`, inside `Token.poolLendingLiquidity`) and signs it only when the token is borrowable: `oracleValuation.signature` is null for premints and fraud-blocked tokens, whose quote is display-only and which the pool refuses. The borrower packs quote + signature into `oracleContext` and the pool's price oracle verifies the signature on-chain. `onchainPrice`, `oracleFeed` and `onchainValuation` are null. */
  | 'SignedQuote';

export type PremintClaimState =
  | 'CLAIMED'
  | 'UNCLAIMED';

export type TokenSortField =
  | 'price'
  | 'score';

export type TokenListFieldsFragment = { tokenId: string, name: string | null, vanityName: string | null, slug: string, propertyLink: string, acres: string | null, region: string | null, regionCode: string | null, district: string | null, place: string | null, country: string | null, countryCode: string | null, score: number | null, estimatedValue: string, cardDisplayValuation: string, marketplacePrice: string | null, marketplaceBidCount: number, imageUrlDark: string | null, imageUrlLight: string | null, supply: string, supplyUnderLoan: string, isPremint: boolean, isBurned: boolean, claimState: PremintClaimState | null, supersededByTokenId: string | null, offRampStatus: string | null, mintedAt: string | null, majorityOwnerAddress: string | null, coordinates: { lat: number, lon: number } };

export type GetTokensQueryVariables = Exact<{
  burned?: boolean | null | undefined;
  premints?: boolean | null | undefined;
  testnets?: boolean | null | undefined;
  contractAddress?: string | null | undefined;
  minListings?: number | null | undefined;
  minScore?: number | null | undefined;
  ownedBy?: string | null | undefined;
  sort?: TokenSortField | null | undefined;
}>;


export type GetTokensQuery = { tokens: Array<{ tokenId: string, name: string | null, vanityName: string | null, slug: string, propertyLink: string, acres: string | null, region: string | null, regionCode: string | null, district: string | null, place: string | null, country: string | null, countryCode: string | null, score: number | null, estimatedValue: string, cardDisplayValuation: string, marketplacePrice: string | null, marketplaceBidCount: number, imageUrlDark: string | null, imageUrlLight: string | null, supply: string, supplyUnderLoan: string, isPremint: boolean, isBurned: boolean, claimState: PremintClaimState | null, supersededByTokenId: string | null, offRampStatus: string | null, mintedAt: string | null, majorityOwnerAddress: string | null, coordinates: { lat: number, lon: number } }> };

export type PoolOracleFieldsFragment = { appraisalBlockReason: AppraisalBlockReason | null, pools: Array<{ address: string, pricing: PoolLendingPricing, oracleValuation: { signature: string | null, quote: { price: string, currency: string, timestamp: number, duration: number } } | null, onchainPrice: { priceUsdc6: string | null, confidenceScore: number | null, cycle: string | null, valuedAt: string | null, sourceId: number | null } | null, oracleFeed: { lastHeartbeat: string | null, maxSilence: string, isStale: boolean, currentCycle: string | null, minValidCycle: string | null, indexerUnavailableReason: string | null } | null, onchainValuation: { usablePriceUsdc6: string | null, capacityBlockReason: string | null, failedCheck: string | null } | null }> };

export type TokenDetailFieldsFragment = { tokenId: string, network: string, contractAddress: string, name: string | null, vanityName: string | null, slug: string, propertyLink: string, geoJson: Record<string, unknown> | null, acres: string | null, country: string | null, countryCode: string | null, region: string | null, regionCode: string | null, postCode: string | null, district: string | null, place: string | null, locality: string | null, neighborhood: string | null, street: string | null, address: string | null, supply: string, supplyUnderLoan: string, supplyLiquidating: string, supplyInDefault: string, isPremint: boolean, isClaimedPremint: boolean, claimState: PremintClaimState | null, supersededByTokenId: string | null, offRampStatus: string | null, isBurned: boolean, fishy: boolean, duplicateParcelCount: number | null, score: number | null, validator: string | null, estimatedValue: string, cardDisplayValuation: string, marketplacePrice: string | null, marketplaceBidCount: number, imageUrlDark: string | null, imageUrlLight: string | null, mintedAt: string | null, operatingAgreementName: string | null, operatingAgreementUrl: string | null, majorityOwnerAddress: string | null, coordinates: { lat: number, lon: number }, fees: { totalAmount: string, fees: Array<{ type: FeeType, createdAt: string, currency: string, amount: string, approved: boolean, approvedAt: string | null, paid: boolean, paidAt: string | null }> }, scoringCheckResults: Array<{ checkName: string, group: string, title: string, value: boolean }>, majorityOwner: { displayName: string, profilePath: string | null } | null, lastOwner: { address: string, user: { displayName: string } } | null, balances: Array<{ balance: string, tokenId: string, holder: { address: string, user: { displayName: string } } }> | null, pricing: Array<{ source: string, scope: string, currency: string, value: string | null, confidence: string | null, timestamp: string }>, configuration: { holdingEntityDate: string | null, propertyNickName: string | null, userDescription: string | null, proofOfTitle: { document: string | null, documentName: string | null, source: string | null } | null, media: Array<{ source: string, type: string | null, description: string | null, order: string | null }> | null } | null, definition: { claim: string, holdingEntity: string, geoJson: Record<string, unknown> | null, coordinates: { lat: number, lon: number }, offchainRegistrar: { admin: string, country: string, propertyId: string } } | null, loans: Array<{ loanId: string, loanStatus: LoanStatus, loanProvider: LoanProvider, loanType: LoanType, principalScaled: string, currencySymbol: string | null, aprPercent: number | null, interestForDurationPercent: number, durationFormatted: string, maturityDate: string, startTime: string, maxRepaymentScaled: string, collateralId: string, amountPaidToLenderScaled: string | null, loanRepaidDate: string | null, loanLiquidationDate: string | null, borrower: { address: string, user: { displayName: string } }, lender: { address: string, user: { displayName: string } } | null }>, poolLendingLiquidity: { appraisalBlockReason: AppraisalBlockReason | null, maxPrincipalScaled: string, maxPrincipalUsdc: string, durations: Array<number>, activeLoan: { id: string, principal: string, repayment: string, duration: string, maturity: string } | null } | null, marketplaceListings: Array<{ marketplaceId: string, side: MarketplaceOrderSide, status: MarketplaceOrderStatus, price: string, usdPrice: string | null, symbol: EthereumCurrency, supply: string, makerAddress: string, startTime: string, endTime: string | null, encumbrance: { buyable: boolean } | null }> | null, marketplaceBids: Array<{ marketplaceId: string, side: MarketplaceOrderSide, status: MarketplaceOrderStatus, price: string, usdPrice: string | null, symbol: EthereumCurrency, supply: string, makerAddress: string, startTime: string, endTime: string | null }> | null, activity: Array<{ activity: ActivityType, source: ActivitySource, time: string, timestamp: number, network: string, tokenId: string | null, transactionHash: string | null, currencyAmount: string | null, currencyDecimals: number | null, currencySymbol: string | null, usdAmount: string | null, newValue: string | null }>, transfers: Array<{ value: string, transactionHash: string, blockTimestamp: string, from: { address: string } | null, to: { address: string } | null }> | null };

export type GetTokenQueryVariables = Exact<{
  tokenId?: string | null | undefined;
  slug?: string | null | undefined;
  network?: string | null | undefined;
}>;


export type GetTokenQuery = { token: { tokenId: string, network: string, contractAddress: string, name: string | null, vanityName: string | null, slug: string, propertyLink: string, geoJson: Record<string, unknown> | null, acres: string | null, country: string | null, countryCode: string | null, region: string | null, regionCode: string | null, postCode: string | null, district: string | null, place: string | null, locality: string | null, neighborhood: string | null, street: string | null, address: string | null, supply: string, supplyUnderLoan: string, supplyLiquidating: string, supplyInDefault: string, isPremint: boolean, isClaimedPremint: boolean, claimState: PremintClaimState | null, supersededByTokenId: string | null, offRampStatus: string | null, isBurned: boolean, fishy: boolean, duplicateParcelCount: number | null, score: number | null, validator: string | null, estimatedValue: string, cardDisplayValuation: string, marketplacePrice: string | null, marketplaceBidCount: number, imageUrlDark: string | null, imageUrlLight: string | null, mintedAt: string | null, operatingAgreementName: string | null, operatingAgreementUrl: string | null, majorityOwnerAddress: string | null, coordinates: { lat: number, lon: number }, fees: { totalAmount: string, fees: Array<{ type: FeeType, createdAt: string, currency: string, amount: string, approved: boolean, approvedAt: string | null, paid: boolean, paidAt: string | null }> }, scoringCheckResults: Array<{ checkName: string, group: string, title: string, value: boolean }>, majorityOwner: { displayName: string, profilePath: string | null } | null, lastOwner: { address: string, user: { displayName: string } } | null, balances: Array<{ balance: string, tokenId: string, holder: { address: string, user: { displayName: string } } }> | null, pricing: Array<{ source: string, scope: string, currency: string, value: string | null, confidence: string | null, timestamp: string }>, configuration: { holdingEntityDate: string | null, propertyNickName: string | null, userDescription: string | null, proofOfTitle: { document: string | null, documentName: string | null, source: string | null } | null, media: Array<{ source: string, type: string | null, description: string | null, order: string | null }> | null } | null, definition: { claim: string, holdingEntity: string, geoJson: Record<string, unknown> | null, coordinates: { lat: number, lon: number }, offchainRegistrar: { admin: string, country: string, propertyId: string } } | null, loans: Array<{ loanId: string, loanStatus: LoanStatus, loanProvider: LoanProvider, loanType: LoanType, principalScaled: string, currencySymbol: string | null, aprPercent: number | null, interestForDurationPercent: number, durationFormatted: string, maturityDate: string, startTime: string, maxRepaymentScaled: string, collateralId: string, amountPaidToLenderScaled: string | null, loanRepaidDate: string | null, loanLiquidationDate: string | null, borrower: { address: string, user: { displayName: string } }, lender: { address: string, user: { displayName: string } } | null }>, poolLendingLiquidity: { appraisalBlockReason: AppraisalBlockReason | null, maxPrincipalScaled: string, maxPrincipalUsdc: string, durations: Array<number>, activeLoan: { id: string, principal: string, repayment: string, duration: string, maturity: string } | null } | null, marketplaceListings: Array<{ marketplaceId: string, side: MarketplaceOrderSide, status: MarketplaceOrderStatus, price: string, usdPrice: string | null, symbol: EthereumCurrency, supply: string, makerAddress: string, startTime: string, endTime: string | null, encumbrance: { buyable: boolean } | null }> | null, marketplaceBids: Array<{ marketplaceId: string, side: MarketplaceOrderSide, status: MarketplaceOrderStatus, price: string, usdPrice: string | null, symbol: EthereumCurrency, supply: string, makerAddress: string, startTime: string, endTime: string | null }> | null, activity: Array<{ activity: ActivityType, source: ActivitySource, time: string, timestamp: number, network: string, tokenId: string | null, transactionHash: string | null, currencyAmount: string | null, currencyDecimals: number | null, currencySymbol: string | null, usdAmount: string | null, newValue: string | null }>, transfers: Array<{ value: string, transactionHash: string, blockTimestamp: string, from: { address: string } | null, to: { address: string } | null }> | null } };

export type GetTokenWithPoolOracleQueryVariables = Exact<{
  tokenId?: string | null | undefined;
  slug?: string | null | undefined;
  network?: string | null | undefined;
}>;


export type GetTokenWithPoolOracleQuery = { token: { tokenId: string, network: string, contractAddress: string, name: string | null, vanityName: string | null, slug: string, propertyLink: string, geoJson: Record<string, unknown> | null, acres: string | null, country: string | null, countryCode: string | null, region: string | null, regionCode: string | null, postCode: string | null, district: string | null, place: string | null, locality: string | null, neighborhood: string | null, street: string | null, address: string | null, supply: string, supplyUnderLoan: string, supplyLiquidating: string, supplyInDefault: string, isPremint: boolean, isClaimedPremint: boolean, claimState: PremintClaimState | null, supersededByTokenId: string | null, offRampStatus: string | null, isBurned: boolean, fishy: boolean, duplicateParcelCount: number | null, score: number | null, validator: string | null, estimatedValue: string, cardDisplayValuation: string, marketplacePrice: string | null, marketplaceBidCount: number, imageUrlDark: string | null, imageUrlLight: string | null, mintedAt: string | null, operatingAgreementName: string | null, operatingAgreementUrl: string | null, majorityOwnerAddress: string | null, poolLendingLiquidity: { appraisalBlockReason: AppraisalBlockReason | null, maxPrincipalScaled: string, maxPrincipalUsdc: string, durations: Array<number>, pools: Array<{ address: string, pricing: PoolLendingPricing, ticks: Array<{ raw: string, available: string }>, oracleValuation: { signature: string | null, quote: { price: string, currency: string, timestamp: number, duration: number } } | null, onchainPrice: { priceUsdc6: string | null, confidenceScore: number | null, cycle: string | null, valuedAt: string | null, sourceId: number | null } | null, oracleFeed: { lastHeartbeat: string | null, maxSilence: string, isStale: boolean, currentCycle: string | null, minValidCycle: string | null, indexerUnavailableReason: string | null } | null, onchainValuation: { usablePriceUsdc6: string | null, capacityBlockReason: string | null, failedCheck: string | null } | null }>, activeLoan: { id: string, principal: string, repayment: string, duration: string, maturity: string } | null } | null, coordinates: { lat: number, lon: number }, fees: { totalAmount: string, fees: Array<{ type: FeeType, createdAt: string, currency: string, amount: string, approved: boolean, approvedAt: string | null, paid: boolean, paidAt: string | null }> }, scoringCheckResults: Array<{ checkName: string, group: string, title: string, value: boolean }>, majorityOwner: { displayName: string, profilePath: string | null } | null, lastOwner: { address: string, user: { displayName: string } } | null, balances: Array<{ balance: string, tokenId: string, holder: { address: string, user: { displayName: string } } }> | null, pricing: Array<{ source: string, scope: string, currency: string, value: string | null, confidence: string | null, timestamp: string }>, configuration: { holdingEntityDate: string | null, propertyNickName: string | null, userDescription: string | null, proofOfTitle: { document: string | null, documentName: string | null, source: string | null } | null, media: Array<{ source: string, type: string | null, description: string | null, order: string | null }> | null } | null, definition: { claim: string, holdingEntity: string, geoJson: Record<string, unknown> | null, coordinates: { lat: number, lon: number }, offchainRegistrar: { admin: string, country: string, propertyId: string } } | null, loans: Array<{ loanId: string, loanStatus: LoanStatus, loanProvider: LoanProvider, loanType: LoanType, principalScaled: string, currencySymbol: string | null, aprPercent: number | null, interestForDurationPercent: number, durationFormatted: string, maturityDate: string, startTime: string, maxRepaymentScaled: string, collateralId: string, amountPaidToLenderScaled: string | null, loanRepaidDate: string | null, loanLiquidationDate: string | null, borrower: { address: string, user: { displayName: string } }, lender: { address: string, user: { displayName: string } } | null }>, marketplaceListings: Array<{ marketplaceId: string, side: MarketplaceOrderSide, status: MarketplaceOrderStatus, price: string, usdPrice: string | null, symbol: EthereumCurrency, supply: string, makerAddress: string, startTime: string, endTime: string | null, encumbrance: { buyable: boolean } | null }> | null, marketplaceBids: Array<{ marketplaceId: string, side: MarketplaceOrderSide, status: MarketplaceOrderStatus, price: string, usdPrice: string | null, symbol: EthereumCurrency, supply: string, makerAddress: string, startTime: string, endTime: string | null }> | null, activity: Array<{ activity: ActivityType, source: ActivitySource, time: string, timestamp: number, network: string, tokenId: string | null, transactionHash: string | null, currencyAmount: string | null, currencyDecimals: number | null, currencySymbol: string | null, usdAmount: string | null, newValue: string | null }>, transfers: Array<{ value: string, transactionHash: string, blockTimestamp: string, from: { address: string } | null, to: { address: string } | null }> | null } };

export type GetValuationQueryVariables = Exact<{
  tokenId?: string | null | undefined;
  slug?: string | null | undefined;
  network?: string | null | undefined;
}>;


export type GetValuationQuery = { token: { tokenId: string, name: string | null, vanityName: string | null, isPremint: boolean, estimatedValue: string, cardDisplayValuation: string, valuationReportUrl: string | null, pricing: Array<{ source: string, scope: string, currency: string, value: string | null, confidence: string | null, timestamp: string, modelVersion: string }>, poolLendingLiquidity: { maxPrincipalScaled: string, maxPrincipalUsdc: string, durations: Array<number>, appraisalBlockReason: AppraisalBlockReason | null, activeLoan: { id: string, principal: string, repayment: string, duration: string, maturity: string } | null, pools: Array<{ address: string, pricing: PoolLendingPricing, oracleValuation: { signature: string | null, quote: { price: string, currency: string, timestamp: number, duration: number } } | null, onchainPrice: { priceUsdc6: string | null, confidenceScore: number | null, cycle: string | null, valuedAt: string | null, sourceId: number | null } | null, oracleFeed: { lastHeartbeat: string | null, maxSilence: string, isStale: boolean, currentCycle: string | null, minValidCycle: string | null, indexerUnavailableReason: string | null } | null, onchainValuation: { usablePriceUsdc6: string | null, capacityBlockReason: string | null, failedCheck: string | null } | null }> } | null } };

export type GetOperatingAgreementQueryVariables = Exact<{
  tokenId?: string | null | undefined;
  network?: string | null | undefined;
}>;


export type GetOperatingAgreementQuery = { token: { tokenId: string, operatingAgreementName: string | null, operatingAgreementUrl: string | null, operatingAgreement: string | null } };

export type OrderBookOrderFieldsFragment = { marketplaceId: string, side: MarketplaceOrderSide, status: MarketplaceOrderStatus, price: string, usdPrice: string | null, symbol: EthereumCurrency, decimals: number, feeBps: string, supply: string, startTime: string, endTime: string | null, makerAddress: string, restrictedToAddresses: Array<string> | null, maker: { user: { displayName: string } }, disclosurePackage: Array<{ name: string, url: string }> | null, encumbrance: { buyable: boolean, blockReason: MarketplaceOrderBlockReason | null, loanId: string } | null };

export type GetOrderBookQueryVariables = Exact<{
  tokenId?: string | null | undefined;
  slug?: string | null | undefined;
  network?: string | null | undefined;
}>;


export type GetOrderBookQuery = { token: { tokenId: string, name: string | null, vanityName: string | null, propertyLink: string, isPremint: boolean, claimState: PremintClaimState | null, supersededByTokenId: string | null, offRampStatus: string | null, isBurned: boolean, supply: string, supplyUnderLoan: string, marketplaceListings: Array<{ marketplaceId: string, side: MarketplaceOrderSide, status: MarketplaceOrderStatus, price: string, usdPrice: string | null, symbol: EthereumCurrency, decimals: number, feeBps: string, supply: string, startTime: string, endTime: string | null, makerAddress: string, restrictedToAddresses: Array<string> | null, maker: { user: { displayName: string } }, disclosurePackage: Array<{ name: string, url: string }> | null, encumbrance: { buyable: boolean, blockReason: MarketplaceOrderBlockReason | null, loanId: string } | null }> | null, marketplaceBids: Array<{ marketplaceId: string, side: MarketplaceOrderSide, status: MarketplaceOrderStatus, price: string, usdPrice: string | null, symbol: EthereumCurrency, decimals: number, feeBps: string, supply: string, startTime: string, endTime: string | null, makerAddress: string, restrictedToAddresses: Array<string> | null, maker: { user: { displayName: string } }, disclosurePackage: Array<{ name: string, url: string }> | null, encumbrance: { buyable: boolean, blockReason: MarketplaceOrderBlockReason | null, loanId: string } | null }> | null } };

export type GetSignContextQueryVariables = Exact<{
  tokenId?: string | null | undefined;
  slug?: string | null | undefined;
  network?: string | null | undefined;
}>;


export type GetSignContextQuery = { token: { tokenId: string, name: string | null, vanityName: string | null, propertyLink: string, contractAddress: string, network: string, isPremint: boolean, claimState: PremintClaimState | null, supersededByTokenId: string | null, offRampStatus: string | null, isBurned: boolean, supply: string, supplyUnderLoan: string, estimatedValue: string, majorityOwnerAddress: string | null, balances: Array<{ balance: string, holder: { address: string }, owner: { address: string } }> | null, marketplaceListings: Array<{ matchTransactionHash: string | null, marketplaceId: string, side: MarketplaceOrderSide, status: MarketplaceOrderStatus, price: string, usdPrice: string | null, symbol: EthereumCurrency, decimals: number, feeBps: string, supply: string, startTime: string, endTime: string | null, makerAddress: string, restrictedToAddresses: Array<string> | null, maker: { user: { displayName: string } }, disclosurePackage: Array<{ name: string, url: string }> | null, encumbrance: { buyable: boolean, blockReason: MarketplaceOrderBlockReason | null, loanId: string } | null }> | null, marketplaceBids: Array<{ matchTransactionHash: string | null, marketplaceId: string, side: MarketplaceOrderSide, status: MarketplaceOrderStatus, price: string, usdPrice: string | null, symbol: EthereumCurrency, decimals: number, feeBps: string, supply: string, startTime: string, endTime: string | null, makerAddress: string, restrictedToAddresses: Array<string> | null, maker: { user: { displayName: string } }, disclosurePackage: Array<{ name: string, url: string }> | null, encumbrance: { buyable: boolean, blockReason: MarketplaceOrderBlockReason | null, loanId: string } | null }> | null } };

export type GetPremintSuccessorQueryVariables = Exact<{
  network: string;
  tokenId: string;
}>;


export type GetPremintSuccessorQuery = { premintSuccessor: { tokenId: string } | null };

export type GetTrustDocumentsQueryVariables = Exact<{
  tokenId?: string | null | undefined;
  slug?: string | null | undefined;
  network?: string | null | undefined;
  withText: boolean;
}>;


export type GetTrustDocumentsQuery = { token: { tokenId: string, network: string, contractAddress: string, name: string | null, vanityName: string | null, propertyLink: string, isPremint: boolean, district: string | null, regionCode: string | null, validator: string | null, metadataUri: string | null, operatingAgreementName: string | null, operatingAgreementUrl: string | null, operatingAgreement?: string | null, definition: { claim: string, holdingEntity: string, offchainRegistrar: { admin: string, adminId: string, country: string, propertyId: string } } | null, configuration: { holdingEntityDate: string | null, proofOfTitle: { document: string | null, documentId: string | null, documentName: string | null, grantor: string | null, source: string | null } | null, documents: Array<{ type: string, source: string, description: string | null, order: string | null }> | null, media: Array<{ type: string | null }> | null } | null } };

export type GetTaxStatusQueryVariables = Exact<{
  tokenId?: string | null | undefined;
  slug?: string | null | undefined;
  network?: string | null | undefined;
}>;


export type GetTaxStatusQuery = { token: { tokenId: string, network: string, contractAddress: string, name: string | null, vanityName: string | null, isPremint: boolean, district: string | null, regionCode: string | null, poolLendingLiquidity: { appraisalBlockReason: AppraisalBlockReason | null } | null } };

export type WalletFieldsFragment = { address: string, tokenCount: string, totalValue: string, totalAcres: string, totalCollateralValue: string, totalOutstandingLoansUSDC: string | null, propertyCountUnderLoan: string, user: { displayName: string, profilePath: string | null, avatarUrl: string | null }, creditHistory: { activeLoans: { loanCount: string, totalPrincipalValue: string, totalPaidValue: string, averageDurationDays: string }, defaultedLoans: { loanCount: string, totalPrincipalValue: string, totalPaidValue: string, averageDurationDays: string }, liquidatedLoans: { loanCount: string, totalPrincipalValue: string, totalPaidValue: string, averageDurationDays: string }, repaidLoans: { loanCount: string, totalPrincipalValue: string, totalPaidValue: string, averageDurationDays: string }, totalLoans: { loanCount: string, totalPrincipalValue: string, totalPaidValue: string, averageDurationDays: string }, tokens: { tokenCount: string, totalEstimatedValue: string } }, tokens: Array<{ tokenId: string, name: string | null, vanityName: string | null, acres: string | null, region: string | null, regionCode: string | null, district: string | null, estimatedValue: string, score: number | null, marketplacePrice: string | null, supplyUnderLoan: string }>, loansTaken: Array<{ loanId: string, loanStatus: LoanStatus, loanProvider: LoanProvider, principalScaled: string, currencySymbol: string | null, aprPercent: number | null, durationFormatted: string, maturityDate: string, startTime: string, collateralId: string, amountPaidToLenderScaled: string | null, loanRepaidDate: string | null, lender: { address: string } | null }> | null, loansMade: Array<{ loanId: string, loanStatus: LoanStatus, loanProvider: LoanProvider, principalScaled: string, currencySymbol: string | null, aprPercent: number | null, durationFormatted: string, maturityDate: string, startTime: string, collateralId: string, amountPaidToLenderScaled: string | null, loanRepaidDate: string | null, borrower: { address: string } }> | null, marketplaceOffersMade: Array<{ marketplaceId: string, tokenId: string, side: MarketplaceOrderSide, status: MarketplaceOrderStatus, price: string, symbol: EthereumCurrency }> | null, activity: Array<{ activity: ActivityType, source: ActivitySource, time: string, timestamp: number, network: string, tokenId: string | null, transactionHash: string | null, currencyAmount: string | null, currencyDecimals: number | null, currencySymbol: string | null, usdAmount: string | null, newValue: string | null }> };

export type GetWalletQueryVariables = Exact<{
  walletAddress: string;
  network: string;
  testnets: boolean;
  contractAddress: string;
}>;


export type GetWalletQuery = { wallet: { address: string, tokenCount: string, totalValue: string, totalAcres: string, totalCollateralValue: string, totalOutstandingLoansUSDC: string | null, propertyCountUnderLoan: string, user: { displayName: string, profilePath: string | null, avatarUrl: string | null }, creditHistory: { activeLoans: { loanCount: string, totalPrincipalValue: string, totalPaidValue: string, averageDurationDays: string }, defaultedLoans: { loanCount: string, totalPrincipalValue: string, totalPaidValue: string, averageDurationDays: string }, liquidatedLoans: { loanCount: string, totalPrincipalValue: string, totalPaidValue: string, averageDurationDays: string }, repaidLoans: { loanCount: string, totalPrincipalValue: string, totalPaidValue: string, averageDurationDays: string }, totalLoans: { loanCount: string, totalPrincipalValue: string, totalPaidValue: string, averageDurationDays: string }, tokens: { tokenCount: string, totalEstimatedValue: string } }, tokens: Array<{ tokenId: string, name: string | null, vanityName: string | null, acres: string | null, region: string | null, regionCode: string | null, district: string | null, estimatedValue: string, score: number | null, marketplacePrice: string | null, supplyUnderLoan: string }>, loansTaken: Array<{ loanId: string, loanStatus: LoanStatus, loanProvider: LoanProvider, principalScaled: string, currencySymbol: string | null, aprPercent: number | null, durationFormatted: string, maturityDate: string, startTime: string, collateralId: string, amountPaidToLenderScaled: string | null, loanRepaidDate: string | null, lender: { address: string } | null }> | null, loansMade: Array<{ loanId: string, loanStatus: LoanStatus, loanProvider: LoanProvider, principalScaled: string, currencySymbol: string | null, aprPercent: number | null, durationFormatted: string, maturityDate: string, startTime: string, collateralId: string, amountPaidToLenderScaled: string | null, loanRepaidDate: string | null, borrower: { address: string } }> | null, marketplaceOffersMade: Array<{ marketplaceId: string, tokenId: string, side: MarketplaceOrderSide, status: MarketplaceOrderStatus, price: string, symbol: EthereumCurrency }> | null, activity: Array<{ activity: ActivityType, source: ActivitySource, time: string, timestamp: number, network: string, tokenId: string | null, transactionHash: string | null, currencyAmount: string | null, currencyDecimals: number | null, currencySymbol: string | null, usdAmount: string | null, newValue: string | null }> } };

export type LoanFieldsFragment = { loanId: string, loanStatus: LoanStatus, loanProvider: LoanProvider, loanType: LoanType, loanContract: string, principalScaled: string, currencySymbol: string | null, aprPercent: number | null, interestForDurationPercent: number, durationFormatted: string, maturityDate: string, startTime: string, maxRepaymentScaled: string, collateralId: string, collateralContract: string, networkName: string, amountPaidToLenderScaled: string | null, loanRepaidDate: string | null, loanLiquidationDate: string | null, borrower: { address: string, user: { displayName: string } }, lender: { address: string, user: { displayName: string } } | null, token: { tokenId: string, name: string | null, acres: string | null, region: string | null, regionCode: string | null, district: string | null, estimatedValue: string } | null };

export type GetLoansQueryVariables = Exact<{
  network?: string | null | undefined;
  networkIn?: Array<string> | string | null | undefined;
  first?: number | null | undefined;
  skip?: number | null | undefined;
}>;


export type GetLoansQuery = { loans: Array<{ loanId: string, loanStatus: LoanStatus, loanProvider: LoanProvider, loanType: LoanType, loanContract: string, principalScaled: string, currencySymbol: string | null, aprPercent: number | null, interestForDurationPercent: number, durationFormatted: string, maturityDate: string, startTime: string, maxRepaymentScaled: string, collateralId: string, collateralContract: string, networkName: string, amountPaidToLenderScaled: string | null, loanRepaidDate: string | null, loanLiquidationDate: string | null, borrower: { address: string, user: { displayName: string } }, lender: { address: string, user: { displayName: string } } | null, token: { tokenId: string, name: string | null, acres: string | null, region: string | null, regionCode: string | null, district: string | null, estimatedValue: string } | null }> };

export type GetLoanStartedEventsQueryVariables = Exact<{
  first: number;
  skip: number;
  networkIn?: Array<string> | string | null | undefined;
}>;


export type GetLoanStartedEventsQuery = { loanStartedEvents: Array<{ loanId: string, borrower: string, lender: string | null, loanPrincipalAmount: string, loanDuration: string, loanStartTime: string, loanInterestRateForDurationInBasisPoints: number, loanProvider: LoanProvider, nftCollateralId: string, transactionHash: string, blockTimestamp: string }> };

export type GetLoanRepaidEventsQueryVariables = Exact<{
  first: number;
  skip: number;
  networkIn?: Array<string> | string | null | undefined;
}>;


export type GetLoanRepaidEventsQuery = { loanRepaidEvents: Array<{ loanId: string, borrower: string, lender: string | null, loanPrincipalAmount: string, amountPaidToLender: string, adminFee: string, nftCollateralId: string, transactionHash: string, blockTimestamp: string }> };

export type GetLoanLiquidatedEventsQueryVariables = Exact<{
  first: number;
  skip: number;
  networkIn?: Array<string> | string | null | undefined;
}>;


export type GetLoanLiquidatedEventsQuery = { loanLiquidatedEvents: Array<{ loanId: string, borrower: string, lender: string | null, loanPrincipalAmount: string, loanLiquidationDate: string, nftCollateralId: string, transactionHash: string, blockTimestamp: string }> };

export type GetCountyBoundsQueryVariables = Exact<{
  fips: string;
}>;


export type GetCountyBoundsQuery = { countyBounds: { geoJson: Record<string, unknown> } | null };

export type GetParcelIndexQueryVariables = Exact<{
  testnets?: boolean | null | undefined;
  contractAddress?: string | null | undefined;
}>;


export type GetParcelIndexQuery = { tokens: Array<{ tokenId: string, name: string | null, vanityName: string | null, slug: string, propertyLink: string, regionCode: string | null, district: string | null, place: string | null, coordinates: { lat: number, lon: number }, definition: { offchainRegistrar: { admin: string, propertyId: string } } | null }> };

export type GetNetworkActivityQueryVariables = Exact<{
  testnets?: boolean | null | undefined;
  contractAddress?: string | null | undefined;
}>;


export type GetNetworkActivityQuery = { tokens: Array<{ tokenId: string, name: string | null, vanityName: string | null, activity: Array<{ activity: ActivityType, source: ActivitySource, time: string, timestamp: number, network: string, tokenId: string | null, transactionHash: string | null, currencyAmount: string | null, currencyDecimals: number | null, currencySymbol: string | null, usdAmount: string | null, newValue: string | null }> }> };

export type GetPropertyLinkQueryVariables = Exact<{
  tokenId?: string | null | undefined;
  network?: string | null | undefined;
}>;


export type GetPropertyLinkQuery = { token: { propertyLink: string } };
