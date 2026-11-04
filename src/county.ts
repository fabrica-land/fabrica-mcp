import { US_COUNTY_ROWS } from "./data/us-counties.js";

/** County names by 5-digit FIPS, as the county table spells them ("San Francisco", "Kenai Peninsula Borough"). */
const COUNTY_NAMES_BY_FIPS: ReadonlyMap<string, string> = new Map(US_COUNTY_ROWS.map((row) => {
  const [, fips = "", name = ""] = row.split("|");
  return [fips, name];
}));

// A table name that already says what it is keeps it: Alaska's boroughs and census areas,
// Connecticut's planning regions, and the independent cities ("Baltimore City", "Carson City").
const ALREADY_TYPED = /\s(?:Borough|Census Area|Municipality|Planning Region|City|County|Parish)$/;
// No counties at all: Alaska's bare entries are municipalities, plus DC and the territories.
const NO_SUFFIX_STATES: ReadonlySet<string> = new Set(["AK", "DC", "GU", "MP", "PR", "VI"]);

/**
 * A bare county-table name as it reads in a sentence, worded like fabrica.land:
 * "San Francisco" → "San Francisco County", "Acadia" in LA → "Acadia Parish".
 * A name that already names its jurisdiction, or one in a state without counties, is left alone.
 */
export function countyDisplayName(name: string, state: string | null | undefined): string {
  const code = (state ?? "").trim().toUpperCase();
  if (ALREADY_TYPED.test(name) || NO_SUFFIX_STATES.has(code)) return name;
  return code === "LA" ? `${name} Parish` : `${name} County`;
}

/** The token fields a county is read from; every level is optional, so any query's selection fits. */
export interface TokenCountySource {
  district?: string | null;
  regionCode?: string | null;
  definition?: { offchainRegistrar?: { admin?: string | null; adminId?: string | null } | null } | null;
}

/**
 * The county a property is in, for display; null when the record names none.
 *
 * `district` when the API has one. It comes from Mapbox, which has no separate county for a
 * consolidated city-county (San Francisco is one area, typed as the city), so it is empty there.
 * The token's registrar still names the recording county: by its FIPS (`adminId`, or an `admin`
 * that is itself a FIPS), resolved through the county table, else by the `admin` name. Either
 * way it is worded like the rest of fabrica.land ("San Francisco County"). Soil reads it the same way.
 */
export function tokenCounty(token: TokenCountySource | null | undefined): string | null {
  if (!token) return null;
  const district = token.district?.trim();
  if (district) return district;
  const registrar = token.definition?.offchainRegistrar;
  const admin = registrar?.admin?.trim() || null;
  const fips = [registrar?.adminId?.trim(), admin].find((v): v is string => !!v && /^\d{5}$/.test(v));
  const name = (fips ? COUNTY_NAMES_BY_FIPS.get(fips) : undefined) ?? (admin && !/^\d+$/.test(admin) ? admin : null);
  return name ? countyDisplayName(name, token.regionCode) : null;
}
