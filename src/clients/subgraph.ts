import { GraphQLClient, gql } from "graphql-request";
import type { SubgraphPool } from "../types/index.js";

const METASTREET_POOL_URL =
  process.env.FABRICA_METASTREET_SUBGRAPH_URL ??
  "https://api.goldsky.com/api/public/project_cmgziqwja00105np2g1gy6stc/subgraphs/v2-pools-mainnet/3.13.2/gn";

const FABRICA_TOKEN_ADDRESS = "0x5cbeb7a0df7ed85d82a472fd56d81ed550f3ea95";
const FABRICA_POOL_ADDRESS = "0x842ffbf1ad5314503904626122376f71603a3cf9";

const poolClient = new GraphQLClient(METASTREET_POOL_URL);

export async function getFabricaPool(): Promise<SubgraphPool | null> {
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
