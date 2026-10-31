import { afterEach, describe, expect, it, vi } from "vitest";
import { getOnRampRecord, getOnRampsForWallet } from "../clients/account.js";
import type { AccountAuth } from "../auth/token.js";

const AUTH: AccountAuth = { token: "secret-token", subject: "s", clientId: "c", scopes: ["onramp:read"], expiresAt: 4102444800 };

const OWNER_VIEW = {
  tokenId: "11",
  status: "premint",
  district: "Costilla",
  regionCode: "CO",
  propertyId: "70310050",
  recipients: { "0x000000000000000000000000000000000000dEaD": "1" },
  collectedFields: { deedBook: "12", bad: 3 },
  grantors: [
    { signerType: "entity", name: "Owner LLC", type: "LLC", signers: [] },
    { signerType: "concurrent", qualifier: "joint", signers: [{ signerType: "individual", firstName: "A", lastName: "B", fullName: "A B" }] },
  ],
  steps: [
    { order: 2, key: "GetFeeApproval", status: "in-progress", text: "Approve", textCompleted: "Approved", visibility: true, userActions: [{ label: "Approve", prompt: "Approve the fee", url: "" }] },
    { order: 1, key: "CollectInfoFromUser", status: "complete", text: "Details", textCompleted: "Details in", visibility: true },
    { order: 3, key: "Weird", status: "unknown" },
  ],
};
// The API's non-owner read: no tokenId, no recipients.
const REDACTED_VIEW = { hasEmail: true, hasRecipients: true, status: "premint", steps: [] };

function respond(status: number, body: unknown): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })));
}

afterEach(() => vi.unstubAllGlobals());

describe("on-ramp reads", () => {
  it("parses the owner's view and sends the token only to the issuer's on-ramp route", async () => {
    respond(200, [OWNER_VIEW, REDACTED_VIEW]);
    const records = await getOnRampsForWallet(AUTH, "0xabc");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ tokenId: "11", county: "Costilla", parcelNumber: "70310050", collectedFields: { deedBook: "12" } });
    expect(records[0].steps.map((s) => s.key)).toEqual(["CollectInfoFromUser", "GetFeeApproval"]);
    expect(records[0].steps[1].userActions[0]).toEqual({ label: "Approve", prompt: "Approve the fee", detail: null, url: null });
    expect(records[0].grantors).toEqual([
      { name: "Owner LLC", kind: "entity", role: "LLC" },
      { name: "A B", kind: "concurrent", role: null },
    ]);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toMatch(/\/on-ramp\/(ethereum|sepolia)\/0x[0-9a-fA-F]{40}\?wallet=0xabc$/);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret-token");
  });

  it("treats the non-owner view of one on-ramp as not this account's", async () => {
    respond(200, REDACTED_VIEW);
    expect(await getOnRampRecord(AUTH, "11")).toBeNull();
  });

  it("maps a 403 to the missing grant", async () => {
    respond(403, { error: "insufficient_scope" });
    await expect(getOnRampRecord(AUTH, "11")).rejects.toThrow("onramp:read");
  });
});
