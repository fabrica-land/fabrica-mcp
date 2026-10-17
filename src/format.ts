/** Shared output formatting: amounts with their symbol, durations in days, no raw units in prose fields. */

const STABLECOINS = new Set(["USDC", "USDT", "DAI"]);

/** "$12,500" for a positive USD decimal string; null when missing, unparseable or zero. */
export function formatUsdOrNull(value: string | null | undefined): string | null {
  const num = Number.parseFloat(value ?? "");
  if (!Number.isFinite(num) || num === 0) return null;
  return `$${num.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

/**
 * Headline estimate for a property. The API returns "0.00" (not null) when no valuation source
 * qualifies for a headline estimate, so zero is reported as "no estimate" with the reason, never "$0".
 */
export function estimateFields(
  value: string | null | undefined,
  pricing?: ReadonlyArray<{ value: string | null }>,
): { estimatedValue: string } | { estimatedValue: null; estimateNote: string } {
  const formatted = formatUsdOrNull(value);
  if (formatted) return { estimatedValue: formatted };
  if (pricing === undefined) {
    return { estimatedValue: null, estimateNote: "No estimate: no valuation source qualifies for a headline estimate. get_property lists the source values." };
  }
  return {
    estimatedValue: null,
    estimateNote: !pricing.some(p => Number.parseFloat(p.value ?? "") > 0)
      ? "No estimate: no valuation source has a value for this property yet."
      : "No estimate: no valuation source qualifies for a headline estimate (an automated valuation below the confidence threshold does not count). Source values are listed under pricing.",
  };
}

/** An already-scaled token amount with its symbol: "429 USDC", "0.25 WETH". */
export function formatTokenAmount(scaled: string | null | undefined, symbol: string | null | undefined): string | null {
  const num = Number.parseFloat(scaled ?? "");
  if (!Number.isFinite(num)) return null;
  const digits = symbol && !STABLECOINS.has(symbol) ? 4 : 2;
  return `${num.toLocaleString("en-US", { maximumFractionDigits: digits })} ${symbol ?? ""}`.trim();
}

/** A raw integer token amount scaled by its decimals: ("543223339", 6, "USDC") → "543.22 USDC". */
export function formatRawTokenAmount(raw: string | null | undefined, decimals: number, symbol: string | null | undefined): string | null {
  const num = Number.parseFloat(raw ?? "");
  if (!Number.isFinite(num)) return null;
  return formatTokenAmount(String(num / 10 ** decimals), symbol);
}

/** Seconds as whole days: 7776000 → "90 days". */
export function formatDurationDays(seconds: string | number | null | undefined): string | null {
  const num = typeof seconds === "number" ? seconds : Number.parseFloat(seconds ?? "");
  if (!Number.isFinite(num)) return null;
  const days = Math.round(num / 86400);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** Unix seconds as an ISO timestamp. */
export function formatUnixTime(seconds: string | number | null | undefined): string | null {
  const num = typeof seconds === "number" ? seconds : Number.parseFloat(seconds ?? "");
  if (!Number.isFinite(num)) return null;
  return new Date(num * 1000).toISOString();
}

/** Active loans first, then most recently started first. */
export function sortLoans<T extends { loanStatus: string; startTime: string | null }>(loans: ReadonlyArray<T>): T[] {
  const time = (l: T) => {
    const t = Date.parse(l.startTime ?? "");
    return Number.isFinite(t) ? t : 0;
  };
  return [...loans].sort((a, b) => {
    const activeA = a.loanStatus === "Active" ? 0 : 1;
    const activeB = b.loanStatus === "Active" ? 0 : 1;
    return activeA - activeB || time(b) - time(a);
  });
}
