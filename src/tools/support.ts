import { getPropertyLink } from "../clients/graphql.js";
import { NETWORK, WEB_BASE } from "../config.js";
import { BIP39_WORDLISTS } from "./bip39-wordlists.js";
import { z } from "zod";
import type { ArgsOf } from "./inputs.js";

/**
 * contact_fabrica_support, option A: no secret and nothing sent. It returns the help center
 * section for the topic, the support address, and a prefilled mailto with the agent's
 * summary, which the person sends. Option B (opening the Intercom conversation from the
 * server) needs an Intercom token on the Vercel project and is a separate step.
 */

export const SUPPORT_EMAIL = "questions@fabrica.land";
const HELP_CENTER = "https://help.fabrica.land/en";
const WEB = WEB_BASE;
const MAX_SUMMARY_CHARS = 2000;
const TOKEN_ID = /^[0-9]{1,80}$/;
/** Most mail clients cut a mailto URL somewhere past 2,000 characters. */
const MAX_MAILTO_CHARS = 1900;

export const SUPPORT_TOPICS = ["getting_started", "adding_property", "buying_selling", "borrowing_lending", "trust_legal", "troubleshooting", "other"] as const;
export type SupportTopic = (typeof SUPPORT_TOPICS)[number];

const TOPIC_PAGES: Record<SupportTopic, { label: string; url: string }> = {
  getting_started: { label: "Getting started", url: `${HELP_CENTER}/collections/19712591-getting-started` },
  adding_property: { label: "Your property", url: `${HELP_CENTER}/collections/19712599-your-property` },
  buying_selling: { label: "Buying and selling", url: `${HELP_CENTER}/collections/19712600-buying-selling` },
  borrowing_lending: { label: "Borrowing and lending", url: `${HELP_CENTER}/collections/19712601-borrowing-lending` },
  trust_legal: { label: "Trust and security", url: `${HELP_CENTER}/collections/19712602-trust-security` },
  troubleshooting: { label: "Troubleshooting", url: `${HELP_CENTER}/collections/19712604-troubleshooting-faq` },
  other: { label: "Help center", url: `${HELP_CENTER}/` },
};

/** A label right before a 64-hex value that marks it as a transaction hash, which support may need. */
const TX_CONTEXT = /(https?:\/\/[^\s/]+\/(?:\S*\/)?tx\/|\b(?:tx|txn|transaction)[ _-]?(?:hash|id)\b\s*(?:is\s*|[:=]\s*)?)$/i;

/**
 * Key material never goes into a support message: a 64-hex-character value with or without
 * 0x (a private key) unless it directly follows a transaction-hash label or a block explorer
 * /tx/ URL, or a run of 12 or more words from one BIP-39 wordlist, in any of the ten standard
 * languages (any case, with numbering, bullets and punctuation between them ignored, repeats
 * allowed). Talking about a lost key is fine.
 */
export function containsSecret(raw: string): boolean {
  // The wordlists are NFC; BIP-39 phrases are often NFKD, so compose before comparing.
  const text = raw.normalize("NFC");
  for (const match of text.matchAll(/(?<![0-9a-zA-Z])(?:0[xX])?[0-9a-fA-F]{64}(?![0-9a-fA-F])/g)) {
    if (!TX_CONTEXT.test(text.slice(Math.max(0, match.index - 120), match.index))) return true;
  }
  // Only letters count, so numbering, bullets and punctuation between words are skipped.
  const words = text.toLowerCase().split(/[^\p{L}\p{M}]+/u).filter((word) => word !== "");
  // The Chinese wordlists use one Han character per word. Written without spaces, a phrase is
  // one token of exactly 12 to 24 words; ordinary Chinese prose is not split, or it would match.
  for (const word of words) {
    const chars = [...word];
    if (chars.length >= 12 && chars.length <= 24 && chars.length % 3 === 0 && /^\p{Script=Han}+$/u.test(word)
      && BIP39_WORDLISTS.some((list) => chars.every((char) => list.has(char)))) return true;
  }
  const runs = BIP39_WORDLISTS.map(() => 0);
  for (const word of words) {
    for (const [i, list] of BIP39_WORDLISTS.entries()) {
      runs[i] = list.has(word) ? runs[i] + 1 : 0;
      if (runs[i] >= 12) return true;
    }
  }
  return false;
}

export const contactSupportInput = {
  summary: z.string().min(10).max(2000).describe("What the person is trying to do, what happened, and what was already checked"),
  topic: z.enum(SUPPORT_TOPICS).optional().describe("Help center section: getting_started, adding_property, buying_selling, borrowing_lending, trust_legal, troubleshooting, other (default)"),
  tokenId: z.string().regex(/^[0-9]{1,80}$/).optional().describe("Token ID of the property the question is about (digits only)"),
  subject: z.string().min(3).max(150).optional().describe("Email subject, in the person's words (default: the topic, plus the token ID when given)"),
  discloseAgent: z.boolean().optional().describe("Add a line saying the email was drafted by an AI agent through the Fabrica MCP server (default: true)"),
};
export type ContactSupportArgs = ArgsOf<typeof contactSupportInput>;

/** Lone UTF-16 surrogates make encodeURIComponent throw; replace them with U+FFFD. */
function wellFormed(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

/** Shortens the summary, never the property link or footer after it, until the mailto fits. */
function mailtoLink(subject: string, summary: string, suffix: string[]): string {
  const encode = encodeURIComponent;
  const base = `mailto:${SUPPORT_EMAIL}?subject=${encode(subject)}&body=`;
  const compose = (text: string) => base + encode([text, ...suffix].join("\n\n"));
  let text = summary;
  while (compose(text).length > MAX_MAILTO_CHARS && text.length > 0) {
    // Never cut between the two halves of a surrogate pair: a lone half makes encodeURIComponent throw.
    text = `${text.slice(0, Math.floor(text.length * 0.9)).replace(/[\uD800-\uDBFF]$/, "").trimEnd()}…`;
  }
  return compose(text);
}

/** The property's page as every other tool links it; the stable /property/ link when the API cannot say. */
async function supportPropertyLink(tokenId: string): Promise<string> {
  try {
    const link = await getPropertyLink(tokenId);
    if (link) return link;
  } catch {
    // Fall through: the stable link always resolves on fabrica.land.
  }
  return `${WEB}/property/${NETWORK}/${encodeURIComponent(tokenId)}`;
}

export async function contactSupport(args: ContactSupportArgs) {
  const summary = wellFormed(args.summary).trim();
  if (summary.length < 10) return { error: "The summary needs at least a sentence: what the person is trying to do and what went wrong." };
  if (summary.length > MAX_SUMMARY_CHARS) return { error: `The summary is limited to ${MAX_SUMMARY_CHARS} characters.` };
  if (containsSecret(summary)) {
    return { error: "The summary looks like it contains a private key or seed phrase. Those are never needed by support and are left out of any message; remove them and call again. A transaction hash is fine when labeled, as in transaction hash: 0x…, or an etherscan /tx/ link." };
  }
  if (args.tokenId !== undefined && !TOKEN_ID.test(args.tokenId)) {
    return { error: "tokenId must be a Fabrica token ID: digits only, as get_land_property and search_land return it." };
  }
  const topic = TOPIC_PAGES[args.topic ?? "other"];
  const subjectText = args.subject ? wellFormed(args.subject).replace(/[\r\n]+/g, " ").trim() : "";
  if (subjectText && containsSecret(subjectText)) {
    return { error: "The subject looks like it contains a private key or seed phrase. Remove it and call again." };
  }
  const propertyLink = args.tokenId ? await supportPropertyLink(args.tokenId) : null;
  const subject = subjectText || `Question about Fabrica: ${topic.label}${args.tokenId ? ` (token ${args.tokenId})` : ""}`;
  const disclose = args.discloseAgent ?? true;
  const suffix = [propertyLink ? `Property: ${propertyLink}` : null, disclose ? "Drafted with an AI agent using the Fabrica MCP server." : null].filter((line) => line !== null);
  return {
    helpCenterUrl: topic.url,
    email: SUPPORT_EMAIL,
    mailto: mailtoLink(subject, summary, suffix),
    ...(propertyLink ? { propertyLink } : {}),
    note: "Nothing has been sent. Opening the mailto link drafts an email to Fabrica support with this summary; the person reviews and sends it, and replies come back by email.",
  };
}
