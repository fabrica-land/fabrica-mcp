import { getTokens, getToken, getCountyBounds, getPremintSuccessor, isTokenNotFound, DEFAULT_MIN_SCORE, filterSpamTokens, propertyLookupError } from "../clients/graphql.js";
import type { TokenModel } from "../types/index.js";
import { NETWORK_LABEL, MAINNET_WARNING, IS_MAINNET, CONTRACTS } from "../config.js";
import { LENDING_POOL_NAME, formatActivityAmount, formatActivitySource, formatLoanProvider, formatUsdcCeiling } from "../labels.js";
import { propertyPhotos, propertyMapImage, toGatewayUrl } from "./media.js";
import { estimateFields, formatTokenAmount, sortLoans, formatUsd, shortenAddress, capList } from "../format.js";
import { locationLink, stateCode, stateName } from "../links.js";
import { propertyStage, describeStage } from "../lifecycle.js";
import { summarizeFees } from "../fees.js";
import { loadTaxSignals, taxSummary } from "./tax.js";
import { countChecks, getRecoveryStatus } from "./scoring.js";
import { isLiveOrder } from "./marketplace.js";

/** USD when the API supplies a USD price; otherwise the native amount and currency, never a guessed "$". */
function formatOrderPrice(usdPrice: string | null, price: string | null, symbol: string | null): string | null {
  const usd = formatUsd(usdPrice);
  if (usd) return usd;
  return price ? `${price} ${symbol ?? ""}`.trim() : null;
}

function tokenToSummary(token: TokenModel) {
  const hasLoan = parseInt(token.supplyUnderLoan || "0") > 0;
  return {
    tokenId: token.tokenId,
    name: token.name ?? token.vanityName,
    location: {
      state: token.regionCode,
      county: token.district,
      place: token.place,
      coordinates: token.coordinates ? [token.coordinates.lat, token.coordinates.lon] : null,
    },
    acres: token.acres ? parseFloat(token.acres) : null,
    confidenceScore: token.score,
    ...estimateFields(token.estimatedValue),
    hasActiveListing: token.marketplacePrice !== null,
    listingPrice: token.marketplacePrice ? formatUsd(token.marketplacePrice) : null,
    hasActiveLoan: hasLoan,
    stage: propertyStage(token),
    owner: shortenAddress(token.majorityOwnerAddress),
    propertyLink: token.propertyLink,
  };
}

/** "Mohave County", "mohave county", "Mohave" → "mohave". */
export function normalizeCounty(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase().replace(/\s+/g, " ").replace(/ county$/, "");
}

/** The name most tokens give for a field, ignoring blanks. */
function mostCommon(values: ReadonlyArray<string | null | undefined>): string | null {
  const counts = new Map<string, number>();
  for (const v of values) {
    const name = v?.trim();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [name, count] of counts) {
    if (best === null || count > (counts.get(best) ?? 0)) best = name;
  }
  return best;
}

export type GroupBy = "state" | "county";

/** The state or state|county a token groups under; null when the record lacks that location. */
function groupKey(t: TokenModel, groupBy: GroupBy): string | null {
  const state = t.regionCode?.trim().toUpperCase() ?? "";
  if (!state) return null;
  if (groupBy === "state") return state;
  const county = normalizeCounty(t.district);
  return county ? `${state}|${county}` : null;
}

/** Tokens a grouping leaves out because the API gives them no state (or no county, by county). */
export function ungroupedCount(tokens: ReadonlyArray<TokenModel>, groupBy: GroupBy): number {
  return tokens.filter(t => groupKey(t, groupBy) === null).length;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalGroupBy(value: unknown): GroupBy | undefined {
  return value === "state" || value === "county" ? value : undefined;
}

/** One row per state or county: counts, acres and the fabrica.land location page. */
export function groupTokens(tokens: ReadonlyArray<TokenModel>, groupBy: GroupBy) {
  const groups = new Map<string, TokenModel[]>();
  for (const t of tokens) {
    // A record with no state (or no county, by county) is not a location; ungroupedCount reports it.
    const key = groupKey(t, groupBy);
    if (key === null) continue;
    const members = groups.get(key);
    if (members) members.push(t);
    else groups.set(key, [t]);
  }
  return [...groups.values()].map(members => {
    const fullState = mostCommon(members.map(t => t.region)) ?? stateName(members[0].regionCode);
    const county = groupBy === "county" ? mostCommon(members.map(t => t.district)) : null;
    const acres = members.reduce((sum, t) => sum + (Number.parseFloat(t.acres ?? "") || 0), 0);
    return {
      state: members[0].regionCode,
      ...(groupBy === "county" ? { county } : {}),
      properties: members.length,
      forSale: members.filter(t => t.marketplacePrice !== null).length,
      totalAcres: Math.round(acres * 100) / 100,
      locationLink: locationLink({ state: fullState, county }),
    };
  }).sort((a, b) => b.properties - a.properties || String(a.county ?? a.state).localeCompare(String(b.county ?? b.state)));
}

export async function searchProperties(args: Record<string, unknown>) {
  const region = args.region as string | undefined;
  const county = optionalString(args.county);
  const groupBy = optionalGroupBy(args.groupBy);
  const minAcres = args.minAcres as number | undefined;
  const maxAcres = args.maxAcres as number | undefined;
  const minScore = args.minScore as number | undefined;
  const hasListings = args.hasListings as boolean | undefined;
  const hasLoans = args.hasLoans as boolean | undefined;
  const ownedBy = args.ownedBy as string | undefined;
  const limit = Math.min(Math.max(Math.trunc((args.limit as number | undefined) ?? 20), 1), 100);
  const offset = Math.max(Math.trunc((args.offset as number | undefined) ?? 0), 0);
  try {
    let tokens = await getTokens({
      // Like the frontend: public listings use the marketplace threshold, while one
      // wallet's own properties are listed in full unless the caller sets a minimum.
      minScore: minScore ?? (ownedBy ? undefined : DEFAULT_MIN_SCORE),
      hasListings: hasListings ?? undefined,
      ownedBy,
      burned: false,
      premints: false,
      testnets: IS_MAINNET ? false : true,
      contractAddress: IS_MAINNET ? undefined : CONTRACTS.fabricaToken,
    });
    tokens = filterSpamTokens(tokens);
    const regionCode = region ? stateCode(region) : null;
    if (region) {
      const upper = regionCode ?? region.toUpperCase();
      tokens = tokens.filter(t => t.regionCode?.toUpperCase() === upper);
    }
    if (county) {
      const wanted = normalizeCounty(county);
      tokens = tokens.filter(t => normalizeCounty(t.district) === wanted);
    }
    // The location page is named from the region/county matches, before other filters can empty the list.
    const locationTokens = tokens;
    if (minAcres !== undefined) {
      tokens = tokens.filter(t => t.acres !== null && parseFloat(t.acres) >= minAcres);
    }
    if (maxAcres !== undefined) {
      tokens = tokens.filter(t => t.acres !== null && parseFloat(t.acres) <= maxAcres);
    }
    if (hasLoans) {
      tokens = tokens.filter(t => parseInt(t.supplyUnderLoan || "0") > 0);
    }
    const total = tokens.length;
    // The page for the location asked about: names as the matches spell them, else from the filter.
    const states = new Set(locationTokens.map(t => t.regionCode?.toUpperCase()));
    const counties = new Set(locationTokens.map(t => normalizeCounty(t.district)));
    const linkState = region ? stateName(regionCode ?? region) ?? mostCommon(locationTokens.map(t => t.region)) : states.size === 1 ? mostCommon(locationTokens.map(t => t.region)) ?? stateName([...states][0]) : null;
    const linkCounty = county ? mostCommon(locationTokens.map(t => t.district)) ?? `${county.trim().replace(/\s+county$/i, "")} County` : null;
    const link = (region || county) && linkState && (!county || counties.size <= 1)
      ? { locationLink: locationLink({ state: linkState, county: linkCounty }) }
      : {};
    if (groupBy) {
      const groups = groupTokens(tokens, groupBy);
      const groupPage = groups.slice(offset, offset + limit);
      const ungrouped = ungroupedCount(tokens, groupBy);
      return {
        network: NETWORK_LABEL,
        ...(MAINNET_WARNING ? { legalNotice: MAINNET_WARNING } : {}),
        total,
        ...link,
        groupBy,
        totalGroups: groups.length,
        showing: groupPage.length > 0 ? `${offset + 1}-${offset + groupPage.length} of ${groups.length}` : `none: offset ${offset} is past the last of ${groups.length} groups`,
        groups: groupPage,
        ...(ungrouped > 0 ? { ungroupedCount: ungrouped, ungroupedNote: `${ungrouped} matching ${ungrouped === 1 ? "property has" : "properties have"} no ${groupBy === "county" ? "state or county" : "state"} in the record and ${ungrouped === 1 ? "is" : "are"} not in any group.` } : {}),
      };
    }
    const page = tokens.slice(offset, offset + limit);
    if (page.length === 0) {
      return {
        network: NETWORK_LABEL,
        ...(MAINNET_WARNING ? { legalNotice: MAINNET_WARNING } : {}),
        total,
        ...link,
        properties: [],
        message: total > 0
          ? `No more results: ${total} properties match, and offset ${offset} is past the end.`
          : region && !regionCode
            ? `No properties found: "${region}" is not a US state code or state name. Pass a two-letter code such as "NV" or a name such as "Nevada".`
            : "No properties found matching your filters.",
      };
    }
    return {
      network: NETWORK_LABEL,
      ...(MAINNET_WARNING ? { legalNotice: MAINNET_WARNING } : {}),
      total,
      ...link,
      showing: `${offset + 1}-${offset + page.length} of ${total}`,
      properties: page.map(tokenToSummary),
    };
  } catch (e) {
    return { error: `Failed to search properties: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** get_property keeps its response bounded: holders and orders beyond these are counted, not listed. */
const MAX_HOLDERS = 25;
const MAX_ORDERS = 20;

/**
 * A premint that was replaced by a minted token no longer loads by its old ID; the API
 * answers "No token or premint found". Follow it to the live successor, as the web app
 * does for an old link.
 */
async function getTokenOrSuccessor(tokenId: string | undefined, slug: string | undefined): Promise<{ token: TokenModel | null; replacedPremintTokenId: string | null }> {
  try {
    return { token: await getToken({ tokenId, slug }), replacedPremintTokenId: null };
  } catch (e) {
    if (!tokenId || !isTokenNotFound(e)) throw e;
    const successorId = await getPremintSuccessor(tokenId);
    if (!successorId) throw e;
    return { token: await getToken({ tokenId: successorId }), replacedPremintTokenId: tokenId };
  }
}

function lifecycleOf(token: TokenModel, replacedPremintTokenId: string | null) {
  const stage = propertyStage(token);
  return {
    stage,
    description: describeStage(stage),
    ...(token.claimState ? { claimState: token.claimState } : {}),
    ...(token.supersededByTokenId ? { successorTokenId: token.supersededByTokenId } : {}),
    ...(replacedPremintTokenId ? { replacesPremintTokenId: replacedPremintTokenId, note: `Token ${replacedPremintTokenId} was a premint that has been replaced by this minted token.` } : {}),
    ...(token.offRampStatus ? { offRampStatus: token.offRampStatus } : {}),
  };
}

function flagsOf(token: TokenModel): string[] {
  const flags: string[] = [];
  const duplicates = token.duplicateParcelCount ?? 0;
  if (duplicates > 0) {
    flags.push(duplicates === 1
      ? "Another token on Fabrica claims the same parcel (same county APN and holding trust)."
      : `${duplicates} other tokens on Fabrica claim the same parcel (same county APN and holding trust).`);
  }
  if (token.fishy) {
    flags.push("The Fabrica marketplace does not sell this property: its Property checks are below the marketplace threshold, or its proof of title is not verified.");
  }
  return flags;
}

export async function getProperty(args: Record<string, unknown>) {
  const tokenId = args.tokenId as string | undefined;
  const slug = args.slug as string | undefined;
  if (!tokenId && !slug) {
    return { error: "Either tokenId or slug is required" };
  }
  try {
    const { token, replacedPremintTokenId } = await getTokenOrSuccessor(tokenId, slug);
    if (!token) {
      return { error: `No property found with ${tokenId ? `token ID ${tokenId}` : `slug ${slug}`}` };
    }
    // Live as get_order_book counts it: active, encumbered or pending, and not past its end time.
    const now = Date.now();
    // Buyable listings first (stable otherwise), so the cap never hides the one a buyer can act on.
    const activeListings = (token.marketplaceListings?.filter(l => isLiveOrder(l, now)) ?? [])
      .sort((a, b) => Number(a.encumbrance?.buyable === false) - Number(b.encumbrance?.buyable === false));
    const activeBids = token.marketplaceBids?.filter(b => isLiveOrder(b, now)) ?? [];
    const activeLoans = token.loans?.filter(l => l.loanStatus === "Active") ?? [];
    const holders = capList(token.balances ?? [], MAX_HOLDERS);
    const listings = capList(activeListings, MAX_ORDERS);
    const bids = capList(activeBids, MAX_ORDERS);
    const recovery = getRecoveryStatus(token.score);
    const fees = summarizeFees(token.fees, token.propertyLink);
    const flags = flagsOf(token);
    const warnings: string[] = [];
    if (recovery && recovery.value !== 7) {
      warnings.push(`Recovery status: ${recovery.label}: ${recovery.meaning}. Sales and loans are paused until it is Normal.`);
    }
    if (parseInt(token.supplyLiquidating || "0") > 0) {
      warnings.push("Property has supply currently in liquidation");
    }
    if (parseInt(token.supplyInDefault || "0") > 0) {
      warnings.push("Property has supply currently in default");
    }
    const tax = await loadTaxSignals(token);
    const checkResults = token.scoringCheckResults?.map(s => ({ check: s.title, group: s.group, passed: s.value })) ?? [];
    warnings.push(...tax.warnings);
    return {
      ...(MAINNET_WARNING ? { legalNotice: MAINNET_WARNING } : {}),
      tokenId: token.tokenId,
      network: token.network,
      contractAddress: token.contractAddress,
      name: token.name ?? token.vanityName,
      propertyLink: token.propertyLink,
      isPremint: token.isPremint,
      lifecycle: lifecycleOf(token, replacedPremintTokenId),
      ...(fees ? { fees } : {}),
      ...(flags.length > 0 ? { flags } : {}),
      recoveryStatus: recovery ? { value: recovery.value, label: recovery.label } : null,
      ...(warnings.length > 0 ? { warnings } : {}),
      location: {
        address: token.address,
        street: token.street,
        place: token.place,
        district: token.district,
        region: token.region,
        regionCode: token.regionCode,
        postCode: token.postCode,
        country: token.country,
        coordinates: token.coordinates ? { lat: token.coordinates.lat, lon: token.coordinates.lon } : null,
      },
      acres: token.acres ? parseFloat(token.acres) : null,
      propertyChecks: {
        ...countChecks(checkResults),
        encoding: token.score,
        results: checkResults,
        about: "Property checks are a starting point for your own research, not a title search or title insurance. encoding is their 5-digit numeric encoding (explain_confidence_score decodes it).",
      },
      taxes: {
        status: tax.status,
        summary: taxSummary(tax.status, tax.checkedAt, token.isPremint, tax),
        checkedAt: tax.checkedAt,
        details: "get_tax_status",
      },
      legal: {
        description: token.definition?.claim ?? null,
        holdingEntity: token.definition?.holdingEntity ?? null,
        // The agreement text is long (about 150 KB); get_trust_documents returns it on request.
        operatingAgreement: token.operatingAgreementUrl ? toGatewayUrl(token.operatingAgreementUrl) ?? token.operatingAgreementUrl : null,
        operatingAgreementName: token.operatingAgreementName,
        registrar: token.definition?.offchainRegistrar ?? null,
        proofOfTitle: token.configuration?.proofOfTitle ?? null,
      },
      valuation: {
        ...estimateFields(token.estimatedValue, token.pricing),
        displayValuation: formatUsd(token.cardDisplayValuation) ?? token.cardDisplayValuation,
        // Deprecated aliases of propertyChecks.encoding and propertyChecks.results, kept for one
        // release; the valuation's own confidence (pricing[].confidence) is a different signal.
        confidenceScore: token.score,
        scoreBreakdown: checkResults,
        pricing: token.pricing.map(p => ({
          source: p.source,
          scope: p.scope,
          asOf: p.timestamp,
          value: formatUsd(p.value),
          currency: p.currency,
          confidence: p.confidence,
        })),
      },
      ownership: {
        owner: token.majorityOwnerAddress,
        ownerName: token.majorityOwner?.displayName ?? null,
        supply: parseInt(token.supply),
        isFractionalized: parseInt(token.supply) > 1,
        supplyUnderLoan: parseInt(token.supplyUnderLoan),
        holders: holders.items.map(b => ({
          address: b.holder.address,
          balance: b.balance,
        })),
        ...(holders.truncated ? { holdersNote: `The first ${MAX_HOLDERS} of ${holders.total} holders.` } : {}),
      },
      lending: {
        activeLoans: sortLoans(activeLoans).map(l => ({
          loanId: l.loanId,
          provider: formatLoanProvider(l.loanProvider),
          principal: formatTokenAmount(l.principalScaled, l.currencySymbol),
          apr: l.aprPercent !== null ? `${l.aprPercent.toFixed(1)}%` : null,
          duration: l.durationFormatted,
          maturityDate: l.maturityDate,
          borrower: shortenAddress(l.borrower?.address),
          lender: shortenAddress(l.lender?.address),
        })),
        lendingPoolLiquidity: token.poolLendingLiquidity ? {
          name: LENDING_POOL_NAME,
          maxPrincipal: formatUsdcCeiling(token.poolLendingLiquidity.maxPrincipalScaled),
          hasActiveLoan: token.poolLendingLiquidity.activeLoan !== null,
        } : null,
      },
      marketplace: {
        listingCount: listings.total,
        offerCount: bids.total,
        ...(listings.truncated || bids.truncated ? { note: `Up to ${MAX_ORDERS} listings and ${MAX_ORDERS} offers are shown; ${listings.total} active listings and ${bids.total} active offers in all.` } : {}),
        listings: listings.items.map(l => ({
          price: formatOrderPrice(l.usdPrice, l.price, l.symbol),
          symbol: l.symbol,
          expiresAt: l.endTime,
          seller: shortenAddress(l.makerAddress),
          // An encumbered listing the loan blocks still shows, but cannot be bought now.
          buyable: l.encumbrance?.buyable !== false,
        })),
        bids: bids.items.map(b => ({
          price: formatOrderPrice(b.usdPrice, b.price, b.symbol),
          symbol: b.symbol,
          bidder: shortenAddress(b.makerAddress),
        })),
      },
      media: {
        imageLight: token.imageUrlLight,
        imageDark: token.imageUrlDark,
        userDescription: token.configuration?.userDescription ?? null,
        mapImage: propertyMapImage(token.contractAddress, token.tokenId),
        photos: propertyPhotos(token.configuration?.media),
      },
      recentActivity: token.activity?.slice(0, 10).map(a => ({
        type: a.activity,
        source: formatActivitySource(a.source),
        time: a.time,
        amount: formatActivityAmount(a),
        txHash: a.transactionHash,
      })) ?? [],
      mintedAt: token.mintedAt,
    };
  } catch (e) {
    return { error: propertyLookupError(e, { tokenId, slug }, "get property") };
  }
}

export async function getPropertyMap(args: Record<string, unknown>) {
  const tokenId = args.tokenId as string | undefined;
  const slug = args.slug as string | undefined;
  const includeCountyBounds = (args.includeCountyBounds as boolean | undefined) ?? false;
  if (!tokenId && !slug) {
    return { error: "Either tokenId or slug is required" };
  }
  try {
    const token = await getToken({ tokenId, slug });
    if (!token) {
      return { error: `No property found with ${tokenId ? `token ID ${tokenId}` : `slug ${slug}`}` };
    }
    const propertyGeoJson = token.geoJson ?? token.definition?.geoJson ?? null;
    const features: Record<string, unknown>[] = [];
    if (propertyGeoJson) {
      features.push({
        type: "Feature",
        properties: {
          type: "property",
          tokenId: token.tokenId,
          name: token.name ?? token.vanityName,
          acres: token.acres ? parseFloat(token.acres) : null,
        },
        geometry: propertyGeoJson,
      });
    } else if (token.coordinates) {
      features.push({
        type: "Feature",
        properties: {
          type: "property",
          tokenId: token.tokenId,
          name: token.name ?? token.vanityName,
          acres: token.acres ? parseFloat(token.acres) : null,
          note: "Boundary polygon not available; showing point location",
        },
        geometry: {
          type: "Point",
          coordinates: [token.coordinates.lon, token.coordinates.lat],
        },
      });
    }
    const warnings: string[] = [];
    if (includeCountyBounds && token.definition?.offchainRegistrar?.propertyId) {
      const fips = token.definition.offchainRegistrar.propertyId.slice(0, 5);
      if (fips && /^\d{5}$/.test(fips)) {
        // The county outline is a decorative extra layer, so a failure here degrades the
        // map rather than failing the call — but it is reported, never swallowed.
        try {
          const countyData = await getCountyBounds(fips);
          if (countyData?.geoJson) {
            features.push({
              type: "Feature",
              properties: {
                type: "county",
                name: token.district,
                fips,
              },
              geometry: countyData.geoJson,
            });
          }
        } catch (e) {
          warnings.push(`County outline for FIPS ${fips} unavailable: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    if (features.length === 0) {
      return {
        tokenId: token.tokenId,
        message: "No geographic data available for this property",
        coordinates: token.coordinates ? { lat: token.coordinates.lat, lon: token.coordinates.lon } : null,
      };
    }
    return {
      type: "FeatureCollection",
      features,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (e) {
    return { error: propertyLookupError(e, { tokenId, slug }, "get property map") };
  }
}
