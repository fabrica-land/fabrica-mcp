# Fabrica MCP Server

An MCP server giving AI agents read-only access to tokenized real property data on the Fabrica protocol.

## What is Fabrica?

Fabrica tokenizes real property (land) as ERC-1155 NFTs on Ethereum. A legal trust holds title at the county level. The token controls the trust. Transfer the token, transfer ownership.

- Platform: https://fabrica.land
- Docs: https://docs.fabrica.land
- Dune: https://dune.com/fabrica/dashboard

---

## Project Structure

```
src/
  config.ts           # Network config, contract addresses, legal notices
  index.ts            # MCP server entrypoint — registers all 9 tools
  tools/
    properties.ts     # search_properties, get_property, get_property_map
    lending.ts        # get_lending_market
    portfolio.ts      # get_portfolio
    protocol.ts       # get_protocol_stats
    scoring.ts        # explain_confidence_score
    borrowing.ts      # get_borrow_quote
    activity.ts       # get_activity
  clients/
    graphql.ts        # Fabrica GraphQL API client (primary data source)
    subgraph.ts       # MetaStreet pool subgraph client (dynamic pool discovery)
  types/
    index.ts          # Shared TypeScript interfaces
  __tests__/          # vitest test suite
```

---

## Tech Stack

- TypeScript (strict mode), ESM, Node 20+
- `@modelcontextprotocol/sdk` (`McpServer` class with `zod` schemas, stdio transport)
- `graphql-request` for GraphQL clients
- `tsup` for building (ESM, `dts: false` due to TS6 deprecation)
- `vitest` for testing
- Not yet published to npm — installed from source

---

## Data Sources

### 1. Fabrica GraphQL API (Primary)

**Endpoint:** `https://api.fabrica.land/graphql` (Apollo Server, public, no auth)

The Apollo API routes subgraph data internally, so all onchain and offchain property data is available through it.

**Key API behaviors:**

- **`tokens` query has NO `first`/`skip` pagination.** Returns all matching tokens. Pagination is client-side.
- **Nested fields `loans`, `marketplaceListings`, `marketplaceBids` are NOT available on list queries** (tokens list, wallet.tokens). Use scalar fields (`supplyUnderLoan`, `marketplacePrice`, `loanOfferCount`) instead. Nested fields only work on single `token()` queries.
- **`loans` query requires `network` or `networkIn`** — errors without one.
- **`loanStartedEvents`, `loanRepaidEvents`, `loanLiquidatedEvents` require `first!` and `skip!`** (non-nullable).
- **Score is a raw integer** (e.g. 73242). Kept as-is. The `minScore` filter expects this integer scale.
- **`estimatedValue` is a string decimal** (e.g. "396647.43"). `acres` is also a string.

**Field naming (differs from what you might guess):**
- WalletModel: `address` (not `walletAddress`), `creditHistory` (not `walletCreditHistory`), `displayName` on nested `user`
- LoanModel: `loanStatus` (not `status`), `principalScaled` (not `principalAmount`), `aprPercent` (not `interestRate`), `maturityDate` (not `repaymentDate`)

### 2. MetaStreet Pool Subgraph (Supplementary)

**Mainnet:** `https://api.goldsky.com/api/public/project_cmgziqwja00105np2g1gy6stc/subgraphs/v2-pools-mainnet/3.13.2/gn`
**Sepolia:** `https://api.goldsky.com/api/public/project_cmgziqwja00105np2g1gy6stc/subgraphs/v2-pools-sepolia/3.13.2/gn`

Used for MetaStreet pool TVL, utilization, and loan count data. **Pools are discovered dynamically** by querying all pools that accept the Fabrica collateral token — no hardcoded pool IDs. Mainnet has 1+ pools, Sepolia has 2. Pool values are in 18-decimal format.

---

## Network Support

Configured via `FABRICA_NETWORK` env var (default: `ethereum`).

| | Ethereum Mainnet | Sepolia Testnet |
|---|---|---|
| Properties | Real US land parcels | Test tokens only |
| Legal consequences | Yes — trustee role, taxes, liabilities | None |
| MetaStreet | Active (1+ pools) | Active (2 pools) |
| NFTfi | Active | Not available |
| Legal notices in responses | Yes | No |

On mainnet, the server's `instructions` field tells agents to inform users about real-world legal consequences and to review the trust instrument attached to tokens before advising on acquisition.

---

## Smart Contract Addresses

Defined in `src/config.ts`. MetaStreet pools are discovered dynamically from the subgraph.

**Ethereum Mainnet:**
- FabricaToken (ERC-1155): `0x5cbeb7A0df7Ed85D82a472FD56d81ed550f3Ea95`
- FabricaValidator: `0x170511f95560A1F280c29026f73a9cD6a4bA8ab0`
- NFTfi V2.3: `0xd0a40eB7FD94eE97102BA8e9342243A2b2E22207`
- NFTfi V3: `0x9F10D706D789e4c76A1a6434cd1A9841c875C0A6`

**Sepolia Testnet:**
- FabricaToken: `0xb52ED2Dc8EBD49877De57De3f454Fd71b75bc1fD`
- FabricaValidator: `0xAAA7FDc1A573965a2eD47Ab154332b6b55098008`

---

## Spam Filtering

Tokens on the smart contract include spam/errored entries. The MCP filters them out:

- **`minScore: 2142`** — default threshold matching the frontend, filters out tokens without basic validation
- **Name filtering** — client-side exclusion of tokens with names like `SyntaxError`, `Error`, `BadGatewayException`
- Default query filters: `burned: false`, `premints: false`, `testnets: false` (mainnet) / `true` (sepolia)

The `minScore` can be overridden by users in `search_properties`.

---

## Confidence Score

A 5-digit positional integer where each digit represents a verification group:

| Position | Group | Max | Weight |
|---|---|---|---|
| Ten-thousands | Recovery status | 7 | ×10000 |
| Thousands | Past title & load | 5 | ×1000 |
| Hundreds | Ownership | 3 | ×100 |
| Tens | On-chain history | 4 | ×10 |
| Ones | Basic validation | 2 | ×1 |

**Max score: 75342.** Recovery digit: 7=normal, 6=under review, 5=recovery, 1=voided.

---

## MCP Tool Design Principles

1. **Concise responses.** Return structured summaries, not raw API dumps. Format monetary values as "$12,500".
2. **Helpful errors.** "No property found with token ID 12345" not stack traces.
3. **Sensible defaults.** Default limit 20, non-burned active tokens, spam filtered.
4. **Composable.** Tools chain naturally: search → get_property → get_borrow_quote.
5. **Lean queries.** Only request fields that the tool returns. Respect list query restrictions.
6. **Score as raw integer.** Never normalize confidence scores.
7. **Network-aware.** Single network per session. Mainnet responses include legal notices.

---

## Code Style

- Strict TypeScript. No `any`. No `as` casts.
- Prefer `const` and immutable patterns.
- Keep functions concise. No blank lines between statements inside functions.
- Error handling: catch errors, return helpful messages, never throw raw errors.
- Environment variables with sensible defaults:
  - `FABRICA_NETWORK` (default: `ethereum`)
  - `FABRICA_API_URL` (default: `https://api.fabrica.land/graphql`)
  - `FABRICA_METASTREET_SUBGRAPH_URL` (default: auto-selected per network)

---

## Testing

Run tests with `npm test` (vitest). Tests cover config, scoring, spam filtering, pool aggregation, legal notices, formatting, and input validation. Tests mock the GraphQL clients — no live API calls.

---

## Distribution

Not yet published to npm. Install from source:

```bash
git clone https://github.com/fabrica-land/fabrica-mcp.git
cd fabrica-mcp && npm install && npm run build
```

Then configure your MCP client with `node /path/to/fabrica-mcp/dist/index.js`.

---

## Reference Repos

```bash
gh api "repos/fabrica-land/<repo>/git/trees/main?recursive=1" --jq '.tree[].path'
gh api repos/fabrica-land/<repo>/contents/<path> --jq '.content' | base64 -d
```

| Repo | What's There | When to Read |
|---|---|---|
| `fabrica-land/fabrica-v3-api` | Backend GraphQL API (NestJS). Has `CLAUDE.md`. | Query signatures, field types, auth guards, mutations |
| `fabrica-land/fabrica-contracts` | Solidity smart contracts (ERC-1155). Has `CLAUDE.md`. | Onchain data structures, view functions, events |
| `fabrica-land/docs` | Public documentation (docs.fabrica.land). | User-facing concepts, trust structure, lending mechanics |
| `fabrica-land/soil-app` | Frontend (Next.js). Has `AGENTS.md`. | How the frontend queries the API, signing flows |
| `fabrica-land/fabrica-connectors` | Legal trust agreement (v4.2). | Trust structure, beneficiary rights |
| `fabrica-land/fabrica-v3-rules` | Jurisdiction rules, county configs. Has `CLAUDE.md`. | County-level data, deed templates, FIPS codes |

---

## Linear Projects

- **Fabrica MCP Server** — Phase 1 read-only tools (complete)
- **MCP Write Operations** — Phase 2 transactional tools (backlog, requires backend wallet-signature auth)
