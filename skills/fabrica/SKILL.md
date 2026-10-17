---
name: fabrica
description: Look up, diligence and add US land on Fabrica, where each property is held in a trust and an ERC-1155 token on Ethereum is the beneficial interest in that trust. Use for questions about a Fabrica property, a parcel's Fabrica status, a wallet's land and loans, or how to put land on Fabrica.
---

# Fabrica

Fabrica puts US land onchain. A trust holds title at the county; an ERC-1155 token on Ethereum is the beneficial interest in that trust. Transfer the token and ownership of the property moves with it. Owners can sell, buy and borrow against land through the DeFi lending pool.

## Connect

The Fabrica MCP server is read-only, public, and needs no key:

- Ethereum mainnet (real properties): `https://mcp.fabrica.land/mcp`
- Sepolia testnet (test tokens): `https://mcp-testnet.fabrica.land/mcp`

Claude Code: `claude mcp add --transport http fabrica https://mcp.fabrica.land/mcp`. Source: https://github.com/fabrica-land/fabrica-mcp. The server also offers the four loops below as MCP prompts (`due_diligence`, `work_parcel_list`, `wallet_review`, `how_to_add_land`).

## Tools

| Tool | What it answers |
|---|---|
| `search_properties` | Properties by location, size, Property checks, listing status |
| `get_property` | One property: location, owner wallet, valuation, listing, loans, operating agreement link |
| `get_valuation` | Every value held for a property, each with its source, date and confidence, and the pool's oracle state |
| `get_trust_documents` | The legal record: the trust, the trust agreement (name, version, link), legal description, parcel identifiers, deed reference and owner-uploaded documents |
| `get_tax_status` | Whether the property's taxes are current, past due or unknown per Property checks, and whether that limits borrowing |
| `get_order_book` | Listings and offers for one property, with prices, expiry and any loan on it |
| `get_property_map` | Parcel boundary as GeoJSON |
| `get_property_image` | Map image of the parcel |
| `explain_confidence_score` | Which Property checks pass, from the property's numeric encoding |
| `get_borrow_quote` | What the DeFi lending pool would lend against a property |
| `get_lending_market` | Loans, pool liquidity, average APR |
| `get_portfolio` | A wallet's holdings, credit history and loans |
| `get_portfolio_image` | Map of a wallet's holdings |
| `get_activity` | Transfers, sales and loans for a property or wallet |
| `get_protocol_stats` | Protocol-wide counts and totals |
| `ask_fabrica` | Cited passages from Fabrica's docs, help center and trust agreement for how Fabrica works |
| `find_parcel` | Any US address or parcel number: the parcel, whether it is on Fabrica, and the on-ramp link if not |

## Loops

**Due diligence on a property.** `get_property` (its `propertyChecks` give how many Property checks pass), then `explain_confidence_score` with the numeric encoding of Property checks, then `get_tax_status`, `get_valuation` with its source, `get_order_book` and `get_trust_documents`, then `get_borrow_quote` and `get_activity`. Report each fact with its source. End with what to verify independently: the county record of the deed into the trust, a title search or title insurance, taxes paid to date. Never a buy recommendation.

**Work a parcel list.** `find_parcel` once per address or parcel number (with state and county when known); re-run ambiguous ones with state and county. On Fabrica: token ID and property link. Not on Fabrica: the on-ramp link. One table at the end. `find_parcel` is limited to 30 calls per minute per client, so long lists go in batches.

**Review a wallet.** `get_portfolio`, then `get_property` for each holding (Property checks from `propertyChecks`, passed of total), each active loan's principal, APR and maturity with its property, then `get_activity`. Summarize holdings, what is owed and when, and what needs attention soon.

**Add land.** `find_parcel` for the parcel; if it is not on Fabrica, the on-ramp link (`https://fabrica.land/go`, with the parcel filled in). The owner submits the property and how title is held, Fabrica reviews title, the owner verifies identity, a trust is created, the owner signs the deed and trust documents (normally with a remote online notary), the deed is recorded, and the token is issued. The setup fee is authorized up front and charged once, at the first sale, loan or use in another app. Steps: https://docs.fabrica.land/docs/on-ramp. Fees: https://docs.fabrica.land/docs/fees. Obligations: https://docs.fabrica.land/docs/property-obligations. Fabrica operates in all 50 states; the on-ramp page shows what each county requires.

## Legal red lines

- The token is the beneficial interest in the trust that holds the property. The trustee is designated by the token holder and is, by default, the holder.
- Fabrica is not a party to the trust, never holds title, never custodies property, and never manages anyone's trust, property or loan.
- Owners carry the land's obligations: property taxes, maintenance, liability. Transfers are legally binding and can be taxable.
- Property checks are a starting point for diligence, not a title search. The number is never a percentage, grade or rating.
- The operating agreement attached to each token sets out the owner's rights and obligations.
- Facts, not advice: no buy, sell or borrow recommendation.

## Wording

Property checks (not "confidence score" as a name). DeFi lending pool. NFTfi only as a retired integration. "Onchain", one word. Stablecoins are digital dollars. No fixed time and no "instantly" for money moving.
