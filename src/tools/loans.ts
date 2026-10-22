// Borrow and repay as sign requests, and one loan's state. borrow_against_land and
// repay_land_loan check the pool and the token's loans, then return a sign link that opens the
// borrow or payoff dialog on fabrica.land, prefilled. The person signs there with their own wallet;
// the server holds no key and submits nothing. get_land_loan reads one loan's state and payoff.
import { z } from "zod";
import { getAllLoans, getLoanContext, isTokenNotFound } from "../clients/graphql.js";
import { IS_MAINNET, NETWORK_LABEL } from "../config.js";
import { describeAppraisalBlock, formatLoanProvider, LENDING_POOL_NAME } from "../labels.js";
import { formatTokenAmount, shortenAddress } from "../format.js";
import type { LoanContextLoan, LoanContextToken } from "../types/index.js";
import type { SignRequestWarning } from "../sign-requests/store.js";
import { type ArgsOf, propertyRefInputs } from "./inputs.js";
import { type Blocked, holds, issue, label, lookup, type Prepared, propertyOf, same, shorten, signLink, usd } from "./sign-requests.js";

const DAY_SECONDS = 86_400;
/** With no loan length asked for, the one offered closest to 30 days. */
const DEFAULT_DURATION_DAYS = 30;

export const LOAN_OBLIGATION = "A loan is a real obligation: the repayment is due at maturity, and a loan not repaid by then lets the lender take the property through the pool's auction. Nothing here is financial advice.";

const walletInput = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "A 0x-prefixed Ethereum address").describe("The wallet that will sign (0x address). The sign page only lets this wallet sign.");
const loanIdInput = z.string().regex(/^[0-9]{1,100}$/, "A loan id: digits, as get_land_loan or estimate_land_borrowing return it");

/** Past maturity a pool loan shows Default until its auction starts, and the borrower can still pay it off. */
function isOpen(loan: LoanContextLoan): boolean {
  return loan.loanStatus === "Active" || loan.loanStatus === "Default";
}

function openLoans(token: LoanContextToken): LoanContextLoan[] {
  return (token.loans ?? []).filter(isOpen);
}

/** The loan length the pool offers closest to the one asked for, ties to the shorter. */
export function closestDuration(offeredSeconds: readonly number[], wantedDays: number): number | null {
  const days = [...new Set(offeredSeconds.map(s => Math.round(s / DAY_SECONDS)))].filter(d => d > 0).sort((a, b) => a - b);
  return days.reduce<number | null>((best, d) => best === null || Math.abs(d - wantedDays) < Math.abs(best - wantedDays) ? d : best, null);
}

async function loanContext(tokenId: string): Promise<LoanContextToken | { error: string }> {
  try {
    return await getLoanContext({ tokenId });
  } catch (e) {
    return { error: `Failed to load the property's loans: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// --- borrow_against_land ---

export const borrowInput = {
  ...propertyRefInputs,
  amountUsd: z.number().min(1).max(100_000_000).describe("Principal to borrow in US dollars, paid in USDC; at most what estimate_land_borrowing shows as maxBorrow"),
  durationDays: z.number().int().min(1).max(3650).optional().describe(`Loan length in days. The sign page uses the pool's offered length closest to it (default: the one closest to ${DEFAULT_DURATION_DAYS} days)`),
  wallet: walletInput,
};
export type BorrowArgs = ArgsOf<typeof borrowInput>;

export async function prepareBorrow({ tokenId, slug, amountUsd, durationDays, wallet }: BorrowArgs): Promise<Prepared | Blocked> {
  const found = await lookup(tokenId, slug);
  if ("error" in found) return found;
  const { token } = found;
  const context = await loanContext(token.tokenId);
  if ("error" in context) return context;
  if (openLoans(context).length > 0 || context.poolLendingLiquidity?.activeLoan || Number.parseInt(token.supplyUnderLoan || "0", 10) > 0) {
    return { error: `${label(token)} already backs an active loan; repay_land_loan prepares paying it off before a new loan.` };
  }
  if (!holds(token, wallet)) return { error: `Wallet ${shorten(wallet)} does not hold ${label(token)}; only its owner can borrow against it.` };
  const pool = context.poolLendingLiquidity;
  const blocked = describeAppraisalBlock(pool?.appraisalBlockReason);
  if (blocked) return { error: `The ${LENDING_POOL_NAME} does not lend against this property right now: ${blocked}` };
  const maxBorrow = Number.parseFloat(pool?.maxPrincipalScaled ?? "0");
  if (!pool || !Number.isFinite(maxBorrow) || maxBorrow <= 0) return { error: `The ${LENDING_POOL_NAME} shows no borrowing capacity for ${label(token)} right now. estimate_land_borrowing explains why and what would raise it.` };
  const amount = Math.round(amountUsd * 100) / 100;
  if (amount > maxBorrow) return { error: `${usd(amount)} is above the ${usd(Math.floor(maxBorrow * 100) / 100)} the ${LENDING_POOL_NAME} offers against ${label(token)} right now.` };
  const wanted = durationDays ?? DEFAULT_DURATION_DAYS;
  const days = closestDuration(pool.durations, wanted);
  if (days === null) return { error: `The ${LENDING_POOL_NAME} offers no loan length for ${label(token)} right now.` };
  const warnings: SignRequestWarning[] = [];
  if (durationDays !== undefined && days !== durationDays) warnings.push({ level: "info", message: `The pool does not offer ${durationDays} days; the closest length it offers is ${days} days, and the sign page uses that.` });
  if (amount > maxBorrow * 0.9) warnings.push({ level: "warning", message: `${usd(amount)} is close to the pool's current maximum of ${usd(Math.floor(maxBorrow * 100) / 100)}; the live quote on the sign page can come out lower.` });
  const maturity = new Date(Date.now() + days * DAY_SECONDS * 1000).toISOString().slice(0, 10);
  return {
    action: "borrow_against_land",
    kind: "transaction",
    wallet,
    property: propertyOf(token),
    loan: { amountUsd: amount, durationDays: days },
    summary: [
      `Borrow ${usd(amount)} in USDC from the ${LENDING_POOL_NAME} against ${label(token)} on ${NETWORK_LABEL}, for ${days} days (maturity about ${maturity}).`,
      "The interest rate and the repayment amount come from the pool's live quote; the sign page shows both before signing.",
      "Signing sends an onchain transaction from this wallet: the token moves into the pool's loan wrapper as collateral and the USDC comes to this wallet. The wallet pays the network fee.",
      "If the wallet has not yet allowed the loan wrapper to hold its Fabrica token, the sign page asks for that approval first.",
      ...(IS_MAINNET ? [LOAN_OBLIGATION] : ["Sepolia testnet: test USDC and test properties, no real-world effect."]),
    ],
    warnings,
    link: id => signLink(token.tokenId, { action: "borrow", amount: amount.toFixed(2).replace(/\.00$/, ""), duration: String(days) }, id),
  };
}

// --- repay_land_loan ---

export const repayInput = {
  ...propertyRefInputs,
  loanId: loanIdInput.optional().describe("The loan to pay off (default: the property's open loan, active or in default)"),
  wallet: walletInput,
};
export type RepayArgs = ArgsOf<typeof repayInput>;

export async function prepareRepay({ tokenId, slug, loanId, wallet }: RepayArgs): Promise<Prepared | Blocked> {
  const found = await lookup(tokenId, slug);
  if ("error" in found) return found;
  const { token } = found;
  const context = await loanContext(token.tokenId);
  if ("error" in context) return context;
  const active = openLoans(context);
  const loan = loanId ? active.find(l => l.loanId === loanId) : active[0];
  if (!loan) {
    const other = loanId ? (context.loans ?? []).find(l => l.loanId === loanId) : undefined;
    if (other) return { error: `Loan ${loanId} on ${label(token)} is ${other.loanStatus.toLowerCase()}, no longer open, so there is nothing to pay off.` };
    return { error: loanId ? `No loan ${loanId} on ${label(token)}. get_land_loan lists its loans.` : `${label(token)} has no open loan to pay off.` };
  }
  if (!same(loan.borrower.address, wallet)) return { error: `Loan ${loan.loanId} was taken by ${shorten(loan.borrower.address)}; only its borrower can pay it off from the sign page.` };
  if (loan.loanProvider !== "PoolLending") return { error: `Loan ${loan.loanId} is a ${formatLoanProvider(loan.loanProvider) ?? loan.loanProvider} loan; only ${LENDING_POOL_NAME} loans can be paid off from a sign link.` };
  const payoff = Number.parseFloat(loan.livePayoffScaled ?? loan.maxRepaymentScaled);
  const payoffText = Number.isFinite(payoff) ? `${usd(payoff)} in USDC` : "the payoff the sign page shows";
  const warnings: SignRequestWarning[] = [];
  const maturity = Date.parse(loan.maturityDate);
  if (Number.isFinite(maturity) && maturity < Date.now()) warnings.push({ level: "warning", message: `The loan matured on ${loan.maturityDate.slice(0, 10)}; once the pool starts its auction it can no longer be paid off.` });
  return {
    action: "repay_land_loan",
    kind: "transaction",
    wallet,
    property: propertyOf(token),
    loan: { loanId: loan.loanId },
    summary: [
      `Pay off loan ${loan.loanId} on ${label(token)} on ${NETWORK_LABEL}: about ${payoffText} today${loan.livePayoffScaled ? "" : " (the full repayment; the pool's live payoff can be lower)"}.`,
      `Principal ${formatTokenAmount(loan.principalScaled, loan.currencySymbol ?? "USDC")}, maturity ${loan.maturityDate.slice(0, 10)}.`,
      "Signing sends an onchain transaction from this wallet: the USDC goes to the pool and the token comes back to this wallet, free of the loan. The wallet pays the network fee.",
      "If the wallet has not yet allowed the pool to use its USDC for the repayment, the sign page asks for that approval first.",
    ],
    warnings,
    link: id => signLink(token.tokenId, { action: "repay", loan: loan.loanId }, id),
  };
}

export const borrowAgainstLand = async (args: BorrowArgs) => issue(await prepareBorrow(args));
export const repayLandLoan = async (args: RepayArgs) => issue(await prepareRepay(args));

// --- get_land_loan ---

export const getLoanInput = {
  ...propertyRefInputs,
  loanId: loanIdInput.optional().describe("The loan id; with no property, the loan is looked up across the network"),
};
export type GetLoanArgs = ArgsOf<typeof getLoanInput>;

function describeLoan(loan: LoanContextLoan) {
  const active = isOpen(loan);
  const symbol = loan.currencySymbol ?? "USDC";
  return {
    loanId: loan.loanId,
    status: loan.loanStatus,
    provider: formatLoanProvider(loan.loanProvider),
    principal: formatTokenAmount(loan.principalScaled, symbol),
    apr: loan.aprPercent !== null ? `${loan.aprPercent.toFixed(1)}%` : null,
    duration: loan.durationFormatted,
    startedAt: loan.startTime,
    maturityDate: loan.maturityDate,
    fullRepayment: formatTokenAmount(loan.maxRepaymentScaled, symbol),
    ...(active ? { payoffToday: formatTokenAmount(loan.livePayoffScaled ?? loan.maxRepaymentScaled, symbol), payoffAsOf: loan.payoffAsOf, ...(loan.livePayoffScaled ? {} : { payoffNote: "The API has no live payoff for this loan; the full repayment is shown, and paying off early can cost less." }) } : {}),
    ...(loan.loanRepaidDate ? { repaidAt: loan.loanRepaidDate } : {}),
    ...(loan.loanLiquidationDate ? { liquidatedAt: loan.loanLiquidationDate } : {}),
    borrower: shortenAddress(loan.borrower.address),
    ...(loan.lender ? { lender: shortenAddress(loan.lender.address) } : {}),
  };
}

export async function getLoan({ tokenId, slug, loanId }: GetLoanArgs) {
  if (!tokenId && !slug && !loanId) return { error: "Either a property (tokenId or slug) or a loanId is required" };
  let propertyTokenId = tokenId;
  if (!tokenId && !slug && loanId) {
    try {
      const match = (await getAllLoans()).find(l => l.loanId === loanId);
      if (!match) return { error: `No loan ${loanId} on ${NETWORK_LABEL}.` };
      propertyTokenId = match.collateralId;
    } catch (e) {
      return { error: `Failed to load loans: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  let token: LoanContextToken;
  try {
    token = await getLoanContext({ tokenId: propertyTokenId, slug: propertyTokenId ? undefined : slug });
  } catch (e) {
    if (isTokenNotFound(e)) return { error: `No property found with ${propertyTokenId ? `token ID ${propertyTokenId}` : `slug ${slug}`}` };
    return { error: `Failed to load the property's loans: ${e instanceof Error ? e.message : String(e)}` };
  }
  const loans = [...(token.loans ?? [])].sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || Date.parse(b.startTime) - Date.parse(a.startTime));
  const loan = loanId ? loans.find(l => l.loanId === loanId) : loans[0];
  const property = { tokenId: token.tokenId, name: token.name ?? token.vanityName, link: token.propertyLink };
  if (!loan) return { network: NETWORK_LABEL, property, error: loanId ? `No loan ${loanId} on this property.` : "This property has no loans." };
  return {
    network: NETWORK_LABEL,
    property,
    loan: describeLoan(loan),
    ...(loans.length > 1 ? { otherLoans: loans.filter(l => l !== loan).map(l => ({ loanId: l.loanId, status: l.loanStatus, startedAt: l.startTime })) } : {}),
  };
}
