import { z } from "zod";
import { NETWORK_LABEL, WEB_BASE } from "../config.js";
import { hasScope, type AccountAuth } from "../auth/token.js";
import {
  AccountApiError,
  getAccountProfile,
  getOnRampRecord,
  isMediaRefusal,
  patchOnRamp,
  startOnRamp,
  type OnRampPatchBody,
  type OnRampRecord,
  type OnRampStartBody,
} from "../clients/account.js";
import { importListing, ListingImportError, type ListingDraft, type ListingMatch } from "../clients/listing-import.js";
import { findParcel, locate, type ParcelCandidate } from "./parcels.js";
import { describeOnRamp, questionRows, type OnRampStatusResult } from "./onramps.js";
import type { ArgsOf } from "./inputs.js";

/**
 * add_land and answer_adding_questions: start adding a property to Fabrica as the connected
 * person, from a listing link, a parcel number or an address, then walk the questions the
 * county's rules ask for that property. The questions come from the Fabrica API's record of the
 * property (the same ones the web app's owner form shows), never from this server: the API picks
 * them by county, state and the kind of owner, so the list is read again after every answer.
 */

export const MAX_START_PHOTOS = 20;
export const MAX_START_DESCRIPTION_CHARS = 5_000;

const WRITE_GRANT_NOTE = "This connection was not granted \"Start adding a property to your account\". Reconnect Fabrica and approve it, and this tool starts the property here.";
const SIGN_IN_NOTE = "Not signed in: the link opens the page to add this parcel on fabrica.land. Signed in to Fabrica (with the add-property grant), this tool starts it here instead and asks the county's questions.";
const LISTING_SIGN_IN_NOTE = "Reading a listing here needs the person signed in to Fabrica: connect Fabrica in this client and call add_land again, or open the link and paste the listing there. A parcel number or an address needs no sign-in.";
const UNSUPPORTED_NOTE = "Property in this county cannot be added to Fabrica online yet. The link opens the page that says what is possible there.";

/** A listing page: https only (the web app refuses anything else) and a sane length. */
const listingUrl = z.string().max(2048).url().refine((value) => /^https:\/\//i.test(value), "an https:// link to a listing page");

const wallet = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "an Ethereum address");

export const addLandInput = {
  listingUrl: listingUrl.optional().describe("A listing page on another website (https link). The web app reads it: title, price, acres, the seller's description, photos, parcel number, county and state, and names the parcel."),
  address: z.string().min(3).max(200).optional().describe("The property's street address, with city and state"),
  parcelNumber: z.string().min(1).max(64).optional().describe("The parcel number (APN) as the county writes it; give state and county with it"),
  state: z.string().length(2).optional().describe("Two-letter state, with parcelNumber (and to narrow an address)"),
  county: z.string().min(2).max(64).optional().describe("County name, with parcelNumber (and to narrow an address)"),
  wallet: wallet.optional().describe("Signed in with several linked accounts: the one that will hold the property. Left out, the only linked account is used."),
};
export type AddLandArgs = ArgsOf<typeof addLandInput>;

const person = z.object({
  firstName: z.string().min(1).max(100).describe("Legal first name, as on the deed"),
  middleName: z.string().max(100).optional().describe("Middle name or initial, as on the deed"),
  lastName: z.string().min(1).max(100).describe("Legal last name, as on the deed"),
  email: z.string().email().describe("This person's email: the signing session and the documents go there"),
  role: z.string().max(100).optional().describe("For an entity: this person's role in it (Manager, President, Trustee...)"),
});

export const ownerInput = z.object({
  kind: z.enum(["individual", "entity", "multiple"]).describe("Who holds title on the deed: one person, a legal entity (LLC, corporation, trust...), or two or more people together"),
  firstName: person.shape.firstName.optional(),
  middleName: person.shape.middleName,
  lastName: person.shape.lastName.optional(),
  email: person.shape.email.optional(),
  role: person.shape.role,
  entityName: z.string().min(1).max(255).optional().describe("Entity: its legal name"),
  entityType: z.string().min(1).max(255).optional().describe("Entity: its type, e.g. Limited Liability Company, C Corporation, Trust, Limited Partnership"),
  entityJurisdiction: z.string().min(2).max(255).optional().describe("Entity: where it is formed, as US- plus the two-letter state in lower case, e.g. US-tx"),
  people: z.array(person).min(2).max(10).optional().describe("Multiple: every person on the deed"),
  qualifier: z.string().min(1).max(200).optional().describe("Multiple: how they hold title, as the deed says, e.g. 'husband and wife', 'as joint tenants with right of survivorship', 'as tenants in common'"),
}).describe("The owner named on the deed. One person: firstName, lastName, email. An entity: entityName, entityType, entityJurisdiction, and the person who signs for it (firstName, lastName, email, role). Multiple: people and qualifier.");

export const answerQuestionsInput = {
  tokenId: z.string().regex(/^\d+$/, "tokenId is the numeric token id").describe("Token id of the property being added (from add_land or get_my_properties_being_added)"),
  owner: ownerInput.optional(),
  answers: z.record(z.string(), z.string().max(2_000)).optional().describe("Answers to the county's questions, keyed by the question exactly as get_adding_status or add_land lists it; a select answer is one of its options, verbatim. An empty string clears an answer."),
  email: z.string().email().optional().describe("Where Fabrica writes about this property; defaults to the account's email"),
};
export type AnswerQuestionsArgs = ArgsOf<typeof answerQuestionsInput>;

/** The parcel a start names: what the parcel service calls it, and where it is. */
interface StartTarget {
  regridUuid: string;
  path: string;
  apn: string;
  /** County FIPS. */
  adminId: string;
  lat: number | null;
  lon: number | null;
  clientInput: string;
}

export interface ListingSummary {
  title: string | null;
  priceUsd: number | null;
  acres: number | null;
  description: string | null;
  photos: number;
  videos: number;
  /** How the page was read, and what it did not give. */
  read: string;
  warnings: string[];
}

export interface AddLandResult extends Omit<Partial<OnRampStatusResult>, "links"> {
  network: string;
  /** What the page said about the property, when a listing link was given. */
  listing?: ListingSummary;
  /** The parcel this resolves to. */
  parcel?: ParcelCandidate | { address: string | null; apn: string | null; county: string | null; state: string | null; regridPath: string | null };
  /** Several parcels fit: the question needs narrowing. */
  candidates?: ParcelCandidate[];
  /** True when this call started adding the property as the connected person. */
  started?: boolean;
  /** Signed in with several linked accounts and none named. */
  accountWallets?: string[];
  links?: { addToFabrica?: string; property?: string };
  notes: string[];
  error?: string;
}

function summarize(draft: ListingDraft): ListingSummary {
  const how = draft.method === "structured" ? "from the page's own data" : draft.method === "model" ? "read from the page's text and photos" : draft.method === "mixed" ? "from the page's data and its text" : "nothing could be read from the page";
  return {
    title: draft.title,
    priceUsd: draft.priceUsd,
    acres: draft.acres,
    description: draft.description,
    photos: draft.photos.length,
    videos: draft.videos.length,
    read: draft.status === "ok" ? how : `The page could not be read (${draft.status}).`,
    warnings: draft.warnings,
  };
}

function goLink(target: { lat: number | null; lon: number | null; regridUuid: string | null; apn: string | null; path: string }): string {
  const params = new URLSearchParams();
  if (target.lat !== null && target.lon !== null) {
    params.set("lat", target.lat.toFixed(6));
    params.set("lon", target.lon.toFixed(6));
  }
  if (target.regridUuid) params.set("parcel", target.regridUuid);
  if (target.apn) params.set("apn", target.apn);
  params.set("path", target.path);
  return `${WEB_BASE}/go?${params.toString()}`;
}

function propertyLink(tokenId: string): string {
  return `${WEB_BASE}/property/${tokenId.includes("/") ? tokenId : `${process.env.FABRICA_NETWORK?.toLowerCase() === "sepolia" ? "sepolia" : "ethereum"}/${encodeURIComponent(tokenId)}`}`;
}

/** The /go link find_us_parcel built for a parcel, read back into a start target. */
export function targetFromGoLink(link: string, clientInput: string): StartTarget | null {
  let params: URLSearchParams;
  try {
    params = new URL(link).searchParams;
  } catch {
    return null;
  }
  const regridUuid = params.get("parcel");
  const path = params.get("path");
  const apn = params.get("apn");
  if (!regridUuid || !path || !apn) return null;
  const adminId = locate(path).county?.fips ?? null;
  if (!adminId) return null;
  const lat = Number(params.get("lat"));
  const lon = Number(params.get("lon"));
  const located = params.has("lat") && Number.isFinite(lat) && Number.isFinite(lon);
  return { regridUuid, path, apn, adminId, lat: located ? lat : null, lon: located ? lon : null, clientInput };
}

function targetFromMatch(match: ListingMatch, clientInput: string): StartTarget | null {
  const parcel = match.parcel;
  if (match.verdict !== "match" || !parcel || !parcel.apn) return null;
  const adminId = parcel.adminId ?? locate(parcel.path).county?.fips ?? null;
  if (!adminId) return null;
  return { regridUuid: parcel.regridUuid, path: parcel.path, apn: parcel.apn, adminId, lat: parcel.centroid?.lat ?? null, lon: parcel.centroid?.lon ?? null, clientInput };
}

/** The description cut at a word under the limit, and the photos the start takes. */
export function startContent(draft: ListingDraft): Pick<OnRampStartBody, "userDescription" | "media"> {
  const content: Pick<OnRampStartBody, "userDescription" | "media"> = {};
  const description = draft.description?.trim();
  if (description) {
    if (description.length <= MAX_START_DESCRIPTION_CHARS) content.userDescription = description;
    else {
      const cut = description.slice(0, MAX_START_DESCRIPTION_CHARS);
      const atWord = cut.lastIndexOf(" ");
      content.userDescription = (atWord > MAX_START_DESCRIPTION_CHARS / 2 ? cut.slice(0, atWord) : cut).trim();
    }
  }
  const photos = draft.photos.filter((photo) => photo.url.startsWith("https://")).slice(0, MAX_START_PHOTOS);
  const videos = draft.videos.filter((url) => url.startsWith("https://"));
  const media = [
    ...photos.map((photo, index) => ({ source: photo.url, type: "image" as const, order: String(index) })),
    ...videos.map((url, index) => ({ source: url, type: "video" as const, order: String(photos.length + index) })),
  ];
  if (media.length > 0) content.media = media;
  return content;
}

function problem(notes: string[], error: string): AddLandResult {
  return { network: NETWORK_LABEL, notes, error };
}

type Resolved =
  | { kind: "target"; target: StartTarget; parcel: AddLandResult["parcel"]; listing?: ListingSummary; draft?: ListingDraft; link: string; notes: string[] }
  | { kind: "answer"; result: AddLandResult };

/**
 * The wallet the listing verdict is read for: the one named, or the only linked one. With several
 * linked and none named, no wallet is sent: the web app can only tell "mine" for one, and a wrong
 * "theirs" would stop the person from adding their own parcel.
 */
async function walletForVerdict(account: AccountAuth | undefined, named: string | undefined): Promise<{ wallet: string | null; several: boolean }> {
  if (named) return { wallet: named, several: false };
  if (!account || !hasScope(account, "profile:read")) return { wallet: null, several: false };
  const profile = await getAccountProfile(account).catch(() => null);
  const wallets = profile?.wallets ?? [];
  return wallets.length === 1 ? { wallet: wallets[0]?.address ?? null, several: false } : { wallet: null, several: wallets.length > 1 };
}

async function resolveListing(url: string, account: AccountAuth | undefined, named: string | undefined): Promise<Resolved> {
  const verdictFor = await walletForVerdict(account, named);
  let imported;
  try {
    imported = await importListing(url, verdictFor.wallet);
  } catch (error) {
    if (error instanceof ListingImportError) return { kind: "answer", result: problem([], error.message) };
    throw error;
  }
  if (!imported.ok) return { kind: "answer", result: problem([], imported.error) };
  const { draft, match } = imported;
  const listing = summarize(draft);
  const base: AddLandResult = { network: NETWORK_LABEL, listing, notes: [] };
  if (draft.status !== "ok") {
    return { kind: "answer", result: { ...base, links: { addToFabrica: `${WEB_BASE}/go` }, notes: [`The page could not be read (${draft.status}), so nothing is known about the property yet. Give the parcel number with its state and county, or the address, and the property can still be added.`] } };
  }
  const parcelRow = { address: match?.parcel ? draft.address ?? draft.title : draft.address, apn: match?.parcel?.apn ?? draft.apn, county: match?.parcel?.county ?? draft.county, state: match?.parcel?.state ?? draft.state, regridPath: match?.parcel?.path ?? null };
  if (match?.onFabrica) {
    const { kind, tokenId } = match.onFabrica;
    const link = propertyLink(tokenId);
    // A record read as the person settles "mine" whatever wallet the verdict was read for.
    if (kind === "premint-mine" || (kind === "premint-theirs" && verdictFor.several)) {
      if (account && hasScope(account, "onramp:read")) {
        const record = await getOnRampRecord(account, tokenId).catch(() => null);
        if (record) return { kind: "answer", result: { ...base, ...describeOnRamp(record, null), parcel: parcelRow, started: false, notes: ["This parcel is already being added by the connected account. answer_adding_questions continues it; get_adding_status shows where it stands."] } };
      }
      if (kind === "premint-mine") return { kind: "answer", result: { ...base, parcel: parcelRow, tokenId, links: { property: link }, notes: ["This parcel is already being added by the connected account. get_adding_status shows where it stands."] } };
    }
    if (kind === "minted-mine") return { kind: "answer", result: { ...base, parcel: parcelRow, tokenId, links: { property: link }, notes: ["This parcel is already on Fabrica and held by the connected account. get_land_property returns its record."] } };
    if (kind === "premint-unclaimed") return { kind: "answer", result: { ...base, parcel: parcelRow, tokenId, links: { property: link }, notes: ["Someone started adding this parcel to Fabrica but has not claimed it. Its page says how to claim it; it cannot be started again here."] } };
    const other = verdictFor.several ? " (or by one of this account's other linked accounts: name it with wallet to check)" : "";
    return { kind: "answer", result: { ...base, parcel: parcelRow, tokenId, links: { property: link }, notes: [kind === "minted-theirs" ? `This parcel is already on Fabrica, held by another account${other}. get_land_property returns its record.` : `Another account${other} is already adding this parcel to Fabrica. Its page shows its status.`] } };
  }
  const target = match ? targetFromMatch(match, url) : null;
  if (!target) {
    const why = match?.reason && match.reason !== "match" ? ` (${match.reason.replace(/-/g, " ")})` : "";
    return { kind: "answer", result: { ...base, parcel: parcelRow, links: { addToFabrica: `${WEB_BASE}/go` }, notes: [`The page was read but the parcel could not be identified from it${why}. Call add_land again with the parcel number, state and county, or the address, and the listing's description and photos can be added on the property page afterwards.`] } };
  }
  return { kind: "target", target, parcel: parcelRow, listing, draft, link: goLink({ ...target, regridUuid: target.regridUuid }), notes: [] };
}

async function resolveParcel(args: AddLandArgs, account: AccountAuth | undefined): Promise<Resolved> {
  const query = args.parcelNumber ?? args.address ?? "";
  const scope: { state?: string; county?: string } = {};
  if (args.state) scope.state = args.state;
  if (args.county) scope.county = args.county;
  const found = await findParcel({ query, ...scope });
  if (!("match" in found) || found.match === undefined) {
    return { kind: "answer", result: problem([], "error" in found && typeof found.error === "string" ? found.error : "The parcel search did not answer.") };
  }
  if (found.match === "ambiguous" || found.match === "unconfirmed") {
    return { kind: "answer", result: { network: NETWORK_LABEL, candidates: found.candidates, notes: [found.note] } };
  }
  if (found.match === "none") return { kind: "answer", result: { network: NETWORK_LABEL, notes: [found.note] } };
  const parcel = found.parcel;
  if (parcel.onFabrica) {
    const { tokenId } = parcel.onFabrica;
    // The search does not say whose it is; the person's own record (being added) continues here, as from a listing.
    if (account && hasScope(account, "onramp:read")) {
      const record = await getOnRampRecord(account, tokenId).catch(() => null);
      if (record) return { kind: "answer", result: { ...describeOnRamp(record, null), parcel, started: false, notes: ["This parcel is already being added by the connected account. answer_adding_questions continues it; get_adding_status shows where it stands."] } };
    }
    return { kind: "answer", result: { network: NETWORK_LABEL, parcel, tokenId, links: { property: parcel.onFabrica.propertyLink ?? propertyLink(tokenId) }, notes: ["This parcel is already on Fabrica (or being added). get_land_property returns its record; get_my_properties_being_added says whether it is the connected account's."] } };
  }
  const link = "links" in found && found.links ? found.links.addToFabrica : null;
  const target = link ? targetFromGoLink(link, query) : null;
  if (!link || !target) {
    return { kind: "answer", result: { network: NETWORK_LABEL, parcel, links: { addToFabrica: link ?? `${WEB_BASE}/go` }, notes: [found.note ?? ""] } };
  }
  if ("coverage" in found && found.coverage?.status === "unsupported") {
    return { kind: "answer", result: { network: NETWORK_LABEL, parcel, links: { addToFabrica: link }, notes: [UNSUPPORTED_NOTE] } };
  }
  return { kind: "target", target, parcel, link, notes: [] };
}

async function chooseWallet(account: AccountAuth, named: string | undefined): Promise<{ wallet: string; email: string | null } | AddLandResult> {
  const profile = await getAccountProfile(account, "onramp:write");
  const wallets = profile?.wallets.map((w) => w.address) ?? [];
  if (wallets.length === 0) return problem([], "No linked account (wallet address) is on this Fabrica account yet, so nothing can hold the property. Link one on fabrica.land first.");
  if (named) {
    const own = wallets.find((w) => w.toLowerCase() === named.toLowerCase());
    if (!own) return problem([], `${named} is not an account linked to this Fabrica login. The linked ones: ${wallets.join(", ")}.`);
    return { wallet: own, email: profile?.email ?? null };
  }
  if (wallets.length > 1) return { network: NETWORK_LABEL, accountWallets: wallets, notes: ["This Fabrica account has several linked accounts. Call add_land again with wallet set to the one that will hold the property."] };
  return { wallet: wallets[0] as string, email: profile?.email ?? null };
}

/**
 * add_land: find the parcel (from the listing, the parcel number or the address), then, signed in
 * with the add-property grant, start adding it as the connected person; otherwise hand over the
 * link that opens it on fabrica.land.
 */
export async function addLand(args: AddLandArgs, account?: AccountAuth): Promise<AddLandResult> {
  const ways = [args.listingUrl, args.address, args.parcelNumber].filter((v) => v !== undefined).length;
  if (ways !== 1) return problem([], "Give exactly one of listingUrl, address, or parcelNumber (with state and county).");
  if (args.parcelNumber && !(args.state && args.county)) return problem([], "A parcel number needs its state and county: the same number repeats across counties.");
  if (args.listingUrl && !account) return { network: NETWORK_LABEL, links: { addToFabrica: `${WEB_BASE}/go` }, notes: [LISTING_SIGN_IN_NOTE] };
  let resolved: Resolved;
  try {
    resolved = args.listingUrl ? await resolveListing(args.listingUrl, account, args.wallet) : await resolveParcel(args, account);
  } catch (error) {
    if (error instanceof AccountApiError) return problem([], error.message);
    throw error;
  }
  if (resolved.kind === "answer") return resolved.result;
  const { target, parcel, listing, draft, link } = resolved;
  const base: AddLandResult = { network: NETWORK_LABEL, ...(listing ? { listing } : {}), parcel, links: { addToFabrica: link }, notes: [...resolved.notes] };
  if (!account) return { ...base, notes: [...base.notes, SIGN_IN_NOTE] };
  if (!hasScope(account, "onramp:write")) return { ...base, notes: [...base.notes, WRITE_GRANT_NOTE] };
  try {
    const chosen = await chooseWallet(account, args.wallet);
    if ("notes" in chosen) return { ...base, ...chosen, notes: [...base.notes, ...chosen.notes] };
    const content = draft ? startContent(draft) : {};
    const body: OnRampStartBody = {
      vendor: "regrid",
      vendorId: target.regridUuid,
      clientInput: target.clientInput,
      country: "US",
      adminId: target.adminId,
      propertyId: target.apn,
      ...(target.lat !== null && target.lon !== null ? { lat: target.lat, lon: target.lon } : {}),
      ...content,
      walletAddress: chosen.wallet,
      ...(chosen.email ? { email: chosen.email } : {}),
    };
    let record: OnRampRecord | null;
    let photosDropped = false;
    try {
      record = await startOnRamp(account, body);
    } catch (error) {
      // Photos never block the property: a start refused over a photo entry goes again without them.
      if (!body.media || !isMediaRefusal(error)) throw error;
      const { media: _dropped, ...withoutMedia } = body;
      record = await startOnRamp(account, withoutMedia);
      photosDropped = true;
    }
    if (!record) return { ...base, notes: [...base.notes, "Another account is already adding this parcel to Fabrica, so it cannot be started here."] };
    const status = describeOnRamp(record, null);
    const notes = [...base.notes];
    if (photosDropped) notes.push("The listing's photos were not accepted, so the property starts without them; they can be added on its page.");
    notes.push(nextNote(record));
    return { ...base, ...status, started: true, links: { addToFabrica: link, property: status.links?.property ?? propertyLink(record.tokenId) }, notes };
  } catch (error) {
    if (error instanceof AccountApiError) return { ...base, notes: [...base.notes], error: error.message };
    throw error;
  }
}

/** What to do next on a record, in one line: the owner, the questions, or the step's own page. */
export function nextNote(record: OnRampRecord): string {
  const open = questionRows(record).filter((q) => q.requiredNow && q.answer === null).map((q) => q.key);
  if (record.grantors.length === 0) {
    return `Next: ask who holds title on the deed (one person, an entity, or several people) and their details, then call answer_adding_questions with owner${open.length > 0 ? ` and the county's questions (${open.join("; ")})` : ""}. The questions can change with the kind of owner, so read them again from the answer.`;
  }
  if (open.length > 0) return `Next: the county still asks: ${open.join("; ")}. Call answer_adding_questions with answers.`;
  return "The owner's details are in. The next step and its link are in nextStep; the fee approval and the signing session happen on fabrica.land.";
}

type Person = z.infer<typeof person>;

function individual(p: Person & { role?: string | undefined }): Record<string, unknown> {
  const fullName = [p.firstName, p.middleName, p.lastName].map((part) => part?.trim()).filter((part) => part).join(" ");
  return {
    signerType: "individual",
    firstName: p.firstName.trim(),
    ...(p.middleName?.trim() ? { middleName: p.middleName.trim() } : {}),
    lastName: p.lastName.trim(),
    fullName,
    email: p.email.trim(),
    ...(p.role?.trim() ? { role: p.role.trim() } : {}),
  };
}

/** The owner as the API's signer shape, or what is missing. */
export function grantorOf(owner: z.infer<typeof ownerInput>): { grantor: Record<string, unknown> } | { error: string } {
  const need = (fields: string[]) => `An ${owner.kind === "individual" ? "individual owner" : owner.kind === "entity" ? "entity owner" : "owner of several people"} needs ${fields.join(", ")}.`;
  if (owner.kind === "individual") {
    if (!owner.firstName || !owner.lastName || !owner.email) return { error: need(["firstName", "lastName", "email"]) };
    return { grantor: individual({ firstName: owner.firstName, middleName: owner.middleName, lastName: owner.lastName, email: owner.email }) };
  }
  if (owner.kind === "entity") {
    if (!owner.entityName || !owner.entityType || !owner.entityJurisdiction || !owner.firstName || !owner.lastName || !owner.email) return { error: need(["entityName", "entityType", "entityJurisdiction", "and the person who signs for it: firstName", "lastName", "email (role is optional)"]) };
    return {
      grantor: {
        signerType: "entity",
        name: owner.entityName.trim(),
        ...(owner.entityType?.trim() ? { type: owner.entityType.trim() } : {}),
        ...(owner.entityJurisdiction?.trim() ? { jurisdiction: owner.entityJurisdiction.trim() } : {}),
        signers: [individual({ firstName: owner.firstName, middleName: owner.middleName, lastName: owner.lastName, email: owner.email, role: owner.role })],
      },
    };
  }
  if (!owner.people || owner.people.length < 2 || !owner.qualifier) return { error: need(["people (two or more, each with firstName, lastName, email)", "qualifier (how they hold title, as the deed says)"]) };
  const emails = new Set(owner.people.map((p) => p.email.trim().toLowerCase()));
  if (emails.size !== owner.people.length) return { error: "Each person needs their own email address: the signing session and the documents go to each of them." };
  return { grantor: { signerType: "concurrent", qualifier: owner.qualifier.trim(), signers: owner.people.map((p) => individual(p)) } };
}

/** The answers checked against the county's questions: unknown keys and select answers off the list are refused. */
export function checkAnswers(record: OnRampRecord, answers: Record<string, string>): { collectedFields: Record<string, string | null> } | { error: string } {
  const byKey = new Map(record.questions.map((q) => [q.key, q]));
  const collectedFields: Record<string, string | null> = {};
  for (const [key, raw] of Object.entries(answers)) {
    const question = byKey.get(key);
    if (!question) {
      const known = record.questions.map((q) => `"${q.key}"`).join(", ");
      return { error: `"${key}" is not one of the county's questions for this property${known ? ` (${known})` : " (it asks none)"}.` };
    }
    const value = question.type === "select" ? raw : raw.trim();
    if (value === "") {
      collectedFields[key] = null;
      continue;
    }
    if (question.type === "select" && !(question.options ?? []).includes(value)) {
      return { error: `"${key}" takes one of: ${(question.options ?? []).map((o) => `"${o}"`).join(", ")}.` };
    }
    collectedFields[key] = value;
  }
  return { collectedFields };
}

/**
 * answer_adding_questions: save the owner named on the deed and the answers to the county's
 * questions on a property the connected person is adding, and say what is still open.
 */
export async function answerAddingQuestions(account: AccountAuth, args: AnswerQuestionsArgs): Promise<AddLandResult> {
  if (!hasScope(account, "onramp:write")) return problem([], WRITE_GRANT_NOTE);
  if (!args.owner && !args.answers && !args.email) return problem([], "Give owner, answers, or email: there is nothing to save.");
  try {
    const record = await getOnRampRecord(account, args.tokenId);
    if (!record) return problem([], `Token ${args.tokenId} is not a property this account is adding to Fabrica. get_my_properties_being_added lists the ones it is.`);
    const body: OnRampPatchBody = {};
    if (args.owner) {
      const grantor = grantorOf(args.owner);
      if ("error" in grantor) return problem([], grantor.error);
      body.grantors = [grantor.grantor];
    }
    if (args.answers && Object.keys(args.answers).length > 0) {
      const checked = checkAnswers(record, args.answers);
      if ("error" in checked) return { ...problem([], checked.error), questions: questionRows(record) };
      body.collectedFields = checked.collectedFields;
    }
    if (args.email) body.email = args.email;
    const saved = await patchOnRamp(account, args.tokenId, body);
    const status = describeOnRamp(saved, null);
    return { ...status, notes: [nextNote(saved)] };
  } catch (error) {
    if (error instanceof AccountApiError) return problem([], error.message);
    throw error;
  }
}
