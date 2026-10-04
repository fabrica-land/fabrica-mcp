import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../clients/graphql.js", () => ({
  getTokens: vi.fn().mockResolvedValue([]),
  getToken: vi.fn().mockResolvedValue(null),
  getAllLoans: vi.fn().mockResolvedValue([]),
  getCountyBounds: vi.fn().mockResolvedValue(null),
  DEFAULT_MIN_SCORE: 72032,
  filterSpamTokens: vi.fn((tokens: unknown[]) => tokens),
}));

vi.mock("../clients/subgraph.js", () => ({
  getFabricaPools: vi.fn().mockResolvedValue([]),
  aggregatePoolStats: vi.fn().mockReturnValue(null),
  FABRICA_TOKEN_ADDRESS: "0x5cbeb7a0df7ed85d82a472fd56d81ed550f3ea95",
}));

import { getTokens } from "../clients/graphql.js";
import { searchProperties } from "../tools/properties.js";
import { getProtocolStats } from "../tools/protocol.js";

const minScoreOfLastCall = () => {
  const calls = vi.mocked(getTokens).mock.calls;
  return (calls[calls.length - 1][0] as { minScore?: number }).minScore;
};

describe("minimum score defaults", () => {
  beforeEach(() => vi.mocked(getTokens).mockClear());

  it("search_properties uses the marketplace threshold by default", async () => {
    await searchProperties({});
    expect(minScoreOfLastCall()).toBe(72032);
  });

  it("search_properties lists every property in a wallet when ownedBy is set", async () => {
    await searchProperties({ ownedBy: "0x0000000000000000000000000000000000000001" });
    expect(minScoreOfLastCall()).toBeUndefined();
  });

  it("search_properties keeps an explicit minScore, with or without ownedBy", async () => {
    await searchProperties({ minScore: 74000 });
    expect(minScoreOfLastCall()).toBe(74000);
    await searchProperties({ minScore: 0, ownedBy: "0x0000000000000000000000000000000000000001" });
    expect(minScoreOfLastCall()).toBe(0);
  });

  it("protocol stats use the marketplace threshold", async () => {
    await getProtocolStats();
    expect(minScoreOfLastCall()).toBe(72032);
  });
});
