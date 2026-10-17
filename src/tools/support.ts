import { NETWORK, WEB_BASE } from "../config.js";

/**
 * contact_support, option A: no secret and nothing sent. It returns the help center
 * section for the topic, the support address, and a prefilled mailto with the agent's
 * summary, which the person sends. Option B (opening the Intercom conversation from the
 * server) needs an Intercom token on the Vercel project and is a separate step.
 */

export const SUPPORT_EMAIL = "questions@fabrica.land";
const HELP_CENTER = "https://help.fabrica.land/en";
const WEB = WEB_BASE;
const MAX_SUMMARY_CHARS = 2000;
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

/** Common English words that are not BIP-39 words: one of them inside a run means prose, not a seed phrase. */
const NOT_SEED_WORDS = new Set("the and for with but not was are from our your his her its were been has had did does would could should than them their here some each most too why how who which while after please".split(" "));
/** Words just before a 64-hex value that mark it as a transaction hash, which support may need. */
const TX_CONTEXT = /(\/tx\/|\btxn?\b|transaction|\bhash\b)[^\n]{0,20}$/i;

/**
 * Key material never goes into a support message: a 64-hex-character value with or without
 * 0x (a private key) unless the words just before it call it a transaction or hash, or a run
 * of 12 or more seed-phrase-shaped words anywhere in the text (lowercase, 3 to 8 letters, no
 * common non-BIP-39 word, mostly distinct), even after a lead-in such as "my seed phrase is:".
 * Talking about a lost key is fine.
 */
export function containsSecret(text: string): boolean {
  for (const match of text.matchAll(/(?<![0-9a-zA-Z])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/g)) {
    if (!TX_CONTEXT.test(text.slice(Math.max(0, match.index - 40), match.index))) return true;
  }
  let run: string[] = [];
  const isSeedRun = () => run.length >= 12 && new Set(run).size >= 10;
  for (const raw of text.split(/\s+/)) {
    if (/^\d+[.)]?$/.test(raw)) continue;
    const word = raw.replace(/^[("'\[]+|[.,;:!?)"'\]]+$/g, "");
    if (/^[a-z]{3,8}$/.test(word) && !NOT_SEED_WORDS.has(word)) {
      run.push(word);
    } else {
      if (isSeedRun()) return true;
      run = [];
    }
  }
  return isSeedRun();
}

export interface ContactSupportArgs {
  summary: string;
  topic?: SupportTopic;
  tokenId?: string;
}

function mailtoLink(subject: string, body: string): string {
  const encode = encodeURIComponent;
  const base = `mailto:${SUPPORT_EMAIL}?subject=${encode(subject)}&body=`;
  let text = body;
  while (base.length + encode(text).length > MAX_MAILTO_CHARS && text.length > 0) {
    text = `${text.slice(0, Math.floor(text.length * 0.9)).trimEnd()}…`;
  }
  return base + encode(text);
}

export function contactSupport(args: ContactSupportArgs) {
  const summary = args.summary.trim();
  if (summary.length < 10) return { error: "The summary needs at least a sentence: what the person is trying to do and what went wrong." };
  if (summary.length > MAX_SUMMARY_CHARS) return { error: `The summary is limited to ${MAX_SUMMARY_CHARS} characters.` };
  if (containsSecret(summary)) {
    return { error: "The summary looks like it contains a private key or seed phrase. Those are never needed by support and are left out of any message; remove them and call again." };
  }
  const topic = TOPIC_PAGES[args.topic ?? "other"];
  const propertyLink = args.tokenId ? `${WEB}/property/${NETWORK}/${encodeURIComponent(args.tokenId)}` : null;
  const subject = `Question from an AI agent: ${topic.label}${args.tokenId ? ` (token ${args.tokenId})` : ""}`;
  const body = [summary, propertyLink ? `Property: ${propertyLink}` : null, "Sent from an AI agent using the Fabrica MCP server."].filter((line) => line !== null).join("\n\n");
  return {
    helpCenterUrl: topic.url,
    email: SUPPORT_EMAIL,
    mailto: mailtoLink(subject, body),
    ...(propertyLink ? { propertyLink } : {}),
    note: "Nothing has been sent. Opening the mailto link drafts an email to Fabrica support with this summary; the person reviews and sends it, and replies come back by email.",
  };
}
