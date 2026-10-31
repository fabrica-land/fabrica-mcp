import { getTokens, getToken, getCountyBounds, getPremintSuccessor, isTokenNotFound, DEFAULT_MIN_SCORE, filterSpamTokens, propertyLookupError } from "../clients/graphql.js";
import type { TokenListItem, TokenModel } from "../types/index.js";
import { NETWORK_LABEL, MAINNET_WARNING, IS_MAINNET, CONTRACTS } from "../config.js";
import { LENDING_POOL_NAME, formatLoanProvider, formatUsdcCeiling } from "../labels.js";
import { propertyPhotos, propertyMapImage, toGatewayUrl } from "./media.js";
import { estimateFields, formatTokenAmount, sortLoans, formatUsd, shortenAddress, capList } from "../format.js";
import { locationLink, stateCode, stateName } from "../links.js";
import { haversineMiles } from "../geo.js";
import { propertyStage, describeStage } from "../lifecycle.js";
import { summarizeFees } from "../fees.js";
import { loadTaxSignals, taxSummary } from "./tax.js";
import { countChecks, getRecoveryStatus } from "./scoring.js";
import { isLiveOrder } from "./marketplace.js";
import { formatActivity, previousScores } from "./activity.js";
import type { ActivityModel } from "../types/index.js";
import { z } from "zod";
import { type ArgsOf, propertyRefInputs } from "./inputs.js";

/** USD when the API supplies a USD price; otherwise the native amount and currency, never a guessed "$". */
function formatOrderPrice(usdPrice: string | null, price: string | null, symbol: string | null): string | null {
  const usd = formatUsd(usdPrice);
  if (usd) return usd;
  return price ? `${price} ${symbol ?? ""}`.trim() : null;
}

/** Listing price in dollars, or null when the property is not listed. */
function listingPriceUsd(token: TokenListItem): number | null {
  const value = Number.parseFloat(token.marketplacePrice ?? "");
  return Number.isFinite(value) ? value : null;
}

function acresOf(token: TokenListItem): number | null {
  const value = Number.parseFloat(token.acres ?? "");
  return Number.isFinite(value) && value > 0 ? value : null;
}

function estimatedValueUsd(token: TokenListItem): number | null {
  const value = Number.parseFloat(token.estimatedValue ?? "");
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Dollars per acre: the listing price over the acres when the property is listed, else
 * the estimated value over the acres. `basis` says which, so the two are never compared
 * as if they were the same number.
 */
export function pricePerAcre(token: TokenListItem): { pricePerAcre: number; basis: "listing" | "estimate" } | null {
  const acres = acresOf(token);
  if (acres === null) return null;
  const listing = listingPriceUsd(token);
  if (listing !== null) return { pricePerAcre: Math.round(listing / acres), basis: "listing" };
  const estimate = estimatedValueUsd(token);
  if (estimate !== null) return { pricePerAcre: Math.round(estimate / acres), basis: "estimate" };
  return null;
}

/** Listing dollars per acre only; null for an unlisted property (the price filters never read the estimate). */
function listingPricePerAcre(token: TokenListItem): number | null {
  const acres = acresOf(token);
  const listing = listingPriceUsd(token);
  return acres !== null && listing !== null ? listing / acres : null;
}

function distanceMiles(token: TokenListItem, from: { lat: number; lon: number }): number | null {
  return token.coordinates ? Math.round(haversineMiles(from, token.coordinates) * 10) / 10 : null;
}

function tokenToSummary(token: TokenListItem, near?: { lat: number; lon: number }) {
  const hasLoan = parseInt(token.supplyUnderLoan || "0") > 0;
  const perAcre = pricePerAcre(token);
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
    ...(perAcre ? { pricePerAcre: formatUsd(String(perAcre.pricePerAcre)), pricePerAcreBasis: perAcre.basis } : {}),
    ...(near ? { distanceMiles: distanceMiles(token, near) } : {}),
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
function groupKey(t: TokenListItem, groupBy: GroupBy): string | null {
  const state = t.regionCode?.trim().toUpperCase() ?? "";
  if (!state) return null;
  if (groupBy === "state") return state;
  const county = normalizeCounty(t.district);
  return county ? `${state}|${county}` : null;
}

/** Tokens a grouping leaves out because the API gives them no state (or no county, by county). */
export function ungroupedCount(tokens: ReadonlyArray<TokenListItem>, groupBy: GroupBy): number {
  return tokens.filter(t => groupKey(t, groupBy) === null).length;
}

/** One row per state or county: counts, acres and the fabrica.land location page. */
export function groupTokens(tokens: ReadonlyArray<TokenListItem>, groupBy: GroupBy) {
  const groups = new Map<string, TokenListItem[]>();
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

export const searchPropertiesInput = {
  region: z.string().optional().describe("US state code (e.g. 'TX', 'CA', 'NV')"),
  county: z.string().optional().describe("County name, case-insensitive, the 'County' suffix optional (e.g. 'Costilla' or 'Mohave County'). Combine with region when the name exists in more than one state."),
  groupBy: z.enum(["state", "county"]).optional().describe("Return one row per state or county (property count, count for sale, total acres, location page link) instead of property rows. limit and offset page through the groups."),
  minAcres: z.number().min(0).optional().describe("Minimum parcel size in acres"),
  maxAcres: z.number().min(0).optional().describe("Maximum parcel size in acres"),
  minScore: z.number().int().min(0).optional().describe("Minimum Property checks number: the 5-digit numeric encoding of Property checks, an integer. Defaults to 72032, the marketplace threshold, except when ownedBy is set (then every property in that wallet is listed). Any minimum also requires a verified deed. Max: 75342."),
  hasListings: z.boolean().optional().describe("Only show properties with active sale listings"),
  hasLoans: z.boolean().optional().describe("Only show properties with active loans"),
  ownedBy: z.string().optional().describe("Filter by owner wallet address"),
  minPrice: z.number().min(0).optional().describe("Minimum listing price in USD. Only listed properties match any price filter."),
  maxPrice: z.number().min(0).optional().describe("Maximum listing price in USD. Only listed properties match any price filter."),
  minPricePerAcre: z.number().min(0).optional().describe("Minimum listing price per acre in USD (listing price over acres; unlisted properties never match)."),
  maxPricePerAcre: z.number().min(0).optional().describe("Maximum listing price per acre in USD (listing price over acres; unlisted properties never match)."),
  near: z.object({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    radiusMiles: z.number().positive().max(3000).optional().describe("Keep only properties within this many miles of the point (default: no limit, every row gets its distance)."),
  }).optional().describe("A point to measure distance from, in decimal degrees. Each row then carries distanceMiles (straight-line), and the default sort is by distance."),
  sortBy: z.enum(["price", "pricePerAcre", "acres", "estimatedValue", "score", "newest", "distance"]).optional().describe("Order of the rows. price and pricePerAcre use the listing price and put unlisted properties last; newest is by the date the property was added; distance needs near. Default: the API's order, or distance when near is set."),
  sortDir: z.enum(["asc", "desc"]).optional().describe("asc (default) or desc. newest is always most recent first."),
  limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20, max 100)"),
  offset: z.number().int().min(0).optional().describe("Pagination offset"),
};
export type SearchPropertiesArgs = ArgsOf<typeof searchPropertiesInput>;

type SortKey = NonNullable<SearchPropertiesArgs["sortBy"]>;

/** The number a sort key reads from a row; null rows go last whatever the direction. */
function sortValue(token: TokenListItem, key: SortKey, near?: { lat: number; lon: number }): number | null {
  switch (key) {
    case "price": return listingPriceUsd(token);
    case "pricePerAcre": return listingPricePerAcre(token);
    case "acres": return acresOf(token);
    case "estimatedValue": return estimatedValueUsd(token);
    case "score": return token.score;
    case "newest": {
      const time = Date.parse(token.mintedAt ?? "");
      return Number.isFinite(time) ? time : null;
    }
    case "distance": return near && token.coordinates ? haversineMiles(near, token.coordinates) : null;
  }
}

/** Stable sort by one key; rows without a value for the key keep their order at the end. */
export function sortTokens(tokens: TokenListItem[], key: SortKey, dir: "asc" | "desc", near?: { lat: number; lon: number }): TokenListItem[] {
  const sign = dir === "desc" ? -1 : 1;
  return tokens
    .map((token, index) => ({ token, index, value: sortValue(token, key, near) }))
    .sort((a, b) => {
      if (a.value === null && b.value === null) return a.index - b.index;
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      return sign * (a.value - b.value) || a.index - b.index;
    })
    .map(row => row.token);
}

export async function searchProperties(args: SearchPropertiesArgs) {
  const region = args.region;
  const county = args.county?.trim() ? args.county : undefined;
  const groupBy = args.groupBy;
  const { minAcres, maxAcres, minScore, hasListings, hasLoans, ownedBy, minPrice, maxPrice, minPricePerAcre, maxPricePerAcre, near } = args;
  const priceFiltered = [minPrice, maxPrice, minPricePerAcre, maxPricePerAcre].some(v => v !== undefined);
  const sortBy: SortKey | undefined = args.sortBy ?? (near ? "distance" : undefined);
  const sortDir: "asc" | "desc" = sortBy === "newest" ? "desc" : args.sortDir ?? "asc";
  const limit = Math.min(Math.max(Math.trunc(args.limit ?? 20), 1), 100);
  const offset = Math.max(Math.trunc(args.offset ?? 0), 0);
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
    if (priceFiltered) {
      tokens = tokens.filter(t => {
        const price = listingPriceUsd(t);
        const perAcre = listingPricePerAcre(t);
        if (price === null) return false;
        if (minPrice !== undefined && price < minPrice) return false;
        if (maxPrice !== undefined && price > maxPrice) return false;
        if (minPricePerAcre !== undefined && (perAcre === null || perAcre < minPricePerAcre)) return false;
        if (maxPricePerAcre !== undefined && (perAcre === null || perAcre > maxPricePerAcre)) return false;
        return true;
      });
    }
    if (near?.radiusMiles !== undefined) {
      const radius = near.radiusMiles;
      tokens = tokens.filter(t => t.coordinates !== null && haversineMiles(near, t.coordinates) <= radius);
    }
    if (sortBy && !groupBy) {
      tokens = sortTokens(tokens, sortBy, sortDir, near);
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
    const unknownRegion = region && !regionCode
      ? `No properties found: "${region}" is not a US state code or state name. Pass a two-letter code such as "NV" or a name such as "Nevada".`
      : null;
    const sortDistanceWithoutNear = sortBy === "distance" && !near;
    const ordering: { sortedBy?: SortKey; sortDir?: "asc" | "desc"; distanceFrom?: { lat: number; lon: number; radiusMiles?: number }; distanceNote?: string; sortNote?: string } = sortBy && !groupBy && !sortDistanceWithoutNear
      ? { sortedBy: sortBy, sortDir, ...(near ? { distanceFrom: { lat: near.lat, lon: near.lon, ...(near.radiusMiles !== undefined ? { radiusMiles: near.radiusMiles } : {}) }, distanceNote: "distanceMiles is the straight-line distance from the point, not driving distance." } : {}), ...(sortBy === "price" || sortBy === "pricePerAcre" ? { sortNote: "Sorted by the listing price; properties with no listing come last." } : {}) }
      : sortDistanceWithoutNear ? { sortNote: "sortBy: distance needs near; rows are in the API's order." } : {};
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
        showing: groupPage.length > 0 ? `${offset + 1}-${offset + groupPage.length} of ${groups.length}` : groups.length === 0 ? "none" : `none: offset ${offset} is past the last of ${groups.length} groups`,
        ...(unknownRegion ? { message: unknownRegion } : groups.length === 0 ? { message: "No properties match these filters." } : {}),
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
        ...ordering,
        properties: [],
        message: total > 0
          ? `No more results: ${total} properties match, and offset ${offset} is past the end.`
          : unknownRegion ?? (priceFiltered ? "No properties found matching your filters. Price filters match listed properties only; drop them to see unlisted properties with their estimated value per acre." : "No properties found matching your filters."),
      };
    }
    return {
      network: NETWORK_LABEL,
      ...(MAINNET_WARNING ? { legalNotice: MAINNET_WARNING } : {}),
      total,
      ...link,
      ...ordering,
      showing: `${offset + 1}-${offset + page.length} of ${total}`,
      properties: page.map(token => tokenToSummary(token, near)),
    };
  } catch (e) {
    return { error: `Failed to search properties: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** get_land_property keeps its response bounded: holders and orders beyond these are counted, not listed. */
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
    ...(replacedPremintTokenId ? { replacesTokenId: replacedPremintTokenId, note: `Token ${replacedPremintTokenId} was the record of this property before its token was issued; it has been replaced by this token.` } : {}),
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

const RECENT_ACTIVITY = 10;
/** get_land_property keeps the start of the legal description; get_land_trust_documents returns all of it. */
export const LEGAL_DESCRIPTION_PREVIEW = 600;

/** The newest events, each ScoreChanged with its new and previous encoding and the groups that moved. */
function recentActivity(activities: readonly ActivityModel[]) {
  const previous = previousScores(activities);
  return activities.slice(0, RECENT_ACTIVITY).map((a, i) => {
    const { tokenId: _tokenId, ...event } = formatActivity(a, previous.get(i));
    return event;
  });
}

/** The legal description, cut at a word boundary when long. */
export function legalDescriptionPreview(claim: string | null | undefined): { description: string | null; truncated: boolean } {
  if (!claim) return { description: null, truncated: false };
  if (claim.length <= LEGAL_DESCRIPTION_PREVIEW) return { description: claim, truncated: false };
  const cut = claim.slice(0, LEGAL_DESCRIPTION_PREVIEW);
  const end = cut.lastIndexOf(" ");
  return { description: `${(end > LEGAL_DESCRIPTION_PREVIEW / 2 ? cut.slice(0, end) : cut).trimEnd()} [...]`, truncated: true };
}

export const getPropertyInput = {
  ...propertyRefInputs,
  display: z.enum(["inline", "fullscreen"]).optional().describe("Hosts that render the property card: ask for it inline (default) or fullscreen. The host may decline."),
};
export type GetPropertyArgs = ArgsOf<typeof getPropertyInput>;

export async function getProperty(args: GetPropertyArgs) {
  const { tokenId, slug } = args;
  if (!tokenId && !slug) {
    return { error: "Either tokenId or slug is required" };
  }
  try {
    const { token, replacedPremintTokenId } = await getTokenOrSuccessor(tokenId, slug);
    if (!token) {
      return { error: `No property found with ${tokenId ? `token ID ${tokenId}` : `slug ${slug}`}` };
    }
    // Live as get_land_order_book counts it: active, encumbered or pending, and not past its end time.
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
    const legal = legalDescriptionPreview(token.definition?.claim);
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
      // Always present, so "no fees" and "no flags" read as answers rather than missing data.
      fees,
      flags,
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
        about: "Property checks are a starting point for your own research, not a title search or title insurance. encoding is their 5-digit numeric encoding (explain_property_checks decodes it).",
      },
      taxes: {
        status: tax.status,
        summary: taxSummary(tax.status, tax.checkedAt, token.isPremint, tax),
        checkedAt: tax.checkedAt,
        details: "get_land_tax_status",
      },
      legal: {
        description: legal.description,
        ...(legal.truncated ? { descriptionTruncated: true, descriptionNote: `The first ${LEGAL_DESCRIPTION_PREVIEW} of ${(token.definition?.claim.length ?? 0).toLocaleString("en-US")} characters; get_land_trust_documents returns the full legal description.` } : {}),
        holdingEntity: token.definition?.holdingEntity ?? null,
        // The agreement text is long (about 150 KB); get_land_trust_documents returns it on request.
        operatingAgreement: token.operatingAgreementUrl ? toGatewayUrl(token.operatingAgreementUrl) ?? token.operatingAgreementUrl : null,
        operatingAgreementName: token.operatingAgreementName,
        // The resource serves this token's own agreement, which can be an older version than the generic one.
        operatingAgreementResource: `fabrica://property/${token.tokenId}/trust-agreement`,
        registrar: token.definition?.offchainRegistrar ?? null,
        proofOfTitle: token.configuration?.proofOfTitle ?? null,
      },
      valuation: {
        ...estimateFields(token.estimatedValue, token.pricing),
        displayValuation: formatUsd(token.cardDisplayValuation) ?? token.cardDisplayValuation,
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
      recentActivity: recentActivity(token.activity ?? []),
      mintedAt: token.mintedAt,
      ...(args.display ? { card: { displayMode: args.display } } : {}),
    };
  } catch (e) {
    return { error: propertyLookupError(e, { tokenId, slug }, "get property") };
  }
}

export const getPropertyMapInput = {
  ...propertyRefInputs,
  includeCountyBounds: z.boolean().optional().describe("Also return the county boundary polygon, a large decorative layer (default: false)"),
};
export type GetPropertyMapArgs = ArgsOf<typeof getPropertyMapInput>;

export async function getPropertyMap(args: GetPropertyMapArgs) {
  const { tokenId, slug } = args;
  const includeCountyBounds = args.includeCountyBounds ?? false;
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
