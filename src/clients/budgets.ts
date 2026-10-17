/** Upper bounds on how much a single tool call reads from the API. */

export const LOAN_PAGE_SIZE = 100;
export const LOAN_PAGE_BUDGET = 50;

/**
 * Most loans `getAllLoans` reads. Mainnet holds about 120, so this bounds a runaway walk without
 * truncating today's data; a tool that reaches it says its loan totals may be incomplete.
 */
export const MAX_LOANS = LOAN_PAGE_SIZE * LOAN_PAGE_BUDGET;

export const LOANS_INCOMPLETE_NOTE = `Loan totals cover the first ${MAX_LOANS.toLocaleString("en-US")} loan records the API returned and may be incomplete.`;

export function loansMayBeIncomplete(loans: ReadonlyArray<unknown>): boolean {
  return loans.length >= MAX_LOANS;
}
