import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../clients/account.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../clients/account.js")>();
  return { ...actual, getAccountProfile: vi.fn(), getOnRampRecord: vi.fn(), startOnRamp: vi.fn(), patchOnRamp: vi.fn() };
});
vi.mock("../clients/listing-import.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../clients/listing-import.js")>();
  return { ...actual, importListing: vi.fn() };
});
vi.mock("../tools/parcels.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/parcels.js")>();
  return { ...actual, findParcel: vi.fn() };
});

import { AccountApiError, getAccountProfile, getOnRampRecord, patchOnRamp, startOnRamp, type OnRampRecord } from "../clients/account.js";
import { importListing, type ListingDraft, type ListingImport } from "../clients/listing-import.js";
import { findParcel, type ParcelCandidate } from "../tools/parcels.js";
import type { CoverageStatus } from "../tools/coverage.js";
import { addLand, answerAddingQuestions, checkAnswers, grantorOf, nextNote, startContent, targetFromGoLink } from "../tools/add-land.js";
import type { AccountAuth } from "../auth/token.js";

const WALLET = "0xAaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAA";
const SECOND = "0xBbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBB";

function auth(scopes: string[] = ["profile:read", "onramp:read", "onramp:write"]): AccountAuth {
  return { token: "t", subject: "s", clientId: "c", scopes, expiresAt: 4102444800 };
}

function record(extra: Partial<OnRampRecord> = {}): OnRampRecord {
  return {
    tokenId: "11",
    status: "premint",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    address: "County Road 12",
    county: "Costilla",
    state: "CO",
    parcelNumber: "70310050",
    missingRequiredFields: [],
    steps: [{ order: 1, key: "CollectInfoFromUser", status: "in-progress", text: "Owner details", textCompleted: "Owner details in", visible: true, expectedCompletion: null, completed: null, userActions: [{ label: "Owner details", prompt: "Tell us who owns the property", detail: null, url: null }] }],
    collectedFields: {},
    grantors: [],
    questions: [
      { key: "Is the parcel improved?", type: "select", options: ["Yes", "No"], required: true, requiredIf: null, placeholder: null },
      { key: "Describe the improvements", type: "textarea", options: null, required: false, requiredIf: { field: "Is the parcel improved?", value: "Yes" }, placeholder: null },
    ],
    ...extra,
  };
}

function draft(extra: Partial<ListingDraft> = {}): ListingDraft {
  return {
    attemptId: "a1", source: { url: "https://www.landwatch.com/lot/1", host: "www.landwatch.com" }, title: "5 acres in Costilla", priceUsd: 12000, acres: 5,
    description: "Quiet lot with road access.", apn: "70310050", county: "Costilla", state: "CO", address: null, coordinates: { lat: 37.1, lon: -105.4 },
    photos: [{ url: "https://img.example/1.jpg", order: 0 }, { url: "http://img.example/2.jpg", order: 1 }], videos: ["https://www.youtube.com/watch?v=abc"], method: "mixed", warnings: ["no-price"], status: "ok", ...extra,
  };
}

const matched: ListingImport = {
  ok: true,
  draft: draft(),
  match: { verdict: "match", reason: "match", parcel: { regridUuid: "uuid-1", path: "/us/co/costilla/1", apn: "70310050", county: "Costilla", state: "CO", adminId: "08023", centroid: { lat: 37.1, lon: -105.4 } }, onFabrica: null },
};

const GO_LINK = "https://fabrica.land/go?lat=37.100000&lon=-105.400000&parcel=uuid-1&apn=70310050&path=%2Fus%2Fco%2Fcostilla%2F1";

type ParcelAnswer = Awaited<ReturnType<typeof findParcel>>;
const PARCEL: ParcelCandidate = { address: "County Road 12", place: "Costilla, CO", apn: "70310050", state: "CO", county: "Costilla", regridPath: "/us/co/costilla/1", onFabrica: null };
/** find_us_parcel's answer for one parcel, as the search returns it: the add link unless the parcel is on Fabrica already. */
function parcelFound(parcel: ParcelCandidate = PARCEL, extra: { coverage?: { status: CoverageStatus; asOf: string }; note?: string } = {}): ParcelAnswer {
  const note = extra.note ?? (parcel.onFabrica ? "This parcel is on Fabrica. get_land_property with the tokenId returns its record." : "The link opens the page to add this parcel to Fabrica.");
  if (parcel.onFabrica) return { network: "Ethereum mainnet", query: parcel.apn ?? parcel.address, match: "single", parcel, note };
  return { network: "Ethereum mainnet", query: parcel.apn ?? parcel.address, match: "single", parcel, links: { addToFabrica: GO_LINK }, ...(extra.coverage ? { coverage: extra.coverage } : {}), note };
}
function parcelAmbiguous(candidates: ParcelCandidate[]): ParcelAnswer {
  return { network: "Ethereum mainnet", query: candidates[0].address, match: "ambiguous", candidates, note: "Several parcels match." };
}

beforeEach(() => {
  vi.mocked(getAccountProfile).mockReset().mockResolvedValue({ email: "owner@example.com", kycStatus: null, wallets: [{ address: WALLET, kind: "embedded" }] });
  vi.mocked(getOnRampRecord).mockReset();
  vi.mocked(startOnRamp).mockReset().mockResolvedValue(record());
  vi.mocked(patchOnRamp).mockReset();
  vi.mocked(importListing).mockReset().mockResolvedValue(matched);
  vi.mocked(findParcel).mockReset().mockResolvedValue(parcelFound());
});
afterEach(() => vi.unstubAllEnvs());

describe("add_land from a listing link", () => {
  it("starts the property as the connected person with the listing's words and photos, and asks for the owner next", async () => {
    const result = await addLand({ listingUrl: "https://www.landwatch.com/lot/1" }, auth());
    expect(result.error).toBeUndefined();
    expect(result.started).toBe(true);
    expect(result.listing).toMatchObject({ title: "5 acres in Costilla", priceUsd: 12000, photos: 2, videos: 1 });
    const [, body] = vi.mocked(startOnRamp).mock.calls[0];
    expect(body).toMatchObject({ vendor: "regrid", vendorId: "uuid-1", country: "US", adminId: "08023", propertyId: "70310050", lat: 37.1, lon: -105.4, walletAddress: WALLET, email: "owner@example.com", userDescription: "Quiet lot with road access." });
    // The http photo is left out; the video follows the photos.
    expect(body.media).toEqual([{ source: "https://img.example/1.jpg", type: "image", order: "0" }, { source: "https://www.youtube.com/watch?v=abc", type: "video", order: "1" }]);
    expect(result.questions?.map((q) => q.key)).toEqual(["Is the parcel improved?", "Describe the improvements"]);
    expect(result.questions?.[1].requiredNow).toBe(false);
    expect(result.notes.at(-1)).toMatch(/who holds title on the deed/);
    expect(result.notes.at(-1)).toMatch(/Is the parcel improved\?/);
    expect(vi.mocked(importListing).mock.calls[0][1]).toBe(WALLET);
  });

  it("asks for sign-in before reading a listing, and names the grant when signed in without it", async () => {
    const anonymous = await addLand({ listingUrl: "https://www.landwatch.com/lot/1" });
    expect(anonymous.started).toBeUndefined();
    expect(anonymous.links?.addToFabrica).toBe("https://fabrica.land/go");
    expect(anonymous.notes.at(-1)).toMatch(/needs the person signed in/);
    expect(vi.mocked(importListing)).not.toHaveBeenCalled();
    expect(vi.mocked(startOnRamp)).not.toHaveBeenCalled();
    const parcelAnonymous = await addLand({ parcelNumber: "70310050", state: "CO", county: "Costilla" });
    expect(parcelAnonymous.links?.addToFabrica).toBe(GO_LINK);
    expect(parcelAnonymous.notes.at(-1)).toMatch(/Not signed in/);
    const readOnly = await addLand({ listingUrl: "https://www.landwatch.com/lot/1" }, auth(["profile:read", "onramp:read"]));
    expect(readOnly.notes.at(-1)).toMatch(/Start adding a property to your account/);
    expect(vi.mocked(startOnRamp)).not.toHaveBeenCalled();
  });

  it("reads the verdict for the named account, or the only one, and settles \"theirs\" by the person's own record when several are linked", async () => {
    await addLand({ listingUrl: "https://www.landwatch.com/lot/1" }, auth());
    expect(vi.mocked(importListing).mock.calls[0][1]).toBe(WALLET);
    vi.mocked(getAccountProfile).mockResolvedValue({ email: null, kycStatus: null, wallets: [{ address: WALLET }, { address: SECOND }] });
    await addLand({ listingUrl: "https://www.landwatch.com/lot/1", wallet: SECOND }, auth());
    expect(vi.mocked(importListing).mock.calls[1][1]).toBe(SECOND);
    vi.mocked(importListing).mockResolvedValue({ ...matched, match: { ...matched.match!, onFabrica: { kind: "premint-theirs", tokenId: "11", slug: null } } });
    vi.mocked(getOnRampRecord).mockResolvedValue(record());
    const own = await addLand({ listingUrl: "https://www.landwatch.com/lot/1" }, auth());
    expect(vi.mocked(importListing).mock.calls[2][1]).toBeNull();
    expect(own.started).toBe(false);
    expect(own.notes[0]).toMatch(/already being added by the connected account/);
    vi.mocked(getOnRampRecord).mockRejectedValue(new AccountApiError(403, "Not yours."));
    const notOwn = await addLand({ listingUrl: "https://www.landwatch.com/lot/1" }, auth());
    expect(notOwn.tokenId).toBe("11");
    expect(notOwn.notes[0]).toMatch(/Another account \(or by one of this account's other linked accounts/);
    expect(vi.mocked(startOnRamp)).toHaveBeenCalledTimes(2);
  });

  it("stops when the parcel is already on Fabrica, and continues the connected account's own record", async () => {
    vi.mocked(importListing).mockResolvedValue({ ...matched, match: { ...matched.match!, onFabrica: { kind: "minted-theirs", tokenId: "77", slug: null } } });
    const theirs = await addLand({ listingUrl: "https://www.landwatch.com/lot/1" }, auth());
    expect(theirs.tokenId).toBe("77");
    expect(theirs.notes[0]).toMatch(/held by another account/);
    expect(vi.mocked(startOnRamp)).not.toHaveBeenCalled();
    vi.mocked(importListing).mockResolvedValue({ ...matched, match: { ...matched.match!, onFabrica: { kind: "premint-mine", tokenId: "11", slug: null } } });
    vi.mocked(getOnRampRecord).mockResolvedValue(record());
    const mine = await addLand({ listingUrl: "https://www.landwatch.com/lot/1" }, auth());
    expect(mine.started).toBe(false);
    expect(mine.questions).toHaveLength(2);
    expect(mine.notes[0]).toMatch(/already being added by the connected account/);
  });

  it("returns the draft and the search page when the page names no parcel, and the web app's refusal as is", async () => {
    vi.mocked(importListing).mockResolvedValue({ ...matched, match: { verdict: "no-match", reason: "missing-apn", parcel: null, onFabrica: null } });
    const noParcel = await addLand({ listingUrl: "https://www.landwatch.com/lot/1" }, auth());
    expect(noParcel.listing?.title).toBe("5 acres in Costilla");
    expect(noParcel.links?.addToFabrica).toBe("https://fabrica.land/go");
    expect(noParcel.notes[0]).toMatch(/missing apn/);
    vi.mocked(importListing).mockResolvedValue({ ok: false, code: "RATE_LIMITED", error: "Too many listing links from here." });
    expect((await addLand({ listingUrl: "https://www.landwatch.com/lot/1" }, auth())).error).toBe("Too many listing links from here.");
  });

  it("retries without photos when the API refuses a photo entry, and passes other refusals on", async () => {
    vi.mocked(startOnRamp).mockRejectedValueOnce(new AccountApiError(400, "Fabrica did not accept this: media.0.source must be an image.")).mockResolvedValueOnce(record());
    const result = await addLand({ listingUrl: "https://www.landwatch.com/lot/1" }, auth());
    expect(result.started).toBe(true);
    expect(vi.mocked(startOnRamp).mock.calls[1][1].media).toBeUndefined();
    expect(result.notes).toContainEqual(expect.stringMatching(/photos were not accepted/));
    vi.mocked(startOnRamp).mockReset().mockRejectedValue(new AccountApiError(429, "Fabrica refused this for now: OAuth on-ramp starts are limited to 3 per account per UTC day."));
    const limited = await addLand({ listingUrl: "https://www.landwatch.com/lot/1" }, auth());
    expect(limited.error).toMatch(/limited to 3/);
    expect(limited.links?.addToFabrica).toBe(GO_LINK);
  });
});

describe("add_land from a parcel number or an address", () => {
  it("needs state and county with a parcel number and exactly one way in", async () => {
    expect((await addLand({ parcelNumber: "70310050" }, auth())).error).toMatch(/state and county/);
    expect((await addLand({ address: "1 Main St", listingUrl: "https://x.example/1" }, auth())).error).toMatch(/exactly one/);
    expect((await addLand({}, auth())).error).toMatch(/exactly one/);
  });

  it("starts the parcel find_us_parcel resolved, from its add-to-Fabrica link", async () => {
    const result = await addLand({ parcelNumber: "70310050", state: "CO", county: "Costilla" }, auth());
    expect(vi.mocked(findParcel)).toHaveBeenCalledWith({ query: "70310050", state: "CO", county: "Costilla" });
    expect(result.started).toBe(true);
    const [, body] = vi.mocked(startOnRamp).mock.calls[0];
    expect(body).toMatchObject({ vendorId: "uuid-1", adminId: "08023", propertyId: "70310050", lat: 37.1, lon: -105.4, clientInput: "70310050" });
    expect(body.media).toBeUndefined();
    expect(result.listing).toBeUndefined();
  });

  it("hands over the link without starting when the county is not supported online", async () => {
    vi.mocked(findParcel).mockResolvedValue(parcelFound(PARCEL, { coverage: { status: "unsupported", asOf: "2026-10" }, note: "n" }));
    const result = await addLand({ parcelNumber: "70310050", state: "CO", county: "Costilla" }, auth());
    expect(result.started).toBeUndefined();
    expect(result.links?.addToFabrica).toBe(GO_LINK);
    expect(result.notes[0]).toMatch(/cannot be added to Fabrica online yet/);
    expect(vi.mocked(startOnRamp)).not.toHaveBeenCalled();
  });

  it("lists the candidates when several parcels fit, and stops on one already on Fabrica", async () => {
    vi.mocked(findParcel).mockResolvedValue(parcelAmbiguous([{ address: "1 Main St", place: "A", apn: "1", state: "CO", county: "X", regridPath: "/us/co/x/1", onFabrica: null }]));
    const several = await addLand({ address: "1 Main St" }, auth());
    expect(several.candidates).toHaveLength(1);
    expect(vi.mocked(startOnRamp)).not.toHaveBeenCalled();
    vi.mocked(findParcel).mockResolvedValue(parcelFound({ address: "1 Main St", place: "A", apn: "1", state: "CO", county: "X", regridPath: "/us/co/x/1", onFabrica: { tokenId: "5", name: null, slug: null, propertyLink: "https://fabrica.land/property/ethereum/5" } }, { note: "On Fabrica." }));
    vi.mocked(getOnRampRecord).mockResolvedValue(null);
    const taken = await addLand({ address: "1 Main St" }, auth());
    expect(taken.tokenId).toBe("5");
    expect(taken.links?.property).toBe("https://fabrica.land/property/ethereum/5");
    expect(vi.mocked(getOnRampRecord)).toHaveBeenCalledWith(expect.anything(), "5");
    // The person's own record, being added: the retry continues it with the county's questions.
    vi.mocked(getOnRampRecord).mockResolvedValue(record({ tokenId: "5" }));
    const own = await addLand({ address: "1 Main St" }, auth());
    expect(own.started).toBe(false);
    expect(own.tokenId).toBe("5");
    expect(own.questions?.map((q) => q.key)).toEqual(["Is the parcel improved?", "Describe the improvements"]);
    expect(own.notes[0]).toMatch(/already being added by the connected account/);
    const anonymous = await addLand({ address: "1 Main St" });
    expect(anonymous.questions).toBeUndefined();
    expect(anonymous.links?.property).toBe("https://fabrica.land/property/ethereum/5");
  });

  it("asks which linked account holds the property when several are linked, and checks a named one", async () => {
    vi.mocked(getAccountProfile).mockResolvedValue({ email: null, kycStatus: null, wallets: [{ address: WALLET }, { address: SECOND }] });
    const ask = await addLand({ address: "County Road 12" }, auth());
    expect(ask.accountWallets).toEqual([WALLET, SECOND]);
    expect(vi.mocked(startOnRamp)).not.toHaveBeenCalled();
    const wrong = await addLand({ address: "County Road 12", wallet: "0x1111111111111111111111111111111111111111" }, auth());
    expect(wrong.error).toMatch(/not an account linked/);
    const chosen = await addLand({ address: "County Road 12", wallet: SECOND.toLowerCase() }, auth());
    expect(chosen.started).toBe(true);
    expect(vi.mocked(startOnRamp).mock.calls[0][1].walletAddress).toBe(SECOND);
  });
});

describe("answer_adding_questions", () => {
  it("saves the owner and the answers and reports what the county still asks", async () => {
    vi.mocked(getOnRampRecord).mockResolvedValue(record());
    vi.mocked(patchOnRamp).mockResolvedValue(record({ grantors: [{ name: "Sam Owner", kind: "individual", role: null }], collectedFields: { "Is the parcel improved?": "Yes" } }));
    const result = await answerAddingQuestions(auth(), { tokenId: "11", owner: { kind: "individual", firstName: "Sam", lastName: "Owner", email: "sam@example.com" }, answers: { "Is the parcel improved?": "Yes" } });
    expect(result.error).toBeUndefined();
    const [, tokenId, body] = vi.mocked(patchOnRamp).mock.calls[0];
    expect(tokenId).toBe("11");
    expect(body.grantors).toEqual([{ signerType: "individual", firstName: "Sam", lastName: "Owner", fullName: "Sam Owner", email: "sam@example.com" }]);
    expect(body.collectedFields).toEqual({ "Is the parcel improved?": "Yes" });
    expect(result.questions?.[1]).toMatchObject({ key: "Describe the improvements", requiredNow: true, answer: null });
    expect(result.notes[0]).toMatch(/still asks: Describe the improvements/);
  });

  it("refuses an answer the county does not ask or a choice off the list, before anything is sent", async () => {
    vi.mocked(getOnRampRecord).mockResolvedValue(record());
    const unknown = await answerAddingQuestions(auth(), { tokenId: "11", answers: { Color: "blue" } });
    expect(unknown.error).toMatch(/"Color" is not one of the county's questions/);
    const off = await answerAddingQuestions(auth(), { tokenId: "11", answers: { "Is the parcel improved?": "Maybe" } });
    expect(off.error).toMatch(/takes one of: "Yes", "No"/);
    expect(vi.mocked(patchOnRamp)).not.toHaveBeenCalled();
  });

  it("needs the grant, something to save, and a record of the connected account's", async () => {
    expect((await answerAddingQuestions(auth(["onramp:read"]), { tokenId: "11", email: "a@b.co" })).error).toMatch(/Start adding a property/);
    expect((await answerAddingQuestions(auth(), { tokenId: "11" })).error).toMatch(/nothing to save/);
    vi.mocked(getOnRampRecord).mockResolvedValue(null);
    expect((await answerAddingQuestions(auth(), { tokenId: "11", email: "a@b.co" })).error).toMatch(/not a property this account is adding/);
  });
});

describe("the owner as the API's signer", () => {
  it("builds an individual, an entity with its signer, and several people", () => {
    expect(grantorOf({ kind: "individual", firstName: " Sam ", middleName: "J", lastName: "Owner", email: "sam@example.com" })).toEqual({
      grantor: { signerType: "individual", firstName: "Sam", middleName: "J", lastName: "Owner", fullName: "Sam J Owner", email: "sam@example.com" },
    });
    expect(grantorOf({ kind: "entity", entityName: "Owner LLC", entityType: "Limited Liability Company", entityJurisdiction: "US-tx", firstName: "Sam", lastName: "Owner", email: "sam@example.com", role: "Manager" })).toEqual({
      grantor: { signerType: "entity", name: "Owner LLC", type: "Limited Liability Company", jurisdiction: "US-tx", signers: [{ signerType: "individual", firstName: "Sam", lastName: "Owner", fullName: "Sam Owner", email: "sam@example.com", role: "Manager" }] },
    });
    const two = grantorOf({ kind: "multiple", qualifier: "husband and wife", people: [{ firstName: "A", lastName: "B", email: "a@x.co" }, { firstName: "C", lastName: "D", email: "c@x.co" }] });
    expect(two).toMatchObject({ grantor: { signerType: "concurrent", qualifier: "husband and wife" } });
  });

  it("says what is missing, and wants one email per person", () => {
    expect(grantorOf({ kind: "individual", firstName: "Sam" })).toMatchObject({ error: expect.stringMatching(/firstName, lastName, email/) });
    expect(grantorOf({ kind: "entity", entityName: "Owner LLC" })).toMatchObject({ error: expect.stringMatching(/person who signs for it/) });
    expect(grantorOf({ kind: "entity", entityName: "Owner LLC", firstName: "Sam", lastName: "Owner", email: "sam@example.com" })).toMatchObject({ error: expect.stringMatching(/entityType, entityJurisdiction/) });
    expect(grantorOf({ kind: "entity", entityName: "Owner LLC", entityType: "Trust", entityJurisdiction: "US-tx", firstName: "Sam", lastName: "Owner", email: "sam@example.com" })).toHaveProperty("grantor");
    expect(grantorOf({ kind: "multiple", people: [{ firstName: "A", lastName: "B", email: "a@x.co" }, { firstName: "C", lastName: "D", email: "A@x.co" }], qualifier: "as joint tenants" })).toMatchObject({ error: expect.stringMatching(/own email/) });
    expect(grantorOf({ kind: "multiple", people: [{ firstName: "A", lastName: "B", email: "a@x.co" }, { firstName: "C", lastName: "D", email: "c@x.co" }] })).toMatchObject({ error: expect.stringMatching(/qualifier/) });
  });
});

describe("answers, content and links", () => {
  it("clears an answer with an empty string and keeps a select verbatim", () => {
    expect(checkAnswers(record(), { "Is the parcel improved?": "No", "Describe the improvements": "" })).toEqual({ collectedFields: { "Is the parcel improved?": "No", "Describe the improvements": null } });
    expect(checkAnswers(record({ questions: [] }), { x: "1" })).toMatchObject({ error: expect.stringMatching(/asks none/) });
  });

  it("cuts a long description at a word and caps the photos", () => {
    const long = draft({ description: `${"word ".repeat(1_200)}end`, photos: Array.from({ length: 25 }, (_, i) => ({ url: `https://img.example/${i}.jpg`, order: i })), videos: [] });
    const content = startContent(long);
    expect(content.userDescription!.length).toBeLessThanOrEqual(5_000);
    expect(content.userDescription!.endsWith("word")).toBe(true);
    expect(content.media).toHaveLength(20);
    expect(startContent(draft({ description: "  ", photos: [], videos: [] }))).toEqual({});
  });

  it("reads a start target back from the add-to-Fabrica link, or none without the parcel id or county", () => {
    expect(targetFromGoLink(GO_LINK, "q")).toEqual({ regridUuid: "uuid-1", path: "/us/co/costilla/1", apn: "70310050", adminId: "08023", lat: 37.1, lon: -105.4, clientInput: "q" });
    expect(targetFromGoLink("https://fabrica.land/go?apn=1&path=%2Fus%2Fco%2Fcostilla%2F1", "q")).toBeNull();
    expect(targetFromGoLink("https://fabrica.land/go?parcel=u&apn=1&path=%2Fus%2Fzz%2Fnowhere%2F1", "q")).toBeNull();
    expect(targetFromGoLink("not a url", "q")).toBeNull();
  });

  it("says the owner's details are in once the required answers are", () => {
    const done = record({ grantors: [{ name: "Sam", kind: "individual", role: null }], collectedFields: { "Is the parcel improved?": "No" } });
    expect(nextNote(done)).toMatch(/details are in/);
  });
});
