import { describe, expect, it } from "vitest";
import { loanVolumeByCurrency } from "../labels.js";

describe("loanVolumeByCurrency", () => {
  it("totals principal per currency and never mixes currencies into dollars", () => {
    const volume = loanVolumeByCurrency([
      { principalScaled: "1000", currencySymbol: "USDC" },
      { principalScaled: "500.4", currencySymbol: "USDC" },
      { principalScaled: "1", currencySymbol: "WETH" },
      { principalScaled: null, currencySymbol: "WETH" },
    ]);
    expect(volume).toEqual({ USDC: "1,500 USDC", WETH: "1 WETH" });
    expect(JSON.stringify(volume)).not.toContain("$");
  });
});
