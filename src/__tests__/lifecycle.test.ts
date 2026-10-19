import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../clients/graphql.js", async () => {
  class FabricaApiError extends Error {
    readonly graphQLErrors: readonly string[];
    constructor(messages: readonly string[]) {
      super(messages.join("; "));
      this.graphQLErrors = messages;
    }
  }
  return {
    getToken: vi.fn(),
    getTokens: vi.fn(),
    getCountyBounds: vi.fn(),
    getPremintSuccessor: vi.fn(),
    DEFAULT_MIN_SCORE: 72032,
    filterSpamTokens: vi.fn((tokens: unknown[]) => tokens),
    FabricaApiError,
    isTokenNotFound: (e: unknown) => e instanceof FabricaApiError && e.graphQLErrors.some(m => m.includes("No token or premint found")),
    propertyLookupError: (e: unknown, lookup: { tokenId?: string; slug?: string }, action: string) =>
      e instanceof FabricaApiError && e.graphQLErrors.some(m => m.includes("No token or premint found"))
        ? `No property found with ${lookup.tokenId ? `token ID ${lookup.tokenId}` : `slug ${lookup.slug ?? ""}`}`
        : `Failed to ${action}: ${e instanceof Error ? e.message : String(e)}`,
  };
});

import { FabricaApiError, getPremintSuccessor, getToken, getTokens } from "../clients/graphql.js";
import { getProperty, searchProperties } from "../tools/properties.js";
import { propertyStage } from "../lifecycle.js";
import { formatFeeAmount, isoTime, summarizeFees } from "../fees.js";
import type { TokenModel } from "../types/index.js";
import { tokenDetail } from "./fixtures.js";

function token(overrides: Partial<TokenModel> = {}): TokenModel {
  return tokenDetail({ propertyLink: "https://fabrica.land/property/ethereum/12345", ...overrides });
}

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

beforeEach(() => vi.mocked(getToken).mockReset());

describe("propertyStage", () => {
  it("names every stage", () => {
    expect(propertyStage({ isPremint: true, isBurned: false, claimState: "UNCLAIMED" })).toBe("premint_unclaimed");
    expect(propertyStage({ isPremint: true, isBurned: false, claimState: "CLAIMED" })).toBe("premint_claimed");
    expect(propertyStage({ isPremint: true, isBurned: false, supersededByTokenId: "99" })).toBe("premint_superseded");
    expect(propertyStage({ isPremint: false, isBurned: false })).toBe("minted");
    expect(propertyStage({ isPremint: false, isBurned: false, offRampStatus: "in-progress" })).toBe("off_ramp_in_progress");
    expect(propertyStage({ isPremint: false, isBurned: false, offRampStatus: "complete" })).toBe("off_ramped");
    expect(propertyStage({ isPremint: false, isBurned: true, offRampStatus: "complete" })).toBe("burned");
  });
});

describe("fees", () => {
  it("formats USDC fee amounts as dollars and unknown currencies as raw units", () => {
    expect(formatFeeAmount("500000000", USDC)).toBe("$500");
    expect(formatFeeAmount("1250000", "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238")).toBe("$1.25");
    expect(formatFeeAmount("7", "0xdead")).toBe("7 (raw units of token 0xdead)");
  });

  it("normalizes epoch-millisecond timestamps to ISO 8601", () => {
    expect(isoTime("1764615012461")).toBe("2025-12-01T18:50:12.461Z");
    expect(isoTime("2025-08-28T17:33:47.699Z")).toBe("2025-08-28T17:33:47.699Z");
  });

  it("returns null without fees and lists state when there are some", () => {
    expect(summarizeFees({ totalAmount: "0", fees: [] }, "https://x")).toBeNull();
    const summary = summarizeFees({
      totalAmount: "1500000000",
      fees: [
        { type: "OnRamp", createdAt: "2026-10-08T05:49:42.371Z", currency: USDC, amount: "500000000", approved: false, approvedAt: null, paid: false, paidAt: null },
        { type: "OnRamp", createdAt: "2026-09-01T00:00:00Z", currency: USDC, amount: "1000000000", approved: true, approvedAt: "2026-09-02T00:00:00Z", paid: true, paidAt: "2026-09-03T00:00:00Z" },
      ],
    }, "https://fabrica.land/property/ethereum/1");
    expect(summary).toMatchObject({
      total: "$1,500",
      unpaidCount: 1,
      approveAt: "https://fabrica.land/property/ethereum/1",
      items: [
        { amount: "$500", state: "awaiting the owner's approval" },
        { amount: "$1,000", state: "paid", paidAt: "2026-09-03T00:00:00Z" },
      ],
    });
  });
});

describe("get_land_property lifecycle, fees and flags", () => {
  it("shows an unclaimed premint with an assessed fee", async () => {
    vi.mocked(getToken).mockResolvedValueOnce(token({
      isPremint: true,
      claimState: "UNCLAIMED",
      fees: { totalAmount: "500000000", fees: [{ type: "OnRamp", createdAt: "2026-10-08T05:49:42.371Z", currency: USDC, amount: "500000000", approved: false, approvedAt: null, paid: false, paidAt: null }] },
    }));
    const result = await getProperty({ tokenId: "12345" });
    expect(result).toMatchObject({
      lifecycle: { stage: "premint_unclaimed", claimState: "UNCLAIMED" },
      fees: { total: "$500", unpaidCount: 1 },
    });
    expect(result).toHaveProperty("flags", []);
  });

  it("shows a minted token without empty blocks", async () => {
    vi.mocked(getToken).mockResolvedValueOnce(token());
    const result = await getProperty({ tokenId: "12345" });
    expect(result).toMatchObject({ lifecycle: { stage: "minted" } });
    expect(result).toHaveProperty("fees", null);
    expect(result).toHaveProperty("flags", []);
  });

  it("shows an off-ramping token", async () => {
    vi.mocked(getToken).mockResolvedValueOnce(token({ offRampStatus: "in-progress" }));
    expect(await getProperty({ tokenId: "12345" })).toMatchObject({ lifecycle: { stage: "off_ramp_in_progress", offRampStatus: "in-progress" } });
  });

  it("flags duplicate parcels and the marketplace screen in plain words", async () => {
    vi.mocked(getToken).mockResolvedValueOnce(token({ duplicateParcelCount: 1, fishy: true }));
    const result = await getProperty({ tokenId: "12345" });
    expect(result).toMatchObject({
      flags: [
        "Another token on Fabrica claims the same parcel (same county APN and holding trust).",
        expect.stringContaining("does not sell this property"),
      ],
    });
  });

  it("follows a replaced premint to its minted successor", async () => {
    vi.mocked(getToken)
      .mockRejectedValueOnce(new FabricaApiError(["No token or premint found for token with ID 111 on any network"]))
      .mockResolvedValueOnce(token({ tokenId: "222" }));
    vi.mocked(getPremintSuccessor).mockResolvedValueOnce("222");
    const result = await getProperty({ tokenId: "111" });
    expect(getToken).toHaveBeenLastCalledWith({ tokenId: "222" });
    expect(result).toMatchObject({ tokenId: "222", lifecycle: { stage: "minted", replacesPremintTokenId: "111" } });
  });

  it("reports a missing token as an error when there is no successor", async () => {
    vi.mocked(getToken).mockRejectedValueOnce(new FabricaApiError(["No token or premint found for token with ID 111 on any network"]));
    vi.mocked(getPremintSuccessor).mockResolvedValueOnce(null);
    const result = await getProperty({ tokenId: "111" });
    expect(result).toEqual({ error: "No property found with token ID 111" });
  });
});

describe("search_land stage", () => {
  it("adds a stage to every row", async () => {
    vi.mocked(getTokens).mockResolvedValueOnce([token(), token({ tokenId: "2", offRampStatus: "in-progress" })]);
    const result = await searchProperties({});
    expect("properties" in result && result.properties.map(p => p.stage)).toEqual(["minted", "off_ramp_in_progress"]);
  });
});
