import { IS_MAINNET } from "./config.js";

/** The marketplace for this network. Property links from the API use the same origin. */
export const PLATFORM_URL = IS_MAINNET ? "https://fabrica.land" : "https://testnets.fabrica.land";

/** "Los Angeles County" → "los-angeles-county", the slug rule of fabrica.land's location pages. */
export function slugifyPlaceName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

/** "Colorado", "colorado" or "co" → "CO"; null when neither a US state code nor a state name. */
export function stateCode(nameOrCode: string | null | undefined): string | null {
  const text = (nameOrCode ?? "").trim();
  if (!text) return null;
  if (STATE_NAMES[text.toUpperCase()]) return text.toUpperCase();
  const wanted = text.toLowerCase().replace(/[^a-z]+/g, " ").trim();
  const code = Object.keys(STATE_NAMES).find(key => STATE_NAMES[key].toLowerCase() === wanted);
  return code ?? null;
}

/**
 * The API's property slug ("us/nevada/elko-county/elko/apn-00633b008") from however an agent
 * passes it: the full fabrica.land URL, a leading or trailing slash, or the slug itself.
 */
export function normalizeSlug(slug: string | undefined): string | undefined {
  if (slug === undefined) return undefined;
  const path = slug.trim().replace(/^https?:\/\/[^/]*fabrica\.land\//i, "").replace(/^\/+|\/+$/g, "");
  return path.length > 0 ? path : undefined;
}

/** "co" → "Colorado"; null for an unknown code. */
export function stateName(code: string | null | undefined): string | null {
  return STATE_NAMES[(code ?? "").trim().toUpperCase()] ?? null;
}

function segment(name: string | null | undefined): string {
  return name?.trim() ? slugifyPlaceName(name) : "";
}

/**
 * Link to the fabrica.land location page ("N properties for sale in X") for a state, county or place:
 * `/us/<state>/<county>/<place>`, down to the deepest level known without a gap. `state` is the full
 * state name (the API's `region`), not the two-letter code. Null without a state.
 */
export function locationLink(location: { state: string | null | undefined; county?: string | null; place?: string | null }): string | null {
  const state = segment(location.state);
  if (!state) return null;
  const county = segment(location.county);
  const place = county ? segment(location.place) : "";
  return `${PLATFORM_URL}/${["us", state, county, place].filter(Boolean).join("/")}`;
}
