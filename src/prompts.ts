import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { IS_MAINNET, MAINNET_LEGAL_NOTICE, NETWORK_LABEL, WEB_BASE } from "./config.js";

/**
 * MCP prompts: the standard loops (due diligence, a parcel list, a wallet review, adding
 * land) written once so every client runs them in the same order and to the same
 * standard. `skills/fabrica/SKILL.md` carries the same loops for agents that never
 * connect to this server. Steps that name a tool this server may not list yet say so.
 */

const WEB = WEB_BASE;

const OWNERSHIP_RULE = IS_MAINNET
  ? "- Owning a Fabrica token means owning the beneficial interest in the trust that holds the property. The trustee is designated by the token holder and is, by default, the holder. Fabrica is not a party to the trust and never holds title, custodies property or manages anyone's trust, property or loan."
  : "- These are test tokens: holding one is not ownership of any real property or of a beneficial interest in a trust. Never present a test token as legal ownership.";

export const WORDING_RULES = `Wording for the answer:
- The per-property verification is called Property checks. It is a starting point for your own research, not a title search or title insurance, and the number is never a percentage, grade or rating.
- The in-app pool is the DeFi lending pool. NFTfi is a retired peer-to-peer integration and appears only as history.
${OWNERSHIP_RULE}
- No fixed time and no "instantly" for money moving. Stablecoins are digital dollars.
- Use the names people see on fabrica.land: "property" is the default noun; a property not yet on Fabrica is "unclaimed" or "being added" (never "premint"); people "add" a property and "remove" it (not "on-ramp", "off-ramp", "mint" or "burn"); a token is "issued".
- Write "onchain" as one word. No buy, sell or borrow recommendation: lay out the facts and what to verify.`;

const NETWORK_LINE = IS_MAINNET
  ? `Network: ${NETWORK_LABEL}. These are real US properties.\n\n${MAINNET_LEGAL_NOTICE}`
  : `Network: ${NETWORK_LABEL}. Test properties only, with no real-world legal or financial effect. Every result on this network (Property checks, tax status, valuations, loans, activity) is test data: label it as test data in the answer and draw no conclusion about real land, taxes or money from it.`;

function prompt(task: string): GetPromptResult {
  return {
    messages: [{ role: "user", content: { type: "text", text: `${task}\n\n${WORDING_RULES}\n\n${NETWORK_LINE}` } }],
  };
}

const VERIFY_ENDING = IS_MAINNET
  ? 'End with "What to verify yourself": the county record of the deed into the trust, a title search or title insurance, taxes paid to date with the county, and anything a step could not answer.'
  : 'End with "What to verify yourself": anything a step could not answer, and that on this test network the property is a test token, so county records, title and taxes do not apply.';

export function dueDiligencePrompt(tokenId: string): GetPromptResult {
  return prompt(`Run due diligence on Fabrica property ${tokenId} with the Fabrica tools, in this order:
1. get_land_property: the record (location, acreage, owner wallet, trust and operating agreement link, listing, loans).
2. Property checks: how many pass, from get_land_property's propertyChecks (passed of total), then explain_property_checks with the numeric encoding of Property checks for what each group means. Never call the number a score, rating or percentage.
3. get_land_tax_status: whether taxes are current, past due or unknown according to Property checks, and whether that limits borrowing.
4. get_land_valuation: the value with its source and confidence level.
5. get_land_order_book: the listing and the offers.
6. get_land_trust_documents: the trust, the trust agreement, the legal description, the deed reference and the documents attached to the token.
7. estimate_land_borrowing: the lending position, what the DeFi lending pool would lend, and from toRaise what would raise that amount (each lever with the step that moves it, stated as facts).
8. get_land_activity for the property: transfers, sales, loans.
Write a short report with one section per step, each fact with the tool it came from. ${VERIFY_ENDING} No recommendation to buy.`);
}

export function workParcelListPrompt(parcels: string): GetPromptResult {
  return prompt(`Work through this list of US parcels (addresses or parcel numbers), one per line or comma-separated:
${parcels}

Call find_us_parcel with queries: up to 10 rows per call, grouped so each call shares one state and county (pass them as state and county when the list gives them). Each resolved row comes back with onFabrica; each unresolved one with a reason. Re-run an unresolved row on its own with the state and county the list implies, or mark it as ambiguous. Then:
- On Fabrica: note the token ID and property link; get_land_property for the listing and loan state if the list is short.
- Not on Fabrica: note the link to add it (addToFabrica on the row; links.addToFabrica when a row is re-run on its own). Opening it starts adding the parcel; the owner decides there.
End with one table: input, matched address, county and state, APN, on Fabrica (token ID) or link to add it, notes. find_us_parcel counts each query as one lookup against a per-client limit of 30 a minute, so a list longer than 30 waits a minute between batches.`);
}

export function walletReviewPrompt(wallet: string): GetPromptResult {
  return prompt(`Review Fabrica wallet ${wallet}:
1. get_land_portfolio: holdings, credit history, and active loans as borrower (lending.asBorrower) and as lender (lending.asLender), each with principal, APR, maturity date and collateral token.
2. get_land_property for each property held (the ones with active loans first; for a large wallet, the first 10 and say how many were left out): its Property checks from propertyChecks (passed of total). For loans the wallet made, get_land_property on the collateralTokenId when the property behind the loan matters. List maturities in date order, borrowed and lent separately.
3. get_land_activity for the wallet: recent transfers, sales and loans; offers made, if the activity shows them.
4. get_land_portfolio_map_image for a map of the holdings, if the client shows images.
Summarize what the wallet holds; as borrower, what it owes and when (principal, APR, maturity); as lender, what it is owed and when, kept separate from what it owes; and anything that needs attention soon (a loan near maturity, a property whose propertyChecks show fewer passed than total). Judge Property checks only from propertyChecks, never from the digits of the numeric encoding.`);
}

const ONRAMP_STEPS = IS_MAINNET
  ? `Explain the steps to add a property, from https://docs.fabrica.land/docs/on-ramp: the owner submits the property and how title is held, Fabrica (as validator) reviews title, the owner verifies identity, a trust is created to hold title, the owner signs the deed and trust documents (normally with a remote online notary), the deed is recorded at the county, and the token is issued. About 10 minutes online for the owner; the property page is live from the start, and the owner can choose to list it for sale from then.
5. Fees, from https://docs.fabrica.land/docs/fees: the setup fee is authorized when the property is added and charged once, at the first sale, loan or use in another app; it is waived if the property is removed unused. Current amounts: https://help.fabrica.land/en/articles/3305355-what-does-fabrica-cost.
6. Obligations that stay with the owner (taxes, maintenance, liability): https://docs.fabrica.land/docs/property-obligations.`
  : "This is the Sepolia test network: properties here are test tokens for trying the flow. No trust is created, no deed is signed or recorded, and nothing changes who owns the land. For adding real property (title review, identity, trust, deed recording at the county), point to https://docs.fabrica.land/docs/on-ramp and Ethereum Mainnet.";

export function howToAddLandPrompt(address: string): GetPromptResult {
  return prompt(`Explain how to add this land to Fabrica: ${address}

1. Call find_us_parcel for it. If it is already on Fabrica, say so and link the property instead.
2. Otherwise, give the link to add it from find_us_parcel (links.addToFabrica), or ${WEB}/go if it could not resolve the parcel.
3. Call check_county_coverage for the parcel's county: say whether adding property is set up there, and list the documents, witnesses and questions it returns, with its as-of date.
4. ${ONRAMP_STEPS}`);
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "due_diligence",
    {
      title: "Due diligence on a property",
      description: "Records, Property checks, taxes, valuation with sources, order book, trust documents, lending position and activity for one Fabrica property, ending with what to verify independently. No buy recommendation.",
      argsSchema: { tokenId: z.string().describe("Token ID of the Fabrica property") },
    },
    ({ tokenId }) => dueDiligencePrompt(tokenId),
  );
  server.registerPrompt(
    "work_parcel_list",
    {
      title: "Work a list of parcels",
      description: "For each US address or parcel number in a list: find the parcel, whether it is on Fabrica, and the link to add it if not. Ends with one table.",
      argsSchema: { parcels: z.string().describe("Addresses or parcel numbers, one per line or comma-separated") },
    },
    ({ parcels }) => workParcelListPrompt(parcels),
  );
  server.registerPrompt(
    "wallet_review",
    {
      title: "Review a wallet",
      description: "Holdings, loans and maturities, activity and credit history for one wallet on Fabrica.",
      argsSchema: { wallet: z.string().describe("Ethereum wallet address (0x...)") },
    },
    ({ wallet }) => walletReviewPrompt(wallet),
  );
  server.registerPrompt(
    "how_to_add_land",
    {
      title: "How to add land to Fabrica",
      description: IS_MAINNET
        ? "What adding a given parcel to Fabrica involves: the link to start it, the steps (title review, identity, notary, recording), the deferred setup fee, and the owner's obligations."
        : "How adding a parcel works on the Sepolia test network: the link to start it, and that test tokens create no trust, record no deed and change no ownership.",
      argsSchema: { address: z.string().describe("Street address or parcel number of the land") },
    },
    ({ address }) => howToAddLandPrompt(address),
  );
}
