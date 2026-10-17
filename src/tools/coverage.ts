import { IS_MAINNET, MAINNET_WARNING, NETWORK_LABEL, WEB_BASE } from "../config.js";
import { US_COUNTY_ROWS } from "../data/us-counties.js";
import table from "../data/onramp-coverage.json";
import { resolveCounty } from "./parcels.js";

/**
 * check_coverage: whether the on-ramp is set up for a US county, and what it asks of the owner,
 * from a static table built out of the on-ramp rules (scripts/build-coverage.mjs). No credential
 * and no call: the table is refreshed by hand, so every answer carries the rules date. The API
 * resolves a county's rules by merging the US layer, the state's and the county's, each as the
 * common file then the signer-type file; this merges the same layers the same way.
 */

export type CoverageStatus = "supported" | "notConfigured" | "unsupported";
export const OWNER_TYPES = ["individual", "entity", "concurrent"] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];

interface CoverageLayer {
  workflowSupport?: CoverageStatus;
  fractionalOwnership?: boolean;
  witnessesRequired?: boolean;
  notaryNote?: string;
  documents?: Record<string, { name?: string; notarize?: boolean }>;
  fields?: Record<string, { required?: boolean; dependsOnParcel?: boolean }>;
  steps?: Array<{ text: string; actions?: Array<{ prompt: string; document?: string }>; stages?: string[] }>;
}

interface CoverageTable {
  source: { commit: string; committedAt: string; builtAt: string };
  layers: Record<string, Record<string, CoverageLayer>>;
}

const TABLE = table as CoverageTable;
export const COVERAGE_AS_OF = TABLE.source.committedAt.slice(0, 10);
const FEES_URL = "https://docs.fabrica.land/docs/fees";

const COUNTIES_BY_FIPS: ReadonlyMap<string, { key: string; name: string }> = new Map(US_COUNTY_ROWS.map((row) => {
  const [key = "", fips = "", name = ""] = row.split("|");
  return [fips, { key, name }];
}));
const STATES: ReadonlySet<string> = new Set(US_COUNTY_ROWS.map((row) => row.slice(0, 2)));

const MEANING: Record<CoverageStatus, string> = {
  supported: "The on-ramp is set up for this jurisdiction: an owner can start adding a parcel here online.",
  notConfigured: "The on-ramp is not set up for this jurisdiction yet, so a parcel here cannot be added online today. contact_support can ask Fabrica about it.",
  unsupported: "Fabrica does not take property in this jurisdiction through the on-ramp.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Objects merge key by key; anything else from the later layer wins (the build refuses arrays set at two layers). */
function merge<T>(base: T, over: T | undefined): T {
  if (over === undefined) return base;
  if (!isRecord(base) || !isRecord(over)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) out[key] = key in out ? merge(out[key], value) : value;
  return out as T;
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

/** The status the API reports for a county path ("ca/riverside"); it reads unsupported when no layer sets one. */
export function coverageStatus(place: string): CoverageStatus {
  return resolveRules(place).workflowSupport ?? "unsupported";
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
function countiesWithOwnRules(state: string, stateStatus: CoverageStatus) {
  const prefix = `${state}/`;
  const places = new Set(Object.values(TABLE.layers).flatMap((byPlace) => Object.keys(byPlace).filter((place) => place.startsWith(prefix))));
  return [...places].sort().map((place) => {
    const row = US_COUNTY_ROWS.find((r) => r.startsWith(`${place}|`));
    const [, fips = null, name = place] = row?.split("|") ?? [];
    const status = coverageStatus(place);
    return { county: name, fips, ...(status !== stateStatus ? { status } : {}) };
  });
}

export interface CheckCoverageArgs {
  fips?: string;
  state?: string;
  county?: string;
  ownerType?: OwnerType;
}

function withNetwork<T extends object>(result: T) {
  return { network: NETWORK_LABEL, ...result, ...(MAINNET_WARNING ? { legalNotice: MAINNET_WARNING } : {}) };
}

const SOURCE = {
  table: "Fabrica on-ramp rules, copied into this server",
  rulesVersion: TABLE.source.commit.slice(0, 7),
  asOf: COVERAGE_AS_OF,
  refresh: "The table is refreshed by hand when the rules change, so it can lag them. The on-ramp page is the live answer.",
};

/** check_coverage's answer: a county (by FIPS, or state and county), or a whole state. */
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
    return { error: "check_coverage needs a county FIPS code, or a two-letter state (and optionally a county)." };
  }

  const rules = resolveRules(place, ownerType);
  const status = rules.workflowSupport ?? "unsupported";
  const stateOnly = !place.includes("/");
  const counties = stateOnly ? countiesWithOwnRules(place, status) : [];
  const details = status === "supported" ? describe(rules) : undefined;
  // On a test network the on-ramp signs and records nothing, so the requirements are labelled as Mainnet's.
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
        ? "This is the state-wide answer. The counties listed have rules of their own; check_coverage with one of them gives its answer."
        : "This is the state-wide answer; no county in this state has rules of its own.",
    } : {}),
    ...(status === "supported" && IS_MAINNET ? { fee: `A one-time setup fee is authorized during the on-ramp. The amount and when it is charged: ask_fabrica or ${FEES_URL}.` } : {}),
    links: { addToFabrica: `${WEB_BASE}/go`, fees: FEES_URL },
    source: SOURCE,
    note: `find_parcel gives the on-ramp link for one parcel. Some questions depend on the parcel (onlyForSomeParcels), so the on-ramp may ask fewer.${IS_MAINNET ? "" : " On this test network the on-ramp is a test flow: no trust is created, no deed is signed or recorded and no fee is charged. mainnetRequirements is what the Ethereum Mainnet on-ramp asks for the same place."}`,
  });
}
