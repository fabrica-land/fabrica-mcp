import { describe, it, expect } from "vitest";
import { filterSpamTokens, DEFAULT_MIN_SCORE } from "../clients/graphql.js";
import type { TokenModel } from "../types/index.js";

function makeToken(overrides: Partial<TokenModel> = {}): TokenModel {
  return {
    tokenId: "1",
    name: "Normal Property",
    vanityName: null,
    slug: "test",
    propertyLink: "https://fabrica.land/test",
    coordinates: null,
    acres: "10",
    region: "Texas",
    regionCode: "TX",
    district: "Travis County",
    place: "Austin",
    country: "US",
    countryCode: "US",
    score: 73242,
    estimatedValue: "100000",
    cardDisplayValuation: "$100,000",
    marketplacePrice: null,
    marketplaceBidCount: 0,
    imageUrlDark: null,
    imageUrlLight: null,
    supply: "1",
    supplyUnderLoan: "0",
    isPremint: false,
    isBurned: false,
    majorityOwnerAddress: "0x1234567890abcdef1234567890abcdef12345678",
    ...overrides,
  } as TokenModel;
}

describe("filterSpamTokens", () => {
  it("keeps normal tokens", () => {
    const tokens = [makeToken({ name: "Austin Ranch 40 Acres" })];
    const result = filterSpamTokens(tokens);
    expect(result).toHaveLength(1);
  });

  it("filters out SyntaxError tokens", () => {
    const tokens = [
      makeToken({ name: "Austin Ranch" }),
      makeToken({ name: "SyntaxError: Unexpected token" }),
    ];
    const result = filterSpamTokens(tokens);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Austin Ranch");
  });

  it("filters out Error tokens", () => {
    const tokens = [
      makeToken({ name: "Error" }),
      makeToken({ name: "Good Property" }),
    ];
    const result = filterSpamTokens(tokens);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Good Property");
  });

  it("filters out BadGatewayException tokens", () => {
    const tokens = [
      makeToken({ name: "BadGatewayException" }),
    ];
    const result = filterSpamTokens(tokens);
    expect(result).toHaveLength(0);
  });

  it("handles tokens with null name using vanityName", () => {
    const tokens = [
      makeToken({ name: null, vanityName: "Good Vanity Name" }),
    ];
    const result = filterSpamTokens(tokens);
    expect(result).toHaveLength(1);
  });

  it("handles tokens with both null name and vanityName", () => {
    const tokens = [
      makeToken({ name: null, vanityName: null }),
    ];
    const result = filterSpamTokens(tokens);
    expect(result).toHaveLength(1); // no spam pattern match on empty string
  });
});

describe("DEFAULT_MIN_SCORE", () => {
  it("is set to 72032 matching the frontend marketplace threshold", () => {
    expect(DEFAULT_MIN_SCORE).toBe(72032);
  });

  it("requires a normal recovery status", () => {
    // 72032 = 7*10000 + 2*1000 + 0*100 + 3*10 + 2*1
    // The ten-thousands digit is the recovery status: 7 is Normal, so a Void (1),
    // Distressed (4), Stolen (5) or Recovery pending (6) property scores below it.
    expect(DEFAULT_MIN_SCORE).toBeGreaterThanOrEqual(70000);
    expect(19999).toBeLessThan(DEFAULT_MIN_SCORE); // Void with every other check passing
    expect(DEFAULT_MIN_SCORE).toBeLessThan(75342); // less than max
  });
});
