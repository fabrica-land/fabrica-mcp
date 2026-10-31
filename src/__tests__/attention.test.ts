import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../clients/graphql.js", () => ({ getToken: vi.fn(), getScoreRecord: vi.fn(), getTaxStatusToken: vi.fn(), isTokenNotFound: vi.fn() }));
vi.mock("../clients/account.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../clients/account.js")>();
  return { ...actual, getAccountProfile: vi.fn() };
});
vi.mock("../tools/account.js", () => ({ getMyProperties: vi.fn() }));
vi.mock("../tools/my-loans.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../tools/my-loans.js")>()), getMyLoans: vi.fn() }));
vi.mock("../tools/offers.js", () => ({ getMyOffers: vi.fn() }));
vi.mock("../tools/onramps.js", () => ({ getMyOnRamps: vi.fn() }));

import { getScoreRecord, getToken } from "../clients/graphql.js";
import { AccountApiError, getAccountProfile } from "../clients/account.js";
import { getMyProperties, type MyPropertiesResult, type MyPropertyRow } from "../tools/account.js";
import { getMyLoans, type MyLoansResult } from "../tools/my-loans.js";
import { getMyOffers, type MyOffersResult } from "../tools/offers.js";
import { getMyOnRamps, type MyOnRampsResult } from "../tools/onramps.js";
import { ATTENTION_TOKEN_BUDGET, whatNeedsAttention } from "../tools/attention.js";
import type { AccountAuth } from "../auth/token.js";
import { tokenDetail } from "./fixtures.js";

const AUTH: AccountAuth = { token: "t", subject: "s", clientId: "c", scopes: ["portfolio:read", "onramp:read"], expiresAt: 4102444800 };
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const CHECKS_OK = [
  { checkName: "propertyTaxesCurrent", group: "g", title: "t", value: true },
  { checkName: "feesInGoodStanding", group: "g", title: "t", value: true },
  { checkName: "ownerHasVerifiedContact", group: "g", title: "t", value: true },
];

function scoreRecord(checks: Record<string, number | boolean | null>) {
  return { checks, updatedAt: "2026-10-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z" };
}
const RECORD_OK = scoreRecord({ propertyTaxesCurrent: 1, feesInGoodStanding: 1, ownerHasVerifiedContact: 1 });

function propertyRow(tokenId: string): MyPropertyRow {
  return { tokenId, name: `Lot ${tokenId}`, location: { state: "CO", county: "Costilla" }, acres: 5, stage: "live", status: "Live on Fabrica", listingPrice: null, offersWaiting: 0, underLoan: false, propertyChecks: 73242, estimatedValue: null, links: { property: `https://fabrica.land/property/ethereum/${tokenId}` } };
}

function properties(rows: MyPropertyRow[]): MyPropertiesResult {
  return { network: "Ethereum Mainnet", wallets: [], totals: { properties: rows.length, beingAdded: 0, live: rows.length, listed: 0, offersWaiting: 0, underLoan: 0, totalAcres: 0, estimatedValueOfLive: "$0" }, properties: rows, notes: [] };
}

const NO_LOANS: MyLoansResult = { network: "Ethereum Mainnet", totals: { activeTaken: 0, maturingSoon: 0, activeMade: 0, deposits: 0 }, taken: [], made: [], deposits: [], history: { total: 0, active: 0, repaid: 0, defaulted: 0, liquidated: 0 }, notes: [] };
const NO_OFFERS: MyOffersResult = { network: "Ethereum Mainnet", showing: "", totals: { received: 0, made: 0, expiringSoon: 0 }, received: [], made: [], notes: [] };
const NO_ONRAMPS: MyOnRampsResult = { network: "Ethereum Mainnet", totals: { inProgress: 0, waitingOnYou: 0, finished: 0 }, onRamps: [], notes: [] };

beforeEach(() => {
  vi.mocked(getAccountProfile).mockReset().mockResolvedValue({ email: null, kycStatus: null, wallets: [{ address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", kind: "embedded" }] });
  vi.mocked(getMyLoans).mockReset().mockResolvedValue(NO_LOANS);
  vi.mocked(getMyOffers).mockReset().mockResolvedValue(NO_OFFERS);
  vi.mocked(getMyOnRamps).mockReset().mockResolvedValue(NO_ONRAMPS);
  vi.mocked(getMyProperties).mockReset().mockResolvedValue(properties([propertyRow("1")]));
  vi.mocked(getToken).mockReset().mockResolvedValue(tokenDetail({ tokenId: "1", score: 73242, scoringCheckResults: CHECKS_OK }));
  vi.mocked(getScoreRecord).mockReset().mockResolvedValue(RECORD_OK);
});

describe("what_needs_attention", () => {
  it("ranks an expiring offer, an on-ramp waiting on the deed and a fee to approve, in that order", async () => {
    vi.mocked(getMyOffers).mockResolvedValue({
      ...NO_OFFERS,
      totals: { received: 1, made: 0, expiringSoon: 1 },
      received: [{ tokenId: "1", name: "Lot 1", underLoan: false, links: { respond: "https://fabrica.land/property/ethereum/1" }, offers: [{
        price: "$12,000", amount: "12,000 USDC", status: "active", buyer: "0xbbbb...bbbb", supply: "1", startsAt: "2026-10-01T00:00:00Z", expiresAt: "2026-10-26T00:00:00Z", expires: "in 2 days", orderId: "0x1", expiringSoon: true,
      }] }],
    });
    vi.mocked(getMyOnRamps).mockResolvedValue({
      ...NO_ONRAMPS,
      totals: { inProgress: 2, waitingOnYou: 1, finished: 0 },
      onRamps: [
        { tokenId: "9", property: { address: "County Road 12", county: "Costilla", state: "CO", parcelNumber: "7" }, status: "Being added to Fabrica", stepsDone: "0 of 9", nextStep: { step: "Details", who: "You", what: "Upload the deed", link: "https://fabrica.land/go?token-id=9", expectedBy: null }, missingDetails: [], startedAt: null, updatedAt: null, links: { property: "x" } },
        { tokenId: "8", property: { address: null, county: null, state: null, parcelNumber: null }, status: "Being added to Fabrica", stepsDone: "4 of 9", nextStep: { step: "Review", who: "Fabrica", what: "Review", link: "x", expectedBy: null }, missingDetails: [], startedAt: null, updatedAt: null, links: { property: "x" } },
      ],
    });
    vi.mocked(getToken).mockResolvedValue(tokenDetail({ tokenId: "1", scoringCheckResults: CHECKS_OK, fees: { totalAmount: "500000000", fees: [{ type: "OnRamp", createdAt: "2026-10-01T00:00:00Z", currency: USDC, amount: "500000000", approved: false, approvedAt: null, paid: false, paidAt: null }] } }));

    const result = await whatNeedsAttention(AUTH);
    expect(result.items.map((item) => item.kind)).toEqual(["offer", "adding", "fee"]);
    expect(result.items[0]).toMatchObject({ dueBy: "2026-10-26T00:00:00Z", link: "https://fabrica.land/property/ethereum/1", whoActs: "You" });
    expect(result.items[1]).toMatchObject({ title: expect.stringContaining("Upload the deed"), link: "https://fabrica.land/go?token-id=9" });
    expect(result.items[2]).toMatchObject({ title: "Approve the fee on Lot 1", why: "$500 waiting on your approval.", link: "https://fabrica.land/property/ethereum/1?action=approve_fee" });
  });

  it("puts a loan past maturity first and flags checks that failed", async () => {
    vi.mocked(getMyLoans).mockResolvedValue({ ...NO_LOANS, taken: [{ loanId: "L", property: { tokenId: "1", name: "Lot 1" }, status: "Active", provider: null, principal: null, apr: null, duration: "30 days", startedAt: "", maturityDate: "2026-10-20T00:00:00Z", daysToMaturity: -4, maturingSoon: true, payoffToday: "5,000 USDC", links: { property: "p" } }] });
    vi.mocked(getToken).mockResolvedValue(tokenDetail({ tokenId: "1", score: 63242, scoringCheckResults: [{ checkName: "propertyTaxesCurrent", group: "g", title: "t", value: false }, { checkName: "ownerHasVerifiedContact", group: "g", title: "t", value: false }] }));
    vi.mocked(getScoreRecord).mockResolvedValue(scoreRecord({ propertyTaxesCurrent: 0, feesInGoodStanding: 1, ownerHasVerifiedContact: 0 }));
    const result = await whatNeedsAttention(AUTH);
    expect(result.items[0]).toMatchObject({ kind: "loan", title: expect.stringContaining("past its maturity") });
    const titles = result.items.map((item) => item.title).join(" | ");
    expect(titles).toContain("taxes on Lot 1 look past due");
    expect(titles).toContain("No verified contact");
    expect(titles).toContain("Recovery pending");
  });

  it("calls taxes never verified unverified, not past due, though the check list says false", async () => {
    vi.mocked(getToken).mockResolvedValue(tokenDetail({ tokenId: "1", score: 73242, scoringCheckResults: CHECKS_OK.map((check) => ({ ...check, value: false })) }));
    vi.mocked(getScoreRecord).mockResolvedValue(scoreRecord({ propertyTaxesCurrent: null, feesInGoodStanding: null, ownerHasVerifiedContact: null }));
    const titles = (await whatNeedsAttention(AUTH)).items.map((item) => item.title);
    expect(titles).toEqual(["Property taxes on Lot 1 are not verified"]);
  });

  it("never gives an all-clear when the Property checks record cannot be read", async () => {
    vi.mocked(getScoreRecord).mockRejectedValue(new Error("API down"));
    const result = await whatNeedsAttention(AUTH);
    expect(result.items).toEqual([]);
    expect(result.notes.join(" ")).toContain("Property checks could not be read right now for 1 property");
    expect(result.notes.at(-1)).toContain("not everything could be read");
  });

  it("keeps a defaulted loan that can still be paid off on the list", async () => {
    vi.mocked(getMyLoans).mockResolvedValue({ ...NO_LOANS, taken: [{ loanId: "D", property: { tokenId: "2", name: "Lot 2" }, status: "Default", provider: null, principal: null, apr: null, duration: "30 days", startedAt: "", maturityDate: "2026-10-22T00:00:00Z", daysToMaturity: -2, maturingSoon: true, payoffToday: "5,000 USDC", links: { property: "p" } }] });
    const result = await whatNeedsAttention(AUTH);
    expect(result.items[0]).toMatchObject({ kind: "loan", tokenId: "2", title: expect.stringContaining("past its maturity") });
  });

  it("says what it checked when nothing is waiting", async () => {
    const result = await whatNeedsAttention(AUTH);
    expect(result.items).toEqual([]);
    expect(result.checked).toHaveLength(4);
    expect(result.notes.at(-1)).toContain("Nothing is waiting on this account. Checked:");
  });

  it("never gives an all-clear while the API does not serve the account", async () => {
    vi.mocked(getAccountProfile).mockResolvedValue(null);
    const result = await whatNeedsAttention(AUTH);
    expect(result.items).toEqual([]);
    expect(result.checked).toEqual([]);
    expect(result.notes.join(" ")).not.toContain("Nothing is waiting");
    expect(result.notes[0]).toContain("does not serve account details yet");
    expect(vi.mocked(getMyLoans)).not.toHaveBeenCalled();
  });

  it("passes a revoked connection through", async () => {
    vi.mocked(getAccountProfile).mockRejectedValue(new AccountApiError(401, "Fabrica no longer accepts this connection"));
    expect((await whatNeedsAttention(AUTH)).notes[0]).toContain("no longer accepts");
  });

  it("says when only part of the account could be read", async () => {
    vi.mocked(getMyLoans).mockResolvedValue({ ...NO_LOANS, error: "Fabrica API could not be reached." });
    const result = await whatNeedsAttention(AUTH);
    expect(result.notes.join(" ")).not.toContain("Nothing is waiting on this account");
    expect(result.notes.at(-1)).toContain("not everything could be read");
  });

  it("keeps what other parts found when one read throws", async () => {
    vi.mocked(getMyLoans).mockRejectedValue(new Error("GraphQL down"));
    vi.mocked(getMyOnRamps).mockResolvedValue({ ...NO_ONRAMPS, totals: { inProgress: 1, waitingOnYou: 1, finished: 0 }, onRamps: [{ tokenId: "9", property: { address: "Road 1", county: "Costilla", state: "CO", parcelNumber: null }, status: "Being added to Fabrica", stepsDone: "0 of 3", nextStep: { step: "Details", who: "You", what: "Upload the deed", link: "l", expectedBy: null }, missingDetails: [], startedAt: null, updatedAt: null, links: { property: "p" } }] });
    const result = await whatNeedsAttention(AUTH);
    expect(result.items.map((item) => item.kind)).toEqual(["adding"]);
    expect(result.notes.join(" ")).toContain("Loans could not be read right now");
  });

  it("checks at most the budget of properties and says how many were left", async () => {
    vi.mocked(getMyProperties).mockResolvedValue(properties(Array.from({ length: ATTENTION_TOKEN_BUDGET + 3 }, (_, i) => propertyRow(String(i + 1)))));
    const result = await whatNeedsAttention(AUTH);
    expect(vi.mocked(getToken)).toHaveBeenCalledTimes(ATTENTION_TOKEN_BUDGET);
    expect(result.notes.join(" ")).toContain("And 3 more properties not checked");
  });

  it("skips what the connection was not granted", async () => {
    const result = await whatNeedsAttention({ ...AUTH, scopes: ["onramp:read"] });
    expect(vi.mocked(getMyLoans)).not.toHaveBeenCalled();
    expect(result.notes[0]).toContain("portfolio:read");
  });
});
