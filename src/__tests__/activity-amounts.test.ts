import { describe, it, expect, vi } from "vitest";

vi.mock("../clients/graphql.js", () => ({
  getToken: vi.fn(),
  getWallet: vi.fn(),
}));

import { getToken } from "../clients/graphql.js";
import { getActivity } from "../tools/activity.js";
import { formatActivityAmount } from "../labels.js";
import type { ActivityModel, TokenModel } from "../types/index.js";

function makeActivity(overrides: Partial<ActivityModel>): ActivityModel {
  return {
    activity: "MarketplaceSold",
    source: "Seaport",
    time: "2026-08-17T20:03:23.000Z",
    timestamp: 1787083403,
    network: "ethereum",
    tokenId: "2998852811793877500",
    transactionHash: "0xsale",
    currencyAmount: null,
    currencyDecimals: null,
    currencySymbol: null,
    usdAmount: null,
    durationSeconds: null,
    ...overrides,
  };
}

// Seaport sale on token 2998852811793877500 as the API returns it: usdAmount holds the raw USDC amount.
const SEAPORT_SALE = makeActivity({
  currencyAmount: "4950000000",
  currencyDecimals: 6,
  currencySymbol: "USDC",
  usdAmount: "4950000000.000000",
});

describe("formatActivityAmount", () => {
  it("scales a Seaport sale by currencyDecimals and ignores the unscaled usdAmount", () => {
    expect(formatActivityAmount(SEAPORT_SALE)).toBe("$4,950");
  });

  it("formats listings and loans the same way", () => {
    expect(formatActivityAmount(makeActivity({ activity: "MarketplaceListingStarted", source: "Fabrica", currencyAmount: "4999000000", currencyDecimals: 6, currencySymbol: "USDC", usdAmount: "4999.000000" }))).toBe("$4,999");
    expect(formatActivityAmount(makeActivity({ activity: "LoanStarted", source: "PoolLending", currencyAmount: "429000000", currencyDecimals: 6, currencySymbol: "USDC", usdAmount: "429.000000" }))).toBe("$429");
  });

  it("takes USDC as 6 decimals when currencyDecimals is missing", () => {
    expect(formatActivityAmount(makeActivity({ currencyAmount: "4999000000", currencySymbol: "USDC" }))).toBe("$4,999");
  });

  it("shows non-stablecoin amounts in their own currency, never as dollars", () => {
    expect(formatActivityAmount(makeActivity({ currencyAmount: "1250000000000000000", currencyDecimals: 18, currencySymbol: "WETH", usdAmount: "3125.00" }))).toBe("1.25 WETH");
  });

  it("falls back to usdAmount when there is no amount to scale", () => {
    expect(formatActivityAmount(makeActivity({ usdAmount: "1200.40" }))).toBe("$1,200");
  });

  it("returns null for events without an amount", () => {
    expect(formatActivityAmount(makeActivity({ activity: "ScoreChanged", source: "Fabrica" }))).toBeNull();
  });
});

describe("get_activity amounts", () => {
  it("reports a Seaport MarketplaceSold at its USDC value", async () => {
    const token = { tokenId: "2998852811793877500", name: "3705 Avondale Road", vanityName: null, activity: [SEAPORT_SALE] } as unknown as TokenModel;
    vi.mocked(getToken).mockResolvedValueOnce(token);
    const result = await getActivity({ tokenId: "2998852811793877500" });
    expect("events" in result ? result.events?.[0] : undefined).toMatchObject({ type: "MarketplaceSold", source: "Seaport", amount: "$4,950" });
  });
});
