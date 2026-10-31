import { z } from "zod";
import { IS_MAINNET, MAINNET_WARNING, NETWORK_LABEL, WEB_BASE } from "../config.js";
import { US_COUNTY_ROWS } from "../data/us-counties.js";
import table from "../data/onramp-coverage.json";
import { resolveCounty } from "./parcels.js";
import type { ArgsOf } from "./inputs.js";

/**
 * check_county_coverage: whether the on-ramp is set up for a US county, and what it asks of the owner,
 * from a static table built out of the on-ramp rules (scripts/build-coverage.mjs). No credential
 * and no call: the table is refreshed by hand, so every answer carries the rules date. The API
 * resolves a county's rules by merging the US layer, the state's and the county's, each as the
 * common file then the signer-type file; this merges the same layers the same way.
 */

export const OWNER_TYPES = ["individual", "entity", "concurrent"] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];

const statusSchema = z.enum(["supported", "notConfigured", "unsupported"]);
export type CoverageStatus = z.infer<typeof statusSchema>;
const layerSchema = z.object({
  workflowSupport: statusSchema.optional(),
  fractionalOwnership: z.boolean().optional(),
  witnessesRequired: z.boolean().optional(),
  notaryNote: z.string().optional(),
  documents: z.record(z.string(), z.object({ name: z.string().optional(), notarize: z.boolean().optional() })).optional(),
  fields: z.record(z.string(), z.object({
    required: z.boolean().optional(),
    dependsOnParcel: z.boolean().optional(),
    requiredWhen: z.object({ question: z.string(), answer: z.string() }).optional(),
  })).optional(),
  steps: z.array(z.object({
    text: z.string(),
    actions: z.array(z.object({ prompt: z.string(), document: z.string().optional() })).optional(),
    stages: z.array(z.string()).optional(),
  })).optional(),
});
type CoverageLayer = z.infer<typeof layerSchema>;
const tableSchema = z.object({
  source: z.object({ commit: z.string(), committedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T/), builtAt: z.string() }),
  layers: z.record(z.string(), z.record(z.string(), layerSchema)),
});

// Checked once at load; the coverage tests fail on a malformed refresh before it ships.
const TABLE = tableSchema.parse(table);
export const COVERAGE_AS_OF = TABLE.source.committedAt.slice(0, 10);
const FEES_URL = "https://docs.fabrica.land/docs/fees";

const COUNTIES_BY_FIPS: ReadonlyMap<string, { key: string; name: string }> = new Map(US_COUNTY_ROWS.map((row) => {
  const [key = "", fips = "", name = ""] = row.split("|");
  return [fips, { key, name }];
}));
const STATES: ReadonlySet<string> = new Set(US_COUNTY_ROWS.map((row) => row.slice(0, 2)));
/** The states the rules have a layer for (the 50); DC and the territories are in the county table but not in the rules. */
const RULE_STATES: ReadonlySet<string> = new Set(Object.values(TABLE.layers).flatMap((byPlace) => Object.keys(byPlace).filter((place) => place !== "" && !place.includes("/"))));

const MEANING: Record<CoverageStatus, string> = {
  supported: "Adding property is set up for this jurisdiction: an owner can start adding a parcel here online.",
  notConfigured: "Adding property is not set up for this jurisdiction yet, so a parcel here cannot be added online today. contact_fabrica_support can ask Fabrica about it.",
  unsupported: "Property in this jurisdiction cannot be added to Fabrica online.",
};

function mergeRecords<V extends object>(base?: Record<string, V>, over?: Record<string, V>): Record<string, V> | undefined {
  if (!base || !over) return over ?? base;
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) out[key] = { ...out[key], ...value };
  return out;
}

/** Later layers win key by key; documents and questions merge per entry (the build refuses arrays set at two layers). */
function merge(base: CoverageLayer, over: CoverageLayer | undefined): CoverageLayer {
  if (!over) return base;
  const documents = mergeRecords(base.documents, over.documents);
  const fields = mergeRecords(base.fields, over.fields);
  return { ...base, ...over, ...(documents ? { documents } : {}), ...(fields ? { fields } : {}) };
}

/** The rules for a place ("", "ca" or "ca/riverside") as the API would merge them for this owner type. */
export function resolveRules(place: string, ownerType: OwnerType = "individual"): CoverageLayer {
  const [state] = place.split("/");
  const chain = ["", ...(state ? [state] : []), ...(place.includes("/") ? [place] : [])];
  return chain.reduce<CoverageLayer>((rules, at) => {
    const atPlace = merge(TABLE.layers.common?.[at] ?? {}, TABLE.layers[ownerType]?.[at]);
    return merge(rules, atPlace);
  }, {});
}

/** DC and the territories have no rules of their own, and the US layer is written for the states. */
function inRules(place: string): boolean {
  return RULE_STATES.has(place.split("/")[0] ?? "");
}

/** The status the API reports for a county path ("ca/riverside"); it reads unsupported when no layer sets one. */
export function coverageStatus(place: string): CoverageStatus {
  return inRules(place) ? resolveRules(place).workflowSupport ?? "unsupported" : "unsupported";
}

function describe(rules: CoverageLayer) {
  const documents = Object.entries(rules.documents ?? {})
    // The deed first, then the forms in the order the rules list them.
    .sort(([a], [b]) => Number(b === "proof-of-title") - Number(a === "proof-of-title"))
    .map(([, doc]) => ({ name: doc.name ?? "Document", notarized: doc.notarize === true }));
  const ownerIsAsked = Object.entries(rules.fields ?? {}).map(([label, field]) => ({
    question: label,
    required: field.required === true,
    ...(field.dependsOnParcel ? { onlyForSomeParcels: true } : {}),
    ...(field.requiredWhen ? { requiredWhen: field.requiredWhen } : {}),
  }));
  return {
    fractionalOwnership: rules.fractionalOwnership === true,
    documents,
    witnessesRequired: rules.witnessesRequired === true,
    ...(rules.notaryNote ? { notaryNote: rules.notaryNote } : {}),
    ownerIsAsked,
    steps: (rules.steps ?? []).map((step) => {
      // The operating agreement is in every on-ramp; other document actions only where the rules list the document.
      const actions = (step.actions ?? [])
        .filter((action) => !action.document || action.document === "operating-agreement" || action.document in (rules.documents ?? {}))
        .map((action) => action.prompt);
      return { text: step.text, ...(actions.length > 0 ? { actions } : {}), ...(step.stages ? { stages: step.stages } : {}) };
    }),
  };
}

/** Counties in a state whose own rules differ from the state's, with their status when it is not the state's. */
function countiesWithOwnRules(state: string, stateStatus: CoverageStatus, ownerType: OwnerType) {
  const prefix = `${state}/`;
  const places = new Set(Object.values(TABLE.layers).flatMap((byPlace) => Object.keys(byPlace).filter((place) => place.startsWith(prefix))));
  return [...places].sort().map((place) => {
    const row = US_COUNTY_ROWS.find((r) => r.startsWith(`${place}|`));
    const [, fips = null, name = place] = row?.split("|") ?? [];
    const status = resolveRules(place, ownerType).workflowSupport ?? "unsupported";
    return { county: name, fips, ...(status !== stateStatus ? { status } : {}) };
  });
}

export const checkCoverageInput = {
  fips: z.string().regex(/^[0-9]{5}$/).optional().describe("5-digit county FIPS code, e.g. '06065'"),
  state: z.string().regex(/^[A-Za-z]{2}$/).optional().describe("Two-letter US state code, e.g. 'CA'"),
  county: z.string().max(80).optional().describe("County name, e.g. 'Riverside' (with state)"),
  ownerType: z.enum(OWNER_TYPES).optional().describe("Who holds title today: individual (default), entity or concurrent (co-owners)"),
};
export type CheckCoverageArgs = ArgsOf<typeof checkCoverageInput>;

function withNetwork<T extends object>(result: T) {
  return { network: NETWORK_LABEL, ...result, ...(MAINNET_WARNING ? { legalNotice: MAINNET_WARNING } : {}) };
}

const SOURCE = {
  table: "Fabrica's rules for adding property, copied into this server",
  rulesVersion: TABLE.source.commit.slice(0, 7),
  asOf: COVERAGE_AS_OF,
  refresh: "The table is refreshed by hand when the rules change, so it can lag them. The add-property page on fabrica.land is the live answer.",
};

/** check_county_coverage's answer: a county (by FIPS, or state and county), or a whole state. */
export function checkCoverage(args: CheckCoverageArgs) {
  const ownerType = args.ownerType ?? "individual";
  let place: string;
  let jurisdiction: { state: string; county?: string; fips?: string };
  if (args.fips) {
    const county = COUNTIES_BY_FIPS.get(args.fips);
    if (!county) return { error: `No US county has FIPS code ${args.fips}. A county FIPS is 5 digits: the 2-digit state code and the 3-digit county code, for example 06065 for Riverside County, CA.` };
    place = county.key;
    jurisdiction = { state: county.key.slice(0, 2).toUpperCase(), county: county.name, fips: args.fips };
  } else if (args.state) {
    const state = args.state.toLowerCase();
    if (!STATES.has(state)) return { error: `"${args.state}" is not a US state code. Use the two-letter code, for example "CA".` };
    if (args.county) {
      const scope = resolveCounty(args.county, state);
      if (!scope) return { error: `No single county in ${state.toUpperCase()} matches "${args.county}". The county name as the state writes it (for example "Riverside"), or its 5-digit FIPS code, identifies it.` };
      place = scope.key;
      jurisdiction = { state: state.toUpperCase(), county: scope.county.name, fips: scope.county.fips };
    } else {
      place = state;
      jurisdiction = { state: state.toUpperCase() };
    }
  } else {
    return { error: "check_county_coverage needs a county FIPS code, or a two-letter state (and optionally a county)." };
  }

  const rules = resolveRules(place, ownerType);
  const status = inRules(place) ? rules.workflowSupport ?? "unsupported" : "unsupported";
  const stateOnly = !place.includes("/");
  const counties = stateOnly ? countiesWithOwnRules(place, status, ownerType) : [];
  const details = status === "supported" ? describe(rules) : undefined;
  // On a test network the on-ramp signs and records nothing, so the requirements are labeled as Mainnet's.
  const shown: Partial<ReturnType<typeof describe>> & { mainnetRequirements?: ReturnType<typeof describe> } =
    !details ? {} : IS_MAINNET ? details : { mainnetRequirements: details };
  return withNetwork({
    jurisdiction,
    ownerType,
    status,
    meaning: MEANING[status],
    ...shown,
    ...(stateOnly ? {
      countiesWithOwnRules: counties,
      scope: counties.length > 0
        ? "This is the state-wide answer. The counties listed have rules of their own; check_county_coverage with one of them gives its answer."
        : "This is the state-wide answer; no county in this state has rules of its own.",
    } : {}),
    ...(status === "supported" && IS_MAINNET ? { fee: `A one-time setup fee is authorized when the property is added. The amount and when it is charged: ask_fabrica or ${FEES_URL}.` } : {}),
    links: { addToFabrica: `${WEB_BASE}/go`, fees: FEES_URL },
    source: SOURCE,
    note: `find_us_parcel gives the link to add one parcel. Some questions depend on the parcel (onlyForSomeParcels), so adding it may ask fewer.${IS_MAINNET ? "" : " On this test network adding a property is a test flow: no trust is created, no deed is signed or recorded and no fee is charged. mainnetRequirements is what adding a property on Ethereum Mainnet asks for the same place."}`,
  });
}
