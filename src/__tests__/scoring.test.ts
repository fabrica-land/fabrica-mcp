import { describe, it, expect, vi } from "vitest";

// Mock the graphql client before importing the module
vi.mock("../clients/graphql.js", () => ({
  getToken: vi.fn(),
}));

import { explainConfidenceScore } from "../tools/scoring.js";

describe("explainConfidenceScore", () => {
  it("decomposes max score 75342 correctly", async () => {
    const result = await explainConfidenceScore({ score: 75342 });
    const r = result as Record<string, unknown>;
    expect(r.score).toBe(75342);
    expect(r.maxScore).toBe(75342);
    expect(r.percentage).toBe("100.0%");
    const breakdown = r.breakdown as Record<string, { value: number; max: number }>;
    expect(breakdown.recoveryStatus.value).toBe(7);
    expect(breakdown.recoveryStatus.max).toBe(7);
    expect(breakdown.pastTitleAndLoad.value).toBe(5);
    expect(breakdown.pastTitleAndLoad.max).toBe(5);
    expect(breakdown.ownership.value).toBe(3);
    expect(breakdown.ownership.max).toBe(3);
    expect(breakdown.onChainHistory.value).toBe(4);
    expect(breakdown.onChainHistory.max).toBe(4);
    expect(breakdown.basicValidation.value).toBe(2);
    expect(breakdown.basicValidation.max).toBe(2);
    expect(r.warnings).toBeUndefined();
  });

  it("decomposes score 73242 correctly", async () => {
    const result = await explainConfidenceScore({ score: 73242 });
    const r = result as Record<string, unknown>;
    expect(r.score).toBe(73242);
    const breakdown = r.breakdown as Record<string, { value: number; max: number }>;
    expect(breakdown.recoveryStatus.value).toBe(7);
    expect(breakdown.pastTitleAndLoad.value).toBe(3);
    expect(breakdown.ownership.value).toBe(2);
    expect(breakdown.onChainHistory.value).toBe(4);
    expect(breakdown.basicValidation.value).toBe(2);
  });

  it("flags recovery status warnings for non-7 values", async () => {
    const result = await explainConfidenceScore({ score: 53242 });
    const r = result as Record<string, unknown>;
    const breakdown = r.breakdown as Record<string, { value: number }>;
    expect(breakdown.recoveryStatus.value).toBe(5);
    const warnings = r.warnings as string[];
    expect(warnings).toBeDefined();
    expect(warnings.some(w => w.includes("Recovery"))).toBe(true);
  });

  it("flags voided token (recovery digit 1)", async () => {
    const result = await explainConfidenceScore({ score: 13242 });
    const r = result as Record<string, unknown>;
    const breakdown = r.breakdown as Record<string, { value: number; label: string }>;
    expect(breakdown.recoveryStatus.value).toBe(1);
    expect(breakdown.recoveryStatus.label).toContain("Voided");
    const warnings = r.warnings as string[];
    expect(warnings).toBeDefined();
  });

  it("flags low title verification", async () => {
    const result = await explainConfidenceScore({ score: 72242 });
    const r = result as Record<string, unknown>;
    const breakdown = r.breakdown as Record<string, { value: number }>;
    expect(breakdown.pastTitleAndLoad.value).toBe(2);
    const warnings = r.warnings as string[];
    expect(warnings).toBeDefined();
    expect(warnings.some(w => w.includes("Title verification"))).toBe(true);
  });

  it("decomposes zero score", async () => {
    const result = await explainConfidenceScore({ score: 0 });
    const r = result as Record<string, unknown>;
    expect(r.score).toBe(0);
    const breakdown = r.breakdown as Record<string, { value: number }>;
    expect(breakdown.recoveryStatus.value).toBe(0);
    expect(breakdown.pastTitleAndLoad.value).toBe(0);
    expect(breakdown.ownership.value).toBe(0);
    expect(breakdown.onChainHistory.value).toBe(0);
    expect(breakdown.basicValidation.value).toBe(0);
  });

  it("returns error when neither tokenId nor score provided", async () => {
    const result = await explainConfidenceScore({});
    expect(result).toHaveProperty("error");
  });

  it("keeps score as raw integer — no normalization", async () => {
    const result = await explainConfidenceScore({ score: 73242 });
    const r = result as Record<string, unknown>;
    expect(r.score).toBe(73242);
    // Score must NOT be divided by anything
    expect(typeof r.score).toBe("number");
    expect(r.score).toBeGreaterThan(100);
  });
});
