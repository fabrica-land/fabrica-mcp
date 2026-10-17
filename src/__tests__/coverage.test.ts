import { describe, it, expect, vi } from "vitest";
import { checkCoverage, coverageStatus, resolveRules, COVERAGE_AS_OF } from "../tools/coverage.js";
import { US_COUNTY_ROWS } from "../data/us-counties.js";
import table from "../data/onramp-coverage.json";

const COUNTY_KEYS = new Set(US_COUNTY_ROWS.map((row) => row.split("|")[0]));

describe("coverage table", () => {
  it("has a source date and a US layer with a status", () => {
    expect(COVERAGE_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(table.layers.common[""]?.workflowSupport).toBeDefined();
  });

  it("names only states and counties the county table knows", () => {
    for (const byPlace of Object.values(table.layers)) {
      for (const place of Object.keys(byPlace)) {
        if (place === "") continue;
        if (place.includes("/")) expect(COUNTY_KEYS.has(place), place).toBe(true);
        else expect([...COUNTY_KEYS].some((key) => key.startsWith(`${place}/`)), place).toBe(true);
      }
    }
  });

  it("carries no fee amounts or template payloads", () => {
    const raw = JSON.stringify(table);
    expect(raw).not.toMatch(/\$\d|amountTemplate|templatePayload|\{\{/);
  });
});

describe("resolveRules", () => {
  it("merges the US, state and county layers like the API", () => {
    const sf = resolveRules("ca/san-francisco");
    expect(sf.workflowSupport).toBe("supported");
    expect(Object.keys(sf.documents ?? {})).toEqual(expect.arrayContaining(["proof-of-title", "jurisdiction-tax-form", "jurisdiction-tax-form-sf-tta"]));
    // The county adds a question; the state's and the US one stay.
    expect(Object.keys(sf.fields ?? {})).toEqual(expect.arrayContaining(["How do you hold title, as shown on your current deed?", "Phone Number", "Property street address (used only if the address on file is incomplete)"]));
  });

  it("keeps a question required by another answer apart from one asked only for some parcels", () => {
    const lender = resolveRules("ca/fresno").fields?.["What is the lender’s name?"];
    expect(lender).toEqual({ required: false, dependsOnParcel: true, requiredWhen: { question: "Is there a loan secured by this property?", answer: "Yes" } });
  });

  it("takes the status a county sets over the US default", () => {
    expect(coverageStatus("ca/riverside")).toBe("notConfigured");
    expect(coverageStatus("ca/fresno")).toBe("supported");
  });
});

describe("checkCoverage", () => {
  it("answers a supported county by FIPS with its documents and steps", () => {
    const result = checkCoverage({ fips: "13089" });
    expect(result).toMatchObject({
      jurisdiction: { state: "GA", county: "DeKalb", fips: "13089" },
      ownerType: "individual",
      status: "supported",
      witnessesRequired: true,
      source: { asOf: COVERAGE_AS_OF },
    });
    if (!("documents" in result) || !result.documents || !result.steps) throw new Error("no documents");
    expect(result.documents[0]).toEqual({ name: "Deed", notarized: true });
    expect(result.documents.map((doc) => doc.name)).toContain("PT-61");
    expect(result.steps.length).toBeGreaterThan(0);
  });

  it("answers a county by state and name, without the details when it is not configured", () => {
    const result = checkCoverage({ state: "ca", county: "Riverside County" });
    expect(result).toMatchObject({ jurisdiction: { county: "Riverside", fips: "06065" }, status: "notConfigured" });
    expect(result).not.toHaveProperty("documents");
    expect(JSON.stringify(result)).toContain("contact_support");
  });

  it("answers a whole state and lists the counties with rules of their own", () => {
    const result = checkCoverage({ state: "CA" });
    expect(result).toMatchObject({ jurisdiction: { state: "CA" }, status: "supported" });
    if (!("countiesWithOwnRules" in result)) throw new Error("no county list");
    expect(result.countiesWithOwnRules).toEqual(expect.arrayContaining([
      { county: "Riverside", fips: "06065", status: "notConfigured" },
      { county: "San Francisco", fips: "06075" },
    ]));
  });

  it("lists a document step only where the county uses that document", () => {
    const actions = (fips: string): string[] => {
      const result = checkCoverage({ fips });
      return "steps" in result && result.steps ? result.steps.flatMap((step) => step.actions ?? []) : [];
    };
    expect(actions("12086")).not.toContain("Local Tax Form"); // Miami-Dade, FL: no transfer tax form
    expect(actions("06019")).toContain("Local Tax Form"); // Fresno, CA: PCOR
    expect(actions("12086")).toEqual(expect.arrayContaining(["Operating Agreement", "Deed"]));
  });

  it("falls back to the US rules for a county with no rules of its own", () => {
    const result = checkCoverage({ state: "TX", county: "Hunt" });
    expect(result).toMatchObject({ status: "supported", documents: [{ name: "Special Warranty Deed", notarized: true }] });
  });

  it("names the date and the manual refresh, and no fee amount", () => {
    const raw = JSON.stringify(checkCoverage({ state: "NY", county: "Orange" }));
    expect(raw).toContain(COVERAGE_AS_OF);
    expect(raw).toContain("refreshed by hand");
    expect(raw).not.toMatch(/\$\d/);
  });

  it("labels the signing requirements as Mainnet's on Sepolia, with no fee", async () => {
    vi.stubEnv("FABRICA_NETWORK", "sepolia");
    vi.resetModules();
    try {
      const testnet = await import("../tools/coverage.js");
      const result = testnet.checkCoverage({ fips: "13089" });
      expect(result).not.toHaveProperty("documents");
      expect(result).not.toHaveProperty("fee");
      expect(result).toMatchObject({ status: "supported", mainnetRequirements: { witnessesRequired: true } });
      expect(JSON.stringify(result)).toContain("no deed is signed or recorded");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("does not cover DC or the territories, which the rules do not name", () => {
    expect(checkCoverage({ fips: "72001" })).toMatchObject({ jurisdiction: { state: "PR" }, status: "unsupported" });
    expect(checkCoverage({ state: "DC" })).toMatchObject({ status: "unsupported" });
    expect(checkCoverage({ state: "PR" })).not.toHaveProperty("documents");
    expect(coverageStatus("pr/adjuntas")).toBe("unsupported");
  });

  it("rejects unknown input with a way forward", () => {
    expect(checkCoverage({ fips: "99999" })).toHaveProperty("error");
    expect(checkCoverage({ state: "XX" })).toHaveProperty("error");
    expect(checkCoverage({ state: "CA", county: "Nowhere" })).toHaveProperty("error");
    expect(checkCoverage({})).toHaveProperty("error");
  });
});
