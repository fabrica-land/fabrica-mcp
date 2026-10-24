import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../clients/graphql.js", () => ({
  getTaxStatusToken: vi.fn(),
  getScoreRecord: vi.fn(),
  isTokenNotFound: (e: unknown) => e instanceof Error && e.message.includes("No token or premint found"),
}));

import { getTaxStatusToken, getScoreRecord } from "../clients/graphql.js";
import { getTaxStatus, resolveTaxStatus } from "../tools/tax.js";
import type { AppraisalBlockReason, TaxStatusToken } from "../types/index.js";
import { LENDING_POOL_NAME } from "../labels.js";
import { MAINNET_WARNING } from "../config.js";

function makeToken(blockReason: AppraisalBlockReason | null = null, overrides: Partial<TaxStatusToken> = {}): TaxStatusToken {
  return {
    tokenId: "3484741603659410548",
    network: "ethereum",
    contractAddress: "0x5cbeb7a0df7ed85d82a472fd56d81ed550f3ea95",
    name: "92 Cuatro Ruedas Dr, Carson, NM",
    vanityName: null,
    isPremint: false,
    district: "Taos County",
    regionCode: "NM",
    poolLendingLiquidity: { appraisalBlockReason: blockReason },
    ...overrides,
  };
}

function record(value: number | boolean | null) {
  return { checks: { propertyTaxesCurrent: value }, updatedAt: "2026-10-17T00:32:12.498Z", expiresAt: "2026-11-10T00:00:00.000Z" };
}

beforeEach(() => {
  vi.mocked(getScoreRecord).mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveTaxStatus", () => {
  it("reads the check when there is no block reason", () => {
    expect(resolveTaxStatus(true, null)).toEqual({ status: "current", basis: "check" });
    expect(resolveTaxStatus(false, null)).toEqual({ status: "delinquent", basis: "check" });
    expect(resolveTaxStatus(null, null)).toEqual({ status: "unknown", basis: "none" });
  });

  it("lets the lending block reason decide, and says when both signals agree", () => {
    expect(resolveTaxStatus(false, "TAX_DELINQUENT")).toEqual({ status: "delinquent", basis: "both" });
    expect(resolveTaxStatus(null, "TAX_DELINQUENT")).toEqual({ status: "delinquent", basis: "lendingBlockReason" });
    expect(resolveTaxStatus(null, "TAX_STATUS_UNKNOWN")).toEqual({ status: "unknown", basis: "lendingBlockReason" });
    expect(resolveTaxStatus(null, "TAX_STATUS_UNKNOWN", true)).toEqual({ status: "unknown", basis: "both" });
    expect(resolveTaxStatus(null, "TAX_DELINQUENT", true)).toEqual({ status: "unknown", basis: "conflicting" });
    expect(resolveTaxStatus(true, "OTHER")).toEqual({ status: "current", basis: "check" });
    expect(resolveTaxStatus(true, "TAX_DELINQUENT")).toEqual({ status: "unknown", basis: "conflicting" });
    expect(resolveTaxStatus(true, "TAX_STATUS_UNKNOWN")).toEqual({ status: "unknown", basis: "conflicting" });
    expect(resolveTaxStatus(false, "TAX_STATUS_UNKNOWN")).toEqual({ status: "unknown", basis: "conflicting" });
  });
});

describe("get_land_tax_status", () => {
  it("requires a tokenId or slug", async () => {
    expect(await getTaxStatus({})).toEqual({ error: "Either tokenId or slug is required" });
  });

  it("reports a missing property without calling the score API", async () => {
    vi.mocked(getTaxStatusToken).mockResolvedValueOnce(null);
    const result = await getTaxStatus({ tokenId: "1" }) as Record<string, unknown>;
    expect(result.error).toBe("No property found with token ID 1");
    expect(getScoreRecord).not.toHaveBeenCalled();
  });

  it("maps the API's not-found error to the not-found response", async () => {
    vi.mocked(getTaxStatusToken).mockRejectedValueOnce(new Error("Fabrica API rejected the query: No token or premint found"));
    const result = await getTaxStatus({ tokenId: "1" }) as Record<string, unknown>;
    expect(result.error).toBe("No property found with token ID 1");
  });

  it("treats a check past its expiry as unknown", async () => {
    vi.mocked(getTaxStatusToken).mockResolvedValueOnce(makeToken());
    vi.mocked(getScoreRecord).mockResolvedValueOnce({ ...record(1), expiresAt: "2026-10-01T00:00:00.000Z" });
    const result = await getTaxStatus({ tokenId: "1" }) as Record<string, unknown>;
    expect(result.status).toBe("unknown");
    expect(result.checkExpired).toBe(true);
    expect(result.summary).toContain("the last verification expired");
    expect(result.checkedAt).toBeNull();
  });

  it("does not date a past-due result that rests on the block reason alone", async () => {
    vi.mocked(getTaxStatusToken).mockResolvedValueOnce(makeToken("TAX_DELINQUENT"));
    vi.mocked(getScoreRecord).mockResolvedValueOnce({ ...record(1), expiresAt: "2026-10-01T00:00:00.000Z" });
    const result = await getTaxStatus({ tokenId: "1" }) as Record<string, unknown>;
    expect(result.status).toBe("delinquent");
    expect(result.basis).toBe("lendingBlockReason");
    expect(result.checkedAt).toBeNull();
    expect(result.nextCheckBy).toBeNull();
    expect(result.summary).not.toContain("as of");
  });

  it("does not trust a check whose expiry is missing", async () => {
    vi.mocked(getTaxStatusToken).mockResolvedValueOnce(makeToken());
    vi.mocked(getScoreRecord).mockResolvedValueOnce({ ...record(1), expiresAt: null });
    const result = await getTaxStatus({ tokenId: "1" }) as Record<string, unknown>;
    expect(result.status).toBe("unknown");
  });

  it("carries the network's legal notice", async () => {
    vi.mocked(getTaxStatusToken).mockResolvedValueOnce(makeToken());
    vi.mocked(getScoreRecord).mockResolvedValueOnce(record(1));
    const result = await getTaxStatus({ tokenId: "1" }) as Record<string, unknown>;
    expect(result.legalNotice).toBe(MAINNET_WARNING ?? undefined);
  });

  it("renders current taxes with the check dates", async () => {
    vi.mocked(getTaxStatusToken).mockResolvedValueOnce(makeToken());
    vi.mocked(getScoreRecord).mockResolvedValueOnce(record(1));
    const result = await getTaxStatus({ tokenId: "3484741603659410548" }) as Record<string, unknown>;
    expect(result.status).toBe("current");
    expect(result.basis).toBe("check");
    expect(result.summary).toBe("Fabrica's checks found the property taxes current as of 2026-10-17.");
    expect(result.checkedAt).toBe("2026-10-17T00:32:12.498Z");
    expect(result.nextCheckBy).toBe("2026-11-10T00:00:00.000Z");
    expect(result.affectsLending).toBe(false);
    expect(result.whatIsNotAvailable).toEqual(["the amount due", "the due date", "the county's own tax record"]);
  });

  it("renders delinquent taxes that block lending", async () => {
    vi.mocked(getTaxStatusToken).mockResolvedValueOnce(makeToken("TAX_DELINQUENT"));
    vi.mocked(getScoreRecord).mockResolvedValueOnce(record(0));
    const result = await getTaxStatus({ tokenId: "1" }) as Record<string, unknown>;
    expect(result.status).toBe("delinquent");
    expect(result.basis).toBe("both");
    expect(result.summary).toContain("past due as of 2026-10-17");
    expect(result.affectsLending).toBe(true);
    expect(result.lending).toContain(LENDING_POOL_NAME);
    expect(result.nextSteps).toContain("county treasurer");
  });

  it("renders unknown taxes with what to do next", async () => {
    vi.mocked(getTaxStatusToken).mockResolvedValueOnce(makeToken("TAX_STATUS_UNKNOWN"));
    vi.mocked(getScoreRecord).mockResolvedValueOnce(record(null));
    const result = await getTaxStatus({ tokenId: "1" }) as Record<string, unknown>;
    expect(result.status).toBe("unknown");
    expect(result.basis).toBe("both");
    expect(result.checkedAt).toBe("2026-10-17T00:32:12.498Z");
    expect(result.summary).toContain("never verified, or the last verification expired");
    expect(result.nextSteps).toContain("county treasurer");
    expect(result.nextSteps).toContain("setup collects tax evidence");
    expect(result.affectsLending).toBe(true);
  });

  it("reports unknown with a warning when the score record is unavailable", async () => {
    vi.mocked(getTaxStatusToken).mockResolvedValueOnce(makeToken());
    vi.mocked(getScoreRecord).mockRejectedValueOnce(new Error("Fabrica score API request failed (HTTP 502)"));
    const result = await getTaxStatus({ tokenId: "1" }) as Record<string, unknown>;
    expect(result.status).toBe("unknown");
    expect(result.checkedAt).toBeNull();
    expect((result.warnings as string[])[0]).toContain("HTTP 502");
    expect((result.warnings as string[])[0]).toContain("tax check and its dates could not be read");
    expect(result.summary).toContain("could not be read right now");
  });

  it("does not claim two signals when the score record is unavailable", async () => {
    vi.mocked(getTaxStatusToken).mockResolvedValueOnce(makeToken("TAX_STATUS_UNKNOWN"));
    vi.mocked(getScoreRecord).mockRejectedValueOnce(new Error("Fabrica score API request failed (HTTP 502)"));
    const result = await getTaxStatus({ tokenId: "1" }) as Record<string, unknown>;
    expect(result.status).toBe("unknown");
    expect(result.basis).toBe("lendingBlockReason");
  });

  it("does not date a result the check disagrees with", async () => {
    vi.mocked(getTaxStatusToken).mockResolvedValueOnce(makeToken("TAX_STATUS_UNKNOWN"));
    vi.mocked(getScoreRecord).mockResolvedValueOnce(record(1));
    const result = await getTaxStatus({ tokenId: "1" }) as Record<string, unknown>;
    expect(result.status).toBe("unknown");
    expect(result.basis).toBe("conflicting");
    expect(result.checkedAt).toBeNull();
    expect(result.nextCheckBy).toBeNull();
    expect((result.warnings as string[]).join(" ")).toContain("disagree");
    expect(result.summary).toContain("disagree");
  });

  it("skips the score API for a premint and says why the status is unknown", async () => {
    vi.mocked(getTaxStatusToken).mockResolvedValueOnce(makeToken(null, { isPremint: true, poolLendingLiquidity: null }));
    const result = await getTaxStatus({ tokenId: "1" }) as Record<string, unknown>;
    expect(getScoreRecord).not.toHaveBeenCalled();
    expect(result.status).toBe("unknown");
    expect(result.summary).toContain("still being added");
  });

  it("never claims the taxes are paid, and names the source as a data lookup", async () => {
    vi.mocked(getTaxStatusToken).mockResolvedValueOnce(makeToken());
    vi.mocked(getScoreRecord).mockResolvedValueOnce(record(1));
    const text = JSON.stringify(await getTaxStatus({ tokenId: "1" }));
    expect(text).not.toMatch(/taxes are paid|paid in full|—/i);
    expect(text).toContain("not the county's own statement");
  });
});
