import { getTokens, getToken, getCountyBounds, DEFAULT_MIN_SCORE, filterSpamTokens } from "../clients/graphql.js";
import type { TokenModel } from "../types/index.js";
import { NETWORK_LABEL, MAINNET_WARNING, IS_MAINNET, CONTRACTS } from "../config.js";
import { LENDING_POOL_NAME, formatActivityAmount, formatActivitySource, formatLoanProvider, formatUsdcCeiling } from "../labels.js";
import { propertyPhotos, propertyMapImage } from "./media.js";
import { estimateFields, formatTokenAmount, sortLoans } from "../format.js";
import { locationLink, stateName } from "../links.js";

function formatUsd(value: string | null | undefined): string | null {
  if (!value) return null;
  const num = parseFloat(value);
  if (isNaN(num)) return null;
  return `$${num.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

/** USD when the API supplies a USD price; otherwise the native amount and currency, never a guessed "$". */
function formatOrderPrice(usdPrice: string | null, price: string | null, symbol: string | null): string | null {
  const usd = formatUsd(usdPrice);
  if (usd) return usd;
  return price ? `${price} ${symbol ?? ""}`.trim() : null;
}

function formatScore(score: number | null): number | null {
  if (score === null) return null;
  return score;
}

function shortenAddress(addr: string | null | undefined): string | null {
  if (!addr) return null;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
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
    confidenceScore: formatScore(token.score),
    ...estimateFields(token.estimatedValue),
    hasActiveListing: token.marketplacePrice !== null,
    listingPrice: token.marketplacePrice ? formatUsd(token.marketplacePrice) : null,
    hasActiveLoan: hasLoan,
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

/** One row per state or county: counts, acres and the fabrica.land location page. */
export function groupTokens(tokens: ReadonlyArray<TokenModel>, groupBy: "state" | "county") {
  const groups = new Map<string, TokenModel[]>();
  for (const t of tokens) {
    const state = t.regionCode?.toUpperCase() ?? "";
    const key = groupBy === "state" ? state : `${state}|${normalizeCounty(t.district)}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  return [...groups.values()].map(members => {
    const stateName = mostCommon(members.map(t => t.region));
    const county = groupBy === "county" ? mostCommon(members.map(t => t.district)) : null;
    const acres = members.reduce((sum, t) => sum + (Number.parseFloat(t.acres ?? "") || 0), 0);
    return {
      state: members[0].regionCode,
      ...(groupBy === "county" ? { county } : {}),
      properties: members.length,
      forSale: members.filter(t => t.marketplacePrice !== null).length,
      totalAcres: Math.round(acres * 100) / 100,
      locationLink: locationLink({ state: stateName, county }),
    };
  }).sort((a, b) => b.properties - a.properties || String(a.county ?? a.state).localeCompare(String(b.county ?? b.state)));
}

export async function searchProperties(args: Record<string, unknown>) {
  const region = args.region as string | undefined;
  const county = args.county as string | undefined;
  const groupBy = args.groupBy as "state" | "county" | undefined;
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
    if (region) {
      const upper = region.toUpperCase();
      tokens = tokens.filter(t => t.regionCode?.toUpperCase() === upper);
    }
    if (county) {
      const wanted = normalizeCounty(county);
      tokens = tokens.filter(t => normalizeCounty(t.district) === wanted);
    }
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
    const states = new Set(tokens.map(t => t.regionCode?.toUpperCase()));
    const counties = new Set(tokens.map(t => normalizeCounty(t.district)));
    const linkState = region ? stateName(region) ?? mostCommon(tokens.map(t => t.region)) : states.size === 1 ? mostCommon(tokens.map(t => t.region)) : null;
    const linkCounty = county ? mostCommon(tokens.map(t => t.district)) ?? `${county.trim().replace(/\s+county$/i, "")} County` : null;
    const link = (region || county) && linkState && (!county || counties.size <= 1)
      ? { locationLink: locationLink({ state: linkState, county: linkCounty }) }
      : {};
    if (groupBy) {
      return {
        network: NETWORK_LABEL,
        ...(MAINNET_WARNING ? { legalNotice: MAINNET_WARNING } : {}),
        total,
        ...link,
        groupBy,
        groups: groupTokens(tokens, groupBy),
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

function getRecoveryStatus(score: number | null): { value: number; label: string } | null {
  if (score === null) return null;
  const digit = Math.floor(score / 10000);
  const labels: Record<number, string> = {
    7: "Normal",
    6: "Under review",
    5: "Recovery in progress",
    1: "Voided",
  };
  return { value: digit, label: labels[digit] ?? "Unknown" };
}

export async function getProperty(args: Record<string, unknown>) {
  const tokenId = args.tokenId as string | undefined;
  const slug = args.slug as string | undefined;
  if (!tokenId && !slug) {
    return { error: "Either tokenId or slug is required" };
  }
  try {
    const token = await getToken({ tokenId, slug });
    if (!token) {
      return { error: `No property found with ${tokenId ? `token ID ${tokenId}` : `slug ${slug}`}` };
    }
    const activeListings = token.marketplaceListings?.filter(l => l.status === "active") ?? [];
    const activeBids = token.marketplaceBids?.filter(b => b.status === "active") ?? [];
    const activeLoans = token.loans?.filter(l => l.loanStatus === "Active") ?? [];
    const recovery = getRecoveryStatus(token.score);
    const warnings: string[] = [];
    if (recovery && recovery.value !== 7) {
      warnings.push(`Recovery status: ${recovery.label}; the property may be disputed or voided`);
    }
    if (parseInt(token.supplyLiquidating || "0") > 0) {
      warnings.push("Property has supply currently in liquidation");
    }
    if (parseInt(token.supplyInDefault || "0") > 0) {
      warnings.push("Property has supply currently in default");
    }
    return {
      ...(MAINNET_WARNING ? { legalNotice: MAINNET_WARNING } : {}),
      tokenId: token.tokenId,
      network: token.network,
      contractAddress: token.contractAddress,
      name: token.name ?? token.vanityName,
      propertyLink: token.propertyLink,
      isPremint: token.isPremint,
      recoveryStatus: recovery,
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
      legal: {
        description: token.definition?.claim ?? null,
        holdingEntity: token.definition?.holdingEntity ?? null,
        operatingAgreement: token.operatingAgreementUrl ?? token.operatingAgreement,
        registrar: token.definition?.offchainRegistrar ?? null,
        proofOfTitle: token.configuration?.proofOfTitle ?? null,
      },
      valuation: {
        ...estimateFields(token.estimatedValue, token.pricing),
        displayValuation: formatUsd(token.cardDisplayValuation) ?? token.cardDisplayValuation,
        confidenceScore: formatScore(token.score),
        scoreBreakdown: token.scoringCheckResults.map(s => ({
          check: s.title,
          group: s.group,
          passed: s.value,
        })),
        pricing: token.pricing.map(p => ({
          source: p.source,
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
        holders: token.balances?.map(b => ({
          address: b.holder.address,
          balance: b.balance,
        })) ?? [],
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
        listings: activeListings.map(l => ({
          price: formatOrderPrice(l.usdPrice, l.price, l.symbol),
          symbol: l.symbol,
          expiresAt: l.endTime,
          seller: shortenAddress(l.makerAddress),
        })),
        bids: activeBids.map(b => ({
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
    return { error: `Failed to get property: ${e instanceof Error ? e.message : String(e)}` };
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
    return { error: `Failed to get property map: ${e instanceof Error ? e.message : String(e)}` };
  }
}
