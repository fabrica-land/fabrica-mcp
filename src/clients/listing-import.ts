import { WEB_BASE } from "../config.js";

/**
 * The web app's listing import (POST /api/import-listing on fabrica.land): it reads a listing
 * page on another website, extracts what it says about the property (title, price, acres, the
 * seller's description, parcel number, county, state, coordinates, photos, videos) and names the
 * parcel it is, with whether that parcel is already on Fabrica. The import runs on the web app;
 * this server only calls it, with its own key (FABRICA_LISTING_IMPORT_KEY) so it is counted on
 * its own budget rather than its address's. Nothing is created by the import.
 */

const IMPORT_TIMEOUT_MS = 30_000;
const KEY_HEADER = "x-listing-import-key";

export interface ListingPhoto {
  url: string;
  order: number;
}

export interface ListingDraft {
  attemptId: string;
  source: { url: string; host: string };
  title: string | null;
  priceUsd: number | null;
  acres: number | null;
  description: string | null;
  apn: string | null;
  county: string | null;
  state: string | null;
  address: string | null;
  coordinates: { lat: number; lon: number } | null;
  photos: ListingPhoto[];
  /** YouTube, Vimeo and X links the page carries. */
  videos: string[];
  /** "structured" (the page's own data), "model" (read by a language model), "mixed" or "none". */
  method: string;
  warnings: string[];
  /** "ok", or why the page gave nothing: "blocked", "unreachable", "not-a-listing", "budget-exhausted". */
  status: string;
}

export interface ListingParcel {
  regridUuid: string;
  path: string;
  apn: string | null;
  county: string | null;
  state: string | null;
  /** The county's 5-digit FIPS. */
  adminId: string | null;
  centroid: { lat: number; lon: number } | null;
}

export interface ListingOnFabrica {
  /** premint-unclaimed, premint-mine, premint-theirs, minted-mine, minted-theirs: in the web app's words. */
  kind: string;
  tokenId: string;
  slug: string | null;
}

export interface ListingMatch {
  verdict: "match" | "no-match";
  reason: string | null;
  parcel: ListingParcel | null;
  onFabrica: ListingOnFabrica | null;
}

export type ListingImport =
  | { ok: true; draft: ListingDraft; match: ListingMatch | null }
  | { ok: false; code: string; error: string };

export function listingImportKey(): string | null {
  return process.env.FABRICA_LISTING_IMPORT_KEY?.trim() || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function point(value: unknown): { lat: number; lon: number } | null {
  if (!isRecord(value)) return null;
  const lat = num(value.lat);
  const lon = num(value.lon);
  return lat !== null && lon !== null ? { lat, lon } : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function parseListingImport(body: unknown): ListingImport | null {
  if (!isRecord(body)) return null;
  if (typeof body.code === "string" && typeof body.error === "string") return { ok: false, code: body.code, error: body.error };
  const listing = body.listing;
  const source = body.source;
  const extraction = body.extraction;
  if (typeof body.attemptId !== "string" || !isRecord(listing) || !isRecord(source) || typeof source.url !== "string" || typeof body.status !== "string") return null;
  const photos: ListingPhoto[] = [];
  if (Array.isArray(listing.photos)) {
    for (const photo of listing.photos) {
      if (!isRecord(photo) || typeof photo.url !== "string") continue;
      photos.push({ url: photo.url, order: typeof photo.order === "number" ? photo.order : photos.length });
    }
  }
  photos.sort((a, b) => a.order - b.order);
  const draft: ListingDraft = {
    attemptId: body.attemptId,
    source: { url: source.url, host: text(source.host) ?? "" },
    title: text(listing.title),
    priceUsd: num(listing.priceUsd),
    acres: num(listing.acres),
    description: text(listing.description),
    apn: text(listing.apn),
    county: text(listing.county),
    state: text(listing.state),
    address: text(listing.address),
    coordinates: point(listing.coordinates),
    photos,
    videos: strings(listing.videos),
    method: isRecord(extraction) ? text(extraction.method) ?? "none" : "none",
    warnings: isRecord(extraction) ? strings(extraction.warnings) : [],
    status: body.status,
  };
  return { ok: true, draft, match: parseMatch(body.match) };
}

function parseMatch(value: unknown): ListingMatch | null {
  if (!isRecord(value) || (value.verdict !== "match" && value.verdict !== "no-match")) return null;
  const verdict = value.verdict === "match" ? "match" : "no-match";
  let parcel: ListingParcel | null = null;
  const p = value.parcel;
  if (isRecord(p) && typeof p.regridUuid === "string" && typeof p.path === "string") {
    parcel = { regridUuid: p.regridUuid, path: p.path, apn: text(p.apn), county: text(p.county), state: text(p.state), adminId: text(p.adminId), centroid: point(p.centroid) };
  }
  let onFabrica: ListingOnFabrica | null = null;
  if (isRecord(value.onFabrica) && typeof value.onFabrica.kind === "string" && typeof value.onFabrica.tokenId === "string") {
    onFabrica = { kind: value.onFabrica.kind, tokenId: value.onFabrica.tokenId, slug: text(value.onFabrica.slug) };
  }
  return { verdict, reason: text(value.reason), parcel, onFabrica };
}

export class ListingImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListingImportError";
  }
}

/**
 * Import one listing page. `account` is the connected person's wallet, so the verdict can tell
 * their own records from others'. Throws ListingImportError when the web app cannot be reached or
 * answers something this server does not understand; a refused import (a bad link, the budget) is
 * returned as `ok: false` with the web app's own words.
 */
export async function importListing(url: string, account: string | null, fetchImpl: typeof fetch = fetch): Promise<ListingImport> {
  // The web app reads https pages only; nothing else is worth a request, with or without the key.
  if (!/^https:\/\/[^\s/]+/i.test(url) || url.length > 2048) throw new ListingImportError("A listing link must be an https:// page address.");
  const key = listingImportKey();
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (key) headers[KEY_HEADER] = key;
  let response: Response;
  try {
    response = await fetchImpl(`${WEB_BASE}/api/import-listing`, {
      method: "POST",
      headers,
      body: JSON.stringify({ url, ...(account ? { account } : {}) }),
      signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new ListingImportError("Reading the listing took too long. Try again shortly, or add the property by its parcel number or address.");
    }
    throw new ListingImportError("The listing import could not be reached. Try again shortly, or add the property by its parcel number or address.");
  }
  const body: unknown = await response.json().catch(() => null);
  const parsed = parseListingImport(body);
  if (!parsed) throw new ListingImportError(`The listing import answered with something this server does not understand (HTTP ${response.status}). Try again shortly.`);
  return parsed;
}
