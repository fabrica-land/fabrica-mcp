import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../clients/graphql.js", () => ({ getPremintSuccessor: vi.fn() }));
vi.mock("../clients/account.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../clients/account.js")>();
  return { ...actual, getAccountProfile: vi.fn(), getOnRampsForWallet: vi.fn(), getOnRampRecord: vi.fn() };
});

import { getPremintSuccessor } from "../clients/graphql.js";
import { AccountApiError, getAccountProfile, getOnRampRecord, getOnRampsForWallet, type OnRampRecord, type OnRampStep } from "../clients/account.js";
import { getMyOnRamps, getOnRampStatus } from "../tools/onramps.js";
import type { AccountAuth } from "../auth/token.js";

const WALLET = "0xAaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAA";

function auth(scopes: string[] = ["onramp:read"]): AccountAuth {
  return { token: "t", subject: "s", clientId: "c", scopes, expiresAt: 4102444800 };
}

function step(order: number, key: string, status: OnRampStep["status"], extra: Partial<OnRampStep> = {}): OnRampStep {
  return { order, key, status, text: `${key} text`, textCompleted: `${key} done`, visible: true, expectedCompletion: null, completed: null, userActions: [], ...extra };
}

function record(tokenId: string, steps: OnRampStep[], extra: Partial<OnRampRecord> = {}): OnRampRecord {
  return {
    tokenId,
    status: "premint",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
    address: "County Road 12",
    county: "Costilla",
    state: "CO",
    parcelNumber: "70310050",
    missingRequiredFields: [],
    steps,
    collectedFields: { deedBook: "12" },
    grantors: [{ name: "Sam Owner", kind: "individual", role: null }],
    ...extra,
  };
}

const waitingOnDeed = record("11", [
  step(1, "CollectInfoFromUser", "in-progress", { userActions: [{ label: "Upload", prompt: "Upload the deed", detail: null, url: "https://fabrica.land/upload/abc" }] }),
  step(2, "GetFeeApproval", "not-started"),
], { missingRequiredFields: ["deedUpload"], updatedAt: "2026-10-05T00:00:00.000Z" });
const inReview = record("22", [
  step(1, "CollectInfoFromUser", "complete"),
  step(2, "GetFeeApproval", "complete"),
  step(3, "PropertyResearch", "complete"),
  step(4, "ResearchReview", "in-progress", { expectedCompletion: "2026-11-01T00:00:00.000Z" }),
  step(5, "Hidden", "not-started", { visible: false }),
], { updatedAt: "2026-10-20T00:00:00.000Z" });
const minted = record("33", [step(1, "CollectInfoFromUser", "complete"), step(2, "Minting", "complete")], { status: "minted" });

beforeEach(() => {
  vi.mocked(getAccountProfile).mockReset();
  vi.mocked(getOnRampsForWallet).mockReset();
  vi.mocked(getOnRampRecord).mockReset();
  vi.mocked(getPremintSuccessor).mockReset().mockResolvedValue(null);
  vi.mocked(getAccountProfile).mockResolvedValue({ email: null, kycStatus: null, wallets: [{ address: WALLET, kind: "embedded" }] });
});

describe("get_my_onramps", () => {
  it("shows one waiting on the owner's deed upload and one in Fabrica review, owner's first", async () => {
    vi.mocked(getOnRampsForWallet).mockResolvedValue([inReview, waitingOnDeed]);
    const result = await getMyOnRamps(auth());
    expect(result.error).toBeUndefined();
    expect(result.onRamps.map((row) => row.tokenId)).toEqual(["11", "22"]);
    expect(result.onRamps[0].nextStep).toMatchObject({ who: "You", what: "Upload the deed", link: expect.stringContaining("/go?token-id=11") });
    expect(result.onRamps[0].missingDetails).toEqual(["deedUpload"]);
    expect(result.onRamps[1].nextStep).toMatchObject({ who: "Fabrica", expectedBy: "2026-11-01T00:00:00.000Z" });
    expect(result.onRamps[1].stepsDone).toBe("3 of 4");
    expect(result.totals).toEqual({ inProgress: 2, waitingOnYou: 1, finished: 0 });
    expect(vi.mocked(getOnRampsForWallet)).toHaveBeenCalledWith(expect.anything(), WALLET.toLowerCase());
  });

  it("leaves owners' names and entered details out of the list", async () => {
    vi.mocked(getOnRampsForWallet).mockResolvedValue([waitingOnDeed]);
    const result = await getMyOnRamps(auth());
    const text = JSON.stringify(result);
    expect(text).not.toContain("Sam Owner");
    expect(text).not.toContain("deedBook");
    expect(text).not.toContain("upload/abc");
  });

  it("shows the live token a premint became", async () => {
    vi.mocked(getOnRampsForWallet).mockResolvedValue([minted, record("44", [step(1, "Minting", "in-progress")])]);
    vi.mocked(getPremintSuccessor).mockImplementation(async (id) => (id === "44" ? "4400" : null));
    const result = await getMyOnRamps(auth());
    const byId = Object.fromEntries(result.onRamps.map((row) => [row.tokenId, row]));
    expect(byId["44"]).toMatchObject({ liveTokenId: "4400", status: "Live on Fabrica", nextStep: null, links: { property: expect.stringContaining("/4400") } });
    expect(byId["33"]).toMatchObject({ liveTokenId: "33", nextStep: null });
    expect(result.totals.finished).toBe(2);
  });

  it("says the fee approval is the owner's and links the approval page", async () => {
    vi.mocked(getOnRampsForWallet).mockResolvedValue([record("55", [step(1, "CollectInfoFromUser", "complete"), step(2, "GetFeeApproval", "in-progress")])]);
    const [row] = (await getMyOnRamps(auth())).onRamps;
    expect(row.nextStep).toMatchObject({ who: "You", link: expect.stringContaining("/55?action=approve_fee") });
  });

  it("keeps the notarized signature the owner's own step", async () => {
    vi.mocked(getOnRampsForWallet).mockResolvedValue([record("66", [step(1, "SignAndNotarize", "not-started")])]);
    const [row] = (await getMyOnRamps(auth())).onRamps;
    expect(row.nextStep?.who).toBe("You");
    expect(row.nextStep?.note).toContain("cannot be completed through this connection");
  });

  it("flags a failed step as Fabrica's problem", async () => {
    vi.mocked(getOnRampsForWallet).mockResolvedValue([record("77", [step(1, "PropertyResearch", "failed")])]);
    const [row] = (await getMyOnRamps(auth())).onRamps;
    expect(row.nextStep).toMatchObject({ who: "Fabrica", problem: true });
  });

  it("needs onramp:read and reads nothing without it", async () => {
    const result = await getMyOnRamps(auth(["profile:read"]));
    expect(result.notes[0]).toContain("onramp:read");
    expect(vi.mocked(getAccountProfile)).not.toHaveBeenCalled();
  });

  it("passes a revoked connection through as an error", async () => {
    vi.mocked(getOnRampsForWallet).mockRejectedValue(new AccountApiError(401, "Fabrica no longer accepts this connection"));
    expect((await getMyOnRamps(auth())).error).toContain("no longer accepts");
  });
});

describe("get_onramp_status", () => {
  it("gives every visible step, the open actions with links, and what the owner entered", async () => {
    vi.mocked(getOnRampRecord).mockResolvedValue(waitingOnDeed);
    const result = await getOnRampStatus(auth(), { tokenId: "11" });
    expect(result.steps?.map((s) => s.status)).toEqual(["in-progress", "not-started"]);
    expect(result.actions).toEqual([{ label: "Upload", prompt: "Upload the deed", detail: null, link: "https://fabrica.land/upload/abc" }]);
    expect(result.provided).toEqual({ owners: [{ name: "Sam Owner", kind: "individual", role: null }], details: { deedBook: "12" } });
  });

  it("answers only for this account's own on-ramps", async () => {
    vi.mocked(getOnRampRecord).mockResolvedValue(null);
    const result = await getOnRampStatus(auth(), { tokenId: "99" });
    expect(result.steps).toBeUndefined();
    expect(result.notes[0]).toContain("not a property this account is adding");
  });
});
