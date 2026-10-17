import { afterEach, describe, expect, it, vi } from "vitest";
import { getAllLoans } from "../clients/graphql.js";
import { LOAN_PAGE_BUDGET, MAX_LOANS, loansMayBeIncomplete } from "../clients/budgets.js";

function stubLoanPages(pageSizes: number[]) {
  const fetchMock = vi.fn(async () => {
    const size = pageSizes.shift() ?? 100;
    const loans = Array.from({ length: size }, (_, i) => ({ loanId: String(i) }));
    return new Response(JSON.stringify({ data: { loans } }), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getAllLoans page budget", () => {
  it("stops at the last short page", async () => {
    const fetchMock = stubLoanPages([100, 16]);
    const loans = await getAllLoans();
    expect(loans).toHaveLength(116);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(loansMayBeIncomplete(loans)).toBe(false);
  });

  it("stops at the budget and flags the totals as possibly incomplete", async () => {
    const fetchMock = stubLoanPages([]);
    const loans = await getAllLoans();
    expect(fetchMock).toHaveBeenCalledTimes(LOAN_PAGE_BUDGET);
    expect(loans).toHaveLength(MAX_LOANS);
    expect(loansMayBeIncomplete(loans)).toBe(true);
  });
});
