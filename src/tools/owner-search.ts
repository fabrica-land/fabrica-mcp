import { z } from "zod";
import { NETWORK_LABEL } from "../config.js";
import type { AccountAuth } from "../auth/token.js";
import { getParcelIndex } from "../clients/graphql.js";
import { OWNER_NAME_MAX, OWNER_NAME_MIN, OwnerSearchError, searchOwnerParcels, type OwnerParcel } from "../clients/owner-search.js";
import { countyDisplayName } from "../county.js";
import type { ParcelIndexToken } from "../types/index.js";
import { matchByApn, onRampLink, resolveCounty, toOnFabrica, type ParcelOnFabrica } from "./parcels.js";
import type { ArgsOf } from "./inputs.js";

/**
 * find_land_by_owner: the parcels a county records under an owner's name, in one county, for the
 * person signed in (the same search as the "Owner name" search on fabrica.land/go). It creates
 * nothing: the parcel the person picks is then added with add_land (parcelNumber, state, county).
 * Regrid bills each parcel it returns, so a search lists at most 10 and needs a county.
 */

export const ownerSearchInput = {
  owner: z.string().min(OWNER_NAME_MIN).max(OWNER_NAME_MAX).describe("The owner's name as the county records it, usually last name first as on the tax bill (e.g. 'Smith John' or 'Smith Family Trust'). A person, a couple, a trust or a company."),
  state: z.string().length(2).describe("Two-letter state"),
  county: z.string().min(2).max(64).describe("County name"),
};
export type OwnerSearchArgs = ArgsOf<typeof ownerSearchInput>;

type IndexLoader = () => Promise<readonly ParcelIndexToken[]>;

interface OwnerParcelResult {
  parcelNumber: string | null;
  owner: string | null;
  address: string | null;
  acres: number | null;
  onFabrica: ParcelOnFabrica | null;
  links: { addToFabrica: string | null };
}

function toResult(parcel: OwnerParcel, countyPath: string, tokens: readonly ParcelIndexToken[] | null): OwnerParcelResult {
  const path = parcel.path?.startsWith(countyPath) ? parcel.path : countyPath;
  const hit = { headline: parcel.address ?? "", context: "", apn: parcel.apn, path, score: 0 };
  const token = tokens ? matchByApn(hit, tokens) : null;
  return {
    parcelNumber: parcel.apn,
    owner: parcel.owner,
    address: parcel.address,
    acres: parcel.acres === null ? null : Math.round(parcel.acres * 100) / 100,
    onFabrica: token ? toOnFabrica(token) : null,
    links: { addToFabrica: token ? null : onRampLink({ lat: parcel.lat, lon: parcel.lon, regridId: parcel.regridId }, hit) },
  };
}

export async function findLandByOwner(account: AccountAuth, args: OwnerSearchArgs, loadIndex: IndexLoader = getParcelIndex) {
  const state = args.state.trim().toUpperCase();
  const resolved = resolveCounty(args.county.trim(), state);
  if (!resolved) return { error: `No single county named "${args.county}" in ${state}. Give the county's name as it is written (e.g. 'Maricopa' or 'St. Louis County').` };
  const owner = args.owner.replace(/\s+/g, " ").trim();
  if (owner.length < OWNER_NAME_MIN) return { error: `An owner name needs at least ${OWNER_NAME_MIN} characters.` };
  const countyPath = `/us/${resolved.key}`;
  const countyName = countyDisplayName(resolved.county.name, state);

  let search;
  try {
    search = await searchOwnerParcels(owner, countyPath, account.subject);
  } catch (error) {
    if (error instanceof OwnerSearchError) return { error: error.message };
    throw error;
  }
  if (search.status === "rate-limited") return { error: "Too many owner searches today for this account. Try again tomorrow, or add the property by its parcel number or address." };
  if (search.status === "failed") return { error: "The county parcel records could not be searched just now. Try again shortly, or add the property by its parcel number or address." };

  let tokens: readonly ParcelIndexToken[] | null = null;
  try {
    tokens = search.parcels.length ? await loadIndex() : [];
  } catch {
    tokens = null;
  }
  const parcels = search.parcels.map((parcel) => toResult(parcel, countyPath, tokens));
  return {
    network: NETWORK_LABEL,
    county: countyName,
    state,
    owner,
    found: parcels.length,
    parcels,
    notes: [
      parcels.length
        ? "Nothing was added yet. add_land with parcelNumber, state and county adds the parcel the person picks: it creates its record as the connected person and returns the county's questions."
        : `No parcels are recorded under "${owner}" in ${countyName}. County records often put the last name first, spell out a trust or company name in full, or list a spouse first; another spelling, a parcel number or an address may find it.`,
      "Only the person's own land belongs on their account: a parcel whose recorded owner is them, or an entity or trust they sign for.",
      ...(search.more ? ["The owner has more parcels in this county than the 10 listed. A fuller name narrows the list."] : []),
      ...(tokens === null ? ["Could not check which of these parcels are already on Fabrica; onFabrica is null for all of them."] : []),
    ],
  };
}
