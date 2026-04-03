# Fabrica MCP Server

Give AI agents access to tokenized real property data. Search properties, analyze lending markets, and explore portfolios across tokenized parcels of US land on the Fabrica protocol.

## What is this?

[Fabrica](https://fabrica.land) tokenizes real property (land) as ERC-1155 NFTs on Ethereum. This MCP server lets any AI agent query the full property catalog, lending market, and portfolio data — no API keys required.

Built on the [Model Context Protocol](https://modelcontextprotocol.io) (MCP).

## Quick Start

First, clone and build:

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

**Cursor** (`.cursor/mcp.json`):

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
| `get_lending_market` | Lending overview: active loans, pool stats, yields, events |
| `get_portfolio` | Wallet holdings, credit history, loan positions |
| `get_protocol_stats` | Protocol-wide metrics: TVL, properties, loan volume |
| `get_property_map` | GeoJSON boundary data for mapping and spatial analysis |
| `get_borrow_quote` | Borrowing options for a property: pool liquidity, loan offers, current loans |
| `get_activity` | Activity feed for a property or wallet: transfers, loans, sales, mints |
| `explain_confidence_score` | Decode the 5-digit confidence score into verification categories |
| `get_property_image` | Static map image of a property's parcel boundary (inline, dark/light themes) |
| `get_portfolio_image` | Map image showing all properties owned by a wallet (inline, dark/light themes) |

## Example Conversations

> "Find me all tokenized properties in Texas"

> "What's the current yield on Fabrica's lending market? How does repayment history look?"

> "Do a full due diligence report on property token 12743610130101631987"

> "Show me the portfolio for wallet 0x23bc...fce4 — what properties do they own?"

> "Give me protocol-wide stats for Fabrica — how many properties, total loan volume, repayment rate?"

> "How much can I borrow against property token 12743610130101631987?"

> "Show me all recent activity for wallet 0x23bc...fce4"

> "Explain the confidence score 73242 — what does each digit mean?"

> "Show me a map of property token 12743610130101631987"

> "Show me a map of all properties in this wallet's portfolio"

## Network Selection

By default, the MCP server connects to **Ethereum Mainnet** where properties represent real parcels of US land with real legal consequences. To experiment with test properties first, set `FABRICA_NETWORK=sepolia`:

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
> **Sepolia:** Test properties only — no real-world implications. NFTfi lending is not available on Sepolia.

## Configuration

All optional — sensible defaults are built in:

| Variable | Default | Description |
|---|---|---|
| `FABRICA_NETWORK` | `ethereum` | Network to operate on (`ethereum` or `sepolia`) |
| `FABRICA_API_URL` | `https://api.fabrica.land/graphql` | Fabrica GraphQL API |
| `FABRICA_METASTREET_SUBGRAPH_URL` | Auto-selected per network | MetaStreet pool subgraph |
| `FABRICA_MEDIA_URL` | `https://media.fabrica.land` | Fabrica media service for map images |

## Links

- [Fabrica Platform](https://fabrica.land)
- [Documentation](https://docs.fabrica.land)
- [Dune Dashboard](https://dune.com/fabrica/dashboard)
- [MCP Specification](https://modelcontextprotocol.io)

## License

MIT
