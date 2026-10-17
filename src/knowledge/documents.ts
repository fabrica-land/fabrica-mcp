// Whole documents reassembled from the knowledge index, for MCP resources. The index is
// passage-grained for retrieval; a resource read wants the full page in reading order.
import { getKnowledgeIndex, type KnowledgeSource, type Passage } from "./index.js";

export interface KnowledgeDocument {
  /** Resource URI, e.g. fabrica://docs/fees */
  uri: string;
  source: KnowledgeSource;
  /** Path under the scheme: the docs slug, the help article slug, or "us-trust-agreement". */
  key: string;
  title: string;
  /** Public page the text comes from. */
  url: string;
  updatedAt: string;
  /** Markdown-ish text with section headings restored. */
  text: string;
}

export const TRUST_AGREEMENT_URI = "fabrica://legal/us-trust-agreement";

function keyFor(passage: Passage): string {
  const path = new URL(passage.url).pathname;
  if (passage.source === "trust-agreement") return "us-trust-agreement";
  if (passage.source === "docs") return path.replace(/^\/docs\//, "").replace(/\/$/, "");
  // help.fabrica.land/en/articles/<id>-<slug>: keep the whole last segment, it is stable and readable
  return path.slice(path.lastIndexOf("/") + 1);
}

function uriFor(source: KnowledgeSource, key: string): string {
  if (source === "trust-agreement") return TRUST_AGREEMENT_URI;
  return `fabrica://${source}/${key}`;
}

function assemble(passages: Passage[]): string {
  const parts: string[] = [];
  let lastSection = "";
  for (const passage of passages) {
    if (passage.sectionTitle && passage.sectionTitle !== passage.title && passage.sectionTitle !== lastSection) {
      parts.push(`## ${passage.sectionTitle}`);
    }
    lastSection = passage.sectionTitle;
    parts.push(passage.text);
  }
  return parts.join("\n\n");
}

let cached: KnowledgeDocument[] | undefined;

/** Every document in the index, in index order (docs pages, then help articles, then the trust agreement). */
export function getKnowledgeDocuments(): KnowledgeDocument[] {
  if (cached) return cached;
  const byUrl = new Map<string, Passage[]>();
  for (const passage of getKnowledgeIndex().passages) {
    const list = byUrl.get(passage.url);
    if (list) list.push(passage);
    else byUrl.set(passage.url, [passage]);
  }
  cached = [...byUrl.values()].map((passages) => {
    const [first] = passages;
    if (!first) throw new Error("knowledge documents: empty passage group");
    const key = keyFor(first);
    return {
      uri: uriFor(first.source, key),
      source: first.source,
      key,
      title: first.title,
      url: first.url,
      updatedAt: first.updatedAt,
      text: assemble(passages),
    };
  });
  return cached;
}

export function findKnowledgeDocument(uri: string): KnowledgeDocument | undefined {
  return getKnowledgeDocuments().find((document) => document.uri === uri);
}

/** The text a resource read returns: a header with provenance, then the document. */
export function renderKnowledgeDocument(document: KnowledgeDocument): string {
  const header = [`# ${document.title}`, `Source: ${document.url}`, document.updatedAt ? `Updated: ${document.updatedAt}` : ""].filter(Boolean);
  return `${header.join("\n")}\n\n${document.text}\n`;
}
