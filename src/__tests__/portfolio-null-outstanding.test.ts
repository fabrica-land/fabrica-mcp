import { describe, it, expect, vi } from "vitest";

vi.mock("../clients/graphql.js", () => ({
  getToken: vi.fn(),
  getWallet: vi.fn(),
}));

import { getWallet } from "../clients/graphql.js";
import { getPortfolio } from "../tools/portfolio.js";
import type { WalletModel } from "../types/index.js";

const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";

describe("get_portfolio with a null totalOutstandingLoansUSDC", () => {
  it("returns no error and a null outstandingLoans", async () => {
    const wallet = {
      address: ADDRESS,
      user: { displayName: null },
      tokens: [],
      tokenCount: "0",
      totalValue: "0",
      totalAcres: "0",
      totalCollateralValue: "0",
      totalOutstandingLoansUSDC: null,
      propertyCountUnderLoan: "0",
      creditHistory: null,
      activity: [],
      loansTaken: null,
      loansMade: null,
      marketplaceOffersMade: null,
    } as unknown as WalletModel;
    vi.mocked(getWallet).mockResolvedValueOnce(wallet);
    const result = await getPortfolio({ address: ADDRESS });
    expect(result).not.toHaveProperty("error");
    expect(result).toMatchObject({ lending: { asBorrower: { outstandingLoans: null } } });
  });
});
