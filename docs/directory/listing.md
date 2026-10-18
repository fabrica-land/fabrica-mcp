# Claude Connectors Directory listing

What to paste into [claude.ai/directory/manage](https://claude.ai/directory/manage) (Submit new, MCP connector) for the hosted mainnet server. Checked against the [submission page](https://claude.com/docs/connectors/building/submission) and the [review criteria](https://claude.com/docs/connectors/building/review-criteria) on 2026-10-17. Re-read both on the day you submit; they change.

Wording rules for every field: "Property checks" (never "confidence score"), "DeFi lending pool", "onchain" as one word, no fee amounts, no yields, no investment framing, no em dashes, never "600+".

## Connection

`https://mcp.fabrica.land/mcp` (one URL). Not the testnet URL.

## Tools

The portal syncs them from the server. It should show 20 tools, all read-only, each with a title and `readOnlyHint: true`:

search_properties, get_property (renders the property card), get_lending_market, get_loan_book, get_portfolio, get_protocol_stats, get_property_map, get_trust_documents, get_tax_status, explain_confidence_score, get_borrow_quote, get_valuation, get_activity, get_order_book, get_property_image, get_portfolio_image, ask_fabrica, find_parcel, check_coverage, contact_support.

## Listing

**Name:** Fabrica

**One-liner** (200 max):

> Explore tokenized US land on Fabrica: property records, Property checks, trust documents, parcel maps, borrow quotes, and lookup of any US parcel by address or APN.

**Description** (2,000 max):

> Fabrica makes US land programmable. Each property is held in a trust, and an ERC-1155 token on Ethereum represents the beneficial interest in that trust. This connector gives Claude read-only access to Fabrica's public property data, with no account and no setup.
>
> With it, Claude can:
> - Search properties by state, county, size, listing status and loan status
> - Show a property as a card with its parcel map, photos and key facts, with buttons that open it on Fabrica
> - Pull a property's full record: legal description, valuation sources, property tax status, ownership, loans, marketplace listings and offers, and the trust agreement that governs the token
> - Explain a property's Property checks, check by check
> - Return parcel boundaries as GeoJSON, and map images of a parcel or of every property a wallet holds
> - Look up any US parcel by street address or APN, and say whether its county can be brought onto Fabrica
> - Summarize the DeFi lending pool and estimate what a property could borrow
> - Show a wallet's portfolio and the onchain activity of a property, a wallet or the whole network
> - Answer questions about how Fabrica works from its documentation and help center, with links to the source
>
> Every tool is read-only. The connector never signs, sends or changes anything, and it serves public data from Fabrica's own API. The card's buttons open fabrica.land, where any purchase, offer or loan happens.
>
> Properties on Fabrica are real parcels of land, and acting on them has legal and tax consequences set out in each token's trust agreement. The connector provides information, not financial or legal advice.

**Categories** (1 to 5, pick the closest the portal offers): Real estate, Finance, Data & analytics, Maps / location, Research.

**Documentation URL:** https://docs.fabrica.land/docs/ai-agents

**Privacy policy URL:** https://fabrica.land/privacy-policy

**Support contact:** questions@fabrica.land

**Icon:** [`icon-512.png`](icon-512.png) (white Fabrica mark on #1E28FF, 512 x 512, from the brand repo's icon mark)

**Slug:** `fabrica` (permanent once published)

**Allowed link URIs:** `https://fabrica.land` and `https://testnets.fabrica.land` (the only origins the card opens)

**Carousel screenshots:** 3 to 5 PNGs from [`prompts.md`](prompts.md), each with its prompt.

## Use cases

- **Primary use cases:** research and due diligence on tokenized land (records, Property checks, trust documents, boundaries, maps, tax status); finding land for sale; checking what a property could borrow; reviewing a wallet's holdings and activity; looking up any US parcel and whether it can be brought onto Fabrica.
- **What users need before connecting:** nothing. No account, plan or API key.
- **Reads, writes or both:** reads only.

## Company

Fabrica Inc., https://fabrica.land. Primary contact: Federico Pomi, fede@fabrica.land.

## Authentication

No authentication. All data is public.

## Data handling

- Underlying API: our own (Fabrica's GraphQL API, media service and documentation).
- Personal health data: no.
- Sponsored content: no.

## Test & launch

> No credentials are needed: the server is public and has no accounts. Add https://mcp.fabrica.land/mcp as a custom connector in Claude (Settings, Connectors, Add custom connector) and run these prompts, which together call every tool:
>
> 1. "Find land for sale on Fabrica in Arizona, then show me the first one." (search_properties, get_property with the card)
> 2. "Explain that property's Property checks, show its parcel boundary and a map image, and its tax status." (explain_confidence_score, get_property_map, get_property_image, get_tax_status)
> 3. "Show its trust documents, valuation sources and order book." (get_trust_documents, get_valuation, get_order_book)
> 4. "How much could be borrowed against it, and what does the lending market look like?" (get_borrow_quote, get_lending_market)
> 5. "Show the portfolio, a portfolio map and the recent activity of the wallet that owns it, then the latest activity across Fabrica." (get_portfolio, get_portfolio_image, get_activity)
> 6. "Give me Fabrica's protocol statistics." (get_protocol_stats)
> 7. "Is 1707 Jones St, San Francisco, CA on Fabrica, and can I add land in Coconino County, Arizona?" (find_parcel, check_coverage)
> 8. "How does the Fabrica trust work? Then draft an email to Fabrica support asking for help with my onramp." (ask_fabrica, contact_support)

Confirm you have run every tool yourself. Our record: `npm run regression` against the hosted mainnet server, 45/45 cases on 2026-10-17 (after the stale `get_activity` case was updated), plus the card seen rendering in Claude on 2026-10-17.

## Compliance (7 acknowledgments)

- **Directory guidelines:** read and followed.
- **First-party API:** yes, Fabrica's own API.
- **Financial transactions:** none. Every tool is read-only and the card only opens fabrica.land, so the connector never transfers money, cryptocurrency or other assets.
- **AI media generation:** none. Map images come from our media service (Mapbox static maps), not an AI model.
- **Prompt injection:** descriptions and server instructions state facts only, enforced by `src/__tests__/http.test.ts`.
- **Conversation data collection:** none beyond the tool arguments needed to answer. The usage log records one line per request with no arguments or IPs (`docs/usage/`).
- **Public documentation:** https://docs.fabrica.land/docs/ai-agents and this repository's README.

## After it is listed

- Listing URL: `https://claude.ai/directory/connectors/fabrica`. Add it to the README and set it as the "Add to Claude" link on about.fabrica.land.
- Status and reviewer feedback appear in the portal. Escalations: mcp-review@anthropic.com.
- Screenshots and listing text can be edited after publication; the slug cannot.
- Then submit the same server to the ChatGPT apps directory and the Cursor MCP directory with the same text (ENG-4988).
