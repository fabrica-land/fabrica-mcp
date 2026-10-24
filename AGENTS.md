# Fabrica MCP Server

An MCP server giving AI agents read-only access to tokenized real property data on the Fabrica protocol.

## What is Fabrica?

Fabrica tokenizes real property (land) as ERC-1155 NFTs on Ethereum. A legal trust holds title at the county level, and the token represents the beneficial interest in that trust: owning the token means owning the beneficial interest in the trust that holds the property.

- Platform: https://fabrica.land
- Docs: https://docs.fabrica.land
- Company overview: https://about.fabrica.land
- Dune: https://dune.com/fabrica/dashboard

---

## Project Structure

```
src/
  config.ts           # Network config, contract addresses, legal notices
  server.ts           # createServer(): registers every tool
  prompts.ts          # MCP prompts (due_diligence, work_parcel_list, wallet_review, how_to_add_land)
  index.ts            # stdio entrypoint (local installs)
  http.ts             # stateless Streamable HTTP handler (hosted)
  usage-log.ts        # one structured log line per request, no arguments or IPs (docs/usage/)
  vercel.ts           # Vercel function entry, bundled by scripts/build-vercel.mjs
  auth/
    config.ts         # Connect Fabrica (OAuth resource server): FABRICA_OAUTH flag, issuer per network, the /mcp/account resource
    token.ts          # access-token checks (ES256 JWT, issuer, audience, expiry, at+jwt) against the issuer's JWKS; never logged
  ui/property-card.ts # registers the property card MCP App resource (ui://fabrica/property-card)
  ui/generated/       # gitignored: HTML built from /ui by scripts/build-ui.mjs
server.json, server.testnet.json # MCP Registry entries (land.fabrica/mcp, land.fabrica/mcp-testnet); npm run registry:publish
skills/fabrica/SKILL.md # Agent Skills file, served at /skill.md by scripts/build-vercel.mjs; keep it in step with the tools
ui/
  property-card/      # the MCP App view (index.html template + app.ts), bundled with the
                      # MCP Apps SDK into one self-contained HTML string (no CDN scripts).
                      # view.ts: layout from the host context (compact under 480 px or on a
                      # phone, regular otherwise), hover, safe areas, fact lines; unit tested
  fonts/              # Open Sauce Two (OFL) subset, served at /fonts by the hosted server
  tools/
    properties.ts     # search_land, get_land_property, get_land_boundary
    lending.ts        # get_fabrica_lending_market
    loan-book.ts      # get_fabrica_loan_book (distribution of the loan records; no auction proceeds or per-loan liquidation rows)
    portfolio.ts      # get_land_portfolio
    protocol.ts       # get_fabrica_stats
    scoring.ts        # explain_property_checks
    borrowing.ts      # estimate_land_borrowing
    valuation.ts      # get_land_valuation (GraphQL GetValuation + REST /valuation/v1)
    activity.ts       # get_land_activity
    marketplace.ts    # get_land_order_book
    images.ts         # get_land_map_image, get_land_portfolio_map_image
    documents.ts      # get_land_trust_documents
    tax.ts            # get_land_tax_status (also the taxes line on get_land_property)
    knowledge.ts      # ask_fabrica
    parcels.ts        # find_us_parcel (Regrid type-ahead via the API, /go on-ramp link, per-client limit)
    coverage.ts       # check_county_coverage (static on-ramp rules table in src/data/onramp-coverage.json, built by scripts/build-coverage.mjs)
    support.ts        # contact_fabrica_support (help center link, support email, prefilled mailto; nothing sent)
    sign-requests.ts  # make_land_offer, list_land_for_sale, accept_land_offer, buy_land, cancel_land_order (prepare a sign request), get_sign_request
    loans.ts          # borrow_against_land, repay_land_loan (sign requests), get_land_loan (GetLoanContext, never cached)
    transactions.ts   # get_transaction_status (JSON-RPC reads only)
    account.ts        # get_my_account, get_my_properties (signed-in endpoint /mcp/account only, the connected user's own token)
    attention.ts      # what_needs_attention (signed-in endpoint only; ranks items from the other personal reads plus fees and checks on up to 20 live properties)
    my-loans.ts       # get_my_loans (signed-in endpoint only, portfolio:read; loans with live payoff, pool deposits valued at tick prices)
    offers.ts         # get_my_offers (signed-in endpoint only, portfolio:read; public order data for the account's wallets)
    onramps.ts        # get_my_properties_being_added, get_adding_status (signed-in endpoint only, onramp:read)
    own-wallet.ts     # On the signed-in endpoint, fills wallet arguments from the account (omitted or "me"; portfolio:read); public reads otherwise unchanged
    inputs.ts         # zod pieces shared by the tools' input schemas (property reference, image size)
  knowledge/
    index.ts          # typed, validated loader for generated/index.json (committed)
    search.ts         # BM25 retrieval with Fabrica synonyms and compound-term normalization
    facts.ts          # wording red lines the tests check the top passages against
    documents.ts      # whole documents reassembled from the index, for resources
  resources/
    knowledge.ts      # fabrica://docs, fabrica://help, fabrica://legal, fabrica://property/{tokenId}/trust-agreement, fabrica://network
  # scripts/build-knowledge.mjs builds the index; scripts/knowledge-diff.mjs and
  # .github/workflows/refresh-knowledge.yml open the daily refresh pull request
  clients/
    graphql.ts        # Fabrica GraphQL API client (primary data source)
    account.ts        # personal reads with the connected user's token (never cached, never on anonymous calls)
    rpc.ts            # Ethereum JSON-RPC reads (transaction, receipt, block number) for get_transaction_status
    generated/        # operations.ts: one result type per gql document, from scripts/codegen.mjs (committed; npm run codegen)
    subgraph.ts       # Lending pool subgraph client (dynamic pool discovery)
    cache.ts          # Short-TTL read cache with in-flight de-duplication (TtlCache)
    budgets.ts        # Read budgets (loan page budget, MAX_LOANS)
  data/
    us-counties.ts    # Regrid county paths to FIPS and name (copied from soil-app's /go table)
  sign-requests/
    store.ts          # SignRequestStore: Vercel KV / Upstash REST (or an in-process map locally), HMAC-checked records, 15-minute expiry
    http.ts           # GET /sign-requests/{id} and POST /sign-requests/{id}/result for the Soil sign page
  vercel-sign-requests.ts # Vercel function entry for /sign-requests
  well-known.ts       # /.well-known/mcp.json, /.well-known/mcp/server-card.json, /.well-known/ai-catalog.json (card read from a live in-process server)
  vercel-well-known.ts # Vercel function entry for /.well-known
  lifecycle.ts        # propertyStage(): unclaimed, being_added, replaced, live, removal_in_progress, removed, retired
  fees.ts             # fees assessed on a token, by currency address
  types/
    index.ts          # Names for the generated operation types (TokenListItem, TokenDetail, WalletModel...) plus the REST and subgraph shapes
  __tests__/          # vitest test suite
```

---

## Tech Stack

- TypeScript (strict mode), ESM, Node 20+
- `@modelcontextprotocol/sdk` (`McpServer` class with `zod` schemas, stdio transport)
- `graphql-request` for GraphQL clients
- `tsup` for building (ESM, `dts: false` due to TS6 deprecation)
- `vitest` for testing
- Not published to npm: the hosted server is the only supported distribution (`package.json` is `private`)

---

## Data Sources

### 1. Fabrica GraphQL API (Primary)

**Endpoint:** `https://api.fabrica.land/graphql` (Apollo Server, public, no auth)

The Apollo API routes subgraph data internally, so all onchain and offchain property data is available through it.

**Key API behaviors:**

- **`tokens` query has NO `first`/`skip` pagination.** Returns all matching tokens. Pagination is client-side.
- **Marketplace orders:** unfiltered `token.marketplaceListings` / `marketplaceBids` return every status (active, encumbered, pending, expired, canceled, filled), and `marketplaceBidCount` counts expired offers too. `get_land_order_book` filters client-side and treats a live order past its `endTime` as expired. `price` is the raw onchain amount (scale by `decimals`); `usdPrice` is dollars. `encumbrance` is set per listing when the property is collateral for a loan; `buyable` and `blockReason` say whether that listing can be bought now (a `LEGACY_POOL` loan cannot be paid off by a third party).
- **Nested fields `loans`, `marketplaceListings`, `marketplaceBids` are NOT available on list queries** (tokens list, wallet.tokens). Use scalar fields (`supplyUnderLoan`, `marketplacePrice`) instead. Nested fields only work on single `token()` queries.
- **`loans` query requires `network` or `networkIn`** — errors without one.
- **`loanStartedEvents`, `loanRepaidEvents`, `loanLiquidatedEvents` require `first!` and `skip!`** (non-nullable).
- **Score is a raw integer** (e.g. 73242). Kept as-is. The `minScore` filter expects this integer scale.
- **`estimatedValue` is a string decimal** (e.g. "396647.43"). `acres` is also a string.

- **Lifecycle fields are anonymous-safe:** `claimState` (premints only), `supersededByTokenId`, `offRampStatus` (`in-progress` / `complete`, null for premints), `duplicateParcelCount` (null for premints), `fishy` (never true for premints), `fees` (currency is a contract address; amount in its raw units; timestamps mix ISO and epoch ms). `token.onRamp` is null without auth. A premint replaced by a minted token no longer loads (`No token or premint found`); `premintSuccessor` returns the live token.

**Field naming (differs from what you might guess):**
- WalletModel: `address` (not `walletAddress`), `creditHistory` (not `walletCreditHistory`), `displayName` on nested `user`
- LoanModel: `loanStatus` (not `status`), `principalScaled` (not `principalAmount`), `aprPercent` (not `interestRate`), `maturityDate` (not `repaymentDate`)

### 2. Lending Pool Subgraph (Supplementary)

**Mainnet:** `https://api.goldsky.com/api/public/project_cmgziqwja00105np2g1gy6stc/subgraphs/v2-pools-mainnet/3.13.2/gn`
**Sepolia:** `https://api.goldsky.com/api/public/project_cmgziqwja00105np2g1gy6stc/subgraphs/v2-pools-sepolia/3.13.1/gn`

Used for DeFi lending pool TVL, utilization, and loan count data. Its `loansLiquidated` counter undercounts on mainnet, so `get_fabrica_loan_book` counts from the loan records and shows the pool counters next to them. The subgraph, the env var and some internal identifiers keep the MetaStreet name for historical reasons; public-facing text says DeFi lending pool. **Pools are discovered dynamically** by querying all pools that accept the Fabrica collateral token — no hardcoded pool IDs. Mainnet has 1+ pools, Sepolia has 10 (2026-10). Pool values are in 18-decimal format.

### 3. Fabrica Media Service (Images)

**Endpoint:** `https://media.fabrica.land/{network}/{contractAddress}/{tokenIdOrWalletAddress}/image`

Public, no auth. Returns a 308 redirect to a Mapbox Static Images API URL. Supports query params: `theme` (dark/light), `width`, `height`. Used by `get_land_map_image` and `get_land_portfolio_map_image` tools — the MCP fetches the image and returns it inline as base64.

Override with `FABRICA_MEDIA_URL` env var.

---

## Network Support

Configured via `FABRICA_NETWORK` env var (default: `ethereum`).

| | Ethereum Mainnet | Sepolia Testnet |
|---|---|---|
| Properties | Real US land parcels | Test tokens only |
| Legal consequences | Yes: beneficial interest in a trust, holder is trustee by default, taxes, liabilities | None |
| DeFi lending pool | Active (1+ pools) | Active (10 pools) |
| NFTfi (peer-to-peer) | Retired integration; historical loans only | Not available |
| Legal notices in responses | Yes | No |

On mainnet, the server's `instructions` carry `MAINNET_LEGAL_NOTICE` (src/config.ts): the legal facts, stated as a notice, never as directions to the model.

---

## Smart Contract Addresses

Defined in `src/config.ts`. Lending pools are discovered dynamically from the subgraph.

**Ethereum Mainnet:**
- FabricaToken (ERC-1155): `0x5cbeb7A0df7Ed85D82a472FD56d81ed550f3Ea95`
- FabricaValidator: `0x170511f95560A1F280c29026f73a9cD6a4bA8ab0`
- NFTfi V2.3 (retired integration, historical loans only): `0xd0a40eB7FD94eE97102BA8e9342243A2b2E22207`
- NFTfi V3 (retired integration, historical loans only): `0x9F10D706D789e4c76A1a6434cd1A9841c875C0A6`

**Sepolia Testnet:**
- FabricaToken: `0xb52ED2Dc8EBD49877De57De3f454Fd71b75bc1fD`
- FabricaValidator: `0xAAA7FDc1A573965a2eD47Ab154332b6b55098008`

---

## Spam Filtering

Tokens on the smart contract include spam/errored entries. The MCP filters them out:

- **`minScore: 72032`**: default threshold matching the frontend marketplace (public listings and protocol stats). The API pairs any `minScore` with a verified-deed requirement, so this leaves out properties the marketplace would not sell, including any whose recovery status is not Normal. `search_land` with `ownedBy` and no `minScore` lists every property in that wallet, like the owner's holdings on the frontend; `get_land_portfolio` applies no score filter
- **Name filtering** — client-side exclusion of tokens with names like `SyntaxError`, `Error`, `BadGatewayException`
- Default query filters: `burned: false`, `premints: false`, `testnets: false` (mainnet) / `true` (sepolia)

The `minScore` can be overridden by users in `search_land`.

---

## Property checks (5-digit numeric encoding)

The feature is called **Property checks** in every description and output. The API's `score` field (and `confidenceScore`, `explain_property_checks`) keep their names as identifiers; in prose the number is "the numeric encoding of Property checks", a 5-digit positional integer where each digit represents a verification group:

| Position | Group | Max | Weight |
|---|---|---|---|
| Ten-thousands | Recovery status | 7 | ×10000 |
| Thousands | Past title & load | 5 | ×1000 |
| Hundreds | Ownership | 3 | ×100 |
| Tens | Onchain history | 4 | ×10 |
| Ones | Basic validation | 2 | ×1 |

**Max: 75342.** Recovery digit (as the API defines it): 7=Normal, 6=Recovery pending, 5=Reported stolen, 4=Tax sale or foreclosure (Distressed), 1=Void.

Each digit is a category value set by its group's rules, not a count of passing checks: never label a digit "x/y checks pass". Pass counts come from the individual results (`scoringCheckResults`), which `get_land_property` returns as `propertyChecks { passed, total, encoding, results }` and the property card shows as "9 of 12 pass", like fabrica.land. The deprecated `valuation.confidenceScore` and `valuation.scoreBreakdown` aliases were removed (payload size); `propertyChecks` is the only copy.

Naming rule: "Property checks" is the name; the number is "the numeric encoding of Property checks". Never call it a score, rating or percentage in user-facing text. Where checks are introduced, say they are a starting point for your own research, not a title search or title insurance.

---

## MCP Tool Design Principles

1. **Concise responses.** Return structured summaries, not raw API dumps. Format monetary values as "$12,500".
2. **Helpful errors.** "No property found with token ID 12345" not stack traces.
3. **Sensible defaults.** Default limit 20, non-burned active tokens, spam filtered.
4. **Composable.** Tools chain naturally: search → get_land_property → estimate_land_borrowing.
5. **Lean queries.** Only request fields that the tool returns. Respect list query restrictions.
6. **Property checks number as raw integer.** Never normalize it, and never present it as a percentage, grade or rating.
7. **Network-aware.** Single network per session. Mainnet responses include legal notices.
8. **Directory-ready registration.** Register tools with `server.registerTool` (never the deprecated `server.tool`), each with a `title` and `annotations` (`readOnlyHint: true` for reads, `destructiveHint` set explicitly). Descriptions and server instructions state facts; they never direct the model ("you must…"). Error results set `isError`. `src/__tests__/http.test.ts` enforces this.

---

## Code Style

- Strict TypeScript. No `any`. No `as` casts (tests included: a fixture is built by a typed helper, never `as never`).
- Each tool exports its zod input shape next to its function (`searchPropertiesInput`) and takes `ArgsOf<typeof thatShape>` (`src/tools/inputs.ts`); `server.ts` registers the exported shape. The handler's parameter type and the schema the client sees come from one definition, so a tool never reads `args` as `Record<string, unknown>`.
- API result types come from the queries: `npm run codegen` (`scripts/codegen.mjs`, driving `@graphql-codegen/core` directly so the toolchain stays on Node 20) regenerates `src/clients/generated/operations.ts` from `schema/api-schema.graphql` and the `gql` documents in `src/clients/graphql.ts`. Run it after changing a query or refreshing the schema and commit the result; CI fails on a stale file (`npm run codegen:check`). A field is in a type exactly when the query selects it, so a new field means adding it to the query, not to a hand-written interface.
- Prefer `const` and immutable patterns.
- Keep functions concise. No blank lines between statements inside functions.
- Error handling: catch errors, return helpful messages, never throw raw errors.
- Environment variables with sensible defaults:
  - `FABRICA_NETWORK` (default: `ethereum`)
  - `FABRICA_API_URL` (default: `https://api.fabrica.land/graphql`)
  - `FABRICA_METASTREET_SUBGRAPH_URL` (default: auto-selected per network)
  - `FABRICA_MEDIA_URL` (default: `https://media.fabrica.land`)
  - `FABRICA_WEB_URL` (default: `https://fabrica.land`, `https://testnets.fabrica.land` on Sepolia): on-ramp links and the APN parcel lookup in `find_us_parcel`
  - `FABRICA_CACHE_TTL_MS` (default: `30000`; `0` disables): how long API and subgraph reads are cached in the process. Every hosted user shares one per-IP API rate limit, so repeated and concurrent identical reads are served once. Tests run with `0` (`vitest.config.ts`)
  - `FABRICA_MCP_APPS` (default: on for Sepolia, off for mainnet): the property card MCP App
  - `FABRICA_SIGN_REQUESTS` (default: on for Sepolia, off for mainnet): the sign-request tools (make_land_offer, list_land_for_sale, accept_land_offer, buy_land, cancel_land_order, get_sign_request, get_transaction_status)
  - `KV_REST_API_URL` and `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`) with `SIGN_REQUEST_SECRET`: the sign-request store. On Vercel without them the sign-request tools report "not configured"; locally an in-process map is used
  - `FABRICA_RPC_URL` (default: publicnode for the network): JSON-RPC endpoint for get_transaction_status and the sign-request result check
  - `FABRICA_OAUTH` (default: off on both networks): Connect Fabrica. `enabled` serves the signed-in endpoint `/mcp/account` (401 with an RFC 9728 challenge without a token) and `/.well-known/oauth-protected-resource[/mcp/account]`; off, both answer 404 and `/mcp` is unchanged
  - `FABRICA_OAUTH_ISSUER` (default: `https://api.fabrica.land`, `https://api-test.fabrica.land` on Sepolia), `FABRICA_OAUTH_JWKS_URL` (default: the issuer's `/.well-known/jwks.json`), `FABRICA_MCP_ORIGIN` (default: `https://mcp.fabrica.land`, `https://mcp-testnet.fabrica.land` on Sepolia; the token audience is `<origin>/mcp/account`)
  - `FABRICA_OAUTH_JWKS` (Sepolia and local only, ignored on mainnet): inline public JWKS for the mocked issuer; `node scripts/oauth-mock-issuer.mjs` prints one with a matching access token and can serve a mock `GET /oauth/account`

---

## Testing

Run tests with `npm test` (vitest). Tests cover config, scoring, spam filtering, pool aggregation, legal notices, formatting, and input validation. Tests mock the GraphQL clients — no live API calls. `src/__tests__/schema-drift.test.ts` validates every document against the schema snapshot, and `npm run codegen:check` keeps the generated result types in step with them.

---

## Distribution

**Hosted:** `https://mcp.fabrica.land/mcp` (mainnet) and `https://mcp-testnet.fabrica.land/mcp` (Sepolia). Two Vercel projects on this repo, each with `FABRICA_NETWORK` set in its environment; `npm run build:vercel` writes a Build Output API bundle (`.vercel/output`). Stateless: a fresh server and transport per POST, JSON responses, no sessions. Keep it that way unless a feature truly needs sessions.

**Local (unsupported, for development):** `npm install && npm run build`, then `node dist/index.js` (stdio). The package is not published to npm.

---

## Public References

| Source | What's There |
|---|---|
| https://docs.fabrica.land | User-facing concepts, trust structure, lending mechanics |
| https://api.fabrica.land/graphql | The public GraphQL API (introspection enabled). `schema/api-schema.graphql` is a checked-in snapshot; refresh with `npm run schema:refresh` |
| `fabrica-land/fabrica-v3-contracts` | The public Solidity smart contracts (ERC-1155): onchain data structures, view functions, events |
| `fabrica-land/fabrica-connectors` | The trust agreement: trust structure, beneficiary rights |

This repository is public. Code, comments, docs, tests, commit messages and pull request titles carry no internal tracker ids (Linear `ENG-…`, `ASK-…`), no internal names or decisions, no business numbers and no credentials; describe the behavior instead. `src/__tests__/public-repo.test.ts` fails on a tracker id in a tracked file; commit messages and pull request titles follow the rule by review, and commits made before the rule are left as they are. The API's own schema descriptions (`schema/api-schema.graphql`, `src/clients/generated/`) are copied verbatim and exempt.

---

## Public Wording Rules

Tool descriptions and outputs are read by agents and repeated to people, so they follow Fabrica's public wording:

- The in-app pool is the **DeFi lending pool** (pool-based lending; "Fabrica lending pool" is retired). Do not present MetaStreet as a live venue in descriptions or output text; code identifiers may keep the name.
- NFTfi is a **retired** peer-to-peer integration. Mention it only as historical and labeled (see `src/labels.ts`).
- Never output a platform-wide or aggregate repayment rate. Loan counts are fine. A single wallet's own repayment percentage shown next to its counts (`get_land_portfolio`) is fine.
- The per-property verification feature is **Property checks**. Not "confidence score", "Provenance Score" or "token score" as a name (the `explain_property_checks` tool and the `score` / `confidenceScore` fields keep their identifiers). The valuation "confidence level" is a different signal and keeps its name.
- Fabrica is not a party to the trust, never holds title and never custodies property. Never write that Fabrica manages, administers, operates, controls, oversees, handles or holds someone's trust, property or loan.
- No fixed time unit and no "instantly" for money moving (sale proceeds, loans, payoffs, withdrawals).
- Stablecoins are "digital dollars"; Fabrica counts one USDC as one dollar. Never promise the coin's value ("always equal $1").
- Write "onchain" as one word. No em dashes in descriptions or output text (`http.test.ts` checks descriptions and instructions).
- Use the product names people see on fabrica.land, not the API's internal vocabulary. "Property" is the default noun; name the token where the text identifies the asset (token ID, contract, the plain explanation of land, trust and token). A premint is "unclaimed" (no owner yet) or "being added" (claimed); a superseded premint is "replaced". People "add" a property to Fabrica and "remove" it; in prose, not "on-ramp", "off-ramp", "onboard", "mint" or "burn" (a token is "issued"; a burned token is "retired"). The property intake fee is the "setup fee". Values this server defines and people read follow the same names (lifecycle stages `unclaimed` ... `retired`, the borrowing lever `setup`, `replacesTokenId`). Docs URL slugs (`/docs/on-ramp`) and the API's own fields and values (`isPremint`, `offRampStatus`, `claimState`, the `Mint` activity type) keep their names.
- American English ("labeled"). Operations across all 50 states are "with varying degrees of functionality"; never a bare "operates in all 50 states".
