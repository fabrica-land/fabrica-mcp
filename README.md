# Fabrica MCP Server

Give AI agents access to tokenized real property data. Search properties, analyze lending markets, and explore portfolios across tokenized parcels of US land on the Fabrica protocol.

## What is this?

[Fabrica](https://fabrica.land) tokenizes real property (land) as ERC-1155 NFTs on Ethereum. This MCP server lets any AI agent query the full property catalog, lending market, and portfolio data — no API keys required.

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

**Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "fabrica": { "url": "https://mcp.fabrica.land/mcp" }
  }
}
```

Any other client that supports remote MCP servers (Streamable HTTP) works the same way. Add both URLs as two separate servers if you want to try things on testnet before mainnet: the network is fixed per URL, so an agent can never reach mainnet through the testnet server.

### Run locally (stdio)

Clone and build:

```bash
git clone https://github.com/fabrica-land/fabrica-mcp.git
cd fabrica-mcp
npm install
npm run build
```

Then configure your MCP client to use the built server:

**Claude Code:**

```bash
claude mcp add fabrica -- node /absolute/path/to/fabrica-mcp/dist/index.js
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "fabrica": {
      "command": "node",
      "args": ["/absolute/path/to/fabrica-mcp/dist/index.js"]
    }
  }
}
```

Replace `/absolute/path/to/fabrica-mcp` with the actual path where you cloned the repo.

## Available Tools

| Tool | Description |
|---|---|
| `search_properties` | Search tokenized properties by location, size, score, listing status |
| `get_property` | Full property details: legal, valuation, ownership, loans, media |
| `get_lending_market` | Lending overview: loan counts, loans, Fabrica lending pool stats, average APR, events |
| `get_portfolio` | Wallet holdings, credit history, loan positions |
| `get_protocol_stats` | Protocol-wide metrics: properties, estimated value, loan volume and counts, lending pool TVL |
| `get_property_map` | GeoJSON boundary data for mapping and spatial analysis |
| `get_borrow_quote` | Borrowing options for a property: Fabrica lending pool liquidity, durations, current loans |
| `get_activity` | Activity feed for a property or wallet: transfers, loans, sales, mints |
| `explain_confidence_score` | Decode the 5-digit confidence score into verification categories |
| `get_property_image` | Static map image of a property's parcel boundary (inline, dark/light themes) |
| `get_portfolio_image` | Map image showing all properties owned by a wallet (inline, dark/light themes) |

## Example Conversations

> "Find me all tokenized properties in Texas"

> "What's the current average APR on Fabrica's lending market? How much liquidity does the lending pool have?"

> "Do a full due diligence report on property token 12743610130101631987"

> "Show me the portfolio for wallet 0x23bc...fce4 — what properties do they own?"

> "Give me protocol-wide stats for Fabrica: how many properties, in which states, and total loan volume?"

> "How much can I borrow against property token 12743610130101631987?"

> "Show me all recent activity for wallet 0x23bc...fce4"

> "Explain the confidence score 73242 — what does each digit mean?"

> "Show me a map of property token 12743610130101631987"

> "Show me a map of all properties in this wallet's portfolio"

## Property card (MCP App)

In clients that support [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) (such as Claude on the web and desktop), `get_property` renders a property card inline in the conversation:
- a gallery with the parcel map first, followed by the owner's photos when there are any
- name, location and acreage
- confidence score, estimated value, listing price, and borrowing capacity
- **Buy** (when listed), **Make an offer**, **Contact owner** and **View on Fabrica** buttons

Every button opens the property on Fabrica, where the user completes the action and signs; the server itself never prepares or submits a transaction. Clients without MCP Apps support receive the same data as JSON.

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

> **Mainnet notice:** On mainnet, the MCP server instructs AI agents to inform users that operations have real-world legal and financial consequences — including accepting the role of trustee, potential property liabilities, and tax implications. Agents are directed to review the trust instrument attached to tokens before advising on acquisition.
>
> **Sepolia:** Test properties only, no real-world implications.

## Configuration

All optional — sensible defaults are built in:

| Variable | Default | Description |
|---|---|---|
| `FABRICA_NETWORK` | `ethereum` | Network to operate on (`ethereum` or `sepolia`) |
| `FABRICA_API_URL` | `https://api.fabrica.land/graphql` | Fabrica GraphQL API |
| `FABRICA_METASTREET_SUBGRAPH_URL` | Auto-selected per network | Subgraph for the lending pool contracts (the variable keeps its original name) |
| `FABRICA_MEDIA_URL` | `https://media.fabrica.land` | Fabrica media service for map images |
| `FABRICA_MCP_APPS` | on for Sepolia, off for mainnet | `enabled` or `disabled`: the property card MCP App on `get_property` |

## Hosting

The hosted servers run on Vercel from this repository: one Vercel project per network, both built with `npm run build:vercel` (see `vercel.json`), which emits a single stateless Streamable HTTP function at `/mcp` and a landing page at `/`. Set `FABRICA_NETWORK` in each project's environment (`ethereum` or `sepolia`). The same handler (`src/http.ts`) can run behind any Node HTTP server.

## Links

- [Fabrica Platform](https://fabrica.land)
- [Documentation](https://docs.fabrica.land)
- [Company Overview](https://about.fabrica.land)
- [Dune Dashboard](https://dune.com/fabrica/dashboard)
- [MCP Specification](https://modelcontextprotocol.io)

## License

MIT
