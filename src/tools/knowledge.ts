// ask_fabrica: cited passages from Fabrica's own documents, so an agent answers legal
// and product questions from our text and points at the page it came from.
import { getKnowledgeIndex, type KnowledgeSource } from "../knowledge/index.js";
import { searchPassages } from "../knowledge/search.js";
import { NETWORK_LABEL } from "../config.js";

export const ASK_FABRICA_SOURCES = ["docs", "help", "trust-agreement", "all"] as const;
export type AskFabricaSource = (typeof ASK_FABRICA_SOURCES)[number];

export interface AskFabricaArgs {
  question: string;
  maxPassages?: number;
  source?: AskFabricaSource;
}

export interface AskFabricaPassage {
  title: string;
  sectionTitle: string;
  url: string;
  source: KnowledgeSource;
  text: string;
  updatedAt: string;
}

export interface AskFabricaResult {
  network: string;
  question: string;
  passages: AskFabricaPassage[];
  suggestedTools: string[];
  index: {
    builtAt: string;
    sources: Record<KnowledgeSource, { url: string; documents: number; commit?: string }>;
  };
  note: string;
}

export interface AskFabricaError {
  error: string;
}

const DEFAULT_PASSAGES = 5;
const MAX_PASSAGES = 10;

const LOOKUP_HINTS: { pattern: RegExp; tools: string[] }[] = [
  { pattern: /\b0x[0-9a-f]{40}\b/i, tools: ["get_portfolio", "get_activity", "get_portfolio_image"] },
  { pattern: /\b\d{15,}\b/, tools: ["get_property", "get_borrow_quote", "get_activity", "get_property_map"] },
  { pattern: /\b(for sale|listed|listing|listings|cheapest|under \$|acres? in|properties in|land in)\b/i, tools: ["search_properties"] },
  { pattern: /\b(how much can .* borrow|borrow against|loan on|borrowing capacity)\b/i, tools: ["get_borrow_quote"] },
  { pattern: /\b(lending market|active loans|repaid loans|pool liquidity|tvl)\b/i, tools: ["get_lending_market", "get_protocol_stats"] },
  { pattern: /\b(how many properties|protocol stats|statistics|which states)\b/i, tools: ["get_protocol_stats"] },
  { pattern: /\b\d{5}\b.*\b(checks|score|encoding)\b|\b(checks|score|encoding)\b.*\b\d{5}\b/i, tools: ["explain_confidence_score"] },
];

function suggestedToolsFor(question: string): string[] {
  const tools = new Set<string>();
  for (const hint of LOOKUP_HINTS) if (hint.pattern.test(question)) for (const tool of hint.tools) tools.add(tool);
  return [...tools];
}

const SOURCE_NOTE =
  "Passages are quoted from Fabrica's published documents. Cite the URL when relaying an answer. " +
  "When no passage answers the question, say so; the help center at https://help.fabrica.land and questions@fabrica.land reach Fabrica support. " +
  "These documents are informational and are not legal, tax or financial advice.";

export async function askFabrica(args: AskFabricaArgs): Promise<AskFabricaResult | AskFabricaError> {
  const question = args.question.trim();
  if (question.length < 3) return { error: "Ask a question of at least three characters." };
  if (question.length > 1000) return { error: "Keep the question under 1000 characters." };
  const limit = Math.min(Math.max(args.maxPassages ?? DEFAULT_PASSAGES, 1), MAX_PASSAGES);
  const source = args.source && args.source !== "all" ? args.source : undefined;
  const index = getKnowledgeIndex();
  const hits = searchPassages(index.passages, question, { limit, ...(source ? { source } : {}) });
  return {
    network: NETWORK_LABEL,
    question,
    passages: hits.map(({ passage }) => ({
      title: passage.title,
      sectionTitle: passage.sectionTitle,
      url: passage.url,
      source: passage.source,
      text: passage.text,
      updatedAt: passage.updatedAt,
    })),
    suggestedTools: suggestedToolsFor(question),
    index: { builtAt: index.builtAt, sources: index.sources },
    note: hits.length === 0 ? `No passage in the index matches this question. ${SOURCE_NOTE}` : SOURCE_NOTE,
  };
}
