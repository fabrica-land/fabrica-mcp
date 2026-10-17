// Builds the static on-ramp coverage table behind the `check_coverage` tool from a local
// checkout of the on-ramp rules (fabrica-land/fabrica-v3-rules, private), written to
// src/data/onramp-coverage.json (committed; the hosted server holds no credential and makes
// no call for coverage).
//
// The API resolves a county's on-ramp rules by merging dist/rules/us/onramp.*.json, then the
// state's, then the county's (WorkflowService.getUsRules). This keeps each of those layers,
// reduced to what a public answer may show: support status, fractional ownership, document
// names and whether they are notarized, witness and notary notes, the questions the owner is
// asked, and the step titles. Fee amounts and template payloads are left out.
//
// Refreshed by hand when the rules change:
//   git clone --depth 1 https://github.com/fabrica-land/fabrica-v3-rules ../fabrica-v3-rules
//   npm run coverage:build -- --rules-dir ../fabrica-v3-rules
import { readFile, readdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);

const OUTPUT_FILE = "src/data/onramp-coverage.json";
const WORKFLOW = "onramp";
const SUPPORT_VALUES = new Set(["supported", "unsupported", "notConfigured"]);
/** Documents a person signs or files; test fixtures and internal forms under other keys stay out. */
const PUBLIC_DOCUMENT = /^(proof-of-title|trust-certificate|jurisdiction-tax-form(-[a-z0-9-]+)?)$/;

const args = process.argv.slice(2);
const rulesDir = args.includes("--rules-dir") ? args[args.indexOf("--rules-dir") + 1] : process.env.ONRAMP_RULES_DIR;
if (!rulesDir) {
  console.error("Usage: npm run coverage:build -- --rules-dir <path to a fabrica-v3-rules checkout>");
  process.exit(1);
}
const usDir = path.join(rulesDir, "dist", "rules", "us");

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function documents(docs) {
  if (!isRecord(docs)) return undefined;
  const out = {};
  for (const [key, doc] of Object.entries(docs)) {
    if (!PUBLIC_DOCUMENT.test(key) || !isRecord(doc)) continue;
    const entry = {};
    if (typeof doc.name === "string") entry.name = doc.name;
    if (typeof doc.notarize === "boolean") entry.notarize = doc.notarize;
    out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function fields(userProvidedFields) {
  if (!isRecord(userProvidedFields)) return undefined;
  const out = {};
  for (const [label, field] of Object.entries(userProvidedFields)) {
    if (!isRecord(field)) continue;
    const entry = {};
    if (typeof field.required === "boolean") entry.required = field.required;
    // includeIf / requiredIf are evaluated against the parcel's Regrid record by the API.
    if (field.includeIf !== undefined || field.requiredIf !== undefined) entry.dependsOnParcel = true;
    out[label] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function visible(item) {
  return isRecord(item) && item.visibility !== false && typeof item.text === "string";
}

function steps(rawSteps) {
  if (!Array.isArray(rawSteps)) return undefined;
  return rawSteps.filter(visible).map((step) => {
    const out = { text: step.text };
    // A document action names a rules document; check_coverage keeps it only where that document applies.
    const actions = (step.userActions ?? []).filter((action) => isRecord(action) && typeof action.prompt === "string")
      .map((action) => (action.disposition === "document" ? { prompt: action.prompt, document: action.key } : { prompt: action.prompt }));
    const stages = (step.substeps ?? []).filter(visible).map((substep) => substep.text);
    if (actions.length > 0) out.actions = actions;
    if (stages.length > 0) out.stages = stages;
    return out;
  });
}

function layer(rules, file) {
  const out = {};
  if (rules.workflowSupport !== undefined) {
    if (!SUPPORT_VALUES.has(rules.workflowSupport)) throw new Error(`${file}: unknown workflowSupport ${rules.workflowSupport}`);
    out.workflowSupport = rules.workflowSupport;
  }
  if (typeof rules.fractionalOwnership === "boolean") out.fractionalOwnership = rules.fractionalOwnership;
  if (typeof rules.witnessesRequired === "boolean") out.witnessesRequired = rules.witnessesRequired;
  if (typeof rules.notaryNote === "string") out.notaryNote = rules.notaryNote;
  const docs = documents(rules.docs);
  if (docs) out.documents = docs;
  const asked = fields(rules.userProvidedFields);
  if (asked) out.fields = asked;
  const stepList = steps(rules.steps);
  if (stepList) out.steps = stepList;
  return out;
}

/** Every `onramp.<signer type>.json` under dist/rules/us, keyed by signer type, then by "", "ca" or "ca/riverside". */
async function collect() {
  const layers = {};
  const walk = async (dir, place) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), place ? `${place}/${entry.name}` : entry.name);
        continue;
      }
      const match = new RegExp(`^${WORKFLOW}\\.([a-z]+)\\.json$`).exec(entry.name);
      if (!match) continue;
      const file = path.join(dir, entry.name);
      const reduced = layer(JSON.parse(await readFile(file, "utf8")), path.relative(rulesDir, file));
      if (Object.keys(reduced).length === 0) continue;
      (layers[match[1]] ??= {})[place] = reduced;
    }
  };
  await walk(usDir, "");
  return layers;
}

/** The runtime merges objects key by key; an array set at two layers would need lodash's index merge, so refuse it. */
function assertNoArrayOverlap(layers) {
  const arrayPaths = new Map();
  const visit = (value, at, place) => {
    if (Array.isArray(value)) {
      const seen = arrayPaths.get(at);
      if (seen !== undefined && seen !== place) throw new Error(`${at} is an array in both "${seen}" and "${place}"; check_coverage's merge does not handle that`);
      arrayPaths.set(at, place);
    } else if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) visit(child, `${at}.${key}`, place);
    }
  };
  for (const [signer, byPlace] of Object.entries(layers)) {
    for (const [place, value] of Object.entries(byPlace)) visit(value, "", `${signer}:${place}`);
  }
}

const layers = await collect();
if (!layers.common?.[""]?.workflowSupport) throw new Error("dist/rules/us/onramp.common.json has no workflowSupport; is this a rules checkout?");
assertNoArrayOverlap(layers);
const { stdout } = await run("git", ["-C", rulesDir, "log", "-1", "--format=%H %cI"]);
const [commit = "", committedAt = ""] = stdout.trim().split(" ");
const table = {
  source: { commit, committedAt, builtAt: new Date().toISOString().slice(0, 10) },
  layers,
};
await writeFile(OUTPUT_FILE, `${JSON.stringify(table, null, 1)}\n`);
const places = Object.values(layers).reduce((sum, byPlace) => sum + Object.keys(byPlace).length, 0);
console.log(`Wrote ${OUTPUT_FILE}: ${places} rule layers from rules ${commit.slice(0, 7)} (${committedAt}).`);
