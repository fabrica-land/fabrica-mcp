# Fabrica MCP Server

An MCP (Model Context Protocol) server that gives AI agents read-only access to tokenized real property data on the Fabrica protocol. Phase 1 is read-only, wrapping existing public APIs. No new backend infrastructure.

## What is Fabrica?

Fabrica tokenizes real property (land) as ERC-1155 NFTs on Ethereum. A legal trust holds title at the county level. The token controls the trust. Transfer the token, transfer ownership. This is a legal mechanism that retrofits existing property law.

- 600+ properties tokenized across the US
- 23 regulatory licenses covering all 50 states
- Lending integrations with NFTfi (peer-to-peer) and MetaStreet (pool-based)
- Marketplace via Seaport protocol
- Platform: https://fabrica.land
- Docs: https://docs.fabrica.land
- Dune: https://dune.com/fabrica/dashboard

---

## Project Status

Phase 1 is implemented. All 6 tools are working with live data from production APIs.

---

## Tech Stack

- TypeScript (strict mode)
- `@modelcontextprotocol/sdk` for the MCP server (uses `McpServer` class with `zod` schemas)
- `graphql-request` for GraphQL clients
- `tsup` for building (ESM, no DTS — TypeScript 6 deprecation issue with DTS generation)
- stdio transport (standard for MCP)
- Published as `@fabrica-land/mcp` on npm

---

## Project Structure

```
src/
  index.ts          # MCP server entrypoint — registers all 6 tools
  tools/
    properties.ts   # search_properties, get_property, get_property_map
    lending.ts      # get_lending_market
    portfolio.ts    # get_portfolio
    protocol.ts     # get_protocol_stats
  clients/
    graphql.ts      # Fabrica GraphQL API client (primary data source)
    subgraph.ts     # MetaStreet pool subgraph client (pool TVL/utilization only)
  types/
    index.ts        # Shared TypeScript interfaces
```

---

## Data Sources

### 1. Fabrica GraphQL API (Primary)

**Endpoint:** `https://api.fabrica.land/graphql` (Apollo Server, public, no auth)

This is the main data source. The Apollo API routes subgraph data internally, so most onchain data is available through it. All queries are public.

**Important API Behaviors (learned during implementation):**

- **`tokens` query has NO `first`/`skip` pagination.** Returns all matching tokens. Pagination is client-side.
- **Nested fields `loans`, `marketplaceListings`, `marketplaceBids` are NOT available on list queries** (tokens list, wallet.tokens). They error with "loans is not available on list queries." Use scalar fields like `supplyUnderLoan`, `marketplacePrice`, `loanOfferCount` instead. These nested fields only work on single `token()` queries.
- **`loans` query requires `network` or `networkIn`** — it errors without one. Use `network: "ethereum"` as default.
- **`loanStartedEvents`, `loanRepaidEvents`, `loanLiquidatedEvents` require `first!` and `skip!`** (non-nullable).
- **WalletModel uses `address` not `walletAddress`** and `creditHistory` not `walletCreditHistory`. `displayName` is on the nested `user` field.
- **LoanModel uses `loanStatus` not `status`**, `principalScaled` not `principalAmount`, `aprPercent` not `interestRate`, `maturityDate` not `repaymentDate`. Marketplace types are all `MarketplaceOrderModel`.
- **Score is a raw integer** (e.g. 73242). Kept as-is in tool responses. The `minScore` filter on the `tokens` query also expects this integer scale.
- **`estimatedValue` is a string decimal** (e.g. "396647.43"). `acres` is also a string.

**Public Queries:**

- `token(network?, contractAddress?, tokenId?, slug?)` — Single property (supports all nested fields)
- `tokens(burned?, contractAddress?, minListings?, minScore?, ownedBy?, premints?, sort?, testnets?)` — List/filter properties (limited nested fields)
- `wallet(walletAddress!, ...)` — Wallet holdings, credit history, value
- `user(walletAddress!, network?)` — User profile
- `loans(network?, networkIn?, first?, skip?, contractAddress?)` — All loans
- `loanStartedEvents(first!, skip!, network?, networkIn?)` — Loan initiation events
- `loanRepaidEvents(first!, skip!, network?, networkIn?)` — Repayment events
- `loanLiquidatedEvents(first!, skip!, network?, networkIn?)` — Liquidation events
- `marketplaceListings(networkName!, contractAddress!, tokenId!, marketplace?, status?)` — Sale listings
- `marketplaceBids(networkName!, contractAddress!, tokenId!, ...)` — Bids
- `countyBounds(fips!)` — County boundary GeoJSON by FIPS code
- `scoringDescriptors()` — Confidence score rules

**Key Enums:** `TokenSortField` (price, score), `LoanStatus` (Active, Default, Liquidated, Liquidating, Repaid), `LoanProvider` (MetaStreet, NFTfi), `MarketplaceOrderStatus` (active, canceled, expired, filled, pending)

### 2. MetaStreet Pool Subgraph (Supplementary)

**Endpoint:** `https://api.goldsky.com/api/public/project_cmgziqwja00105np2g1gy6stc/subgraphs/v2-pools-mainnet/3.13.2/gn`

Used only for MetaStreet pool TVL, utilization, and loan count data. The Fabrica pool ID is `0x842ffbf1ad5314503904626122376f71603a3cf9`.

Pool values are in 18-decimal format (divide by 10^18 for USDC amounts). Currency is USDC (6 decimals, but pool stores in 18-decimal scaled format).

**Note:** The Fabrica subgraph (`fabrica-ethereum/v1.2.1`) is offline. All Fabrica data comes through the Apollo GraphQL API.

---

## Smart Contract Addresses

**Ethereum Mainnet:**
- FabricaToken (ERC-1155): `0x5cbeb7A0df7Ed85D82a472FD56d81ed550f3Ea95`
- FabricaValidator: `0x170511f95560A1F280c29026f73a9cD6a4bA8ab0`
- MetaStreet Pool: `0x842Ffbf1AD5314503904626122376f71603A3Cf9`
- MetaStreet Wrapper: `0x4512b49d3081e1D258EebEF7c435f2310e7d3090`
- NFTfi V2.3 Loan: `0xd0a40eB7FD94eE97102BA8e9342243A2b2E22207`
- NFTfi V3 Loan: `0x9F10D706D789e4c76A1a6434cd1A9841c875C0A6`

**Sepolia Testnet:**
- FabricaToken: `0xb52ED2Dc8EBD49877De57De3f454Fd71b75bc1fD`
- FabricaValidator: `0xAAA7FDc1A573965a2eD47Ab154332b6b55098008`

**Base Sepolia:**
- FabricaToken: `0xCE53C17A82bd67aD835d3e2ADBD3e062058B8F81`
- FabricaValidator: `0x40Ac72C5C7712566eB5552fb1aB2093FA07B9682`

---

## MCP Tool Design Principles

1. **Concise responses.** LLMs have limited context. Return structured summaries, not raw API dumps. Trim unnecessary fields. Format monetary values as human-readable strings ("$12,500" not "12500000000").

2. **Helpful errors.** "No property found with token ID 12345" not stack traces. Empty results are not errors.

3. **Sensible defaults.** Default to mainnet, default limit 20, default to non-burned active tokens.

4. **Composable.** Tools should chain naturally. An agent should be able to search_properties, pick one, then get_property on it, then check get_lending_market for that borrower.

5. **Lean queries.** Only request GraphQL fields that the tool actually returns. Don't fetch entire token objects when you need 5 fields. Respect the API's list query restrictions.

6. **Score as raw integer.** Confidence scores are returned as raw integers from the API (e.g. 73242). Do not normalize to 0-1 or 0-100.

---

## Code Style

- Strict TypeScript. No `any`. No `as` casts.
- Prefer `const` and immutable patterns.
- Keep functions concise. No blank lines between statements inside functions.
- Error handling: catch errors, return helpful messages to the agent, never throw raw errors.
- Use environment variables for configuration with sensible defaults:
  - `FABRICA_API_URL` (default: `https://api.fabrica.land/graphql`)
  - `FABRICA_METASTREET_SUBGRAPH_URL` (default: Goldsky mainnet endpoint)
- ESM modules. Target Node 20+.
- Build with tsup. Output to `dist/`.

---

## Distribution

The MCP server is installable with zero config:

**Claude Code:**
```bash
claude mcp add fabrica -- npx @fabrica-land/mcp
```

**Claude Desktop (`claude_desktop_config.json`):**
```json
{
  "mcpServers": {
    "fabrica": {
      "command": "npx",
      "args": ["@fabrica-land/mcp"]
    }
  }
}
```

**Cursor (`.cursor/mcp.json`):**
```json
{
  "mcpServers": {
    "fabrica": {
      "command": "npx",
      "args": ["@fabrica-land/mcp"]
    }
  }
}
```

The `bin` field in package.json points to `dist/index.js` with a node shebang. The `files` field includes only `dist/`.

---

## Reference Repos

Access other Fabrica repos for deeper context when needed:

```bash
# List files in a repo
gh api "repos/fabrica-land/<repo>/git/trees/main?recursive=1" --jq '.tree[].path'

# Read a specific file
gh api repos/fabrica-land/<repo>/contents/<path> --jq '.content' | base64 -d
```

| Repo | What's There | When to Read |
|---|---|---|
| `fabrica-land/fabrica-v3-api` | Backend GraphQL API (NestJS). Resolvers, models, types. Has `CLAUDE.md`. | To understand exact query signatures, field types, filtering options |
| `fabrica-land/fabrica-v3-subgraph` | The Graph subgraph. Schema, mappings, event handlers. | To understand onchain data model, entity relationships, event indexing |
| `fabrica-land/fabrica-contracts` | Solidity smart contracts (ERC-1155). Has `CLAUDE.md`. | To understand onchain data structures, view functions, events |
| `fabrica-land/docs` | Public documentation (docs.fabrica.land). Property lifecycle, lending, legal. | To understand user-facing concepts, trust structure, lending mechanics |
| `fabrica-land/fabrica-connectors` | Legal trust agreement (v4.2). | To understand trust structure, beneficiary rights, ownership rules |
| `fabrica-land/fabrica-v3-rules` | Jurisdiction rules, county configs. Has `CLAUDE.md`. | To understand county-level data, deed templates, FIPS codes |
| `fabrica-land/soil-app` | Frontend (Next.js). Has `AGENTS.md` for voice/tone. | To see how the frontend queries the API, what fields it uses |

---

## Linear Project

Tickets for this project are tracked in Linear under the "Fabrica MCP Server" project (Engineering team). Check there for detailed specs on each tool including exact input schemas, return formats, and acceptance criteria.
