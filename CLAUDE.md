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

## Project Goal

Build 6 MCP tools that wrap Fabrica's existing public APIs:

| Tool | Purpose |
|---|---|
| `search_properties` | Search/filter tokenized properties by location, size, score, listings |
| `get_property` | Full property detail: legal, valuation, ownership, loans, media |
| `get_lending_market` | Lending overview: active loans, pool stats, yields, events |
| `get_portfolio` | Wallet holdings, credit history, loan positions |
| `get_protocol_stats` | Protocol-wide metrics: TVL, properties, loan volume |
| `get_property_map` | GeoJSON boundary data for mapping/spatial analysis |

All tools are read-only. No authentication required. Data comes from two public sources described below.

---

## Tech Stack

- TypeScript (strict mode)
- `@modelcontextprotocol/sdk` for the MCP server
- `graphql-request` for GraphQL clients
- `tsup` for building
- stdio transport (standard for MCP)
- Published as `@fabrica-land/mcp` on npm

---

## Project Structure

```
src/
  index.ts          # MCP server entrypoint
  tools/
    properties.ts   # search_properties, get_property, get_property_map
    lending.ts      # get_lending_market
    portfolio.ts    # get_portfolio
    protocol.ts     # get_protocol_stats
  clients/
    graphql.ts      # Fabrica GraphQL API client
    subgraph.ts     # Goldsky subgraph client
  types/
    index.ts        # Shared TypeScript interfaces
```

---

## Data Sources

### 1. Fabrica GraphQL API

The primary backend API. All queries below are PUBLIC (no auth required).

**Public Queries (no auth):**

- `token(network?, contractAddress?, tokenId?, slug?)` — Single property by ID or slug
- `tokens(network?, contractAddress?, ownedBy?, testnets?, premints?, burned?, minListings?, minScore?, sort?)` — List/filter properties
- `wallet(walletAddress, testnets?, premints?, network?, contractAddress?)` — Wallet holdings, credit history, value
- `user(walletAddress, network?)` — User profile
- `loans(network?, networkIn?, contractAddress?, first?, skip?)` — All loans with terms
- `loanStartedEvents(network?, networkIn?, first?, skip?)` — Loan initiation events
- `loanRepaidEvents(network?, networkIn?, first?, skip?)` — Loan repayment events
- `loanLiquidatedEvents(network?, networkIn?, first?, skip?)` — Loan liquidation events
- `marketplaceListings(networkName, contractAddress, tokenId, marketplace?, status?)` — Active sale listings
- `marketplaceBids(networkName, contractAddress, tokenId, minAmount?, marketplace?, status?)` — Active bids
- `marketplaceDisclosures(cid)` — Disclosure packages
- `scoringDescriptors()` — Confidence score rules
- `countyBounds(fips)` — County boundary GeoJSON by FIPS code
- `balances(network?, networkIn?, first?, skip?)` — Token balances

**Key Return Types:**

`TokenModel` fields: tokenId, network, contractAddress, name, vanityName, propertyLink, coordinates, geoJson, isPremint, isClaimedPremint, isBurned, lastOwner, configuration, definition, operatingAgreement, metadataUri, supply, majorOwner, balances, transfers, score, scoringCheckResults, validator, marketplaceBids, marketplaceListings, pricing, estimatedValue, imageUrlDark, imageUrlLight, marketplacePrice, cardDisplayValuation, loanOffers, metaStreetLiquidity, loans, fiatTransactions, booleanTraits, decimalTraits, stringTraits, acres, country, countryCode, region, regionCode, postCode, district, place, locality, neighborhood, street, address, activity

`WalletModel` fields: walletAddress, displayName, profilePath, tokens, activity, walletCreditHistory, walletValue, loanOfferCount, marketplaceOrderCount

`LoanModel` fields: loanId, collateralToken, borrower, lender, principalAmount, principalAsset, interestRate, repaymentDate, status, createdAt, liquidatedAt

**Queries requiring auth (NOT used in Phase 1):** onRamp, offRamp, clientConfig, buildUnsignedMarketplaceOrder, getMarketplaceFulfillmentPermission, all mutations.

**Reference repo:** `fabrica-land/fabrica-v3-api` (NestJS + GraphQL). Key files for schema reference:
- `src/token/token.resolver.ts` — Token query definitions
- `src/token/token.model.ts` — Token field definitions
- `src/loan/loan.resolver.ts` — Loan query definitions
- `src/wallet/wallet.resolver.ts` — Wallet query definitions
- `src/marketplace/marketplace.resolver.ts` — Marketplace query definitions

### 2. Goldsky Subgraph (Onchain Data)

Raw onchain data indexed from Ethereum. Public GraphQL endpoint.

**Endpoints:**
- Ethereum mainnet: `https://api.goldsky.com/api/public/project_cmgx8wuc60031tlp27berclwq/subgraphs/fabrica-ethereum/v1.2.1/gn`
- Sepolia testnet: `https://api.goldsky.com/api/public/project_cmgx8wuc60031tlp27berclwq/subgraphs/fabrica-sepolia/v1.2.1/gn`
- Base Sepolia: `https://api.goldsky.com/api/public/project_cmgx8wuc60031tlp27berclwq/subgraphs/fabrica-base-sepolia/v1.2.1/gn`

**MetaStreet Pool subgraph (for lending pool data):**
- Ethereum: `https://api.goldsky.com/api/public/project_cmgziqwja00105np2g1gy6stc/subgraphs/v2-pools-mainnet/3.13.2/gn`
- Sepolia: `https://api.goldsky.com/api/public/project_cmgziqwja00105np2g1gy6stc/subgraphs/v2-pools-sepolia/3.13.1/gn`

**Key Entities:**

`Token`: id, contractAddress, tokenId, uri, creator, supply, balances, sales, configuration, configurationUrl, definition, definitionUrl, operatingAgreement, booleanTraits, decimalTraits, stringTraits, mintTimestamp, network

`Loan`: id, loanId, loanContract, borrower, lender, loanProvider, loanPrincipalAmount, loanDuration, loanStartTime, loanMaturityDate, loanInterestRateForDurationInBasisPoints, loanAdminFeeInBasisPoints, loanStatus (ActiveOrDefault/Liquidating/Liquidated/Repaid), nftCollateralContract, nftCollateralId, pool, ticks, useds, maximumRepaymentAmount, amountPaidToLender, adminFeePaid, erc20Denomination, network

`Pool` (MetaStreet): id, implementation, collateralToken, currencyToken, totalValueLocked, totalValueUsed, totalValueAvailable, durations, rates, maxBorrows, loansOriginated, loansActive, loansRepaid, loansLiquidated, adminFeeRate, ticks, deposits, loans

`User`: id, address, network, borrowing, lending, tokens, created, promissoryNotes, obligationReceipts

`Transfer`: token, from, to, operator, value, transactionHash, blockNumber, blockTimestamp

`Sale`: token, seller, buyer, currencyAddress, currencyAmount, supply

`LoanStartedEvent`: loan, borrower, lender, loanPrincipalAmount, loanDuration, loanStartTime, loanInterestRateForDurationInBasisPoints, network, transactionHash, blockNumber, blockTimestamp

`LoanRepaidEvent`: loan, borrower, lender, amountPaidToLender, adminFee, revenueShare, loanPrincipalAmount, network

`LoanLiquidatedEvent`: loan, borrower, lender, newOwner, loanLiquidationDate, loanPrincipalAmount, proceeds, network

**Filtering:** All entities support `_eq`, `_not`, `_gt`, `_lt`, `_gte`, `_lte`, `_in`, `_not_in`, `_contains`, `_starts_with`, `_ends_with` (and `_nocase` variants). Sorting via `orderBy` + `orderDirection`. Pagination via `first` (max 1000) + `skip`.

**Reference repo:** `fabrica-land/fabrica-v3-subgraph`. Key file: `schema.graphql`

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

**Contract interface reference:** `fabrica-land/fabrica-contracts/src/IFabricaToken.sol`

Key view function:
```solidity
function _property(uint256 tokenId) external view returns (
    uint256 supply,
    string memory operatingAgreement,
    string memory definition,
    string memory configuration,
    address validator
);
```

---

## MCP Tool Design Principles

1. **Concise responses.** LLMs have limited context. Return structured summaries, not raw API dumps. Trim unnecessary fields. Format monetary values as human-readable strings ("$12,500" not "12500000000").

2. **Helpful errors.** "No property found with token ID 12345" not stack traces. Empty results are not errors.

3. **Sensible defaults.** Default to mainnet, default limit 20, default to non-burned active tokens.

4. **Composable.** Tools should chain naturally. An agent should be able to search_properties, pick one, then get_property on it, then check get_lending_market for that borrower.

5. **Lean queries.** Only request GraphQL fields that the tool actually returns. Don't fetch entire token objects when you need 5 fields.

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

## Code Style

- Strict TypeScript. No `any`. No `as` casts.
- Prefer `const` and immutable patterns.
- Keep functions concise. No blank lines between statements inside functions.
- Error handling: catch errors, return helpful messages to the agent, never throw raw errors.
- Use environment variables for configuration with sensible defaults:
  - `FABRICA_API_URL` (default: production GraphQL endpoint)
  - `FABRICA_SUBGRAPH_URL` (default: mainnet Goldsky endpoint)
- ESM modules. Target Node 20+.
- Build with tsup. Output to `dist/`.

---

## Distribution

The MCP server should be installable with zero config:

**Claude Code:**
```bash
claude mcp add fabrica-mcp -- npx @fabrica-land/mcp
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

The `bin` field in package.json should point to `dist/index.js` with a node shebang. The `files` field should include only `dist/`.

---

## Linear Project

Tickets for this project are tracked in Linear under the "Fabrica MCP Server" project (Engineering team). Check there for detailed specs on each tool including exact input schemas, return formats, and acceptance criteria.
