import { describe, it, expect } from "vitest";

describe("config", () => {
  it("defaults to ethereum mainnet", async () => {
    // Config is evaluated at import time using process.env
    // Default (no FABRICA_NETWORK set) should be ethereum
    const { NETWORK, IS_MAINNET, NETWORK_LABEL, CONTRACTS, MAINNET_WARNING, MAINNET_LEGAL_NOTICE } = await import("../config.js");
    expect(NETWORK).toBe("ethereum");
    expect(IS_MAINNET).toBe(true);
    expect(NETWORK_LABEL).toBe("Ethereum Mainnet");
    expect(CONTRACTS.fabricaToken).toBe("0x5cbeb7A0df7Ed85D82a472FD56d81ed550f3Ea95");
    expect(CONTRACTS.nftfiV2).toBeTruthy();
    expect(CONTRACTS.nftfiV3).toBeTruthy();
    expect(MAINNET_WARNING).toBeTruthy();
    expect(MAINNET_LEGAL_NOTICE).toContain("IMPORTANT LEGAL NOTICE");
    expect(MAINNET_LEGAL_NOTICE).toContain("trustee");
    expect(MAINNET_LEGAL_NOTICE).toContain("tax");
    expect(MAINNET_LEGAL_NOTICE).toContain("trust instrument");
  });

  it("has legal notice covering key obligations", async () => {
    const { MAINNET_LEGAL_NOTICE } = await import("../config.js");
    // The legal notice must cover these key areas
    expect(MAINNET_LEGAL_NOTICE).toContain("beneficial owner");
    expect(MAINNET_LEGAL_NOTICE).toContain("trustee");
    expect(MAINNET_LEGAL_NOTICE).toContain("property taxes");
    expect(MAINNET_LEGAL_NOTICE).toContain("capital gains");
    expect(MAINNET_LEGAL_NOTICE).toContain("operating agreement");
    expect(MAINNET_LEGAL_NOTICE).toContain("trust instrument");
    expect(MAINNET_LEGAL_NOTICE).toContain("not financial or legal advice");
  });

  it("mainnet contracts have all required addresses", async () => {
    const { CONTRACTS } = await import("../config.js");
    // All mainnet contracts must be non-null
    expect(CONTRACTS.fabricaToken).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(CONTRACTS.fabricaValidator).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(CONTRACTS.nftfiV2).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(CONTRACTS.nftfiV3).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });
});
