import { getSignedValuations, getTokenValuation, propertyLookupError } from "../clients/graphql.js";
import { MAINNET_WARNING } from "../config.js";
import {
  LENDING_POOL_NAME,
  describeAppraisalBlock,
  describeCapacityBlock,
  describeFailedCheck,
  describeSignedValuationReason,
  formatUsdc6,
  formatUsdcCeiling,
  formatValuationSource,
  unixToIso,
} from "../labels.js";
import type { PoolLendingLiquidityWithOracle, PoolLendingPoolValuation, SignedValuationPanel, ValuationPricing } from "../types/index.js";
import { formatUsd, shortenAddress } from "../format.js";
import { type ArgsOf, propertyRefInputs } from "./inputs.js";
import { APPRAISAL_RULE, collateralPriceUsd, describeAppraisalDerivation } from "./borrow-limits.js";

const ASSESSOR_SOURCE = "regrid-county-assessor";
/** Sources the API's `estimatedValue` is taken from: the lower of their land values when both exist. */
const ESTIMATE_SOURCES = new Set(["fabrica-avm", "prycd"]);

function parseAmount(value: string | null | undefined): number | null {
  const num = Number.parseFloat(value ?? "");
  return Number.isFinite(num) ? num : null;
}

/**
 * The API's estimate with the sources it matches. `estimatedValue` is the lower of the
 * Fabrica AVM and Prycd land values when both exist (confidence-gated); the matching land
 * rows are named so an agent can say where the number comes from.
 */
function describeEstimate(estimatedValue: string, pricing: ValuationPricing[]) {
  const value = parseAmount(estimatedValue);
  if (value === null || value <= 0) {
    return { value: null, basedOn: [], asOf: null, note: "The API holds no estimate for this property." };
  }
  const matches = pricing.filter(p => {
    const v = parseAmount(p.value);
    return ESTIMATE_SOURCES.has(p.source) && p.scope === "land" && v !== null && Math.abs(v - value) < 0.5;
  });
  return {
    value: formatUsd(estimatedValue),
    basedOn: matches.map(p => formatValuationSource(p.source)),
    asOf: matches[0]?.timestamp ?? null,
    note: matches.length > 0
      ? "The estimate is the lower of the Fabrica AVM and Prycd land values when both exist, after a confidence check."
      : "The estimate does not match a current source row; the API does not report how it was derived.",
  };
}

function sourceRow(p: ValuationPricing) {
  return {
    source: formatValuationSource(p.source),
    sourceId: p.source,
    scope: p.scope,
    value: formatUsd(p.value),
    currency: p.currency.toUpperCase(),
    confidence: p.confidence,
    asOf: p.timestamp,
    modelVersion: p.modelVersion || null,
    ...(p.value === null ? { note: p.source === "fabrica-avm"
      ? `The Fabrica AVM published no value for this scope${parseAmount(p.confidence) === 0 ? " (confidence 0)" : ""}. The API does not say why (for example no comparable sales, or the parcel outside the model's coverage), so the gap is not a judgment on the property.`
      : "This source published no value for this scope." } : {}),
  };
}

/** County assessor figures by scope, from the assessor rows of `pricing`. */
function describeAssessor(pricing: ValuationPricing[]) {
  const rows = pricing.filter(p => p.source === ASSESSOR_SOURCE);
  if (rows.length === 0) return null;
  const byScope = (scope: string) => formatUsd(rows.find(r => r.scope === scope)?.value);
  return {
    source: formatValuationSource(ASSESSOR_SOURCE),
    land: byScope("land"),
    improvements: byScope("improvements"),
    total: byScope("parcel"),
    lastSale: byScope("last sale"),
    asOf: rows[0].timestamp,
  };
}

function describeSignedValuations(panel: SignedValuationPanel | null, pricing: ValuationPricing[]) {
  if (!panel) {
    return { asOf: null, entries: [], note: "The signed valuation service did not answer; the other sections are unaffected." };
  }
  return {
    asOf: panel.asOf,
    note: `Each quote is the collateral price in USDC that the DeFi lending pool lends against. ${APPRAISAL_RULE}`,
    entries: panel.valuations.map(v => ({
      source: v.source,
      version: v.version,
      signer: v.signer,
      price: v.quote ? formatUsdc6(v.quote.price) : null,
      quotedAt: v.quote ? unixToIso(v.quote.timestamp) : null,
      validForSeconds: v.quote?.duration ?? null,
      signed: v.signature !== null,
      ...(v.reason ? { reason: describeSignedValuationReason(v.reason) } : {}),
      ...(v.quote && parseAmount(v.quote.price) === 0 ? { reason: "The API found no valid valuation for this source, so the quote is zero." } : {}),
      ...(v.quote ? { derivation: describeAppraisalDerivation((parseAmount(v.quote.price) ?? 0) / 1e6, pricing)?.derivation ?? null } : {}),
    })),
  };
}

/** One pool's oracle state in plain words: how it prices this token, and why it might not. */
export function describePoolOracle(pool: PoolLendingPoolValuation) {
  if (pool.pricing === "SignedQuote") {
    const quote = pool.oracleValuation?.quote ?? null;
    const notes: string[] = [];
    if (quote && parseAmount(quote.price) === 0) notes.push("The API found no valid valuation for this property, so the signed quote is zero and the pool refuses a loan.");
    if (pool.oracleValuation && pool.oracleValuation.signature === null) notes.push("The quote is for display only: the API does not sign it, and the pool refuses unsigned quotes.");
    return {
      pool: shortenAddress(pool.address),
      pricing: "Signed quote from the Fabrica API",
      quotePrice: quote ? formatUsdc6(quote.price) : null,
      quotedAt: quote ? unixToIso(quote.timestamp) : null,
      signed: pool.oracleValuation ? pool.oracleValuation.signature !== null : false,
      ...(notes.length > 0 ? { notes } : {}),
    };
  }
  const feed = pool.oracleFeed;
  const source = pool.onchainPrice;
  const valuation = pool.onchainValuation;
  const cycle = parseAmount(source?.cycle);
  const minValid = parseAmount(feed?.minValidCycle);
  return {
    pool: shortenAddress(pool.address),
    pricing: "Onchain price oracle",
    feed: feed ? {
      stale: feed.isStale,
      lastHeartbeat: unixToIso(feed.lastHeartbeat),
      maxSilenceSeconds: parseAmount(feed.maxSilence),
      currentCycle: feed.currentCycle,
      ...(feed.indexerUnavailableReason ? { note: "The indexer could not be read, so the heartbeat, cycle and source price may be missing; the oracle's live verdict is unaffected." } : {}),
    } : null,
    sourcePrice: source ? {
      price: formatUsdc6(source.priceUsdc6),
      confidence: source.confidenceScore !== null ? `${(source.confidenceScore / 100).toFixed(1)}%` : null,
      valuedAt: unixToIso(source.valuedAt),
      cycle: source.cycle,
      invalidated: cycle !== null && minValid !== null && cycle < minValid,
    } : null,
    usablePrice: formatUsdc6(valuation?.usablePriceUsdc6),
    failedCheck: valuation?.failedCheck ?? null,
    failedCheckReason: describeFailedCheck(valuation?.failedCheck),
    capacityBlock: describeCapacityBlock(valuation?.capacityBlockReason),
  };
}

/**
 * Plain-word reasons a property shows no pool borrowing capacity, from the appraisal block
 * and each pool's oracle state. Empty when the API states no specific reason.
 */
export function zeroCapacityReasons(liquidity: PoolLendingLiquidityWithOracle | null | undefined): string[] {
  if (!liquidity) return [];
  const reasons: string[] = [];
  const appraisal = describeAppraisalBlock(liquidity.appraisalBlockReason);
  if (appraisal) reasons.push(appraisal);
  for (const pool of liquidity.pools ?? []) {
    const described = describePoolOracle(pool);
    if ("notes" in described && described.notes) reasons.push(...described.notes);
    if ("failedCheckReason" in described && described.failedCheckReason) reasons.push(described.failedCheckReason);
    if ("capacityBlock" in described && described.capacityBlock) reasons.push(described.capacityBlock);
    if ("feed" in described && described.feed?.stale && !described.failedCheckReason) reasons.push("The price feed is stale.");
  }
  return [...new Set(reasons)];
}

export const getValuationInput = propertyRefInputs;
export type GetValuationArgs = ArgsOf<typeof getValuationInput>;

export async function getValuation(args: GetValuationArgs) {
  const { tokenId, slug } = args;
  if (!tokenId && !slug) {
    return { error: "Either tokenId or slug is required" };
  }
  try {
    const [token, earlyPanel] = await Promise.all([
      getTokenValuation({ tokenId, slug }),
      tokenId ? getSignedValuations(tokenId) : Promise.resolve(null),
    ]);
    if (!token) {
      return { error: `No property found with ${tokenId ? `token ID ${tokenId}` : `slug ${slug}`}` };
    }
    const panel = tokenId ? earlyPanel : await getSignedValuations(token.tokenId);
    const liquidity = token.poolLendingLiquidity;
    const maxBorrow = parseAmount(liquidity?.maxPrincipalScaled) ?? 0;
    return {
      ...(MAINNET_WARNING ? { legalNotice: MAINNET_WARNING } : {}),
      tokenId: token.tokenId,
      name: token.name ?? token.vanityName,
      isPremint: token.isPremint,
      estimate: describeEstimate(token.estimatedValue, token.pricing),
      cardDisplayValuation: formatUsd(token.cardDisplayValuation),
      sources: token.pricing.filter(p => p.source !== ASSESSOR_SOURCE).map(sourceRow),
      assessor: describeAssessor(token.pricing),
      signedValuations: describeSignedValuations(panel, token.pricing),
      oracle: liquidity ? {
        lendingPool: LENDING_POOL_NAME,
        maxBorrow: maxBorrow > 0 ? formatUsdcCeiling(liquidity.maxPrincipalScaled) : null,
        appraisalBlock: describeAppraisalBlock(liquidity.appraisalBlockReason),
        pools: (liquidity.pools ?? []).map(p => {
          // Only a signed quote is the API's appraisal; an onchain oracle price comes from the aggregator.
          const appraisal = p.pricing === "SignedQuote" ? describeAppraisalDerivation(collateralPriceUsd(p), token.pricing) : null;
          return { ...describePoolOracle(p), ...(appraisal ? { appraisal } : {}) };
        }),
        ...(maxBorrow > 0 ? {} : { noCapacityReasons: zeroCapacityReasons(liquidity) }),
      } : null,
      reportUrl: token.valuationReportUrl,
      note: "Each value is shown with its source and date as the API holds it. None is an offer or a price suggestion.",
    };
  } catch (e) {
    return { error: propertyLookupError(e, { tokenId, slug }, "get valuation") };
  }
}
