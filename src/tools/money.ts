import { IS_MAINNET } from "../config.js";
import { getTokenPayments } from "../clients/graphql.js";
import { ethCall } from "../clients/rpc.js";
import { PLATFORM_URL } from "../links.js";
import type { AccountAuth } from "../auth/token.js";
import type { TokenPayment } from "../types/index.js";

/**
 * Dollars in and out. Paying in: the sign page of a purchase, a loan payoff or a pool deposit also
 * takes a card, a bank transfer or a wire, and those payments are followed here. Paying out: the
 * USDC a sale or a loan leaves in an account, and the link to Cash out on fabrica.land, where the
 * owner sends it to a bank account or card. Nothing here moves money.
 */

/** USDC, the stablecoin Fabrica's marketplace and lending pool settle in (6 decimals). */
export const USDC_ADDRESS = IS_MAINNET
  ? "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
  : "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

/** Below a dollar a balance is dust: not worth a cash out. */
export const CASH_OUT_MIN_USD = 1;

/** Said on a purchase or a payoff: the sign page offers dollars too. */
export const PAY_IN_DOLLARS_LINE =
  "The sign page also offers paying in dollars by card, bank transfer or wire, depending on the amount; bank transfer and wire need a one-time identity check. A payment in dollars completes once it clears, which can take a few business days; get_sign_request follows it.";

/** The owner's Cash out on fabrica.land, for this account (wallet address). */
export function cashOutLink(wallet: string): string {
  return `${PLATFORM_URL}/profile/${wallet.toLowerCase()}?action=cashout`;
}

/** balanceOf(address) */
const BALANCE_OF = "0x70a08231";

/** The account's USDC balance in dollars, read from the chain; null when the read fails. */
export async function usdcBalance(wallet: string): Promise<number | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return null;
  try {
    const data = await ethCall(USDC_ADDRESS, `${BALANCE_OF}${wallet.slice(2).toLowerCase().padStart(64, "0")}`);
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(data)) return null;
    return Number(BigInt(data)) / 1e6;
  } catch {
    return null;
  }
}

/** Dollars to the cent, floored, so a balance is never shown above what is there. */
export function dollars(amount: number): string {
  const cents = Math.floor(amount * 100 + 1e-6) / 100;
  return `$${cents.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** How each payment stage reads, as fabrica.land says it. */
const PHASE: Record<TokenPayment["phase"], string> = {
  WaitingOnBank: "Waiting on the bank",
  ConvertingToUsdc: "Payment received, converting to USDC",
  EnteringTick: "Converted, being applied onchain",
  BankFailed: "The payment failed",
  Expired: "The wire was not received in time",
  DepositReverted: "The deposit could not be applied",
};

const METHOD: Record<string, string> = { creditCard: "card", ach: "bank transfer", wire: "wire" };

/** The API's action names for each sign request a dollar payment can pay. */
const PAYMENT_ACTIONS: Record<"buy_land" | "repay_loan_against_land", readonly string[]> = {
  buy_land: ["buy property", "checkout"],
  repay_loan_against_land: ["repay loan"],
};

export function paysInDollars(action: string): action is keyof typeof PAYMENT_ACTIONS {
  return action === "buy_land" || action === "repay_loan_against_land";
}

/** A payment this request may have started: the request's account and action, made while its link was open. */
export interface DollarPayment {
  method: string;
  stage: string;
  failed: boolean;
  totalUsd: string;
  startedAt: string;
  expectedBy: string | null;
}

/** A payment row with the fields a match needs: the API leaves them null for a caller it does not show them to. */
type ReadablePayment = TokenPayment & { walletAddress: string; createdAt: string; method: string; total: string };

function isReadable(payment: TokenPayment): payment is ReadablePayment {
  return payment.walletAddress != null && payment.createdAt != null && payment.method != null && payment.total != null;
}

/**
 * The newest payment the request's account started on its property while the link was open, or null.
 * `as` reads the payments as the connected person (see getTokenPayments). A row whose payer or
 * dates the API did not return is not this request's payment.
 */
export async function findDollarPayment(record: { action: string; wallet: string; createdAt: string; expiresAt: string; property?: { tokenId: string } }, as?: AccountAuth): Promise<DollarPayment | null> {
  if (!paysInDollars(record.action) || !record.property) return null;
  const actions = PAYMENT_ACTIONS[record.action];
  const from = Date.parse(record.createdAt) - 1000;
  const to = Date.parse(record.expiresAt);
  const payments = await getTokenPayments(record.property.tokenId, as);
  const match = payments
    .filter(isReadable)
    .filter(p => p.walletAddress.toLowerCase() === record.wallet.toLowerCase() && actions.includes(p.action))
    .filter(p => { const at = Date.parse(p.createdAt); return at >= from && at <= to; })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!match) return null;
  const failed = match.phase === "BankFailed" || match.phase === "Expired" || match.phase === "DepositReverted";
  const total = Number.parseFloat(match.total);
  return {
    method: METHOD[match.method] ?? match.method,
    stage: PHASE[match.phase] ?? match.phase,
    failed,
    totalUsd: Number.isFinite(total) ? dollars(total) : match.total,
    startedAt: match.createdAt,
    expectedBy: failed ? null : match.eta,
  };
}

/** The dollars (USDC) an account holds, and where to cash them out. */
export interface MoneyInWallet {
  /** USDC held, in dollars; absent when the chain could not be read. */
  balanceUsd?: string;
  /** fabrica.land Cash out for this account, when it holds at least a dollar. */
  cashOut?: string;
}

export const CASH_OUT_NOTE = "Dollars from a sale or a loan arrive as USDC in the account. Cash out on fabrica.land (the cashOut link, signed in with that account) sends them to a bank account or card, with the fee and arrival shown before anything is sent.";

/** Each wallet with its USDC balance and, from a dollar up, its Cash out link. */
export async function withMoney<T extends { address: string }>(wallets: T[]): Promise<Array<T & MoneyInWallet>> {
  const balances = await Promise.all(wallets.map(wallet => usdcBalance(wallet.address)));
  return wallets.map((wallet, index) => {
    const balance = balances[index];
    if (balance === null) return wallet;
    return { ...wallet, balanceUsd: dollars(balance), ...(balance >= CASH_OUT_MIN_USD ? { cashOut: cashOutLink(wallet.address) } : {}) };
  });
}
