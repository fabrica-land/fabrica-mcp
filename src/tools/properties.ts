import { getTokens, getToken, getCountyBounds, DEFAULT_MIN_SCORE, filterSpamTokens } from "../clients/graphql.js";
import type { TokenModel } from "../types/index.js";
import { NETWORK_LABEL, MAINNET_WARNING } from "../config.js";

function formatUsd(value: string | null | undefined): string | null {
  if (!value) return null;
  const num = parseFloat(value);
  if (isNaN(num)) return null;
  return `$${num.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
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
    estimatedValue: formatUsd(token.estimatedValue),
    hasActiveListing: token.marketplacePrice !== null,
    listingPrice: token.marketplacePrice ? formatUsd(token.marketplacePrice) : null,
    hasActiveLoan: hasLoan,
    owner: shortenAddress(token.majorityOwnerAddress),
    propertyLink: token.propertyLink,
  };
}

export async function searchProperties(args: Record<string, unknown>) {
  const region = args.region as string | undefined;
  const minAcres = args.minAcres as number | undefined;
  const maxAcres = args.maxAcres as number | undefined;
  const minScore = args.minScore as number | undefined;
  const hasListings = args.hasListings as boolean | undefined;
  const hasLoans = args.hasLoans as boolean | undefined;
  const ownedBy = args.ownedBy as string | undefined;
  const limit = Math.min((args.limit as number | undefined) ?? 20, 100);
  const offset = (args.offset as number | undefined) ?? 0;
  try {
    let tokens = await getTokens({
      minScore: minScore ?? DEFAULT_MIN_SCORE,
      hasListings: hasListings ?? undefined,
      ownedBy,
      burned: false,
      premints: false,
    });
    tokens = filterSpamTokens(tokens);
    if (region) {
      const upper = region.toUpperCase();
      tokens = tokens.filter(t => t.regionCode?.toUpperCase() === upper);
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
    const page = tokens.slice(offset, offset + limit);
    if (page.length === 0) {
      return {
        network: NETWORK_LABEL,
        ...(MAINNET_WARNING ? { legalNotice: MAINNET_WARNING } : {}),
        total: 0,
        properties: [],
        message: "No properties found matching your filters.",
      };
    }
    return {
      network: NETWORK_LABEL,
      ...(MAINNET_WARNING ? { legalNotice: MAINNET_WARNING } : {}),
      total,
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
      warnings.push(`Recovery status: ${recovery.label} — property may be disputed or voided`);
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
        estimatedValue: formatUsd(token.estimatedValue),
        displayValuation: token.cardDisplayValuation,
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
        activeLoans: activeLoans.map(l => ({
          loanId: l.loanId,
          provider: l.loanProvider,
          principal: `${l.principalScaled} ${l.currencySymbol ?? ""}`.trim(),
          apr: l.aprPercent !== null ? `${l.aprPercent.toFixed(1)}%` : null,
          duration: l.durationFormatted,
          maturityDate: l.maturityDate,
          borrower: shortenAddress(l.borrower?.address),
          lender: shortenAddress(l.lender?.address),
        })),
        loanOffers: token.loanOffers?.slice(0, 5).map(o => ({
          principal: `${o.principalScaled} ${o.currencySymbol ?? ""}`.trim(),
          apr: o.aprPercent !== null ? `${o.aprPercent.toFixed(1)}%` : null,
          duration: o.durationFormatted,
        })) ?? [],
        metaStreetLiquidity: token.metaStreetLiquidity ? {
          maxPrincipal: `${token.metaStreetLiquidity.maxPrincipalScaled} USDC`,
          hasActiveLoan: token.metaStreetLiquidity.activeLoan !== null,
        } : null,
      },
      marketplace: {
        listings: activeListings.map(l => ({
          price: formatUsd(l.usdPrice ?? l.price),
          symbol: l.symbol,
          expiresAt: l.endTime,
          seller: shortenAddress(l.makerAddress),
        })),
        bids: activeBids.map(b => ({
          price: formatUsd(b.usdPrice ?? b.price),
          symbol: b.symbol,
          bidder: shortenAddress(b.makerAddress),
        })),
      },
      media: {
        imageLight: token.imageUrlLight,
        imageDark: token.imageUrlDark,
        userDescription: token.configuration?.userDescription ?? null,
      },
      recentActivity: token.activity?.slice(0, 10).map(a => ({
        type: a.activity,
        source: a.source,
        time: a.time,
        amount: a.usdAmount ? formatUsd(a.usdAmount) : (a.currencyAmount ? `${a.currencyAmount} ${a.currencySymbol ?? ""}`.trim() : null),
        txHash: a.transactionHash,
      })) ?? [],
      mintedAt: token.mintedAt,
      geoJson: token.geoJson ?? token.definition?.geoJson ?? null,
    };
  } catch (e) {
    return { error: `Failed to get property: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function getPropertyMap(args: Record<string, unknown>) {
  const tokenId = args.tokenId as string | undefined;
  const slug = args.slug as string | undefined;
  const includeCountyBounds = (args.includeCountyBounds as boolean | undefined) ?? true;
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
    if (includeCountyBounds && token.definition?.offchainRegistrar?.propertyId) {
      const fips = token.definition.offchainRegistrar.propertyId.slice(0, 5);
      if (fips && /^\d{5}$/.test(fips)) {
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
    };
  } catch (e) {
    return { error: `Failed to get property map: ${e instanceof Error ? e.message : String(e)}` };
  }
}
