// The knowledge index behind `ask_fabrica`: passages from docs.fabrica.land, the help
// center and the US trust agreement, built by scripts/build-knowledge.mjs into
// generated/index.json (committed). This module validates the file's shape once at load,
// so the rest of the code works with typed passages and no casts.
import generated from "./generated/index.json";

export type KnowledgeSource = "docs" | "help" | "trust-agreement";

export interface Passage {
  id: string;
  source: KnowledgeSource;
  title: string;
  sectionTitle: string;
  url: string;
  text: string;
  updatedAt: string;
}

export interface SourceInfo {
  url: string;
  documents: number;
  commit?: string;
}

export interface KnowledgeIndex {
  builtAt: string;
  sources: Record<KnowledgeSource, SourceInfo>;
  passages: Passage[];
}

const SOURCES: readonly KnowledgeSource[] = ["docs", "help", "trust-agreement"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`knowledge index: ${key} is not a string`);
  return value;
}

function toSource(value: string): KnowledgeSource {
  const found = SOURCES.find((source) => source === value);
  if (!found) throw new Error(`knowledge index: unknown source ${value}`);
  return found;
}

function toPassage(value: unknown): Passage {
  if (!isRecord(value)) throw new Error("knowledge index: passage is not an object");
  return {
    id: readString(value, "id"),
    source: toSource(readString(value, "source")),
    title: readString(value, "title"),
    sectionTitle: readString(value, "sectionTitle"),
    url: readString(value, "url"),
    text: readString(value, "text"),
    updatedAt: readString(value, "updatedAt"),
  };
}

function toSourceInfo(value: unknown): SourceInfo {
  if (!isRecord(value)) throw new Error("knowledge index: source info is not an object");
  const documents = value.documents;
  if (typeof documents !== "number") throw new Error("knowledge index: documents is not a number");
  const commit = value.commit;
  return { url: readString(value, "url"), documents, ...(typeof commit === "string" ? { commit } : {}) };
}

function loadIndex(raw: unknown): KnowledgeIndex {
  if (!isRecord(raw) || !isRecord(raw.sources) || !Array.isArray(raw.passages)) {
    throw new Error("knowledge index: unexpected file shape");
  }
  const sources = raw.sources;
  return {
    builtAt: readString(raw, "builtAt"),
    sources: {
      docs: toSourceInfo(sources.docs),
      help: toSourceInfo(sources.help),
      "trust-agreement": toSourceInfo(sources["trust-agreement"]),
    },
    passages: raw.passages.map(toPassage),
  };
}

let cached: KnowledgeIndex | undefined;

/** The index, validated once per process. */
export function getKnowledgeIndex(): KnowledgeIndex {
  if (!cached) cached = loadIndex(generated);
  return cached;
}
