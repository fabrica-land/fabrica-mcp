import { GraphQLClient, gql } from "graphql-request";
import type { SubgraphPool } from "../types/index.js";
import { CONTRACTS, IS_MAINNET } from "../config.js";
import { TtlCache } from "./cache.js";

const METASTREET_MAINNET_URL =
  "https://api.goldsky.com/api/public/project_cmgziqwja00105np2g1gy6stc/subgraphs/v2-pools-mainnet/3.13.2/gn";
const METASTREET_SEPOLIA_URL =
  "https://api.goldsky.com/api/public/project_cmgziqwja00105np2g1gy6stc/subgraphs/v2-pools-sepolia/3.13.2/gn";

const METASTREET_POOL_URL =
  process.env.FABRICA_METASTREET_SUBGRAPH_URL ??
  (IS_MAINNET ? METASTREET_MAINNET_URL : METASTREET_SEPOLIA_URL);

const FABRICA_TOKEN_ADDRESS = CONTRACTS.fabricaToken.toLowerCase();

const poolClient = new GraphQLClient(METASTREET_POOL_URL);

const POOL_FIELDS = gql`
  fragment PoolFields on Pool {
    id
    implementation
    collateralToken { id }
    currencyToken { id symbol decimals }
    totalValueLocked
    totalValueUsed
    totalValueAvailable
    durations
    rates
    maxBorrows
    loansOriginated
    loansActive
    loansRepaid
    loansLiquidated
    adminFeeRate
  }
`;

const poolsCache = new TtlCache<SubgraphPool[]>();

const GET_FABRICA_POOLS_QUERY = gql`
  ${POOL_FIELDS}
  query GetFabricaPools($collateralToken: String!) {
    pools(where: { collateralToken: $collateralToken }) {
      ...PoolFields
    }
  }
`;

/**
 * Fetch ALL MetaStreet pools that accept the Fabrica token as collateral.
 * Dynamically discovers pools from the subgraph, no hardcoded pool addresses.
 * Returns null when the subgraph cannot be read, so a failure is never reported as zero.
 * Cached briefly (failures are not cached).
 */
export async function getFabricaPools(): Promise<SubgraphPool[] | null> {
  try {
    return await poolsCache.get(FABRICA_TOKEN_ADDRESS, async () => {
      const data = await poolClient.request<{ pools: SubgraphPool[] }>(GET_FABRICA_POOLS_QUERY, {
        collateralToken: FABRICA_TOKEN_ADDRESS,
      });
      return data.pools;
    });
  } catch {
    return null;
  }
}

/** Exact sum of integer strings (18-decimal pool values overflow float precision); float sum otherwise. */
function sumValues(values: string[]): string {
  if (values.every(v => /^\d+$/.test(v))) {
    return values.reduce((sum, v) => sum + BigInt(v), 0n).toString();
  }
  return String(values.reduce((sum, v) => sum + parseFloat(v), 0));
}

/** Aggregate stats across all Fabrica pools */
export function aggregatePoolStats(pools: SubgraphPool[]) {
  if (pools.length === 0) return null;
  return {
    poolCount: pools.length,
    totalValueLocked: sumValues(pools.map(p => p.totalValueLocked)),
    totalValueUsed: sumValues(pools.map(p => p.totalValueUsed)),
    totalValueAvailable: sumValues(pools.map(p => p.totalValueAvailable)),
    loansOriginated: pools.reduce((sum, p) => sum + parseInt(p.loansOriginated), 0),
    loansActive: pools.reduce((sum, p) => sum + parseInt(p.loansActive), 0),
    loansRepaid: pools.reduce((sum, p) => sum + parseInt(p.loansRepaid), 0),
    loansLiquidated: pools.reduce((sum, p) => sum + parseInt(p.loansLiquidated), 0),
  };
}

export { FABRICA_TOKEN_ADDRESS };
