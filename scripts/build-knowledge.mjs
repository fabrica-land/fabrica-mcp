// Builds the knowledge index behind the `ask_fabrica` tool: every public Fabrica
// document, split into passages with its source URL, written to
// src/knowledge/generated/index.json (committed, so deploys and tests never depend on
// a third-party fetch; the refresh workflow opens a pull request when a source moves).
//
// Sources (knowledge/sources.json):
//   docs            docs.fabrica.land, from the fabrica-land/docs repository (branch v3.0).
//                   Read from a local checkout (--docs-dir or KNOWLEDGE_DOCS_DIR), or
//                   downloaded from GitHub with GITHUB_TOKEN when the checkout is absent.
//   help            help.fabrica.land, the public Intercom help center: the sitemap lists
//                   the articles, each article page carries its body.
//   trust-agreement the US trust agreement, fabrica-land/fabrica-connectors (public).
//
// Usage: node scripts/build-knowledge.mjs [--docs-dir <path>] [--check]
//   --check  exits 1 when any source moved past its pin (used by the refresh workflow).
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);

const SOURCES_FILE = "knowledge/sources.json";
const OUTPUT_FILE = "src/knowledge/generated/index.json";
const MAX_PASSAGE_CHARS = 1600;
const DOCS_BASE_URL = "https://docs.fabrica.land/docs/";

const args = process.argv.slice(2);
const docsDirArg = args.includes("--docs-dir") ? args[args.indexOf("--docs-dir") + 1] : undefined;
const docsDir = docsDirArg ?? process.env.KNOWLEDGE_DOCS_DIR;
const checkOnly = args.includes("--check");

const sources = JSON.parse(await readFile(SOURCES_FILE, "utf8"));

/** Fetch with a timeout and a clear error; GitHub calls carry the token when present. */
async function fetchText(url, init = {}) {
  const headers = { "User-Agent": "fabrica-mcp-knowledge-build", ...init.headers };
  if (url.startsWith("https://api.github.com/") && process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/** Intercom article HTML to markdown-like text: headings, lists and paragraphs survive, markup does not. */
function htmlToText(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, inner) => `\n\n${"#".repeat(Number(level))} ${inner}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
    .replace(/<\/(p|div|ul|ol|table|tr|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<td[^>]*>([\s\S]*?)<\/td>/gi, " $1 |")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      return href.startsWith("http") && label && label !== href ? `${label} (${href})` : label;
    })
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Minimal YAML frontmatter reader: top-level scalar keys plus a few nested ones we use. */
function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { attributes: {}, body: markdown };
  const attributes = {};
  let section = null;
  for (const line of match[1].split("\n")) {
    const top = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (top) {
      section = top[1];
      if (top[2] !== "") attributes[top[1]] = top[2].replace(/^['"]|['"]$/g, "");
      continue;
    }
    const nested = line.match(/^\s+([a-zA-Z_]+):\s*(.*)$/);
    if (nested && section) attributes[`${section}.${nested[1]}`] = nested[2].replace(/^['"]|['"]$/g, "");
    const folded = line.match(/^\s+(\S.*)$/);
    if (folded && !nested && section === "content" && attributes["content.excerpt"] !== undefined) {
      attributes["content.excerpt"] = `${attributes["content.excerpt"]} ${folded[1]}`.trim();
    }
  }
  return { attributes, body: markdown.slice(match[0].length) };
}

/** Strip MDX components and HTML comments from a docs page, keeping the words. */
function cleanDocsMarkdown(body) {
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<Image\b[^>]*\/>/g, "")
    .replace(/<\/?(Callout|Table|Image|Tabs|Tab|Accordion|Embed)\b[^>]*>/g, "")
    .replace(/\[([^\]]+)\]\((doc:[^)]+|#[^)]*)\)/g, "$1")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1 ($2)")
    .trim();
}

/** Split a page by headings, then by paragraphs when a section runs long. */
/**
 * Blocks to pack into passages: paragraphs, with any paragraph longer than the cap split
 * on single line breaks (numbered clauses in the trust agreement) and then on sentence ends.
 */
function splitLongBlocks(body) {
  const blocks = [];
  for (const paragraph of body.split(/\n\n+/)) {
    if (paragraph.length <= MAX_PASSAGE_CHARS) {
      blocks.push(paragraph);
      continue;
    }
    for (const line of paragraph.split("\n")) {
      if (line.length <= MAX_PASSAGE_CHARS) {
        blocks.push(line);
        continue;
      }
      let piece = "";
      for (const sentence of line.split(/(?<=[.;:])\s+/)) {
        if (piece && piece.length + sentence.length + 1 > MAX_PASSAGE_CHARS) {
          blocks.push(piece.trim());
          piece = "";
        }
        piece += `${sentence} `;
      }
      if (piece.trim()) blocks.push(piece.trim());
    }
  }
  return blocks;
}

function splitIntoPassages(text, pageTitle) {
  const sections = [];
  let current = { heading: pageTitle, lines: [] };
  for (const line of text.split("\n")) {
    const heading = line.match(/^#{1,4}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      if (current.lines.join("\n").trim()) sections.push(current);
      current = { heading: heading[1].replace(/[*_`]/g, "").trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.join("\n").trim()) sections.push(current);
  const passages = [];
  for (const section of sections) {
    const body = section.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (body.length <= MAX_PASSAGE_CHARS) {
      passages.push({ sectionTitle: section.heading, text: body });
      continue;
    }
    let chunk = "";
    for (const paragraph of splitLongBlocks(body)) {
      if (chunk && chunk.length + paragraph.length + 2 > MAX_PASSAGE_CHARS) {
        passages.push({ sectionTitle: section.heading, text: chunk.trim() });
        chunk = "";
      }
      chunk += `${paragraph}\n\n`;
    }
    if (chunk.trim()) passages.push({ sectionTitle: section.heading, text: chunk.trim() });
  }
  // A fragment too short to retrieve on its own (a one-line clause, a signature block)
  // is folded into its neighbour rather than dropped, so a document rebuilt from its
  // passages is complete.
  const merged = [];
  for (const passage of passages) {
    const previous = merged[merged.length - 1];
    if (passage.text.replace(/\W/g, "").length < 40 && previous) {
      previous.text = `${previous.text}\n\n${passage.sectionTitle !== previous.sectionTitle ? `## ${passage.sectionTitle}\n\n` : ""}${passage.text}`;
      continue;
    }
    merged.push({ ...passage });
  }
  return merged;
}

function passageId(source, url, index) {
  return `${source}:${sha256(`${url}#${index}`).slice(0, 12)}`;
}

/**
 * Passages the server must not emit even though a source page carries them. Fabrica's
 * public wording never calls its code open source (AGENTS.md, Public Wording Rules); the
 * trust agreement, a legal instrument under CC0, is a different matter and stays.
 */
// A clause that puts "open source" and "contract" or "code" together, in either order, whatever
// the grammar ("the contracts are open source", "open-source lending-pool contracts"). A comma
// ends the clause, so "the trust agreement is open source, and the contracts live on Ethereum" stays.
const EXCLUDED_PASSAGE_PATTERNS = [
  /open[- ]sourced?\b[^.,;:\n]{0,60}\b(contracts?|code|codebase)\b/i,
  /\b(contracts?|code|codebase)\b[^.,;:\n]{0,60}\bopen[- ]sourced?\b/i,
];

function toPassages(source, title, url, updatedAt, text) {
  return splitIntoPassages(text, title)
    .filter((passage) => {
      const excluded = EXCLUDED_PASSAGE_PATTERNS.some((pattern) => pattern.test(passage.text));
      if (excluded) console.warn(`knowledge: excluded a passage of ${url} (${passage.sectionTitle}) by wording rule`);
      return !excluded;
    })
    .map((passage, index) => ({
    id: passageId(source, url, index),
    source,
    title,
    sectionTitle: passage.sectionTitle,
    url,
    text: passage.text,
    updatedAt,
  }));
}

// ---------- docs.fabrica.land ----------

async function listMarkdownFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listMarkdownFiles(full)));
    else if (entry.name.endsWith(".md")) files.push(full);
  }
  return files.sort();
}

async function readDocsFromDir(dir) {
  const root = path.join(dir, "docs");
  const files = await listMarkdownFiles(root);
  const pages = [];
  for (const file of files) {
    const markdown = await readFile(file, "utf8");
    const relative = path.relative(root, file);
    pages.push({ relative, markdown, modified: await lastCommitDate(dir, file) });
  }
  return pages;
}

/** The date of the commit that last touched a file in a checkout; empty when git cannot say. */
async function lastCommitDate(dir, file) {
  try {
    const { stdout } = await run("git", ["-C", dir, "log", "-1", "--format=%cs", "--", path.relative(dir, file)]);
    return stdout.trim();
  } catch {
    return "";
  }
}

async function readDocsFromGitHub(repo, ref) {
  const tree = JSON.parse(await fetchText(`https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`));
  const pages = [];
  for (const entry of tree.tree) {
    if (entry.type !== "blob" || !entry.path.startsWith("docs/") || !entry.path.endsWith(".md")) continue;
    const blob = JSON.parse(await fetchText(`https://api.github.com/repos/${repo}/git/blobs/${entry.sha}`));
    const markdown = Buffer.from(blob.content, "base64").toString("utf8");
    // The blob API carries no history, so the page has no updated date on this path.
    pages.push({ relative: entry.path.slice("docs/".length), markdown, modified: "" });
  }
  return pages;
}

function docsSlug(relative) {
  const base = path.basename(relative, ".md");
  if (base === "index") return path.basename(path.dirname(relative));
  return base;
}

/** The commit of a local checkout, when the docs come from one. */
async function localGitHead(dir) {
  try {
    const { stdout } = await run("git", ["-C", dir, "rev-parse", "HEAD"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function buildDocs() {
  const config = sources.docs;
  const headSha = docsDir ? await localGitHead(docsDir) : await resolveGitHubHead(config.repo, config.ref);
  const pages = docsDir ? await readDocsFromDir(docsDir) : await readDocsFromGitHub(config.repo, headSha ?? config.ref);
  const passages = [];
  let pageCount = 0;
  for (const page of pages) {
    const { attributes, body } = parseFrontmatter(page.markdown);
    if (attributes.hidden === "true" || attributes.redirect) continue;
    const title = attributes.title ?? docsSlug(page.relative);
    const excerpt = attributes["content.excerpt"] ?? attributes.excerpt ?? "";
    const text = `${excerpt ? `${excerpt}\n\n` : ""}${cleanDocsMarkdown(body)}`;
    const url = `${DOCS_BASE_URL}${docsSlug(page.relative)}`;
    passages.push(...toPassages("docs", title, url, page.modified, text));
    pageCount += 1;
  }
  return { passages, documents: pageCount, commit: headSha };
}

async function resolveGitHubHead(repo, ref) {
  try {
    const commit = JSON.parse(await fetchText(`https://api.github.com/repos/${repo}/commits/${ref}`));
    return typeof commit.sha === "string" ? commit.sha : null;
  } catch (error) {
    console.warn(`knowledge: could not resolve ${repo}@${ref}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// ---------- help.fabrica.land ----------

async function buildHelp() {
  const config = sources.help;
  const sitemap = await fetchText(config.sitemap);
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((match) => match[1])
    .filter((url) => url.includes("/articles/"));
  const passages = [];
  const fingerprints = [];
  for (const url of urls) {
    const html = await fetchText(url);
    const article = html.match(/<article[^>]*>([\s\S]*?)<\/article>/);
    const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    if (!article || !titleMatch) {
      console.warn(`knowledge: skipped ${url} (no article body)`);
      continue;
    }
    const title = decodeEntities(titleMatch[1].replace(/<[^>]+>/g, "").trim());
    const description = html.match(/"articleContent":\{[^}]*?"description":"((?:[^"\\]|\\.)*)"/);
    const text = `${description ? `${JSON.parse(`"${description[1]}"`)}\n\n` : ""}${htmlToText(article[1])}`;
    const updated = html.match(/Updated (?:over|about|more than)?\s*([^<"]+?) ago/);
    const updatedAt = updated ? `updated ${updated[1]} ago at build` : "";
    fingerprints.push(sha256(text));
    passages.push(...toPassages("help", title, url, updatedAt, text));
  }
  return { passages, documents: urls.length, fingerprint: sha256(fingerprints.sort().join("\n")) };
}

// ---------- the US trust agreement ----------

async function buildTrustAgreement() {
  const config = sources["trust-agreement"];
  const headSha = await resolveGitHubHead(config.repo, config.ref);
  const markdown = await fetchText(config.rawUrl.replace("{ref}", headSha ?? config.ref));
  const text = cleanDocsMarkdown(markdown.replace(/^#\s+.+\n/, ""));
  // The pin is the content's own fingerprint, whether or not the GitHub API answered, so
  // `--check` compares like with like across runs; the commit is recorded when known.
  const fingerprint = `sha256:${sha256(markdown)}`;
  return {
    passages: toPassages("trust-agreement", config.title, config.url, headSha ? headSha.slice(0, 7) : "", text),
    documents: 1,
    commit: headSha,
    pin: fingerprint,
  };
}

// ---------- main ----------

const started = Date.now();
const [docs, help, trust] = await Promise.all([buildDocs(), buildHelp(), buildTrustAgreement()]);

const pins = {
  docs: docs.commit,
  help: help.fingerprint,
  "trust-agreement": trust.pin,
};
const moved = Object.entries(pins).filter(([key, value]) => value && sources[key].pinned && sources[key].pinned !== value);
if (checkOnly) {
  if (moved.length === 0) {
    console.log("knowledge: every source is at its pin");
    process.exit(0);
  }
  for (const [key, value] of moved) console.log(`knowledge: ${key} moved ${sources[key].pinned} -> ${value}`);
  process.exit(1);
}

const passages = [...docs.passages, ...help.passages, ...trust.passages];
const index = {
  builtAt: new Date().toISOString().slice(0, 10),
  sources: {
    docs: { url: "https://docs.fabrica.land", repo: sources.docs.repo, ref: sources.docs.ref, commit: docs.commit, documents: docs.documents },
    help: { url: "https://help.fabrica.land", documents: help.documents, fingerprint: help.fingerprint },
    "trust-agreement": { url: sources["trust-agreement"].url, repo: sources["trust-agreement"].repo, commit: trust.commit, fingerprint: trust.pin, documents: 1 },
  },
  passages,
};
await mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
await writeFile(OUTPUT_FILE, `${JSON.stringify(index, null, 1)}\n`);
for (const [key, value] of Object.entries(pins)) if (value) sources[key].pinned = value;
await writeFile(SOURCES_FILE, `${JSON.stringify(sources, null, 2)}\n`);
const bytes = (await stat(OUTPUT_FILE)).size;
console.log(
  `knowledge: ${passages.length} passages from ${docs.documents} docs pages, ${help.documents} help articles and the trust agreement; ` +
    `${(bytes / 1024).toFixed(0)} KB in ${((Date.now() - started) / 1000).toFixed(1)} s`,
);
