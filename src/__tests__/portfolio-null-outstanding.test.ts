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
    const totalOutstandingLoansUSDC: WalletModel["totalOutstandingLoansUSDC"] = null;
    const wallet = {
      address: ADDRESS,
      user: { displayName: null },
      tokens: [],
      tokenCount: "0",
      totalValue: "0",
      totalAcres: "0",
      totalCollateralValue: "0",
      totalOutstandingLoansUSDC,
      propertyCountUnderLoan: "0",
      creditHistory: null,
      activity: [],
      loansTaken: null,
      loansMade: null,
      marketplaceOffersMade: null,
    };
    vi.mocked(getWallet).mockResolvedValueOnce(wallet as never);
    const portfolio = await getPortfolio({ address: ADDRESS });
    expect(portfolio).not.toHaveProperty("error");
    expect(portfolio).toMatchObject({ lending: { asBorrower: { outstandingLoans: null } } });
  });
});
