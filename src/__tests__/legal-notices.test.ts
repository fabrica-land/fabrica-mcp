import { describe, it, expect, vi } from "vitest";

// Mock graphql and subgraph clients
vi.mock("../clients/graphql.js", () => ({
  getTokens: vi.fn().mockResolvedValue([]),
  getToken: vi.fn().mockResolvedValue(null),
  getAllLoans: vi.fn().mockResolvedValue([]),
  getLoanStartedEvents: vi.fn().mockResolvedValue([]),
  getLoanRepaidEvents: vi.fn().mockResolvedValue([]),
  getLoanLiquidatedEvents: vi.fn().mockResolvedValue([]),
  DEFAULT_MIN_SCORE: 2142,
  filterSpamTokens: vi.fn((tokens: unknown[]) => tokens),
}));

vi.mock("../clients/subgraph.js", () => ({
  getFabricaPools: vi.fn().mockResolvedValue([]),
  aggregatePoolStats: vi.fn().mockReturnValue(null),
  FABRICA_TOKEN_ADDRESS: "0x5cbeb7a0df7ed85d82a472fd56d81ed550f3ea95",
}));

import { searchProperties, getProperty } from "../tools/properties.js";
import { getProtocolStats } from "../tools/protocol.js";
import { IS_MAINNET } from "../config.js";

describe("legal notices on mainnet", () => {
  it("search_properties includes network and legal notice on mainnet", async () => {
    const result = await searchProperties({}) as Record<string, unknown>;
    expect(result.network).toBeDefined();
    if (IS_MAINNET) {
      expect(result.legalNotice).toBeTruthy();
    }
  });

  it("get_property returns error with legal context for missing token", async () => {
    const result = await getProperty({ tokenId: "nonexistent" }) as Record<string, unknown>;
    expect(result.error).toBeDefined();
  });

  it("get_protocol_stats includes legal notice on mainnet", async () => {
    const result = await getProtocolStats() as Record<string, unknown>;
    if (IS_MAINNET) {
      expect(result.legalNotice).toBeTruthy();
    }
    const protocol = result.protocol as Record<string, unknown>;
    expect(protocol.network).toBeDefined();
  });
});

describe("tool input validation", () => {
  it("get_property requires tokenId or slug", async () => {
    const result = await getProperty({}) as Record<string, unknown>;
    expect(result.error).toContain("Either tokenId or slug is required");
  });

  it("search_properties returns empty message for no matches", async () => {
    const result = await searchProperties({ region: "XX" }) as Record<string, unknown>;
    expect(result.total).toBe(0);
    expect(result.message).toBeTruthy();
  });
});
