import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../clients/graphql.js", () => ({
  getTokenValuation: vi.fn(),
  getSignedValuations: vi.fn(),
  getToken: vi.fn(),
}));

import { getSignedValuations, getToken, getTokenValuation } from "../clients/graphql.js";
import { getValuation } from "../tools/valuation.js";
import { getBorrowQuote } from "../tools/borrowing.js";
import { oraclePool, poolLendingLiquidityWithOracle, tokenDetailWithPoolOracle, valuationPricing, valuationToken } from "./fixtures.js";
import { describeAppraisalBlock, describeCapacityBlock, describeFailedCheck, describeSignedValuationReason, formatUsdc6 } from "../labels.js";

const avmAndPrycd = valuationToken({
  tokenId: "100",
  name: "Two Source Ranch",
  vanityName: null,
  isPremint: false,
  estimatedValue: "8210.74",
  cardDisplayValuation: "20000.00",
  valuationReportUrl: "https://ipfs.fabrica.land/ipfs/report",
  pricing: [
    valuationPricing({ source: "fabrica-avm", scope: "land", value: "9100.00", currency: "usd", confidence: "60.000", timestamp: "2026-09-27T06:09:36.614Z", modelVersion: "1.14.1" }),
    valuationPricing({ source: "fabrica-avm", scope: "improvements", value: null, currency: "usd", confidence: "0.000", timestamp: "2026-09-27T06:09:36.614Z", modelVersion: "1.14.1" }),
    valuationPricing({ source: "prycd", scope: "land", value: "8210.74000000000000000000", currency: "usd", confidence: "75.200", timestamp: "2026-10-13T03:03:02.064Z", modelVersion: "" }),
    valuationPricing({ source: "regrid-county-assessor", scope: "land", value: "15930.00", currency: "usd", confidence: null, timestamp: "2026-10-12T03:03:14.824Z", modelVersion: "" }),
    valuationPricing({ source: "regrid-county-assessor", scope: "last sale", value: "25000.00", currency: "usd", confidence: null, timestamp: "2026-10-12T03:03:14.824Z", modelVersion: "" }),
  ],
  poolLendingLiquidity: poolLendingLiquidityWithOracle({
    maxPrincipalScaled: "325.684574",
    maxPrincipalUsdc: "325684574",
    durations: [30],
    activeLoan: null,
    appraisalBlockReason: null,
    pools: [oraclePool({
      address: "0x842Ffbf1AD5314503904626122376f71603A3Cf9",
      pricing: "SignedQuote",
      oracleValuation: { quote: { price: "1524966393", currency: "0xA0b8", timestamp: 1792198035, duration: 1200 }, signature: "0xsig" },
      onchainPrice: null,
      oracleFeed: null,
      onchainValuation: null,
    })],
  }),
});

const onchainPool = oraclePool({
  address: "0x1111111111111111111111111111111111111111",
  pricing: "OnchainOracle",
  oracleValuation: null,
  onchainPrice: { priceUsdc6: "9000000000", confidenceScore: 9250, cycle: "4", valuedAt: "1792000000", sourceId: 2 },
  oracleFeed: { lastHeartbeat: "1792100000", maxSilence: "86400", isStale: false, currentCycle: "5", minValidCycle: "3", indexerUnavailableReason: null },
  onchainValuation: { usablePriceUsdc6: null, capacityBlockReason: null, failedCheck: "min_sources" },
});

const onchainOracle = valuationToken({
  ...avmAndPrycd,
  tokenId: "200",
  name: "Oracle Lot",
  poolLendingLiquidity: poolLendingLiquidityWithOracle({
    maxPrincipalScaled: "0",
    maxPrincipalUsdc: "0",
    durations: [30],
    activeLoan: null,
    appraisalBlockReason: null,
    pools: [onchainPool],
  }),
});

const assessorOnlyPremint = valuationToken({
  tokenId: "300",
  name: "Premint Parcel",
  vanityName: null,
  isPremint: true,
  estimatedValue: "0.00",
  cardDisplayValuation: "0.00",
  valuationReportUrl: null,
  pricing: [
    valuationPricing({ source: "regrid-county-assessor", scope: "parcel", value: "42000.00", currency: "usd", confidence: null, timestamp: "2026-10-12T03:03:14.824Z", modelVersion: "" }),
  ],
  poolLendingLiquidity: null,
});

const signedPanel = {
  networkName: "ethereum",
  asOf: "2026-10-17T00:57:16.344Z",
  valuations: [
    { source: "All Fabrica Properties", version: "1.0", signer: "0xC888", signature: "0xabc", quote: { price: "1524966393", currency: "0xA0b8", timestamp: 1792198036, duration: 1200 } },
    { source: "All US Land", version: "1.0", signer: "0xC888", signature: null, quote: null, reason: "valuation_unavailable" },
  ],
};

beforeEach(() => {
  vi.mocked(getSignedValuations).mockResolvedValue(signedPanel);
});

describe("get_valuation", () => {
  it("requires a token id or slug", async () => {
    expect(await getValuation({})).toEqual({ error: "Either tokenId or slug is required" });
  });

  it("names the sources behind the estimate and lists every row with its date", async () => {
    vi.mocked(getTokenValuation).mockResolvedValue(avmAndPrycd);
    const result = await getValuation({ tokenId: "100" });
    expect(result).toMatchObject({
      estimate: { value: "$8,211", basedOn: ["Prycd"], asOf: "2026-10-13T03:03:02.064Z" },
      sources: [
        { source: "Fabrica AVM (automated valuation model)", scope: "land", value: "$9,100", confidence: "60.000", modelVersion: "1.14.1" },
        { scope: "improvements", value: null, note: expect.stringContaining("The Fabrica AVM published no value for this scope") },
        { source: "Prycd", value: "$8,211", modelVersion: null },
      ],
      assessor: { land: "$15,930", lastSale: "$25,000", total: null },
      signedValuations: {
        entries: [
          { source: "All Fabrica Properties", price: "$1,524.97", signed: true, validForSeconds: 1200 },
          { source: "All US Land", price: null, signed: false, reason: "This source could not produce a valuation." },
        ],
      },
      oracle: {
        maxBorrow: "325 USDC",
        pools: [{ pricing: "Signed quote from the Fabrica API", quotePrice: "$1,524.97", signed: true }],
      },
      reportUrl: "https://ipfs.fabrica.land/ipfs/report",
    });
  });

  it("explains an onchain oracle that has no usable price", async () => {
    vi.mocked(getTokenValuation).mockResolvedValue(onchainOracle);
    const result = await getValuation({ tokenId: "200" });
    expect(result).toMatchObject({
      oracle: {
        maxBorrow: null,
        noCapacityReasons: [describeFailedCheck("min_sources")],
        pools: [{
          pricing: "Onchain price oracle",
          feed: { stale: false, maxSilenceSeconds: 86400 },
          sourcePrice: { price: "$9,000.00", confidence: "92.5%", invalidated: false },
          usablePrice: null,
          failedCheck: "min_sources",
        }],
      },
    });
  });

  it("renders a premint with only the assessor value", async () => {
    vi.mocked(getTokenValuation).mockResolvedValue(assessorOnlyPremint);
    const result = await getValuation({ slug: "us/x/premint" });
    expect(getSignedValuations).toHaveBeenCalledWith("300");
    expect(result).toMatchObject({
      isPremint: true,
      estimate: { value: null, basedOn: [] },
      sources: [],
      assessor: { total: "$42,000" },
      oracle: null,
    });
  });

  it("still answers when the signed valuation service fails", async () => {
    vi.mocked(getTokenValuation).mockResolvedValue(avmAndPrycd);
    vi.mocked(getSignedValuations).mockResolvedValue(null);
    const result = await getValuation({ tokenId: "100" });
    expect(result).not.toHaveProperty("error");
    expect(result).toMatchObject({ signedValuations: { entries: [], note: expect.stringContaining("did not answer") } });
  });

  it("reports a missing token as not found", async () => {
    vi.mocked(getTokenValuation).mockResolvedValue(null);
    expect(await getValuation({ tokenId: "9" })).toEqual({ error: "No property found with token ID 9" });
  });
});

describe("get_borrow_quote states why capacity is zero", () => {
  it("gives the tax reason", async () => {
    vi.mocked(getToken).mockResolvedValue(tokenDetailWithPoolOracle({
      tokenId: "4", name: "Taxed Lot", estimatedValue: "1000", supplyUnderLoan: "0", loans: [],
      poolLendingLiquidity: poolLendingLiquidityWithOracle({ maxPrincipalScaled: "0", maxPrincipalUsdc: "0", durations: [30], activeLoan: null, appraisalBlockReason: "TAX_DELINQUENT", pools: [] }),
    }));
    const result = await getBorrowQuote({ tokenId: "4" });
    expect(result).toMatchObject({
      lendingPool: { available: false, reasons: [describeAppraisalBlock("TAX_DELINQUENT")] },
      appraisalBlock: expect.stringContaining("past due"),
    });
  });

  it("gives the oracle reason", async () => {
    vi.mocked(getToken).mockResolvedValue(tokenDetailWithPoolOracle({
      tokenId: onchainOracle.tokenId, name: onchainOracle.name, estimatedValue: onchainOracle.estimatedValue, supplyUnderLoan: "0", loans: [],
      poolLendingLiquidity: poolLendingLiquidityWithOracle({ maxPrincipalScaled: "0", maxPrincipalUsdc: "0", durations: [30], activeLoan: null, appraisalBlockReason: null, pools: [onchainPool] }),
    }));
    const result = await getBorrowQuote({ tokenId: "200" });
    expect(result).toMatchObject({
      lendingPool: { reasons: [describeFailedCheck("min_sources")] },
      oracle: [{ failedCheck: "min_sources" }],
    });
  });

  it("says so when the API gives no specific reason", async () => {
    vi.mocked(getToken).mockResolvedValue(tokenDetailWithPoolOracle({
      tokenId: "5", name: "Quiet Lot", estimatedValue: "1000", supplyUnderLoan: "0", loans: [],
      poolLendingLiquidity: poolLendingLiquidityWithOracle({ maxPrincipalScaled: "0", maxPrincipalUsdc: "0", durations: [30], activeLoan: null, appraisalBlockReason: null, pools: [] }),
    }));
    const result = await getBorrowQuote({ tokenId: "5" });
    expect(result).toMatchObject({ lendingPool: { reasons: [expect.stringContaining("states no specific reason")] } });
  });
});

describe("valuation wording", () => {
  const banned = /fair value|fair market|worth|should sell|should list|should ask|recommended price|underpriced|overpriced|bargain|—/i;

  it("uses no price-suggestion language in labels", () => {
    const strings = [
      ...["TAX_DELINQUENT", "TAX_STATUS_UNKNOWN", "OTHER"].map(describeAppraisalBlock),
      ...["heartbeat", "registry", "recovery", "currency", "max_silence", "min_sources", "dispersion", "land_use", "eligibility_unattested", "eligibility", "eligibility_region_unattested", "eligibility_region", "eligibility_vacant_land", "price_unavailable", "eligibility_unavailable", "oracle_state_unavailable", "new_gate"].map(describeFailedCheck),
      describeCapacityBlock("oracle_read_not_pool_oracle"),
      describeSignedValuationReason("valuation_unavailable"),
    ];
    for (const s of strings) expect(s).not.toMatch(banned);
  });

  it("uses no price-suggestion language in tool output", async () => {
    for (const token of [avmAndPrycd, onchainOracle, assessorOnlyPremint]) {
      vi.mocked(getTokenValuation).mockResolvedValue(token);
      const text = JSON.stringify(await getValuation({ tokenId: token.tokenId }));
      expect(text).not.toMatch(banned);
    }
  });

  it("formats 6-decimal USDC amounts", () => {
    expect(formatUsdc6("1524966393")).toBe("$1,524.97");
    expect(formatUsdc6(null)).toBeNull();
  });
});

describe("appraisal provenance by pool pricing", () => {
  it("leaves the appraisal derivation off an onchain oracle price", async () => {
    const pool = oraclePool({
      pricing: "OnchainOracle",
      onchainPrice: { priceUsdc6: "6174527000", confidenceScore: 9250, cycle: "4", valuedAt: "1792000000", sourceId: 2 },
      onchainValuation: { usablePriceUsdc6: "6174527000", capacityBlockReason: null, failedCheck: null },
    });
    vi.mocked(getTokenValuation).mockResolvedValue(valuationToken({ ...avmAndPrycd, poolLendingLiquidity: poolLendingLiquidityWithOracle({ maxPrincipalScaled: "325.684574", maxPrincipalUsdc: "325684574", pools: [pool] }) }));
    vi.mocked(getSignedValuations).mockResolvedValue(null);
    const result = await getValuation({ tokenId: "100" });
    if ("error" in result) throw new Error(result.error);
    expect(result.oracle?.pools[0]).not.toHaveProperty("appraisal");
  });
});
