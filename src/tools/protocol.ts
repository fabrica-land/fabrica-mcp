import { LOANS_INCOMPLETE_NOTE, loansMayBeIncomplete } from "../clients/budgets.js";
import { getTokens, getAllLoans, DEFAULT_MIN_SCORE, filterSpamTokens } from "../clients/graphql.js";
import { getFabricaPools } from "../clients/subgraph.js";
import { CONTRACTS, NETWORK_LABEL, MAINNET_WARNING, IS_MAINNET } from "../config.js";
import { loanVolumeByCurrency } from "../labels.js";
import { buildPoolStats } from "./pool-stats.js";
import { formatUsd } from "../format.js";

export async function getProtocolStats() {
  try {
    const [tokens, loans, pools] = await Promise.all([
      getTokens({
        burned: false,
        premints: false,
        minScore: DEFAULT_MIN_SCORE,
        testnets: IS_MAINNET ? false : true,
        contractAddress: IS_MAINNET ? undefined : CONTRACTS.fabricaToken,
      }),
      getAllLoans(),
      getFabricaPools(),
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
    return {
      protocol: {
        name: "Fabrica",
        description: "Tokenized real property (land) as ERC-1155 NFTs on Ethereum",
        website: "https://fabrica.land",
        docs: "https://docs.fabrica.land",
        network: NETWORK_LABEL,
        tokenStandard: "ERC-1155",
      },
      ...(MAINNET_WARNING ? { legalNotice: MAINNET_WARNING } : {}),
      contracts: {
        fabricaToken: CONTRACTS.fabricaToken,
      },
      ...(CONTRACTS.nftfiV2 ? {
        historicalContracts: {
          note: "Former peer-to-peer lending integration (NFTfi), retired. Listed only to read historical loans.",
          nftfiV2: CONTRACTS.nftfiV2,
          nftfiV3: CONTRACTS.nftfiV3,
        },
      } : {}),
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
        loanVolumeByCurrency: loanVolumeByCurrency(loans),
        ...(loansMayBeIncomplete(loans) ? { note: LOANS_INCOMPLETE_NOTE } : {}),
        lendingPools: buildPoolStats(pools),
      },
      marketplace: {
        activeListings: activeListingsCount,
      },
      links: {
        platform: "https://fabrica.land",
        docs: "https://docs.fabrica.land",
        about: "https://about.fabrica.land",
        dune: "https://dune.com/fabrica/dashboard",
        opensea: "https://opensea.io/collection/fabrica-v3",
        github: "https://github.com/fabrica-land",
      },
    };
  } catch (e) {
    return { error: `Failed to get protocol stats: ${e instanceof Error ? e.message : String(e)}` };
  }
}
