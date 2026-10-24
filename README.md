# Fabrica MCP Server

Give AI agents access to US land on Fabrica. Search properties, research a parcel, check what it could borrow, and explore portfolios across the US land held on the Fabrica protocol.

## What is this?

On [Fabrica](https://fabrica.land), a property is held in a trust; once its ERC-1155 token on Ethereum is issued, the token controls the trust, which holds title. This MCP server lets any AI agent query the full property catalog, lending market, and portfolio data, with no API keys required.

Built on the [Model Context Protocol](https://modelcontextprotocol.io) (MCP).

## Quick Start

### Hosted (recommended): nothing to install

Point any MCP client at the hosted server:

| Network | URL |
|---|---|
| Ethereum Mainnet (real parcels) | `https://mcp.fabrica.land/mcp` |
| Sepolia Testnet (test properties) | `https://mcp-testnet.fabrica.land/mcp` |

**Claude (claude.ai and desktop):** Settings → Connectors → Add custom connector → paste the URL.

**Claude Code:**

```bash
claude mcp add --transport http fabrica https://mcp.fabrica.land/mcp
claude mcp add --transport http fabrica-testnet https://mcp-testnet.fabrica.land/mcp
```

**Cursor:** one click installs the mainnet server:

[![Add Fabrica to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=fabrica&config=eyJ1cmwiOiJodHRwczovL21jcC5mYWJyaWNhLmxhbmQvbWNwIn0%3D)

Or add it by hand (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "fabrica": { "url": "https://mcp.fabrica.land/mcp" }
  }
}
```

Any other client that supports remote MCP servers (Streamable HTTP) works the same way. Add both URLs as two separate servers if you want to try things on testnet before mainnet: the network is fixed per URL, so an agent can never reach mainnet through the testnet server.

**Discovery without a registry:** each host serves `/.well-known/mcp.json` (URL, transport, auth, docs, the other network's server) and `/.well-known/mcp/server-card.json` (the same plus every tool with its title and annotations, the prompts and the resource templates), plus `/.well-known/ai-catalog.json`, the AI Catalog that domain-level discovery reads first, pointing at both servers' cards. The card is read from the running server, so it always matches what that host registers.

### Run locally (stdio)

The hosted URLs above are the supported way to use the server; it is not published to npm. To run it on your own machine from source (Node 20 or later):

```bash
git clone https://github.com/fabrica-land/fabrica-mcp.git
cd fabrica-mcp
npm install
npm run build
claude mcp add fabrica -- node /absolute/path/to/fabrica-mcp/dist/index.js
```

Set `FABRICA_NETWORK=sepolia` in the server's environment for the testnet.

## Available Tools

| Tool | Description |
|---|---|
| `search_land` | Search properties by state, county, size, Property checks, listing status, listing price and price per acre, or distance from a point; sort by price, price per acre, acres, estimated value, Property checks, date added or distance. Each row carries its lifecycle stage and price per acre; or counts per state or county, with links to the fabrica.land location pages |
| `get_land_property` | Full property details: legal, valuation, ownership, loans, media, lifecycle stage, assessed fees, duplicate-parcel flags |
| `get_fabrica_lending_market` | Lending overview: loan counts, loans, DeFi lending pool stats, average APR, events |
| `get_fabrica_loan_book` | The lending history as a distribution: loan-to-value bands, exposure by state and acreage, APR and duration spread, repaid and liquidated counts, originations by month, largest loans |
| `get_land_portfolio` | Wallet holdings, credit history, loan positions |
| `get_fabrica_stats` | Protocol-wide metrics: properties, estimated value, loan volume and counts, DeFi lending pool TVL |
| `get_land_boundary` | GeoJSON boundary data for mapping and spatial analysis |
| `get_land_tax_status` | Property tax status from Property checks (current, past due, unknown), its basis, check dates and whether it limits borrowing |
| `get_land_trust_documents` | The legal record: trust, trust agreement (name, version, link, text on request), legal description, parcel IDs, deed reference, uploaded documents |
| `estimate_land_borrowing` | Borrowing options for a property: DeFi lending pool liquidity, durations, current loans, what limits the amount (pool liquidity, LTV, tax status, oracle), why capacity is zero when it is, and what would raise it (`toRaise`: each lever, what it would allow, the step that moves it) |
| `get_land_loan` | One loan against a property: status, provider, principal, APR, maturity, full repayment and, while active, the payoff today; by property, `loanId`, or both |
| `get_land_valuation` | Every value the API holds for a property with its source, date and confidence: estimate, AVM, Prycd, county assessor, signed valuations, pool oracle state |
| `get_land_activity` | Activity feed for a property or wallet, or the recent activity across the whole network: transfers, loans, sales, properties added |
| `get_land_order_book` | Listings and offers on a property: prices, sellers and buyers, expiry, whether a loan blocks each listing, whether the property is still being added |
| `explain_property_checks` | Decode the numeric encoding of Property checks (5 digits, formerly called the confidence score) into verification groups |
| `get_land_map_image` | Static map image of a property's parcel boundary (inline, dark/light themes) |
| `get_land_portfolio_map_image` | Map image showing all properties owned by a wallet (inline, dark/light themes) |
| `ask_fabrica` | Cited passages from Fabrica's docs, help center and the US trust agreement that answer a question about how Fabrica works |
| `find_us_parcel` | Any US address or parcel number (APN) to a parcel: on Fabrica or not, and the link to add it; `queries` takes a list of up to 10 and returns a table. No owner names from parcel data; 30 lookups per minute per client, each query in a list counting as one |
| `check_county_coverage` | Whether property in a US county (or state) can be added online, and what it asks the owner for. From a table of Fabrica's rules for adding property, dated and refreshed by hand (`npm run coverage:build`) |
| `contact_fabrica_support` | Hand a question to Fabrica support: help center section, support email, and a prefilled mailto with the summary and property link. Sends nothing itself |

### Sign requests (testnet host first)

On `mcp-testnet.fabrica.land` (and on mainnet only with `FABRICA_SIGN_REQUESTS=enabled`), seven tools prepare actions: the marketplace's `make_land_offer`, `list_land_for_sale`, `accept_land_offer`, `buy_land` and `cancel_land_order`, and the DeFi lending pool's `borrow_against_land` (checks the wallet holds the token, no loan is active and the amount is within the pool's maximum) and `repay_land_loan` (checks the loan is active and the wallet is its borrower, with the payoff today). Each checks the live data (the property is live, the wallet holds it or not, the listing or offer is open, buyable and the wallet's own where it has to be), then returns a `signRequest`: a summary, warnings, a sign link to the property page on fabrica.land with the dialog prefilled, and an expiry 15 minutes out. The person opens the link and signs with their own wallet. The server holds no keys, signs nothing and submits nothing; `payload` (typed data or an unsigned transaction for a wallet in the conversation) stays null until Connect Fabrica ships. `get_sign_request` says whether a request was signed (it also checks the order book), and `get_transaction_status` follows a transaction by hash.

Pending requests live in the server's own store (Vercel KV / Upstash Redis: `KV_REST_API_URL` and `KV_REST_API_TOKEN`, plus `SIGN_REQUEST_SECRET` for the records' HMAC). The sign link is `{web}/property/{network}/{tokenId}?action=…&request={id}`. The sign page reads the request at `GET /sign-requests/{id}` (410 once expired) and reports the outcome at `POST /sign-requests/{id}/result` with `{ orderHash }` or `{ transactionHash }`, which the server checks against the API or the chain before recording. Without a store the tools say they are not configured; locally (stdio) an in-process map is used.

### Knowledge layer

`ask_fabrica` answers questions about Fabrica (the trust, fees, Property checks, lending, taxes, adding and removing a property, the legal framework) from Fabrica's own text and returns the passages with their URLs, so an agent cites the page instead of paraphrasing from memory. Three sources feed it: [docs.fabrica.land](https://docs.fabrica.land), the [help center](https://help.fabrica.land) and the [US trust agreement](https://github.com/fabrica-land/fabrica-connectors/blob/main/connectors/us/us-trust-agreement.md).

The index lives at `src/knowledge/generated/index.json` and is committed, so deploys and tests never fetch the sources at runtime. Retrieval is BM25 over passage text with titles weighted in and a small synonym list for Fabrica's vocabulary; there is no model call and no external service. To rebuild after the sources change:

```bash
npm run knowledge:build -- --docs-dir ../docs   # docs from a local checkout of fabrica-land/docs
GITHUB_TOKEN=... npm run knowledge:build        # or read the docs repo through the GitHub API
npm run knowledge:check                         # exit 1 when a source moved past its pin
```

Source pins (docs commit, help center sitemap fingerprint, trust agreement commit) are recorded in `knowledge/sources.json`. The build takes about 30 seconds and the index is under 1 MB.

A scheduled workflow (`.github/workflows/refresh-knowledge.yml`, daily and on demand) rebuilds the index, runs the tests and opens a pull request titled "Knowledge index: <source> <short sha>" whose body lists the pages added, removed and changed (`scripts/knowledge-diff.mjs`). Merging it deploys both servers. The workflow needs one repository secret, `KNOWLEDGE_TOKEN`, a fine-grained GitHub token with read access to the contents of the private `fabrica-land/docs` repository; a failed source fetch fails the run, so a partial index is never proposed.

### Resources

The same documents are registered as MCP resources, so a person can attach one to a conversation from the client's resource picker (Claude's "add from connector", Cursor's `@`) without the agent searching for it. All are `text/markdown`, and every read starts with the source URL and the content's updated date.

| URI | What it is |
|---|---|
| `fabrica://docs/<slug>` | Every docs.fabrica.land page (the ten most useful are listed first: obligations, fees, add and remove a property, Property checks, pool lending, the trust, the regulatory framework, the glossary, AI agents) |
| `fabrica://help/<id>` | Every help center article, by its article id and slug |
| `fabrica://legal/us-trust-agreement` | The US trust agreement text |
| `fabrica://property/{tokenId}/trust-agreement` | The operating agreement attached to one token, as the API serves it (versions differ by the date the token was issued) |
| `fabrica://network` | This deployment's network, contract addresses and legal notice |

`fabrica://docs/{slug}` and `fabrica://help/{id}` are also resource templates with completion.

## Prompts and skill file

The server offers four MCP prompts: `due_diligence` (one property, ending with what to verify yourself), `work_parcel_list` (a list of addresses or parcel numbers through `find_us_parcel`), `wallet_review` (holdings, loans and maturities) and `how_to_add_land` (adding one parcel to Fabrica). The same loops, the tool list and the legal red lines are in the Agent Skills file [`skills/fabrica/SKILL.md`](skills/fabrica/SKILL.md), served at https://mcp.fabrica.land/skill.md for agents that do not connect to the server.

## Example Conversations

> "Find me all tokenized properties in Texas"

> "What's the current average APR on Fabrica's lending market? How much liquidity does the lending pool have?"

> "Do a full due diligence report on property token 12743610130101631987"

> "Show me the portfolio for wallet 0x23bc...fce4. What properties do they own?"

> "Give me protocol-wide stats for Fabrica: how many properties, in which states, and total loan volume?"

> "How much can I borrow against property token 12743610130101631987?"

> "Show me all recent activity for wallet 0x23bc...fce4"

> "What is property 3484741603659410548 listed for, and what offers are waiting on it?"

> "Explain the Property checks number 73242. What does each digit mean?"

> "Show me a map of property token 12743610130101631987"

> "Show me a map of all properties in this wallet's portfolio"

## Property card (MCP App)

In clients that support [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) (such as Claude on the web and desktop), `get_land_property` renders a property card inline in the conversation:
- a gallery with the parcel map first, followed by the owner's photos when there are any
- name, location and acreage
- Property checks, estimated value, listing price, and borrowing capacity
- **Buy** (when listed), **Make an offer**, **Contact owner** and **View on Fabrica** buttons

Every button opens the property on Fabrica, where the user completes the action and signs; the server itself never prepares or submits a transaction. Clients without MCP Apps support receive the same data as JSON.

The agent can ask for the card fullscreen with `display: "fullscreen"`; the host may decline.

The card is on by default on Sepolia and off on mainnet unless `FABRICA_MCP_APPS=enabled`. Photos are limited to the origins the card's sandbox allows (see `WIDGET_IMAGE_ORIGINS` in `src/tools/media.ts`).

## Network Selection

The hosted servers are split by URL (see Quick Start). A local server connects to **Ethereum Mainnet** by default, where properties represent real parcels of US land with real legal consequences. To experiment with test properties first, set `FABRICA_NETWORK=sepolia`:

**Claude Code (Sepolia):**

```bash
claude mcp add fabrica -e FABRICA_NETWORK=sepolia -- node /absolute/path/to/fabrica-mcp/dist/index.js
```

**Claude Desktop (Sepolia):**

```json
{
  "mcpServers": {
    "fabrica": {
      "command": "node",
      "args": ["/absolute/path/to/fabrica-mcp/dist/index.js"],
      "env": { "FABRICA_NETWORK": "sepolia" }
    }
  }
}
```

> **Mainnet notice:** On mainnet, the server instructions carry a legal notice stated as facts: the properties are real US land, each held in a trust; owning a token means owning the beneficial interest in the trust that holds the property; the trustee is designated by the token holder and is, by default, the holder; and acquiring, transferring, listing or borrowing against a token has legal, tax and liability consequences set out in the trust agreement attached to it.
>
> **Sepolia:** Test properties only, no real-world implications.

## Configuration

All optional; sensible defaults are built in:

| Variable | Default | Description |
|---|---|---|
| `FABRICA_NETWORK` | `ethereum` | Network to operate on (`ethereum` or `sepolia`) |
| `FABRICA_API_URL` | `https://api.fabrica.land/graphql` | Fabrica GraphQL API |
| `FABRICA_METASTREET_SUBGRAPH_URL` | Auto-selected per network | Subgraph for the lending pool contracts (the variable keeps its original name) |
| `FABRICA_MEDIA_URL` | `https://media.fabrica.land` | Fabrica media service for map images |
| `FABRICA_MCP_APPS` | on for Sepolia, off for mainnet | `enabled` or `disabled`: the property card MCP App on `get_land_property` |

## Regression list

`npm run regression` (mainnet) or `npm run regression -- sepolia` calls every tool on a hosted server with the case list in `scripts/regression/cases.json`: happy paths, edge cases and the wording of a miss. One line per case, exit code 1 on a failure. Run it after each release and before a directory submission.

## Hosting

The hosted servers run on Vercel from this repository: one Vercel project per network, both built with `npm run build:vercel` (see `vercel.json`), which emits a stateless Streamable HTTP function at `/mcp`, the sign-request endpoints at `/sign-requests`, the discovery documents at `/.well-known/`, and a landing page at `/`. Set `FABRICA_NETWORK` in each project's environment (`ethereum` or `sepolia`). The same handler (`src/http.ts`) can run behind any Node HTTP server.

## MCP Registry

Both hosts are listed in the official [MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=land.fabrica) as `land.fabrica/mcp` and `land.fabrica/mcp-testnet` (remote servers, no package). PulseMCP, Glama, the GitHub MCP registry and VS Code read from it. The entries live in `server.json` and `server.testnet.json`.

To republish after a release: bump `version` in `package.json`, `src/server.ts` and both server files (a test keeps them equal), then run `npm run registry:publish` (`-- --dry-run` prints the entries). Before writing anything it checks both entries against the registry: a version already there with the same content is skipped, so a rerun after a partial publish finishes the job, and one with different content stops the run. The namespace is proven by the `v=MCPv1` TXT record on fabrica.land; the script reads the matching Ed25519 private key from `MCP_REGISTRY_PRIVATE_KEY` or `~/.config/mcp-registry/fabrica-land-ed25519.pem`.

## Links

- [Fabrica Platform](https://fabrica.land)
- [Documentation](https://docs.fabrica.land)
- [Company Overview](https://about.fabrica.land)
- [Dune Dashboard](https://dune.com/fabrica/dashboard)
- [MCP Specification](https://modelcontextprotocol.io)

## License

MIT
