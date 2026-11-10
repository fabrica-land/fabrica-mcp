import { z } from "zod";
import { NETWORK_LABEL } from "../config.js";
import type { AccountAuth } from "../auth/token.js";
import { ListingImportError, scanWebsite } from "../clients/listing-import.js";
import type { ArgsOf } from "./inputs.js";

/**
 * find_listings_on_website: the listing pages on a seller's own website, read by the web app's
 * website import (the same reader as fabrica.land's "Add from your website" on the profile). It
 * creates nothing: each listing is then added with add_land (listingUrl), which reads the page,
 * finds the parcel, says whether it is already on Fabrica and starts the record.
 */

export const websiteInput = {
  url: z.string().min(4).max(2048).describe("The seller's website, or the page that lists their properties (e.g. 'example-land.com/properties')"),
};
export type WebsiteArgs = ArgsOf<typeof websiteInput>;

/** Listings returned in one answer; the site's own list can be longer (truncated says so). */
export const MAX_LISTINGS_RETURNED = 200;

const SOURCE: Record<string, string> = {
  sitemap: "the site's sitemap",
  links: "the links on the page",
  index: "the site's listings page",
  rendered: "the page as a browser shows it",
};

export async function findListingsOnWebsite(account: AccountAuth, { url }: WebsiteArgs) {
  let scan;
  try {
    scan = await scanWebsite(url.trim(), account.subject);
  } catch (error) {
    if (error instanceof ListingImportError) return { error: error.message };
    throw error;
  }
  const base = { network: NETWORK_LABEL };
  switch (scan.status) {
    case "ok": {
      const listings = scan.listings.slice(0, MAX_LISTINGS_RETURNED);
      return {
        ...base,
        site: scan.site,
        found: listings.length,
        readFrom: SOURCE[scan.source] ?? scan.source,
        listings: listings.map((listingUrl) => ({ listingUrl })),
        notes: [
          "Nothing was added yet. add_land with a listingUrl adds one listing: it reads the page (price, acres, description, photos, parcel number), finds the parcel, says whether it is already on Fabrica, and starts its record with the county's questions.",
          "Only listings the person owns, on a website that is theirs, belong on their account: the description and photos are copied from the page.",
          ...(scan.truncated ? [`The site lists more pages than this; the first ${listings.length} are shown.`] : []),
          ...(scan.partial ? ["The site was read in part before time ran out, so some listings may be missing. Asking again reads it again."] : []),
        ],
      };
    }
    case "none":
      return { ...base, site: scan.site, found: 0, listings: [], notes: ["No listing pages were found on this site. A link to the page that lists the properties often works better than the home page; each listing can also be added with add_land and its own link."] };
    case "timeout":
      return { error: `Reading ${scan.site} took too long. Try again shortly, or give the page that lists the properties.` };
    case "blocked":
      return { error: "The website refuses automated reading, so its listings could not be read. Each listing can still be added with add_land and its own link." };
    case "unreachable":
      return { error: "The website could not be reached. Check the address and try again." };
    case "invalid-url":
      return { error: "That is not a website address this reader accepts: a public https site is needed." };
    case "rate-limited":
      return { error: "Too many websites were read in the last hour. Try again later." };
  }
}
