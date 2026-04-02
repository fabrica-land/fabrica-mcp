import { getTokens, getAllLoans, DEFAULT_MIN_SCORE, filterSpamTokens } from "../clients/graphql.js";
import { getFabricaPool, FABRICA_TOKEN_ADDRESS, FABRICA_POOL_ADDRESS } from "../clients/subgraph.js";

function formatUsd(value: string | null | undefined): string | null {
  if (!value) return null;
  const num = parseFloat(value);
  if (isNaN(num)) return null;
  return `$${num.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function formatPoolValue(raw: string, decimals: number): string {
  const num = parseFloat(raw) / Math.pow(10, decimals);
  return `$${num.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export async function getProtocolStats() {
  try {
    const [tokens, loans, pool] = await Promise.all([
      getTokens({ burned: false, premints: false, minScore: DEFAULT_MIN_SCORE }),
      getAllLoans(),
      getFabricaPool(),
    ]);
    const activeTokens = filterSpamTokens(tokens.filter(t => !t.isBurned && !t.isPremint));
    const statesRepresented = new Set(activeTokens.map(t => t.regionCode).filter(Boolean));
    const totalEstimatedValue = activeTokens.reduce(
      (sum, t) => sum + parseFloat(t.estimatedValue || "0"), 0,
    );
    const activeListingsCount = activeTokens.filter(t => t.marketplacePrice !== null).length;
    const activeLoans = loans.filter(l => l.loanStatus === "Active");
    const repaidLoans = loans.filter(l => l.loanStatus === "Repaid");
    const liquidatedLoans = loans.filter(l => l.loanStatus === "Liquidated");
    const totalLoanVolume = loans.reduce((sum, l) => sum + parseFloat(l.principalScaled || "0"), 0);
    const repaymentRate = (repaidLoans.length + liquidatedLoans.length) > 0
      ? ((repaidLoans.length / (repaidLoans.length + liquidatedLoans.length)) * 100)
      : 100;
    const poolStats = pool ? {
      totalValueLocked: formatPoolValue(pool.totalValueLocked, 18),
      totalValueUsed: formatPoolValue(pool.totalValueUsed, 18),
      totalValueAvailable: formatPoolValue(pool.totalValueAvailable, 18),
      utilization: pool.totalValueLocked !== "0"
        ? `${((parseFloat(pool.totalValueUsed) / parseFloat(pool.totalValueLocked)) * 100).toFixed(1)}%`
        : "0%",
      loansOriginated: parseInt(pool.loansOriginated),
      loansActive: parseInt(pool.loansActive),
      loansRepaid: parseInt(pool.loansRepaid),
      loansLiquidated: parseInt(pool.loansLiquidated),
    } : null;
    return {
      protocol: {
        name: "Fabrica",
        description: "Tokenized real property (land) as ERC-1155 NFTs on Ethereum",
        website: "https://fabrica.land",
        docs: "https://docs.fabrica.land",
        network: "Ethereum mainnet",
        tokenStandard: "ERC-1155",
      },
      contracts: {
        fabricaToken: FABRICA_TOKEN_ADDRESS,
        metaStreetPool: FABRICA_POOL_ADDRESS,
        nftfiV2: "0xd0a40eB7FD94eE97102BA8e9342243A2b2E22207",
        nftfiV3: "0x9F10D706D789e4c76A1a6434cd1A9841c875C0A6",
      },
      properties: {
        totalTokenized: activeTokens.length,
        totalEstimatedValue: formatUsd(String(totalEstimatedValue)),
        statesRepresented: statesRepresented.size,
        states: Array.from(statesRepresented).sort(),
      },
      lending: {
        totalLoans: loans.length,
        activeLoans: activeLoans.length,
        repaidLoans: repaidLoans.length,
        liquidatedLoans: liquidatedLoans.length,
        totalLoanVolume: formatUsd(String(totalLoanVolume)),
        repaymentRate: `${repaymentRate.toFixed(0)}%`,
        pool: poolStats,
      },
      marketplace: {
        activeListings: activeListingsCount,
      },
      links: {
        platform: "https://fabrica.land",
        docs: "https://docs.fabrica.land",
        dune: "https://dune.com/fabrica/dashboard",
        opensea: "https://opensea.io/collection/fabrica-v3",
        github: "https://github.com/fabrica-land",
      },
    };
  } catch (e) {
    return { error: `Failed to get protocol stats: ${e instanceof Error ? e.message : String(e)}` };
  }
}
