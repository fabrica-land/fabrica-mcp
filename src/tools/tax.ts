import { getTaxStatusToken, getScoreRecord, isTokenNotFound } from "../clients/graphql.js";
import { MAINNET_WARNING } from "../config.js";
import type { AppraisalBlockReason, ScoreRecord } from "../types/index.js";
import { LENDING_POOL_NAME } from "../labels.js";

const TAX_CHECK = "propertyTaxesCurrent";

export type TaxStatus = "current" | "delinquent" | "unknown";
export type TaxBasis = "check" | "lendingBlockReason" | "both" | "conflicting" | "none";

const NOT_AVAILABLE = ["the amount due", "the due date", "the county's own tax record"];

const SOURCE_NOTE = "This comes from Fabrica's Property checks, a data lookup. It is not the county's own statement; the county treasurer holds the official record.";

/** The check as the score record stores it: 1/true passes, 0/false fails, anything else was never verified. */
function checkFromRecord(record: ScoreRecord | null): boolean | null {
  const value = record?.checks[TAX_CHECK];
  if (value === 1 || value === true) return true;
  if (value === 0 || value === false) return false;
  return null;
}

/** Combines the check with the lending block reason, which the API derives from the same check. */
export function resolveTaxStatus(check: boolean | null, blockReason: AppraisalBlockReason | null | undefined): { status: TaxStatus; basis: TaxBasis } {
  // The two signals are read separately and can briefly disagree; when they do, claim neither.
  if (blockReason === "TAX_DELINQUENT" && check === true) return { status: "unknown", basis: "conflicting" };
  if (blockReason === "TAX_STATUS_UNKNOWN" && check !== null) return { status: "unknown", basis: "conflicting" };
  if (blockReason === "TAX_DELINQUENT") return { status: "delinquent", basis: check === false ? "both" : "lendingBlockReason" };
  if (blockReason === "TAX_STATUS_UNKNOWN") return { status: "unknown", basis: "lendingBlockReason" };
  if (check === true) return { status: "current", basis: "check" };
  if (check === false) return { status: "delinquent", basis: "check" };
  return { status: "unknown", basis: "none" };
}

function asOf(date: string | null): string {
  return date ? `as of ${date.slice(0, 10)}` : "in the latest check";
}

export function taxSummary(status: TaxStatus, checkedAt: string | null, isPremint = false): string {
  if (status === "current") return `Fabrica's checks found the property taxes current ${asOf(checkedAt)}.`;
  if (status === "delinquent") return `Fabrica's checks found the property taxes past due ${asOf(checkedAt)}.`;
  if (isPremint) return "Fabrica's checks have not verified the property taxes yet: this property is a premint, and the onramp collects tax evidence.";
  return "Fabrica's checks have no current tax status for this property: it was never verified, or the last verification expired.";
}

function nextSteps(status: TaxStatus): string {
  if (status === "current") return "For the amount and due date of the next installment, check the county treasurer's records.";
  if (status === "delinquent") return "The county treasurer has the amount due, any penalties and how to pay. Unpaid property taxes can lead to a tax sale.";
  return "Check the county treasurer's records for the parcel. When a property is onboarded, the onramp collects tax evidence.";
}

/** The tax signals of one token: the check from its score record and the lending block reason. */
export async function loadTaxSignals(token: {
  tokenId: string;
  contractAddress: string;
  isPremint: boolean;
  poolLendingLiquidity: { appraisalBlockReason?: AppraisalBlockReason | null } | null;
}) {
  const warnings: string[] = [];
  let record: ScoreRecord | null = null;
  if (!token.isPremint) {
    try {
      record = await getScoreRecord(token.contractAddress, token.tokenId);
    } catch (e) {
      warnings.push(`Score record unavailable, so the tax check and its dates could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // A check past its expiry, or one whose expiry cannot be read, says nothing about today.
  const expiry = record?.expiresAt ? Date.parse(record.expiresAt) : Number.NaN;
  const checkExpired = Number.isFinite(expiry) && expiry <= Date.now();
  const check = record && Number.isFinite(expiry) && !checkExpired ? checkFromRecord(record) : null;
  const blockReason = token.poolLendingLiquidity?.appraisalBlockReason ?? null;
  const resolved = resolveTaxStatus(check, blockReason);
  if (resolved.basis === "conflicting") {
    warnings.push(`Fabrica's tax check and the ${LENDING_POOL_NAME}'s tax status disagree; the two are updated separately. Try again shortly.`);
  }
  // The record's dates describe the result only when its check supports it; a result resting on
  // the block reason alone, or on disagreeing signals, has no check date to cite.
  const dated = resolved.basis === "check" || resolved.basis === "both" ? record : null;
  return {
    ...resolved,
    blockReason,
    checkExpired,
    checkedAt: dated?.updatedAt ?? null,
    nextCheckBy: dated?.expiresAt ?? null,
    warnings,
  };
}

export async function getTaxStatus(args: Record<string, unknown>) {
  const tokenId = args.tokenId as string | undefined;
  const slug = args.slug as string | undefined;
  if (!tokenId && !slug) {
    return { error: "Either tokenId or slug is required" };
  }
  try {
    const token = await getTaxStatusToken({ tokenId, slug });
    if (!token) {
      return { error: `No property found with ${tokenId ? `token ID ${tokenId}` : `slug ${slug}`}` };
    }
    const signals = await loadTaxSignals(token);
    const affectsLending = signals.blockReason === "TAX_DELINQUENT" || signals.blockReason === "TAX_STATUS_UNKNOWN";
    return {
      ...(MAINNET_WARNING ? { legalNotice: MAINNET_WARNING } : {}),
      tokenId: token.tokenId,
      name: token.name ?? token.vanityName,
      county: token.district,
      state: token.regionCode,
      status: signals.status,
      basis: signals.basis,
      summary: taxSummary(signals.status, signals.checkedAt, token.isPremint),
      checkedAt: signals.checkedAt,
      nextCheckBy: signals.nextCheckBy,
      ...(signals.checkExpired ? { checkExpired: true } : {}),
      affectsLending,
      ...(affectsLending ? { lending: `The ${LENDING_POOL_NAME} shows no borrowing capacity for this property because of its tax status.` } : {}),
      nextSteps: nextSteps(signals.status),
      whatIsNotAvailable: NOT_AVAILABLE,
      source: SOURCE_NOTE,
      ...(signals.warnings.length > 0 ? { warnings: signals.warnings } : {}),
    };
  } catch (e) {
    if (isTokenNotFound(e)) {
      return { error: `No property found with ${tokenId ? `token ID ${tokenId}` : `slug ${slug}`}` };
    }
    return { error: `Failed to get tax status: ${e instanceof Error ? e.message : String(e)}` };
  }
}
