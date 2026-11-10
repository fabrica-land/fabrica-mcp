import { WEB_BASE } from "../config.js";
import { listingImportKey } from "./listing-import.js";

/**
 * The web app's owner search (POST /api/regrid-owner on fabrica.land, the "Owner name" search on
 * /go): the parcels the county records under an owner's name in one county, up to 10. The web app
 * asks the Fabrica API, which answers from Regrid. This server calls it for the person signed in
 * here: its own key (FABRICA_LISTING_IMPORT_KEY) and that person's Fabrica account id, so each
 * person keeps their own daily allowance. Nothing is created by a search.
 */

const SEARCH_TIMEOUT_MS = 20_000;
const KEY_HEADER = "x-listing-import-key";
const SUBJECT_HEADER = "x-listing-import-subject";

/** The fewest and most characters of an owner name the web app searches. */
export const OWNER_NAME_MIN = 4;
export const OWNER_NAME_MAX = 100;

export interface OwnerParcel {
  apn: string | null;
  owner: string | null;
  address: string | null;
  acres: number | null;
  lat: number;
  lon: number;
  /** Regrid's parcel path, "/us/<state>/<county>/...". */
  path: string | null;
  regridId: string | null;
}

export type OwnerSearch =
  | { status: "ok"; parcels: OwnerParcel[]; more: boolean }
  | { status: "rate-limited" }
  | { status: "failed" };

export class OwnerSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerSearchError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseParcel(value: unknown): OwnerParcel | null {
  if (!isRecord(value)) return null;
  const lat = num(value.lat);
  const lon = num(value.lon);
  if (lat === null || lon === null) return null;
  return {
    apn: text(value.apn),
    owner: text(value.owner),
    address: text(value.address),
    acres: num(value.acres),
    lat,
    lon,
    path: text(value.path),
    regridId: text(value.llUuid),
  };
}

/** The web app's answer: `{ parcels, more }`, or null when it is not one. */
export function parseOwnerSearch(body: unknown): { parcels: OwnerParcel[]; more: boolean } | null {
  if (!isRecord(body) || !Array.isArray(body.parcels)) return null;
  const parcels = body.parcels.map(parseParcel).filter((parcel): parcel is OwnerParcel => parcel !== null);
  return { parcels, more: body.more === true };
}

/**
 * Search one county (`path`, "/us/<state>/<county>") for an owner's parcels, for the person signed
 * in here (`subject`, their Fabrica account id). Throws OwnerSearchError when the search is not set
 * up, cannot be reached, refuses this server, or answers something unknown.
 */
export async function searchOwnerParcels(owner: string, path: string, subject: string, fetchImpl: typeof fetch = fetch): Promise<OwnerSearch> {
  const key = listingImportKey();
  if (!key) throw new OwnerSearchError("Searching by owner is not set up on this server.");
  let response: Response;
  try {
    response = await fetchImpl(`${WEB_BASE}/api/regrid-owner`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", [KEY_HEADER]: key, [SUBJECT_HEADER]: subject },
      // The owner's name goes in the body only, never in a URL that logs keep.
      body: JSON.stringify({ owner, path }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new OwnerSearchError("The owner search took too long. Try again shortly.");
    }
    throw new OwnerSearchError("The owner search could not be reached. Try again shortly.");
  }
  if (response.status === 401 || response.status === 404) throw new OwnerSearchError("Searching by owner is not available from this server right now.");
  if (response.status === 429) return { status: "rate-limited" };
  if (response.status === 502) return { status: "failed" };
  if (response.status === 400) throw new OwnerSearchError("The owner search refused this request: an owner name of 4 to 100 characters and a known county are needed.");
  const body: unknown = await response.json().catch(() => null);
  const parsed = response.ok ? parseOwnerSearch(body) : null;
  if (!parsed) throw new OwnerSearchError(`The owner search answered with something this server does not understand (HTTP ${response.status}). Try again shortly.`);
  return { status: "ok", ...parsed };
}
