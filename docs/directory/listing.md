# Claude Connectors Directory listing

What to paste into [claude.ai/directory/manage](https://claude.ai/directory/manage) (Submit new, MCP connector) for the hosted mainnet server. Checked against the [submission page](https://claude.com/docs/connectors/building/submission) and the [review criteria](https://claude.com/docs/connectors/building/review-criteria) on 2026-10-22. Re-read both on the day you submit; they change.

Wording rules for every field: "Property checks" (never "confidence score"), "DeFi lending pool", "onchain" as one word, no fee amounts, no yields, no investment framing, no em dashes, never "600+".

## Connection

`https://mcp.fabrica.land/mcp` (one URL). Not the testnet URL.

## Tools

The portal syncs them from the server. It should show 20 tools, all read-only, each with a title and `readOnlyHint: true`:

search_land, get_land_property (renders the property card), get_fabrica_lending_market, get_fabrica_loan_book, get_land_portfolio, get_fabrica_stats, get_land_boundary, get_land_trust_documents, get_land_tax_status, explain_property_checks, estimate_land_borrowing, get_land_valuation, get_land_activity, get_land_order_book, get_land_map_image, get_land_portfolio_map_image, ask_fabrica, find_us_parcel, check_county_coverage, contact_fabrica_support.

## Listing

**Name:** Fabrica Land (display name; the slug stays `fabrica`)

**One-liner** (200 max):

> Find US land for sale on Fabrica, mostly vacant land, lots and acreage, by county, acres and price. See property records, parcel maps and property taxes. Look up any US parcel by address or APN.

**Description** (2,000 max):

> Find US land for sale on Fabrica, mostly vacant lots and acreage. Search by state, county, acres and price, then explore property records, a parcel map, property taxes and value for properties on Fabrica.
>
> For any US parcel, look it up by address or APN (assessor parcel number) to identify it, see whether it is on Fabrica and check county coverage. Records, maps, tax status, valuations and borrowing estimates are available only for properties on Fabrica.
>
> With it, Claude can:
> - Search Fabrica land by state, county, acres, price, price per acre, distance from a point, listing status and loan status, and sort results
> - Show an interactive property card with a map, photos, key facts and buttons that open fabrica.land
> - Read trust documents, property tax status, valuations, listings and offers for Fabrica properties
> - Explain Property checks, check by check
> - Return parcel boundaries as GeoJSON and map images for a Fabrica property or wallet portfolio
> - Estimate borrowing against a property's token from the DeFi lending pool, and summarize the lending market and loan book
> - Show Fabrica wallet portfolios, property onchain activity and network statistics
> - Answer Fabrica questions from documentation and help-center sources, with links
> - Draft a support email without sending it
>
> Every property on Fabrica is a real US parcel held in a trust, and an ERC-1155 token on Ethereum represents the beneficial interest in that trust.
>
> Every tool is read-only. The connector provides public data and never signs transactions, sends support emails or changes property records. Card buttons open fabrica.land.
>
> Properties on Fabrica are real parcels of land, and acting on them has legal and tax consequences set out in each token's trust agreement. The connector provides information, not financial or legal advice.

**Categories** (1 to 5, pick the closest the portal offers): Real estate, Maps / location, Research, Data & analytics, Finance.

**Documentation URL:** https://docs.fabrica.land/docs/ai-agents

**Privacy policy URL:** https://fabrica.land/privacy-policy

**Support contact:** questions@fabrica.land

**Icon:** [`icon-512.png`](icon-512.png) (white Fabrica mark on #1E28FF, 512 x 512, from the brand repo's icon mark)

**Slug:** `fabrica` (permanent once published)

**Allowed link URIs:** `https://fabrica.land` and `https://testnets.fabrica.land` (the only origins the card opens)

**Carousel screenshots:** 3 to 5 PNGs from [`prompts.md`](prompts.md), each with its prompt.

## Use cases

- **Primary use cases:** finding vacant land, lots and acreage for sale; research and due diligence on a parcel (records, Property checks, trust documents, boundaries, maps, tax status); checking what a property could borrow; reviewing a wallet's holdings and activity; looking up any US parcel and whether it can be brought onto Fabrica.
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
> 1. "Find land for sale on Fabrica in Arizona, then show me the first one." (search_land, get_land_property with the card)
> 2. "Explain that property's Property checks, show its parcel boundary and a map image, and its tax status." (explain_property_checks, get_land_boundary, get_land_map_image, get_land_tax_status)
> 3. "Show its trust documents, valuation sources and order book." (get_land_trust_documents, get_land_valuation, get_land_order_book)
> 4. "How much could be borrowed against it, what does the lending market look like, and show the loan book." (estimate_land_borrowing, get_fabrica_lending_market, get_fabrica_loan_book)
> 5. "Show the portfolio, a portfolio map and the recent activity of the wallet that owns it, then the latest activity across Fabrica." (get_land_portfolio, get_land_portfolio_map_image, get_land_activity)
> 6. "Give me Fabrica's protocol statistics." (get_fabrica_stats)
> 7. "Is 1707 Jones St, San Francisco, CA on Fabrica, and can I add land in Coconino County, Arizona?" (find_us_parcel, check_county_coverage)
> 8. "How does the Fabrica trust work? Then draft an email to Fabrica support asking for help with my onramp." (ask_fabrica, contact_fabrica_support)

Confirm you have run every tool yourself. Our record: `npm run regression` against the hosted mainnet server, 47/47 cases on 2026-10-19 after the tool renames, plus the card seen rendering in Claude on 2026-10-17.

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
- Then submit the same server to the ChatGPT apps directory and the Cursor MCP directory with the same text.
