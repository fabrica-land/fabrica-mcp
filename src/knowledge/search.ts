// Lexical retrieval over the knowledge index: BM25 over passage text with the page and
// section titles weighted in, plus a small synonym list for Fabrica's own vocabulary.
// No model call and no external service: the agent reading the result is the model.
import type { KnowledgeSource, Passage } from "./index.js";

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from", "how", "i", "if", "in", "is",
  "it", "its", "my", "of", "on", "or", "that", "the", "this", "to", "what", "when", "where", "which", "who", "why",
  "will", "with", "you", "your", "about", "into", "than", "then", "there", "these", "they", "was", "were", "has",
  "have", "had", "me", "we", "our", "any", "all", "not", "no", "so", "but", "also", "just",
]);

/** Query-side expansions. Each entry maps a token (after normalization) to the extra tokens it also means. */
const SYNONYMS: Record<string, string[]> = {
  trustee: ["trustee", "trust"],
  beneficiary: ["beneficiary", "beneficial", "beneficialinterest", "holder"],
  beneficialinterest: ["beneficialinterest", "beneficial", "beneficiary", "trust"],
  beneficial: ["beneficial", "beneficialinterest", "beneficiary"],
  owner: ["owner", "holder", "beneficiary"],
  own: ["own", "owner", "beneficial"],
  hold: ["hold", "holder", "beneficial"],
  nft: ["nft", "token"],
  token: ["token", "nft"],
  premint: ["premint", "unclaimed", "claim"],
  onramp: ["onramp", "ramp", "add", "tokenize", "tokenization"],
  tokenize: ["tokenize", "tokenization", "onramp", "add"],
  tokenizing: ["tokenize", "tokenization", "onramp", "add"],
  offramp: ["offramp", "ramp", "remove", "dissolve"],
  remove: ["remove", "offramp", "dissolve"],
  score: ["score", "checks", "encoding"],
  checks: ["checks", "check", "score", "encoding", "verification"],
  confidence: ["confidence", "checks", "score"],
  pool: ["pool", "lending", "defi"],
  lend: ["lend", "lending", "loan", "borrow"],
  lending: ["lending", "loan", "borrow", "pool"],
  loan: ["loan", "lending", "borrow"],
  borrow: ["borrow", "loan", "lending"],
  mortgage: ["mortgage", "loan", "lending", "borrow"],
  yield: ["yield", "interest", "apr", "return", "deposit"],
  interest: ["interest", "apr", "rate"],
  fee: ["fee", "fees", "cost", "price", "charge"],
  fees: ["fees", "fee", "cost", "charge"],
  cost: ["cost", "fee", "fees", "charge"],
  tax: ["tax", "taxes", "property"],
  taxes: ["taxes", "tax"],
  deed: ["deed", "title", "record"],
  title: ["title", "deed", "record"],
  notary: ["notary", "notarization", "notarized", "sign"],
  notarization: ["notarization", "notary", "notarized"],
  kyc: ["kyc", "identity", "verification", "aml"],
  sell: ["sell", "selling", "list", "listing", "sale"],
  buy: ["buy", "buying", "purchase", "offer"],
  offer: ["offer", "offers", "bid"],
  wallet: ["wallet", "account", "key"],
  dollars: ["dollars", "usdc", "stablecoin", "digital"],
  usdc: ["usdc", "dollars", "stablecoin"],
  mail: ["mail", "forwarding", "address"],
  die: ["die", "death", "estate", "heir", "succession"],
  dies: ["dies", "death", "estate", "heir", "succession"],
  died: ["died", "death", "estate", "heir", "succession"],
  passes: ["passes", "death", "estate", "heir"],
  death: ["death", "estate", "heir", "succession", "inheritance"],
  inherit: ["inherit", "inheritance", "estate", "succession", "death"],
  security: ["security", "securities", "howey"],
  securities: ["securities", "security", "howey"],
  mcp: ["mcp", "agent", "agents", "ai"],
  agent: ["agent", "agents", "mcp", "ai"],
  validator: ["validator", "validators", "validation", "checks"],
  mint: ["mint", "minting", "issue", "issuance"],
  recovery: ["recovery", "stolen", "lost", "recover"],
  stolen: ["stolen", "recovery", "theft"],
};

function stem(token: string): string {
  if (token.length <= 4) return token;
  if (token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.endsWith("ing") && token.length > 6) return token.slice(0, -3);
  if (token.endsWith("es") && token.length > 5) return token.slice(0, -2);
  if (token.endsWith("ed") && token.length > 5) return token.slice(0, -2);
  if (token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

/** Lowercase word tokens with Fabrica's compound terms normalized ("on-ramp" and "on ramp" become "onramp", "beneficial interest" one token). */
export function tokenize(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .replace(/on[- ]ramp(ing|ed|s)?/g, "onramp")
    .replace(/off[- ]ramp(ing|ed|s)?/g, "offramp")
    .replace(/pre[- ]mint(ed|s)?/g, "premint")
    .replace(/on[- ]chain/g, "onchain")
    .replace(/beneficial[- ]interests?/g, "beneficialinterest");
  return normalized
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
    .map(stem);
}

function expandQuery(tokens: string[]): string[] {
  const expanded = new Set<string>();
  for (const token of tokens) {
    expanded.add(token);
    const synonyms = SYNONYMS[token];
    if (synonyms) for (const synonym of synonyms) expanded.add(stem(synonym));
  }
  return [...expanded];
}

interface IndexedPassage {
  passage: Passage;
  termFrequencies: Map<string, number>;
  length: number;
}

interface Bm25Index {
  passages: IndexedPassage[];
  documentFrequencies: Map<string, number>;
  averageLength: number;
}

const K1 = 1.4;
const B = 0.75;
const TITLE_WEIGHT = 3;

function buildIndex(passages: Passage[]): Bm25Index {
  const indexed: IndexedPassage[] = [];
  const documentFrequencies = new Map<string, number>();
  let totalLength = 0;
  for (const passage of passages) {
    const termFrequencies = new Map<string, number>();
    const bodyTokens = tokenize(passage.text);
    const titleTokens = tokenize(`${passage.title} ${passage.sectionTitle}`);
    for (const token of bodyTokens) termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + 1);
    for (const token of titleTokens) termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + TITLE_WEIGHT);
    const length = bodyTokens.length + titleTokens.length * TITLE_WEIGHT;
    for (const token of termFrequencies.keys()) documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
    indexed.push({ passage, termFrequencies, length });
    totalLength += length;
  }
  return { passages: indexed, documentFrequencies, averageLength: indexed.length ? totalLength / indexed.length : 1 };
}

const indexCache = new WeakMap<Passage[], Bm25Index>();

export interface SearchHit {
  passage: Passage;
  score: number;
}

export interface SearchOptions {
  limit: number;
  source?: KnowledgeSource;
}

/** Rank passages for a question. Returns the best `limit` hits with a positive score, one per page section. */
export function searchPassages(passages: Passage[], question: string, options: SearchOptions): SearchHit[] {
  let index = indexCache.get(passages);
  if (!index) {
    index = buildIndex(passages);
    indexCache.set(passages, index);
  }
  const queryTokens = expandQuery(tokenize(question));
  if (queryTokens.length === 0) return [];
  const total = index.passages.length;
  const hits: SearchHit[] = [];
  for (const entry of index.passages) {
    if (options.source && entry.passage.source !== options.source) continue;
    let score = 0;
    for (const token of queryTokens) {
      const frequency = entry.termFrequencies.get(token);
      if (!frequency) continue;
      const documentFrequency = index.documentFrequencies.get(token) ?? 0;
      const idf = Math.log(1 + (total - documentFrequency + 0.5) / (documentFrequency + 0.5));
      const normalized = (frequency * (K1 + 1)) / (frequency + K1 * (1 - B + (B * entry.length) / index.averageLength));
      score += idf * normalized;
    }
    if (score > 0) hits.push({ passage: entry.passage, score });
  }
  hits.sort((left, right) => right.score - left.score);
  // One hit per page section: a long section split into several passages should not crowd
  // out distinct evidence from other pages.
  const seen = new Set<string>();
  const distinct: SearchHit[] = [];
  for (const hit of hits) {
    const key = `${hit.passage.url}#${hit.passage.sectionTitle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(hit);
    if (distinct.length === options.limit) break;
  }
  return distinct;
}
