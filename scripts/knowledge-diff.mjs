// Compare two knowledge indexes and write a pull request title and body for the refresh
// workflow: which sources moved, which pages were added, removed or changed.
//
// Usage: node scripts/knowledge-diff.mjs <old-index.json> <new-index.json> [--out <dir>]
//   Prints the body to stdout. With --out, also writes <dir>/title.txt and <dir>/body.md.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [oldPath, newPath, ...rest] = process.argv.slice(2);
if (!oldPath || !newPath) {
  console.error("usage: node scripts/knowledge-diff.mjs <old-index.json> <new-index.json> [--out <dir>]");
  process.exit(2);
}
const outDir = rest.includes("--out") ? rest[rest.indexOf("--out") + 1] : undefined;

const before = JSON.parse(await readFile(oldPath, "utf8"));
const after = JSON.parse(await readFile(newPath, "utf8"));

/** One entry per document (URL): title, source and a hash of its text in passage order. */
function documents(index) {
  const byUrl = new Map();
  for (const passage of index.passages) {
    const entry = byUrl.get(passage.url) ?? { title: passage.title, source: passage.source, hash: createHash("sha256") };
    entry.hash.update(passage.sectionTitle).update("\n").update(passage.text).update("\n");
    byUrl.set(passage.url, entry);
  }
  return new Map([...byUrl].map(([url, entry]) => [url, { title: entry.title, source: entry.source, digest: entry.hash.digest("hex") }]));
}

const SOURCE_LABEL = { docs: "docs.fabrica.land", help: "help center", "trust-agreement": "trust agreement" };

function sourcePin(index, key) {
  const info = index.sources?.[key] ?? {};
  return info.commit ?? info.fingerprint ?? null;
}

const oldDocs = documents(before);
const newDocs = documents(after);
const added = [...newDocs].filter(([url]) => !oldDocs.has(url));
const removed = [...oldDocs].filter(([url]) => !newDocs.has(url));
const changed = [...newDocs].filter(([url, entry]) => oldDocs.has(url) && oldDocs.get(url).digest !== entry.digest);

const moved = Object.keys(SOURCE_LABEL).filter((key) => sourcePin(before, key) !== sourcePin(after, key));
const touched = new Set([...added, ...removed, ...changed].map(([, entry]) => entry.source));
const sourcesForTitle = moved.length ? moved : [...touched];

function short(pin) {
  if (!pin) return "unknown";
  return pin.startsWith("sha256:") ? pin.slice(7, 14) : pin.slice(0, 7);
}

const title = sourcesForTitle.length
  ? `Knowledge index: ${sourcesForTitle.map((key) => `${SOURCE_LABEL[key]} ${short(sourcePin(after, key))}`).join(", ")}`
  : `Knowledge index: rebuilt ${after.builtAt}`;

function list(entries) {
  return entries.map(([url, entry]) => `- ${entry.title} (${SOURCE_LABEL[entry.source]}): ${url}`).join("\n");
}

const lines = [
  `Scheduled rebuild of the \`ask_fabrica\` knowledge index on ${after.builtAt}.`,
  "",
  "## Sources",
  ...Object.keys(SOURCE_LABEL).map((key) => {
    const from = short(sourcePin(before, key));
    const to = short(sourcePin(after, key));
    const count = after.sources?.[key]?.documents ?? 0;
    return `- ${SOURCE_LABEL[key]}: ${from === to ? `unchanged at ${to}` : `${from} to ${to}`} (${count} document${count === 1 ? "" : "s"})`;
  }),
  "",
  `## Pages (${added.length} added, ${removed.length} removed, ${changed.length} changed)`,
  added.length ? `\n### Added\n${list(added)}` : "",
  removed.length ? `\n### Removed\n${list(removed)}` : "",
  changed.length ? `\n### Changed\n${list(changed)}` : "",
  added.length + removed.length + changed.length === 0 ? "\nNo page text changed; only source pins or dates moved." : "",
  "",
  `Passages: ${before.passages.length} to ${after.passages.length}. Review fee and legal pages with care: their wording reaches people through agents.`,
].filter((line) => line !== undefined);

const body = `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
process.stdout.write(body);
if (outDir) {
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "title.txt"), `${title}\n`);
  await writeFile(path.join(outDir, "body.md"), body);
}
