import { getParcelIndex, type ParcelIndexToken } from "../clients/graphql.js";
import { IS_MAINNET } from "../config.js";
import { US_COUNTY_ROWS } from "../data/us-counties.js";

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
const WEB_BASE = (process.env.FABRICA_WEB_URL ?? (IS_MAINNET ? "https://fabrica.land" : "https://testnets.fabrica.land")).replace(/\/+$/, "");

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
  regridPath: string;
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

/** The registrar's parcel number, also when it carries a five-digit county FIPS prefix ("06037-018-007"). */
function registrarApns(propertyId: string): string[] {
  const unprefixed = /^\d{5}-(.+)$/.exec(propertyId)?.[1];
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
      && registrarApns(registrar.propertyId).includes(apn)
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

/** The parcel's point (Regrid's own interior point, else the outer ring's average) and outline. Reads no other field. */
export function parseParcelPoint(body: unknown, path: string): ParcelPoint | null {
  const parcels = isRecord(body) && isRecord(body.parcels) && Array.isArray(body.parcels.features) ? body.parcels.features : [];
  const features = parcels.filter(isRecord);
  const feature = features.find((f) => isRecord(f.properties) && f.properties.path === path) ?? features[0];
  if (!feature) return null;
  const fields = isRecord(feature.properties) && isRecord(feature.properties.fields) ? feature.properties.fields : {};
  const polygons = polygonsOf(feature.geometry);
  const lat = Number(fields.lat);
  const lon = Number(fields.lon);
  const regridId = text(fields.ll_uuid);
  if (Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0)) return { lat, lon, regridId, polygons };
  const outer = polygons[0]?.[0];
  if (!outer || outer.length === 0) return null;
  const sum = outer.reduce((acc, [x = 0, y = 0]) => ({ lon: acc.lon + x, lat: acc.lat + y }), { lon: 0, lat: 0 });
  return { lat: sum.lat / outer.length, lon: sum.lon / outer.length, regridId, polygons };
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

export interface FindParcelArgs {
  query: string;
  state?: string;
  county?: string;
}

export async function findParcel(args: FindParcelArgs) {
  const query = args.query.trim();
  if (query.length < 3) return { error: "The query needs at least 3 characters: a street address or a parcel number (APN)." };
  const scope = args.county ? resolveCounty(args.county, args.state) : null;
  if (args.county && !scope) {
    return { error: `No single US county matches "${args.county}"${args.state ? ` in ${args.state.toUpperCase()}` : ""}. A two-letter state and the county name (for example state "AZ", county "Navajo") identify it.` };
  }
  const params = new URLSearchParams({ query });
  if (scope) params.set("adminId", scope.county.fips);
  let hits: TypeAheadHit[];
  try {
    hits = parseTypeAhead(await fetchJson(`${API_BASE}/regrid/type-ahead?${params.toString()}`));
  } catch (error) {
    return { error: `The parcel search did not answer (${error instanceof Error ? error.message : "unknown error"}). Try again shortly.` };
  }
  const inScope = hits.filter((hit) => inState(hit, args.state));
  // A query that is a parcel number matching exactly one parcel in scope is that parcel.
  const exactApn = inScope.filter((hit) => hit.apn !== null && normalizeApn(hit.apn) === normalizeApn(query));
  const scoped = (exactApn.length === 1 ? exactApn : inScope).slice(0, MAX_CANDIDATES);
  if (scoped.length === 0) {
    return { query, match: "none", candidates: [], note: "No US parcel matched. A full street address with city and state, or a parcel number with state and county, narrows the search." };
  }
  let tokens: ParcelIndexToken[] = [];
  let indexNote: string | null = null;
  try {
    tokens = await getParcelIndex();
  } catch {
    indexNote = "Could not check which of these parcels are already on Fabrica; onFabrica is null for all of them.";
  }
  const matched = scoped.map((hit) => ({ hit, token: matchByApn(hit, tokens) }));
  const [top, second] = matched;
  const single = top !== undefined && (second === undefined || top.hit.score - second.hit.score >= CLEAR_LEAD);
  if (!top || !single) {
    return {
      query,
      match: "ambiguous",
      candidates: matched.map(({ hit, token }) => toCandidate(hit, token)),
      note: `Several parcels match. Calling find_parcel again with state (and county) narrows it to one.${indexNote ? ` ${indexNote}` : ""}`,
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
  let point: ParcelPoint | null = null;
  try {
    point = await lookUpParcelPoint(top.hit);
  } catch {
    point = null;
  }
  const byOutline = point && point.polygons.length > 0 && !indexNote
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
  return {
    query,
    match: "single",
    parcel: toCandidate(top.hit, null),
    links: { addToFabrica },
    note: `${point ? "The link opens the on-ramp for this parcel. Nothing is created until a person opens it and decides there." : "The parcel's location could not be looked up, so the link opens the on-ramp search page; the address or parcel number can be entered there."} ${COVERAGE_NOTE}${indexNote ? ` ${indexNote}` : ""}`,
  };
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
