import { GraphQLClient, gql } from "graphql-request";
import type { SubgraphPool } from "../types/index.js";
import { CONTRACTS, IS_MAINNET } from "../config.js";

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

/**
 * Fetch ALL MetaStreet pools that accept the Fabrica token as collateral.
 * Dynamically discovers pools from the subgraph — no hardcoded pool addresses.
 */
export async function getFabricaPools(): Promise<SubgraphPool[]> {
  const query = gql`
    ${POOL_FIELDS}
    query GetFabricaPools($collateralToken: String!) {
      pools(where: { collateralToken: $collateralToken }) {
        ...PoolFields
      }
    }
  `;
  try {
    const data = await poolClient.request<{ pools: SubgraphPool[] }>(query, {
      collateralToken: FABRICA_TOKEN_ADDRESS,
    });
    return data.pools;
  } catch {
    return [];
  }
}

/** Aggregate stats across all Fabrica pools */
export function aggregatePoolStats(pools: SubgraphPool[]) {
  if (pools.length === 0) return null;
  let totalValueLocked = 0;
  let totalValueUsed = 0;
  let totalValueAvailable = 0;
  let loansOriginated = 0;
  let loansActive = 0;
  let loansRepaid = 0;
  let loansLiquidated = 0;
  for (const pool of pools) {
    totalValueLocked += parseFloat(pool.totalValueLocked);
    totalValueUsed += parseFloat(pool.totalValueUsed);
    totalValueAvailable += parseFloat(pool.totalValueAvailable);
    loansOriginated += parseInt(pool.loansOriginated);
    loansActive += parseInt(pool.loansActive);
    loansRepaid += parseInt(pool.loansRepaid);
    loansLiquidated += parseInt(pool.loansLiquidated);
  }
  return {
    poolCount: pools.length,
    totalValueLocked: String(totalValueLocked),
    totalValueUsed: String(totalValueUsed),
    totalValueAvailable: String(totalValueAvailable),
    loansOriginated,
    loansActive,
    loansRepaid,
    loansLiquidated,
  };
}

export { FABRICA_TOKEN_ADDRESS };
