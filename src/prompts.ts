import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { IS_MAINNET, MAINNET_LEGAL_NOTICE, NETWORK_LABEL } from "./config.js";

/**
 * MCP prompts: the standard loops (due diligence, a parcel list, a wallet review, adding
 * land) written once so every client runs them in the same order and to the same
 * standard. `skills/fabrica/SKILL.md` carries the same loops for agents that never
 * connect to this server. Steps that name a tool this server may not list yet say so.
 */

const WEB = IS_MAINNET ? "https://fabrica.land" : "https://testnets.fabrica.land";

export const WORDING_RULES = `Wording for the answer:
- The per-property verification is called Property checks. It is a starting point for diligence, not a title search, and the number is never a percentage, grade or rating.
- The in-app pool is the DeFi lending pool. NFTfi is a retired peer-to-peer integration and appears only as history.
- Owning a Fabrica token means owning the beneficial interest in the trust that holds the property. The trustee is designated by the token holder and is, by default, the holder. Fabrica is not a party to the trust and never holds title, custodies property or manages anyone's trust, property or loan.
- No fixed time and no "instantly" for money moving. Stablecoins are digital dollars.
- Write "onchain" as one word. No buy, sell or borrow recommendation: lay out the facts and what to verify.`;

const NETWORK_LINE = IS_MAINNET
  ? `Network: ${NETWORK_LABEL}. These are real US properties.\n\n${MAINNET_LEGAL_NOTICE}`
  : `Network: ${NETWORK_LABEL}. Test properties only, with no real-world legal or financial effect.`;

function prompt(task: string): GetPromptResult {
  return {
    messages: [{ role: "user", content: { type: "text", text: `${task}\n\n${WORDING_RULES}\n\n${NETWORK_LINE}` } }],
  };
}

export function dueDiligencePrompt(tokenId: string): GetPromptResult {
  return prompt(`Run due diligence on Fabrica property ${tokenId} with the Fabrica tools, in this order:
1. get_property: the record (location, acreage, owner wallet, trust and operating agreement link, listing, loans).
2. Property checks: how many pass, from get_property's propertyChecks (passed of total), then explain_confidence_score with the numeric encoding of Property checks for what each group means. Never call the number a score, rating or percentage.
3. get_tax_status: whether taxes are current, past due or unknown according to Property checks, and whether that limits borrowing.
4. get_valuation: the value with its source and confidence level.
5. get_order_book: the listing and the offers.
6. get_trust_documents: the trust, the trust agreement, the legal description, the deed reference and the documents attached to the token.
7. get_borrow_quote: the lending position and what the DeFi lending pool would lend.
8. get_activity for the property: transfers, sales, loans.
Write a short report with one section per step, each fact with the tool it came from. End with "What to verify yourself": the county record of the deed into the trust, a title search or title insurance, taxes paid to date with the county, and anything a step could not answer. No recommendation to buy.`);
}

export function workParcelListPrompt(parcels: string): GetPromptResult {
  return prompt(`Work through this list of US parcels (addresses or parcel numbers), one per line or comma-separated:
${parcels}

For each parcel, call find_parcel once (with state and county when the list gives them). If it returns several candidates, call it again with the state and county the list implies, or mark the row as ambiguous. Then:
- On Fabrica: note the token ID and property link; get_property for the listing and loan state if the list is short.
- Not on Fabrica: note the on-ramp link (links.addToFabrica). Opening it starts adding the parcel; the owner decides there.
End with one table: input, matched address, county and state, APN, on Fabrica (token ID) or on-ramp link, notes. find_parcel is limited per client per minute, so a long list goes in batches.`);
}

export function walletReviewPrompt(wallet: string): GetPromptResult {
  return prompt(`Review Fabrica wallet ${wallet}:
1. get_portfolio: holdings, credit history, loan positions.
2. get_property for each property held (the ones with active loans first; for a large wallet, the first 10 and say how many were left out): its Property checks from propertyChecks (passed of total) and, for each active loan, principal, APR, maturity date and the property it is against. List maturities in date order.
3. get_activity for the wallet: recent transfers, sales and loans; offers made, if the activity shows them.
4. get_portfolio_image for a map of the holdings, if the client shows images.
Summarize what the wallet holds, what it owes and when, and anything that needs attention soon (a loan near maturity, a property whose propertyChecks show fewer passed than total). Judge Property checks only from propertyChecks, never from the digits of the numeric encoding.`);
}

export function howToAddLandPrompt(address: string): GetPromptResult {
  return prompt(`Explain how to add this land to Fabrica: ${address}

1. Call find_parcel for it. If it is already on Fabrica, say so and link the property instead.
2. Otherwise, give the on-ramp link from find_parcel (links.addToFabrica), or ${WEB}/go if it could not resolve the parcel.
3. Explain the on-ramp, from https://docs.fabrica.land/docs/on-ramp: the owner submits the property and how title is held, Fabrica (as validator) reviews title, the owner verifies identity, a trust is created to hold title, the owner signs the deed and trust documents (normally with a remote online notary), the deed is recorded at the county, and the token is issued. About 10 minutes online for the owner; the property page and listing are live from the start.
4. Fees, from https://docs.fabrica.land/docs/fees: the setup fee is authorized when the property is added and charged once, at the first sale, loan or use in another app; it is waived if the property is removed unused. Current amounts: https://help.fabrica.land/en/articles/3305355-what-does-fabrica-cost.
5. Obligations that stay with the owner (taxes, maintenance, liability): https://docs.fabrica.land/docs/property-obligations.
Fabrica operates in all 50 states; the on-ramp page shows what this county requires.`);
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
      description: "For each US address or parcel number in a list: find the parcel, whether it is on Fabrica, and the on-ramp link if not. Ends with one table.",
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
      description: "What the on-ramp involves for a given parcel: the link to start it, the steps (title review, identity, notary, recording), the deferred setup fee, and the owner's obligations.",
      argsSchema: { address: z.string().describe("Street address or parcel number of the land") },
    },
    ({ address }) => howToAddLandPrompt(address),
  );
}
