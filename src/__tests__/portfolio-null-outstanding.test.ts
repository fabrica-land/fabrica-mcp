import { describe, it, expect, vi } from "vitest";

vi.mock("../clients/graphql.js", () => ({
  getToken: vi.fn(),
  getWallet: vi.fn(),
}));

import { getWallet } from "../clients/graphql.js";
import { getPortfolio } from "../tools/portfolio.js";
import { wallet } from "./fixtures.js";

const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";

describe("get_portfolio with a null totalOutstandingLoansUSDC", () => {
  it("returns no error and a null outstandingLoans", async () => {
    const portfolioWallet = wallet({
      address: ADDRESS,
      totalOutstandingLoansUSDC: null,
      loansTaken: null,
      loansMade: null,
      marketplaceOffersMade: null,
    });
    vi.mocked(getWallet).mockResolvedValueOnce(portfolioWallet);
    const portfolio = await getPortfolio({ address: ADDRESS });
    expect(portfolio).not.toHaveProperty("error");
    expect(portfolio).toMatchObject({ lending: { asBorrower: { outstandingLoans: null } } });
  });
});
