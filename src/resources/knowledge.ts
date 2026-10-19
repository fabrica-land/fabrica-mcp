// MCP resources: Fabrica's key documents, readable by any client. Built from the same
// knowledge index as ask_fabrica, so there is one pipeline and one set of pins.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { getOperatingAgreement } from "../clients/graphql.js";
import { CONTRACTS, IS_MAINNET, MAINNET_LEGAL_NOTICE, NETWORK, NETWORK_LABEL } from "../config.js";
import {
  findKnowledgeDocument,
  getKnowledgeDocuments,
  renderKnowledgeDocument,
  TRUST_AGREEMENT_URI,
  type KnowledgeDocument,
} from "../knowledge/documents.js";
import { getKnowledgeIndex } from "../knowledge/index.js";

export const NETWORK_URI = "fabrica://network";
export const PROPERTY_TRUST_AGREEMENT_TEMPLATE = "fabrica://property/{tokenId}/trust-agreement";
const MARKDOWN = "text/markdown";

/**
 * Listed first, in this order: the pages a person most often wants to pull into a chat.
 * Docs slugs as served by docs.fabrica.land.
 */
export const CURATED_DOCS: readonly string[] = [
  "property-obligations",
  "fees",
  "on-ramp",
  "off-ramp",
  "confidence-scoring-system",
  "lending-pool",
  "fabrica-trust",
  "regulatory-framework",
  "glossary",
  "ai-agents",
];

function markdownResource(uri: string, text: string): ReadResourceResult {
  return { contents: [{ uri, mimeType: MARKDOWN, text }] };
}

function describe(document: KnowledgeDocument): string {
  const where = document.source === "docs" ? "docs.fabrica.land" : document.source === "help" ? "the Fabrica help center" : "fabrica-land/fabrica-connectors";
  return `${document.title}, from ${where} (${document.url})`;
}

function networkText(): string {
  const lines = [
    "# Fabrica MCP server network",
    `Network: ${NETWORK_LABEL} (${NETWORK})`,
    "",
    "## Contracts",
    `- Fabrica token (ERC-1155): ${CONTRACTS.fabricaToken}`,
    `- Fabrica validator: ${CONTRACTS.fabricaValidator}`,
    ...(CONTRACTS.nftfiV2 ? [`- NFTfi v2 (retired peer-to-peer lending): ${CONTRACTS.nftfiV2}`] : []),
    ...(CONTRACTS.nftfiV3 ? [`- NFTfi v3 (retired peer-to-peer lending): ${CONTRACTS.nftfiV3}`] : []),
    "- DeFi lending pools: discovered from the lending subgraph (see get_fabrica_lending_market)",
    "",
    "## Documents",
    `Knowledge index built ${getKnowledgeIndex().builtAt}; sources at ${TRUST_AGREEMENT_URI}, fabrica://docs/{slug}, fabrica://help/{id}.`,
    "",
    IS_MAINNET ? MAINNET_LEGAL_NOTICE : "Sepolia Testnet: properties on this network are test tokens with no real-world legal or financial effect.",
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * The generic agreement with what an agent needs before quoting it: which version this is,
 * that a property may pin another one, and the section list up front (the full text runs
 * past many clients' read limit, so the contents show what was cut).
 */
export function renderTrustAgreement(document: KnowledgeDocument): string {
  const commit = getKnowledgeIndex().sources["trust-agreement"].commit;
  const sections = [...document.text.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  const lines = [
    `# ${document.title}`,
    `Source: ${document.url}`,
    `Version: the current template on fabrica-connectors main, as indexed ${getKnowledgeIndex().builtAt}${commit ? ` (commit ${commit.slice(0, 7)})` : ""}.`,
    "",
    `> Each property is governed by the agreement version attached to its token, which can be older than this one. For a specific property read ${PROPERTY_TRUST_AGREEMENT_TEMPLATE} (its own text, name and version), or call get_land_trust_documents with includeAgreementText.`,
    "",
    ...(sections.length > 0 ? ["## Contents", ...sections.map((title) => `- ${title}`), ""] : []),
    document.text,
  ];
  return `${lines.join("\n")}\n`;
}

export function registerKnowledgeResources(server: McpServer): void {
  const documents = getKnowledgeDocuments();
  const docs = documents.filter((document) => document.source === "docs");
  const help = documents.filter((document) => document.source === "help");
  const trust = documents.find((document) => document.source === "trust-agreement");

  // Curated pages first, then the rest of the docs, so resources/list reads top-down.
  const curated = CURATED_DOCS.map((slug) => docs.find((document) => document.key === slug)).filter((document): document is KnowledgeDocument => document !== undefined);
  const ordered = [...curated, ...docs.filter((document) => !curated.includes(document))];
  for (const document of ordered) {
    server.registerResource(
      `docs:${document.key}`,
      document.uri,
      { title: document.title, description: describe(document), mimeType: MARKDOWN },
      async () => markdownResource(document.uri, renderKnowledgeDocument(document)),
    );
  }

  if (trust) {
    server.registerResource(
      "legal:us-trust-agreement",
      TRUST_AGREEMENT_URI,
      { title: trust.title, description: `${describe(trust)}. The current template; a property may pin an older version, served at ${PROPERTY_TRUST_AGREEMENT_TEMPLATE}.`, mimeType: MARKDOWN },
      async () => markdownResource(TRUST_AGREEMENT_URI, renderTrustAgreement(trust)),
    );
  }

  server.registerResource(
    "network",
    NETWORK_URI,
    { title: `Fabrica network: ${NETWORK_LABEL}`, description: "The network this server reads, its contract addresses and the legal notice", mimeType: MARKDOWN },
    async () => markdownResource(NETWORK_URI, networkText()),
  );

  for (const document of help) {
    server.registerResource(
      `help:${document.key}`,
      document.uri,
      { title: document.title, description: describe(document), mimeType: MARKDOWN },
      async () => markdownResource(document.uri, renderKnowledgeDocument(document)),
    );
  }

  // Templates: the same documents addressed by slug or id, with completion, for clients
  // that let a person type a URI. Listing is left to the static resources above.
  const byKeyTemplate = (source: "docs" | "help", list: KnowledgeDocument[], variable: string) =>
    new ResourceTemplate(`fabrica://${source}/{${variable}}`, {
      list: undefined,
      complete: {
        [variable]: (value) => list.map((document) => document.key).filter((key) => key.startsWith(value)).slice(0, 50),
      },
    });
  server.registerResource(
    "docs-by-slug",
    byKeyTemplate("docs", docs, "slug"),
    { title: "Fabrica docs page", description: "A docs.fabrica.land page by slug, e.g. fabrica://docs/fees", mimeType: MARKDOWN },
    async (uri) => {
      const document = findKnowledgeDocument(uri.href);
      if (!document) throw new Error(`No docs page ${uri.href}. Slugs: ${docs.map((entry) => entry.key).join(", ")}`);
      return markdownResource(document.uri, renderKnowledgeDocument(document));
    },
  );
  server.registerResource(
    "help-by-id",
    byKeyTemplate("help", help, "id"),
    { title: "Fabrica help center article", description: "A help.fabrica.land article by id, e.g. fabrica://help/3305355-what-does-fabrica-cost", mimeType: MARKDOWN },
    async (uri) => {
      const document = findKnowledgeDocument(uri.href);
      if (!document) throw new Error(`No help center article ${uri.href}.`);
      return markdownResource(document.uri, renderKnowledgeDocument(document));
    },
  );

  server.registerResource(
    "property-trust-agreement",
    new ResourceTemplate(PROPERTY_TRUST_AGREEMENT_TEMPLATE, { list: undefined }),
    {
      title: "Trust agreement for one property",
      description: `The operating agreement (trust instrument) attached to a specific token, as the Fabrica API serves it (${NETWORK_LABEL}). Versions differ by mint date, so read this one rather than the generic agreement when a question is about a particular property.`,
      mimeType: MARKDOWN,
    },
    async (uri, variables) => {
      const tokenId = String(variables.tokenId ?? "").trim();
      if (!/^\d{1,78}$/.test(tokenId)) throw new Error("tokenId must be the numeric token id, e.g. fabrica://property/12743610130101631987/trust-agreement");
      const token = await getOperatingAgreement(tokenId);
      if (!token) throw new Error(`No property found with token ID ${tokenId} on ${NETWORK_LABEL}.`);
      if (!token.operatingAgreement) throw new Error(`Token ${tokenId} has no operating agreement text on the API. Its URL, when set: ${token.operatingAgreementUrl ?? "none"}.`);
      const header = [
        `# ${token.operatingAgreementName ?? "Operating agreement"} (token ${tokenId})`,
        `Network: ${NETWORK_LABEL}`,
        token.operatingAgreementUrl ? `Source: ${token.operatingAgreementUrl}` : "",
      ].filter(Boolean);
      return markdownResource(uri.href, `${header.join("\n")}\n\n${token.operatingAgreement}\n`);
    },
  );
}
