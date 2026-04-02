# Fabrica MCP Server

Give AI agents access to tokenized real property data. Search properties, analyze lending markets, and explore portfolios across tokenized parcels of US land on the Fabrica protocol.

## What is this?

[Fabrica](https://fabrica.land) tokenizes real property (land) as ERC-1155 NFTs on Ethereum. This MCP server lets any AI agent query the full property catalog, lending market, and portfolio data — no API keys required.

Built on the [Model Context Protocol](https://modelcontextprotocol.io) (MCP).

## Quick Start

**Claude Code:**

```bash
claude mcp add fabrica -- npx @fabrica-land/mcp
```

**Claude Desktop** (`claude_desktop_config.json`):

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

**Cursor** (`.cursor/mcp.json`):

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

**From source:**

```bash
git clone https://github.com/fabrica-land/fabrica-mcp.git
cd fabrica-mcp
npm install
npm run build
node dist/index.js
```

## Available Tools

| Tool | Description |
|---|---|
| `search_properties` | Search tokenized properties by location, size, score, listing status |
| `get_property` | Full property details: legal, valuation, ownership, loans, media |
| `get_lending_market` | Lending overview: active loans, pool stats, yields, events |
| `get_portfolio` | Wallet holdings, credit history, loan positions |
| `get_protocol_stats` | Protocol-wide metrics: TVL, properties, loan volume |
| `get_property_map` | GeoJSON boundary data for mapping and spatial analysis |
| `explain_confidence_score` | Decode the 5-digit confidence score into verification categories |

## Example Conversations

> "Find me all tokenized properties in Texas"

> "What's the current yield on Fabrica's lending market? How does repayment history look?"

> "Do a full due diligence report on property token 12743610130101631987"

> "Show me the portfolio for wallet 0x23bc...fce4 — what properties do they own?"

> "Give me protocol-wide stats for Fabrica — how many properties, total loan volume, repayment rate?"

> "Explain the confidence score 73242 — what does each digit mean?"

## Configuration

All optional — sensible defaults are built in:

| Variable | Default | Description |
|---|---|---|
| `FABRICA_API_URL` | `https://api.fabrica.land/graphql` | Fabrica GraphQL API |
| `FABRICA_METASTREET_SUBGRAPH_URL` | Goldsky mainnet endpoint | MetaStreet pool subgraph |

## Links

- [Fabrica Platform](https://fabrica.land)
- [Documentation](https://docs.fabrica.land)
- [Dune Dashboard](https://dune.com/fabrica/dashboard)
- [MCP Specification](https://modelcontextprotocol.io)

## License

MIT
