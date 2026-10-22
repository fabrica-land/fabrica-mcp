---
name: fabrica
description: Look up, diligence and add US land on Fabrica. On Ethereum mainnet each property is held in a trust and an ERC-1155 token is the beneficial interest in that trust; on the Sepolia testnet tokens are test tokens with no ownership. Use for questions about a Fabrica property, a parcel's Fabrica status, a wallet's land and loans, or how to put land on Fabrica.
---

# Fabrica

Fabrica puts US land onchain. A trust holds title at the county; an ERC-1155 token on Ethereum is the beneficial interest in that trust. An authorized transfer of the token transfers the beneficial interest in the trust; the trust keeps title. A token held by a lending, escrow or bridge contract, or moved without the owner's authorization, does not move beneficial ownership. Owners can sell, buy and borrow against land through the DeFi lending pool.

## Connect

The Fabrica MCP server is read-only, public, and needs no key:

- Ethereum mainnet (real properties): `https://mcp.fabrica.land/mcp`
- Sepolia testnet (test tokens): `https://mcp-testnet.fabrica.land/mcp`

Everything in this file about trusts, ownership, deeds, taxes and obligations applies to Ethereum mainnet only. On Sepolia, tokens are test tokens: holding or transferring one is not ownership of any real property or of a beneficial interest in a trust, and adding a parcel there creates no trust and records no deed. Every Sepolia result (Property checks, tax status, valuations, loans) is test data: label it so and draw no real-world conclusion from it.

Claude Code, mainnet: `claude mcp add --transport http fabrica https://mcp.fabrica.land/mcp`. Sepolia testnet: `claude mcp add --transport http fabrica-testnet https://mcp-testnet.fabrica.land/mcp`. Source: https://github.com/fabrica-land/fabrica-mcp. The server also offers the four loops below as MCP prompts (`due_diligence`, `work_parcel_list`, `wallet_review`, `how_to_add_land`).

## Tools

| Tool | What it answers |
|---|---|
| `search_land` | Properties by location, size, Property checks, listing status, price, price per acre, distance from a point (`near`); sorted with `sortBy` |
| `get_land_property` | One property: location, owner wallet, valuation, listing, loans, operating agreement link |
| `get_land_valuation` | Every value held for a property, each with its source, date and confidence, and the pool's oracle state |
| `get_land_trust_documents` | The legal record: the trust, the trust agreement (name, version, link), legal description, parcel identifiers, deed reference and owner-uploaded documents |
| `get_land_tax_status` | Whether the property's taxes are current, past due or unknown per Property checks, and whether that limits borrowing |
| `get_land_order_book` | Listings and offers for one property, with prices, expiry and any loan on it |
| `get_land_boundary` | Parcel boundary as GeoJSON |
| `get_land_map_image` | Map image of the parcel |
| `explain_property_checks` | What each verification group's value means, decoded from the numeric encoding of Property checks (pass counts come from `get_land_property`'s `propertyChecks`) |
| `estimate_land_borrowing` | What the DeFi lending pool would lend against a property, and what limits it (`limits.limitedBy`): a small amount is often the pool's free liquidity, not a valuation. `toRaise` says what would raise it: each lever, what it would allow, and the step that moves it |
| `get_land_loan` | One loan against a property: status, provider, principal, APR, maturity, full repayment and, while active, the payoff today; by property, by `loanId`, or both |
| `get_fabrica_lending_market` | Loans, pool liquidity, average APR |
| `get_fabrica_loan_book` | What has been lent, at what loan-to-value (against today's estimate), where, and how many were repaid or liquidated |
| `get_land_portfolio` | A wallet's holdings, credit history and loans |
| `get_land_portfolio_map_image` | Map of a wallet's holdings |
| `get_land_activity` | Transfers, sales and loans for a property or wallet; with no filter, the newest across the network |
| `get_fabrica_stats` | Protocol-wide counts and totals |
| `ask_fabrica` | Cited passages from Fabrica's docs, help center and trust agreement for how Fabrica works |
| `find_us_parcel` | Any US address or parcel number: the parcel, whether it is on Fabrica, and the on-ramp link if not |
| `check_county_coverage` | Whether a county (or state) can be added through the on-ramp, and what it asks for: deed and forms, notarization and witnesses, questions, steps. From a table of the on-ramp rules with an as-of date |
| `contact_fabrica_support` | When the docs do not answer or a person is needed: the help center section, the support email and a prefilled email draft. Sends nothing; the person sends it |

On the testnet server (`mcp-testnet.fabrica.land`), seven more tools prepare actions as sign requests: `make_land_offer`, `list_land_for_sale`, `accept_land_offer`, `buy_land`, `cancel_land_order`, and for the DeFi lending pool `borrow_against_land` and `repay_land_loan` (each takes the `wallet` that will sign), plus `get_sign_request` and `get_transaction_status`. They return a summary, warnings and a sign link; nothing happens until the person opens the link and signs with their own wallet. Present the summary and every warning before the link, and say it was prepared, not sent.

## Loops

**Due diligence on a property.** `get_land_property` (its `propertyChecks` give how many Property checks pass), then `explain_property_checks` with the numeric encoding of Property checks, then `get_land_tax_status`, `get_land_valuation` with its source, `get_land_order_book` and `get_land_trust_documents`, then `estimate_land_borrowing` (when the amount is small or zero, its `toRaise` gives each lever and the step that clears it) and `get_land_activity`. Report each fact with its source. End with what to verify independently: the county record of the deed into the trust, a title search or title insurance, taxes paid to date. Never a buy recommendation.

**Find land for a buyer.** One `search_land` call with the filters the person gave: `region` or `county`, `minAcres` and `maxAcres`, `maxPrice` or `maxPricePerAcre` (listed properties only), `near: { lat, lon, radiusMiles }` for "within N miles of", and `sortBy` (`pricePerAcre`, `price`, `acres`, `newest`, `distance`). Each row carries `pricePerAcre` with its basis (listing or estimate) and, with `near`, `distanceMiles` (straight-line). Then `get_land_property` on the shortlist. Never a buy recommendation.

**Work a parcel list.** `find_us_parcel` with `queries`: up to 10 addresses or parcel numbers per call that share a state and county (give those as `state` and `county`). Each row says `onFabrica`; on Fabrica, `tokenId` and `propertyLink`; not on Fabrica, `addToFabrica` (the on-ramp link) and `coverage`. Re-run each `unresolved` entry on its own with a fuller address or with state and county. One table at the end. Each query counts as one lookup against the limit of 30 per minute per client, so a list longer than 30 waits a minute between batches of three calls.

**Review a wallet.** `get_land_portfolio` (loans as borrower and as lender, each with principal, APR, maturity and collateral token), then `get_land_property` for each holding (Property checks from `propertyChecks`, passed of total) and, where it matters, for the collateral of loans the wallet made, then `get_land_activity`. Summarize holdings, then loans where the wallet borrows (what it owes and when) separately from loans where it lends (what it is owed and when), and what needs attention soon.

**Make an offer (testnet).** `get_land_order_book` for the open listings and offers, then `make_land_offer` with the amount, the days it stays open and the person's wallet. Show the summary and the warnings, then the `signLink`, and say it expires in 15 minutes. After the person says they signed, `get_sign_request` with the id; `get_land_order_book` shows the offer. `buy_land` and `accept_land_offer` take the `orderId` from `get_land_order_book` as `orderHash`; a purchase is an onchain transaction that `get_transaction_status` follows.

**Borrow against land (testnet).** `estimate_land_borrowing` for the pool's maximum and the loan lengths it offers, then `borrow_against_land` with the amount, the days and the owner's wallet. Show the summary and every warning, say plainly that a loan is a real obligation (a loan not repaid by maturity lets the lender take the property through the pool's auction), then the `signLink`. The rate and repayment come from the live quote on the sign page. Later, `get_land_loan` shows the loan and its payoff today, and `repay_land_loan` prepares paying it off.

**Add land.** `find_us_parcel` for the parcel; if it is not on Fabrica, the on-ramp link `find_us_parcel` returns in `links.addToFabrica` (it already points at the active network, with the parcel filled in). The owner submits the property and how title is held, Fabrica reviews title, the owner verifies identity, a trust is created, the owner signs the deed and trust documents (normally with a remote online notary), the deed is recorded, and the token is issued. The setup fee is authorized up front and charged once, at the first sale, loan or use in another app. Steps: https://docs.fabrica.land/docs/on-ramp. Fees: https://docs.fabrica.land/docs/fees. Obligations: https://docs.fabrica.land/docs/property-obligations. `check_county_coverage` with the county says whether the on-ramp is set up there and lists the documents and questions; it answers from a dated table, so the on-ramp page is the live answer.

## Legal red lines

- The token is the beneficial interest in the trust that holds the property. The trustee is designated by the token holder and is, by default, the holder.
- Fabrica is not a party to the trust, never holds title, never custodies property, and never manages anyone's trust, property or loan.
- Owners carry the land's obligations: property taxes, maintenance, liability. Transfers are legally binding and can be taxable.
- Property checks are a starting point for your own research, not a title search or title insurance. The number is never a percentage, grade or rating.
- The operating agreement attached to each token sets out the owner's rights and obligations.
- Facts, not advice: no buy, sell or borrow recommendation.
- Owner names: share the names in Fabrica's own records (the deed grantor) and a holder's chosen display name. Never name an owner from third-party parcel data, and never guess one.
- A property is governed by the agreement version on its token, which can be older than the generic template. Quote `fabrica://property/{tokenId}/trust-agreement` (or `get_land_trust_documents`) for a specific property, not `fabrica://legal/us-trust-agreement`.

## Wording

Property checks (not "confidence score" as a name). DeFi lending pool. NFTfi only as a retired integration. "Onchain", one word. Stablecoins are digital dollars. No fixed time and no "instantly" for money moving.
