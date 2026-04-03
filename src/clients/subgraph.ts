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

const FABRICA_TOKEN_ADDRESS = CONTRACTS.fabricaToken;
const FABRICA_POOL_ADDRESS = CONTRACTS.metaStreetPool;

const poolClient = new GraphQLClient(METASTREET_POOL_URL);

export async function getFabricaPool(): Promise<SubgraphPool | null> {
  if (!FABRICA_POOL_ADDRESS) return null;
  const query = gql`
    query GetPool($id: ID!) {
      pool(id: $id) {
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
    }
  `;
  try {
    const data = await poolClient.request<{ pool: SubgraphPool | null }>(query, {
      id: FABRICA_POOL_ADDRESS,
    });
    return data.pool;
  } catch {
    return null;
  }
}

export { FABRICA_TOKEN_ADDRESS, FABRICA_POOL_ADDRESS };
