import { getParcelIndex } from "../clients/graphql.js";
import type { ParcelIndexToken } from "../types/index.js";
import { stateCode } from "../links.js";
import { MAINNET_WARNING, NETWORK_LABEL, WEB_BASE } from "../config.js";
import { US_COUNTY_ROWS } from "../data/us-counties.js";
import { z } from "zod";
import type { ArgsOf } from "./inputs.js";
import { COVERAGE_AS_OF, coverageStatus, type CoverageStatus } from "./coverage.js";

/**
 * find_parcel: any US address or parcel number to a parcel identity, whether it is
 * already on Fabrica, and the link that starts its on-ramp. One type-ahead lookup per
 * call (the API's Regrid type-ahead, a metered third-party search), plus one parcel
 * lookup on the web app's APN route only when a single parcel is found that is not on
 * Fabrica, to get the point the on-ramp link needs. Owner names are never read out.
 */

const DEFAULT_API_URL = "https://api.fabrica.land/graphql";
const LOOKUP_TIMEOUT_MS = 10_000;
const MAX_CANDIDATES = 5;
/** Type-ahead scores run roughly 0 to 100; a lead this large means one parcel clearly matches. */
const CLEAR_LEAD = 10;

export const COVERAGE_NOTE = "Fabrica operates in all 50 states; the on-ramp page shows what this county requires.";

const API_BASE = new URL(process.env.FABRICA_API_URL ?? DEFAULT_API_URL).origin;

interface County {
  fips: string;
  name: string;
}

const COUNTIES: ReadonlyMap<string, County> = new Map(US_COUNTY_ROWS.map((row) => {
  const [path = "", fips = "", name = ""] = row.split("|");
  return [path, { fips, name }];
}));

export interface TypeAheadHit {
  headline: string;
  context: string;
  apn: string | null;
  path: string;
  score: number;
}

export interface ParcelOnFabrica {
  tokenId: string;
  name: string | null;
  slug: string | null;
  propertyLink: string | null;
}

export interface ParcelCandidate {
  address: string;
  place: string;
  apn: string | null;
  state: string | null;
  county: string | null;
  regridPath: string | null;
  onFabrica: ParcelOnFabrica | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Keeps only the fields find_parcel shows. `owner` is dropped here, before anything else sees it. */
export function parseTypeAhead(body: unknown): TypeAheadHit[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((row) => {
    if (!isRecord(row)) return [];
    const headline = text(row.headline);
    const path = text(row.path);
    if (!headline || !path || !path.startsWith("/us/")) return [];
    return [{
      headline,
      context: text(row.context) ?? "",
      apn: text(row.parcelnumb),
      path,
      score: typeof row.score === "number" ? row.score : 0,
    }];
  });
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS), headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** "/us/ca/san-francisco/..." to its state code and county. */
export function locate(path: string): { state: string | null; countyKey: string | null; county: County | null } {
  const [, , state, county] = path.split("/");
  if (!state) return { state: null, countyKey: null, county: null };
  const countyKey = county ? `${state}/${county}` : null;
  return { state: state.toUpperCase(), countyKey, county: countyKey ? COUNTIES.get(countyKey) ?? null : null };
}

export function normalizeApn(apn: string): string {
  return apn.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** County-equivalent suffixes, as people and registrars write them; the county table names mostly leave them out. */
function withoutSuffix(slug: string): string {
  return slug.replace(/-(county|parish|city-and-borough|borough|census-area|municipality)$/, "");
}

/**
 * Whether a token's registrar admin (a county name such as "Bartow") is the parcel's county.
 * Compared against the county's full table name, so "St. Louis" (the county) never matches "St. Louis City".
 */
function sameCounty(admin: string | null | undefined, countyKey: string | null, county: County | null): boolean {
  if (!admin || !countyKey) return true;
  const adminSlug = withoutSuffix(slugify(admin));
  if (county !== null) return withoutSuffix(slugify(county.name)) === adminSlug;
  return withoutSuffix(countyKey.split("/")[1] ?? "") === adminSlug;
}

/**
 * The registrar's parcel number, also without a county FIPS prefix ("06037-018-007"), but only when that
 * prefix is the parcel's own county FIPS: "12345-678" is otherwise a bare parcel number.
 */
function registrarApns(propertyId: string, countyFips: string | null): string[] {
  const prefixed = /^(\d{5})-(.+)$/.exec(propertyId);
  const unprefixed = prefixed && countyFips !== null && prefixed[1] === countyFips ? prefixed[2] : undefined;
  return unprefixed ? [normalizeApn(propertyId), normalizeApn(unprefixed)] : [normalizeApn(propertyId)];
}

function toOnFabrica(token: ParcelIndexToken): ParcelOnFabrica {
  return {
    tokenId: token.tokenId,
    name: token.name ?? token.vanityName ?? null,
    slug: token.slug ?? null,
    propertyLink: token.propertyLink ?? null,
  };
}

/** A token in the same state and county with the same parcel number, ignoring punctuation. */
export function matchByApn(hit: TypeAheadHit, tokens: readonly ParcelIndexToken[]): ParcelIndexToken | null {
  if (!hit.apn) return null;
  const apn = normalizeApn(hit.apn);
  if (!apn) return null;
  const { state, countyKey, county } = locate(hit.path);
  return tokens.find((token) => {
    const registrar = token.definition?.offchainRegistrar;
    return token.regionCode?.toUpperCase() === state
      && registrar?.propertyId !== undefined && registrar.propertyId !== null
      && registrarApns(registrar.propertyId, county?.fips ?? null).includes(apn)
      && sameCounty(registrar.admin, countyKey, county);
  }) ?? null;
}

type Ring = ReadonlyArray<readonly number[]>;

function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi = 0, yi = 0] = ring[i] ?? [];
    const [xj = 0, yj = 0] = ring[j] ?? [];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function isRing(value: unknown): value is Ring {
  return Array.isArray(value) && value.every((point) => Array.isArray(point) && point.every((n) => typeof n === "number"));
}

/** Polygons of a GeoJSON Polygon or MultiPolygon geometry, each as rings of [lon, lat]. */
export function polygonsOf(geometry: unknown): Ring[][] {
  if (!isRecord(geometry) || !Array.isArray(geometry.coordinates)) return [];
  const polygons: unknown[] = geometry.type === "MultiPolygon" ? geometry.coordinates : geometry.type === "Polygon" ? [geometry.coordinates] : [];
  return polygons.flatMap((polygon) => Array.isArray(polygon) && polygon.every(isRing) ? [polygon.filter(isRing)] : []);
}

export function pointInPolygons(lat: number, lon: number, polygons: Ring[][]): boolean {
  return polygons.some(([outer, ...holes]) => outer !== undefined && inRing(lon, lat, outer) && !holes.some((hole) => inRing(lon, lat, hole)));
}

export interface ParcelPoint {
  lat: number;
  lon: number;
  regridId: string | null;
  polygons: Ring[][];
}

/** The parcel's point (Regrid's own interior point, else one computed from the outline) and outline. Reads no other field. */
export function parseParcelPoint(body: unknown, path: string): ParcelPoint | null {
  const parcels = isRecord(body) && isRecord(body.parcels) && Array.isArray(body.parcels.features) ? body.parcels.features : [];
  const features = parcels.filter(isRecord);
  // Without an exact path match, only a lone feature is safely this parcel.
  const feature = features.find((f) => isRecord(f.properties) && f.properties.path === path) ?? (features.length === 1 ? features[0] : undefined);
  if (!feature) return null;
  const fields = isRecord(feature.properties) && isRecord(feature.properties.fields) ? feature.properties.fields : {};
  const polygons = polygonsOf(feature.geometry);
  const lat = Number(fields.lat);
  const lon = Number(fields.lon);
  const regridId = text(fields.ll_uuid);
  if (Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0)) return { lat, lon, regridId, polygons };
  const [first] = polygons;
  const inside = first ? interiorPoint(first) : null;
  return inside ? { ...inside, regridId, polygons } : null;
}

/**
 * A point guaranteed to lie inside the polygon (holes included): the middle of the widest span where a
 * horizontal line through the middle of its bounding box crosses it. A vertex average can fall outside
 * a concave parcel or inside a hole.
 */
export function interiorPoint(polygon: Ring[]): { lat: number; lon: number } | null {
  const lats = polygon.flatMap((ring) => ring.map(([, y = 0]) => y));
  if (lats.length === 0) return null;
  const lat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const crossings = polygon.flatMap((ring) => ring.flatMap((a, i) => {
    const b = ring[(i + 1) % ring.length];
    if (!b) return [];
    const [x1 = 0, y1 = 0] = a;
    const [x2 = 0, y2 = 0] = b;
    return (y1 > lat) !== (y2 > lat) ? [x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1)] : [];
  })).sort((p, q) => p - q);
  let best: { lat: number; lon: number } | null = null;
  let widest = 0;
  for (let i = 0; i + 1 < crossings.length; i += 2) {
    const [west = 0, east = 0] = [crossings[i], crossings[i + 1]];
    if (east - west > widest) {
      widest = east - west;
      best = { lat, lon: (west + east) / 2 };
    }
  }
  return best;
}

export function onRampLink(point: { lat: number; lon: number; regridId: string | null }, hit: TypeAheadHit): string {
  const params = new URLSearchParams({ lat: point.lat.toFixed(6), lon: point.lon.toFixed(6) });
  if (point.regridId) params.set("parcel", point.regridId);
  if (hit.apn) params.set("apn", hit.apn);
  params.set("path", hit.path);
  return `${WEB_BASE}/go?${params.toString()}`;
}

async function lookUpParcelPoint(hit: TypeAheadHit): Promise<ParcelPoint | null> {
  const { countyKey, county } = locate(hit.path);
  if (!hit.apn || !countyKey || !county) return null;
  const params = new URLSearchParams({ parcelnumb: hit.apn, path: `/us/${countyKey}`, adminId: county.fips });
  return parseParcelPoint(await fetchJson(`${WEB_BASE}/api/regrid-apn?${params.toString()}`), hit.path);
}

function toCandidate(hit: TypeAheadHit, token: ParcelIndexToken | null): ParcelCandidate {
  const { state, county } = locate(hit.path);
  return {
    address: hit.headline,
    place: hit.context,
    apn: hit.apn,
    state,
    county: county?.name ?? null,
    regridPath: hit.path,
    onFabrica: token ? toOnFabrica(token) : null,
  };
}

/** The county named by `county` (and `state`), when exactly one county fits. */
export function resolveCounty(county: string, state: string | undefined): { key: string; county: County } | null {
  const prefix = state ? `${state.toLowerCase()}/` : "";
  const inPrefix = [...COUNTIES.entries()].filter(([key]) => key.startsWith(prefix));
  const pick = (normalize: (slug: string) => string): { key: string; county: County } | null => {
    const wanted = normalize(slugify(county));
    const fits = inPrefix.filter(([key, entry]) => normalize(key.split("/")[1] ?? "") === wanted || normalize(slugify(entry.name)) === wanted);
    const [only] = fits;
    return fits.length === 1 && only ? { key: only[0], county: only[1] } : null;
  };
  // An exact name first, so "St. Louis County" is not confused with the city of St. Louis; then without the suffix.
  return pick((slug) => slug) ?? pick(withoutSuffix);
}

function inState(hit: TypeAheadHit, state: string | undefined): boolean {
  return !state || locate(hit.path).state === state.toUpperCase();
}

/**
 * The type-ahead scopes only by county. A state given without a county is searched a second time with the
 * state in the text, where Regrid weighs it. Returns null when there is nothing to retry (no state, a county
 * scope, or the query already names the state).
 */
export function stateRetryText(query: string, state: string | undefined, countyScoped: boolean): string | null {
  if (!state || countyScoped) return null;
  const code = state.toUpperCase();
  if (query.toUpperCase().split(/[^A-Z]+/).includes(code)) return null;
  return `${query}, ${code}`;
}

/**
 * The type-ahead's upstream search answers 503 to any query with a comma (ENG-5024), so
 * commas become spaces before the call. The words and their order are unchanged.
 */
export function typeAheadText(query: string): string {
  return query.replace(/,/g, " ").replace(/\s+/g, " ").trim();
}

const STREET_SUFFIXES: Record<string, string> = {
  road: "rd", street: "st", avenue: "ave", drive: "dr", lane: "ln", court: "ct", boulevard: "blvd",
  place: "pl", highway: "hwy", parkway: "pkwy", circle: "cir", terrace: "ter", trail: "trl", way: "way",
};
const DIRECTIONS: Record<string, string> = { north: "n", south: "s", east: "e", west: "w" };

const DIRECTION_LETTERS = new Set(Object.values(DIRECTIONS));

/**
 * "29078 West Stagecoach Lane, Seligman, AZ" to its house number, its direction ("w", or null) and its
 * street words, abbreviated the usual way. The direction is kept apart so "W" and "West" compare equal.
 */
export function streetKey(address: string): { number: string; direction: string | null; street: string[] } | null {
  const [line = ""] = address.split(",");
  const words = line.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  const [number, ...rest] = words;
  if (!number || !/^\d+[a-z]?$/.test(number) || rest.length === 0) return null;
  const normalized = rest.map((word) => STREET_SUFFIXES[word] ?? DIRECTIONS[word] ?? word);
  const directions = normalized.filter((word) => DIRECTION_LETTERS.has(word));
  const street = normalized.filter((word) => !DIRECTION_LETTERS.has(word));
  return street.length > 0 ? { number, direction: directions.join("") || null, street } : null;
}

/**
 * Fabrica properties whose name has the same house number and street as the query, or whose
 * registrar parcel number is the query, within the state when one is given. Used only when the
 * parcel search is down, so a parcel already on Fabrica still resolves from Fabrica's own records.
 */
/**
 * The city and state written into a comma-separated address: "123 Main St, Reno, NV 89501" gives
 * { city: "Reno", state: "NV" }. Only the comma form is read; a bare trailing word is too often a suffix ("Ct").
 */
export function queryLocality(query: string): { city: string | null; state: string | null } {
  const parts = query.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return { city: null, state: null };
  const last = parts[parts.length - 1].replace(/\b\d{5}(?:-\d{4})?\b/g, "").trim();
  const state = stateCode(last);
  const cityPart = state ? (parts.length >= 3 ? parts[parts.length - 2] : null) : parts[parts.length - 1];
  return { city: cityPart || null, state };
}

export function matchIndexByQuery(query: string, scope: { state?: string; county?: string }, tokens: readonly ParcelIndexToken[]): ParcelIndexToken[] {
  const wanted = streetKey(query);
  const apn = normalizeApn(query);
  const county = scope.county ? withoutSuffix(slugify(scope.county)) : null;
  // The locality in the address text binds too: "123 Main St, Reno, NV" is not 123 Main St in another city or state.
  const locality = queryLocality(query);
  const state = scope.state ?? locality.state;
  const city = locality.city ? slugify(locality.city) : null;
  return tokens.filter((token) => {
    if (state && token.regionCode?.toUpperCase() !== state.toUpperCase()) return false;
    if (city && token.place && slugify(token.place) !== city) return false;
    const tokenCounty = token.district ?? token.definition?.offchainRegistrar?.admin ?? null;
    if (county && tokenCounty && withoutSuffix(slugify(tokenCounty)) !== county) return false;
    const propertyId = token.definition?.offchainRegistrar?.propertyId;
    if (apn.length >= 4 && /\d/.test(apn) && propertyId && registrarApns(propertyId, null).includes(apn)) return true;
    const own = streetKey(token.name ?? token.vanityName ?? "");
    if (!wanted || !own || own.number !== wanted.number) return false;
    // East and West Stagecoach Lane are different streets; a direction given on one side only is not a conflict.
    if (own.direction && wanted.direction && own.direction !== wanted.direction) return false;
    return sameStreet(own.street, wanted.street);
  });
}

const SUFFIX_ABBREVIATIONS = new Set(Object.values(STREET_SUFFIXES));

/**
 * The same complete street: "Palo Colorado Rd" and "Palo Colorado Road" match, and so does
 * "Palo Colorado" with no suffix, but "Main St" and "Main St Extension" or "Palo Alto Rd" do not.
 */
function sameStreet(a: readonly string[], b: readonly string[]): boolean {
  const split = (words: readonly string[]) => {
    const last = words[words.length - 1];
    return words.length > 1 && SUFFIX_ABBREVIATIONS.has(last) ? { core: words.slice(0, -1), suffix: last } : { core: words, suffix: null };
  };
  const x = split(a);
  const y = split(b);
  if (x.suffix && y.suffix && x.suffix !== y.suffix) return false;
  return x.core.length === y.core.length && x.core.every((word, i) => word === y.core[i]);
}

function indexCandidate(token: ParcelIndexToken): ParcelCandidate {
  const registrar = token.definition?.offchainRegistrar ?? null;
  const name = token.name ?? token.vanityName ?? "";
  return {
    address: name.split(",")[0]?.trim() || name,
    place: [token.place, token.regionCode].filter(Boolean).join(", "),
    apn: registrar?.propertyId ?? null,
    state: token.regionCode?.toUpperCase() ?? null,
    county: token.district ?? registrar?.admin ?? null,
    regridPath: null,
    onFabrica: toOnFabrica(token),
  };
}

const SEARCH_DOWN = "The US parcel search is not answering right now";

/** When the type-ahead fails: the properties already on Fabrica that the query names, from Fabrica's own records. */
async function indexFallback(query: string, args: FindParcelArgs, failure: string) {
  let matches: ParcelIndexToken[];
  try {
    matches = matchIndexByQuery(query, { state: args.state, county: args.county }, await getParcelIndex());
  } catch {
    return { error: `${SEARCH_DOWN} (${failure}), and Fabrica's property records could not be read either. Try again shortly.` };
  }
  if (matches.length === 0) {
    return { error: `${SEARCH_DOWN} (${failure}). No property on Fabrica matches this address or parcel number, so it is probably not on Fabrica yet; try again shortly for the full search and the on-ramp link.` };
  }
  const source = "matched against Fabrica's own property records (the property name or its registrar parcel number), not the US parcel search; a name match is not a parcel-boundary check";
  if (matches.length === 1 && matches[0]) {
    return {
      query,
      match: "single",
      matchSource: "fabrica-index",
      parcel: indexCandidate(matches[0]),
      note: `${SEARCH_DOWN} (${failure}), so this was ${source}. This parcel is on Fabrica; get_property with the tokenId returns its record.`,
    };
  }
  return {
    query,
    match: "ambiguous",
    matchSource: "fabrica-index",
    candidates: matches.slice(0, MAX_CANDIDATES).map(indexCandidate),
    note: `${SEARCH_DOWN} (${failure}), so these were ${source}. Adding the state narrows them.`,
  };
}

export const findParcelInput = {
  query: z.string().min(3).max(200).describe("Street address (with city and state when known) or parcel number (APN)"),
  state: z.string().regex(/^[A-Za-z]{2}$/).optional().describe("Two-letter US state code, e.g. 'AZ'"),
  county: z.string().max(80).optional().describe("County name, e.g. 'Navajo'"),
};
export type FindParcelArgs = ArgsOf<typeof findParcelInput>;

/** find_parcel's answer. Every non-error result names the network and, on mainnet, carries the legal notice. */
export async function findParcel(args: FindParcelArgs) {
  const result = await searchParcel(args);
  if ("error" in result) return result;
  return { network: NETWORK_LABEL, ...result, ...(MAINNET_WARNING ? { legalNotice: MAINNET_WARNING } : {}) };
}

async function searchParcel(args: FindParcelArgs) {
  const query = args.query.trim();
  if (query.length < 3) return { error: "The query needs at least 3 characters: a street address or a parcel number (APN)." };
  const scope = args.county ? resolveCounty(args.county, args.state) : null;
  if (args.county && !scope) {
    return { error: `No single US county matches "${args.county}"${args.state ? ` in ${args.state.toUpperCase()}` : ""}. A two-letter state and the county name (for example state "AZ", county "Navajo") identify it.` };
  }
  const typeAhead = async (text: string): Promise<TypeAheadHit[]> => {
    const params = new URLSearchParams({ query: typeAheadText(text) });
    if (scope) params.set("adminId", scope.county.fips);
    return parseTypeAhead(await fetchJson(`${API_BASE}/regrid/type-ahead?${params.toString()}`));
  };
  const isExactApn = (hit: TypeAheadHit): boolean => hit.apn !== null && normalizeApn(hit.apn) === normalizeApn(query);
  let inScope: TypeAheadHit[];
  try {
    // Parcel numbers go in as typed (extra words stop them matching). Unless the first search already found the
    // parcel number, a state given without a county is searched again with the state in the text, where Regrid
    // weighs it; that state-ranked result wins when it has anything in the state.
    const first = (await typeAhead(query)).filter((hit) => inState(hit, args.state));
    const retry = first.some(isExactApn) ? null : stateRetryText(query, args.state, scope !== null);
    const second = retry !== null ? (await typeAhead(retry)).filter((hit) => inState(hit, args.state)) : [];
    inScope = second.length > 0 ? second : first;
  } catch (error) {
    return indexFallback(query, args, error instanceof Error ? error.message : "unknown error");
  }
  // A query that is a parcel number matching exactly one parcel in scope is that parcel.
  const exactApn = inScope.filter(isExactApn);
  // Several parcels sharing that exact number stay ambiguous: a score lead says nothing about which one is meant.
  const scoped = (exactApn.length > 0 ? exactApn : inScope).slice(0, MAX_CANDIDATES);
  if (scoped.length === 0) {
    return { query, match: "none", candidates: [], note: `No US parcel matched${args.state && !scope ? ` in ${args.state.toUpperCase()}; adding the county scopes the search itself, not just its results` : ""}. A full street address with city and state, or a parcel number with state and county, narrows the search.` };
  }
  let tokens: ParcelIndexToken[] = [];
  let indexNote: string | null = null;
  try {
    tokens = await getParcelIndex();
  } catch {
    indexNote = "Could not check which of these parcels are already on Fabrica; onFabrica is null for all of them.";
  }
  const byApn = scoped.map((hit) => ({ hit, token: matchByApn(hit, tokens) }));
  // Two parcels sharing a county and parcel number cannot both be the token's parcel, and the index has no Regrid
  // path to tell them apart, so neither gets it by number.
  const shared = new Set(byApn.flatMap(({ token }, i) => token && byApn.some((other, j) => j !== i && other.token === token) ? [token.tokenId] : []));
  const lookUpPoint = async (hit: TypeAheadHit): Promise<ParcelPoint | null> => {
    try {
      return await lookUpParcelPoint(hit);
    } catch {
      return null;
    }
  };
  // A parcel number can repeat within a county and its twin may not be in these hits, so a number match is kept
  // only when the parcel's outline, if it loads, contains the token. Only number-matched hits pay for the lookup.
  const matched = await Promise.all(byApn.map(async ({ hit, token }) => {
    const candidate = token && !shared.has(token.tokenId) ? token : null;
    if (!candidate) return { hit, token: null, point: undefined };
    const point = await lookUpPoint(hit);
    const coordinates = candidate.coordinates;
    const contradicted = point !== null && point.polygons.length > 0 && coordinates
      && !pointInPolygons(coordinates.lat, coordinates.lon, point.polygons);
    return { hit, token: contradicted ? null : candidate, point };
  }));
  const [top, second] = matched;
  const single = top !== undefined && (second === undefined || (exactApn.length === 0 && top.hit.score - second.hit.score >= CLEAR_LEAD));
  if (!top || !single) {
    return {
      query,
      match: "ambiguous",
      candidates: matched.map(({ hit, token }) => toCandidate(hit, token)),
      note: `Several parcels match. Calling find_parcel again with state (and county) narrows it to one.${indexNote ? ` ${indexNote}` : " onFabrica here comes from parcel numbers only; null means not confirmed on Fabrica, and the full check (including the parcel outline) runs once the search narrows to one parcel."}`,
    };
  }
  if (top.token) {
    return {
      query,
      match: "single",
      parcel: toCandidate(top.hit, top.token),
      note: "This parcel is on Fabrica. get_property with the tokenId returns its record.",
    };
  }
  if (indexNote) {
    // Without the token check the parcel may already be on Fabrica, so no on-ramp link.
    return {
      query,
      match: "single",
      parcel: toCandidate(top.hit, null),
      note: `${indexNote} The add-to-Fabrica link is withheld until that check succeeds; calling find_parcel again shortly retries it.`,
    };
  }
  const point = top.point !== undefined ? top.point : await lookUpPoint(top.hit);
  const byOutline = point && point.polygons.length > 0
    ? tokens.find((token) => token.coordinates && token.regionCode?.toUpperCase() === locate(top.hit.path).state && pointInPolygons(token.coordinates.lat, token.coordinates.lon, point.polygons))
    : undefined;
  if (byOutline) {
    return {
      query,
      match: "single",
      parcel: toCandidate(top.hit, byOutline),
      note: "A Fabrica property sits inside this parcel's boundary. get_property with the tokenId returns its record.",
    };
  }
  const addToFabrica = point ? onRampLink(point, top.hit) : `${WEB_BASE}/go`;
  const { countyKey } = locate(top.hit.path);
  const coverage = countyKey ? { status: coverageStatus(countyKey), asOf: COVERAGE_AS_OF } : null;
  return {
    query,
    match: "single",
    parcel: toCandidate(top.hit, null),
    links: { addToFabrica },
    ...(coverage ? { coverage } : {}),
    note: `${point ? "The link opens the on-ramp for this parcel. Nothing is created until a person opens it and decides there." : "The parcel's location could not be looked up, so the link opens the on-ramp search page; the address or parcel number can be entered there."} ${coverage ? coverageNote(coverage.status) : COVERAGE_NOTE}`,
  };
}

function coverageNote(status: CoverageStatus): string {
  if (status === "supported") return `The on-ramp is set up for this county (on-ramp rules as of ${COVERAGE_AS_OF}); check_coverage lists the documents and steps it asks for.`;
  if (status === "notConfigured") return `The on-ramp is not set up for this county yet (on-ramp rules as of ${COVERAGE_AS_OF}), so the owner may not be able to finish online; contact_support can ask Fabrica about it.`;
  return `Fabrica does not take property in this county through the on-ramp (on-ramp rules as of ${COVERAGE_AS_OF}).`;
}

/** Per-client limit on find_parcel calls, per warm server instance (the type-ahead is metered). */
export const FIND_PARCEL_LIMIT_PER_MINUTE = 30;
const WINDOW_MS = 60_000;
const recentCalls = new Map<string, number[]>();

/** Records `count` find_parcel calls for `client` and says whether they fit in the limit. */
export function allowFindParcel(client: string, count: number, now: number = Date.now()): boolean {
  if (count === 0) return true;
  const recent = (recentCalls.get(client) ?? []).filter((at) => now - at < WINDOW_MS);
  if (recent.length + count > FIND_PARCEL_LIMIT_PER_MINUTE) {
    recentCalls.set(client, recent);
    return false;
  }
  recentCalls.set(client, [...recent, ...Array.from({ length: count }, () => now)]);
  if (recentCalls.size > 10_000) {
    for (const [key, times] of recentCalls) if (times.every((at) => now - at >= WINDOW_MS)) recentCalls.delete(key);
  }
  return true;
}
