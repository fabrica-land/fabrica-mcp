import type { TokenFee, TokenFees } from "./types/index.js";

/** Fee currencies the API reports by contract address. Fabrica counts one USDC as one dollar. */
const FEE_CURRENCIES: Record<string, { symbol: string; decimals: number; dollars: boolean }> = {
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6, dollars: true }, // Ethereum Mainnet
  "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238": { symbol: "USDC", decimals: 6, dollars: true }, // Sepolia
};

const FEE_TYPES: Record<string, string> = {
  OnRamp: "On-ramp fee (adding the property to Fabrica)",
};

/** "500000000" in USDC → "$500"; an unknown currency keeps the raw amount and the contract address. */
export function formatFeeAmount(amount: string, currency: string): string {
  const known = FEE_CURRENCIES[currency.toLowerCase()];
  const raw = Number(amount);
  if (!known || !Number.isFinite(raw)) return `${amount} (raw units of token ${currency})`;
  const value = raw / 10 ** known.decimals;
  const text = value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return known.dollars ? `$${text}` : `${text} ${known.symbol}`;
}

/** The API mixes ISO strings and epoch milliseconds in fee timestamps; always return ISO 8601. */
export function isoTime(value: string): string {
  if (!/^\d+$/.test(value)) return value;
  const n = Number(value);
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
}

function feeState(fee: TokenFee): string {
  if (fee.paid) return "paid";
  if (fee.approved) return "approved, not yet paid";
  return "awaiting the owner's approval";
}

/**
 * Fees already assessed on the token, with approval and payment state. Null when there
 * are none, so a property without fees carries no empty block.
 */
export function summarizeFees(fees: TokenFees | undefined, propertyLink: string) {
  if (!fees || fees.fees.length === 0) return null;
  const currency = fees.fees[0].currency;
  const singleCurrency = fees.fees.every(f => f.currency.toLowerCase() === currency.toLowerCase());
  const outstanding = fees.fees.filter(f => !f.paid);
  const awaitingApproval = fees.fees.filter(f => !f.approved && !f.paid);
  return {
    total: singleCurrency ? formatFeeAmount(fees.totalAmount, currency) : null,
    items: fees.fees.map(f => ({
      type: FEE_TYPES[f.type] ?? f.type,
      amount: formatFeeAmount(f.amount, f.currency),
      state: feeState(f),
      assessedAt: isoTime(f.createdAt),
      ...(f.approvedAt ? { approvedAt: isoTime(f.approvedAt) } : {}),
      ...(f.paidAt ? { paidAt: isoTime(f.paidAt) } : {}),
    })),
    unpaidCount: outstanding.length,
    ...(awaitingApproval.length > 0 ? { approveAt: propertyLink, note: "The owner approves the fee on the property page." } : {}),
  };
}
