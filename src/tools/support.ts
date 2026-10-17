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

/**
 * Key material never goes into a support message: a bare 64-hex-character string (a private
 * key as wallets export it; transaction hashes carry 0x and pass), or a line that is only
 * 12 to 24 lowercase words (a seed phrase). Talking about a lost key is fine.
 */
export function containsSecret(text: string): boolean {
  if (/(?<![0-9a-fA-Fx])[0-9a-fA-F]{64}(?![0-9a-fA-F])/.test(text)) return true;
  return text.split(/\r?\n/).some((line) => {
    const words = line.trim().split(/\s+/);
    return words.length >= 12 && words.length <= 24 && words.length % 3 === 0 && words.every((word) => /^[a-z]{3,8}$/.test(word));
  });
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
