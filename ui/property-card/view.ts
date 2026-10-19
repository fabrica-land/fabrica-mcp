// Pure view logic for the property card: layout choice from the host context, and the
// fact lines built from the get_land_property result. No DOM access, so it is unit tested.

export type Layout = "compact" | "regular";
export type DisplayMode = "inline" | "fullscreen" | "pip";

/** The host context fields the card reads (MCP Apps McpUiHostContext, all optional). */
export interface HostContextLike {
  displayMode?: DisplayMode;
  availableDisplayModes?: DisplayMode[];
  platform?: "web" | "desktop" | "mobile";
  containerDimensions?: { width?: number; maxWidth?: number };
  deviceCapabilities?: { touch?: boolean; hover?: boolean };
  safeAreaInsets?: { top: number; right: number; bottom: number; left: number };
}

/** Below this container width the card uses one column whatever the platform. */
export const COMPACT_MAX_WIDTH = 480;
/** On a mobile host the compact layout holds up to this width. */
export const MOBILE_COMPACT_MAX_WIDTH = 700;
/** A screen whose short side is under this is a phone, so it stays compact in landscape too. */
export const PHONE_MAX_SHORT_SIDE = 600;

/**
 * The width the card lays out against: the host's fixed or maximum container width when it
 * sends one, else the frame's own width.
 */
export function layoutWidth(context: HostContextLike | undefined, viewportWidth: number): number {
  const dims = context?.containerDimensions;
  const hostWidth = dims?.width ?? dims?.maxWidth;
  return typeof hostWidth === "number" && hostWidth > 0 ? Math.min(hostWidth, viewportWidth || hostWidth) : viewportWidth;
}

/**
 * `screenShortSide` is the device screen's shorter side: a mobile host on a phone stays compact
 * in landscape, while a tablet in portrait (820 px and up) gets the regular layout.
 */
export function chooseLayout(context: HostContextLike | undefined, viewportWidth: number, screenShortSide = 0): Layout {
  const width = layoutWidth(context, viewportWidth);
  if (width > 0 && width < COMPACT_MAX_WIDTH) return "compact";
  if (context?.platform !== "mobile") return "regular";
  if (width < MOBILE_COMPACT_MAX_WIDTH) return "compact";
  return screenShortSide > 0 && screenShortSide < PHONE_MAX_SHORT_SIDE ? "compact" : "regular";
}

/**
 * Hover details only where the device can hover. Without the capability the host did not
 * say, so fall back to the frame's own media query.
 */
export function canHover(context: HostContextLike | undefined, mediaHover: boolean): boolean {
  const hover = context?.deviceCapabilities?.hover;
  return typeof hover === "boolean" ? hover : mediaHover;
}

export function safeArea(context: HostContextLike | undefined): { top: number; right: number; bottom: number; left: number } {
  const insets = context?.safeAreaInsets;
  const px = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
  return { top: px(insets?.top), right: px(insets?.right), bottom: px(insets?.bottom), left: px(insets?.left) };
}

const SOURCE_LABELS: Record<string, string> = {
  prycd: "Prycd",
  "fabrica-avm": "Fabrica AVM",
  "regrid-county-assessor": "County assessor",
};

interface PricingEntry {
  source?: unknown;
  scope?: unknown;
  asOf?: unknown;
  value?: unknown;
}

/** "lastSale" -> "last sale"; nothing for a missing scope. */
export function scopeLabel(scope: unknown): string | null {
  if (typeof scope !== "string" || scope === "") return null;
  return scope.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

/**
 * The line under the estimate: which source it equals, and the county assessor's figure
 * (with its scope, preferring the whole parcel) when it differs. Nothing when no source matches (the estimate is shown on its own).
 */
export function estimateSourceLine(estimate: string | null, pricing: PricingEntry[]): string | null {
  if (!estimate) return null;
  const parts: string[] = [];
  // Prefer a valuation source; the county assessor is named only when it is the one the estimate equals.
  const match = pricing.find((p) => p.value === estimate && typeof p.source === "string" && p.source !== "regrid-county-assessor")
    ?? pricing.find((p) => p.value === estimate && p.source === "regrid-county-assessor");
  if (match && typeof match.source === "string") {
    const date = shortDate(match.asOf);
    parts.push([SOURCE_LABELS[match.source] ?? match.source, date].filter(Boolean).join(", "));
  }
  // A last sale is history, not an assessment, so it never stands in for the assessor's figure here.
  const assessments = pricing.filter((p) => p.source === "regrid-county-assessor" && typeof p.value === "string" && p.scope !== "lastSale");
  const assessor = assessments.find((p) => p.scope === "parcel") ?? assessments[0];
  if (assessor && typeof assessor.value === "string" && assessor.value !== estimate) {
    const scope = scopeLabel(assessor.scope);
    parts.push(`assessor${scope ? ` ${scope}` : ""} ${assessor.value}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

interface CheckResult {
  check?: unknown;
  passed?: unknown;
}

/** Names of the Property checks that did not pass, in the API's order. */
export function failedChecks(results: CheckResult[]): string[] {
  return results.flatMap((r) => (r.passed === false && typeof r.check === "string" ? [r.check] : []));
}

/** "2 not passed" under the pass count, or "All pass"; nothing without a count. */
export function checksSubline(passed: number | null, total: number | null): string | null {
  if (passed === null || total === null || total <= 0) return null;
  const missing = total - passed;
  return missing <= 0 ? "All pass" : `${missing} not passed`;
}

/** Whole USDC from a "966 USDC" string, rounded down; null when there is no capacity. */
export function usdcAmount(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const amount = Math.floor(Number.parseFloat(value.replace(/,/g, "")));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

/** Status chip text for the property's taxes, or nothing when unknown. */
export function taxChip(status: unknown): string | null {
  if (status === "current") return "Taxes current";
  if (status === "delinquent") return "Taxes past due";
  return null;
}

export function isFullscreen(context: HostContextLike | undefined): boolean {
  return context?.displayMode === "fullscreen";
}

/** The Expand control shows only when the host offers fullscreen and the card is not in it. */
export function canExpand(context: HostContextLike | undefined): boolean {
  return !isFullscreen(context) && (context?.availableDisplayModes ?? []).includes("fullscreen");
}

export type Tab = "Overview" | "Value" | "Lending" | "Documents" | "Activity";
export const TABS: readonly Tab[] = ["Overview", "Value", "Lending", "Documents", "Activity"];

/**
 * Pricing sources that returned a value, each labelled with its scope (land, parcel, last sale)
 * so figures from one source stay distinguishable, and dated. Exact repeats are dropped.
 */
export function pricingRows(pricing: PricingEntry[]): { label: string; value: string; asOf: string | null }[] {
  const rows: { label: string; value: string; asOf: string | null }[] = [];
  for (const p of pricing) {
    if (typeof p.source !== "string" || typeof p.value !== "string" || p.value.trim() === "") continue;
    const scope = scopeLabel(p.scope);
    const label = [SOURCE_LABELS[p.source] ?? p.source, scope].filter(Boolean).join(", ");
    if (!rows.some((r) => r.label === label && r.value === p.value)) rows.push({ label, value: p.value, asOf: shortDate(p.asOf) });
  }
  return rows;
}

// Buttons may only open Fabrica's own pages over https.
const FABRICA_HOSTS = new Set(["fabrica.land", "testnets.fabrica.land"]);

/** The property page link when it is one of Fabrica's own pages over https; null otherwise. */
export function fabricaUrl(link: string | null): string | null {
  if (!link) return null;
  try {
    const url = new URL(link);
    return url.protocol === "https:" && FABRICA_HOSTS.has(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

const IPFS_GATEWAY = "https://ipfs.fabrica.land/ipfs/";
const DOCUMENT_HOSTS = new Set(["ipfs.fabrica.land", "fabrica.land", "testnets.fabrica.land"]);

/** A document link on Fabrica's own hosts: ipfs:// URIs go to its gateway, other hosts are dropped. */
export function documentUrl(uri: unknown): string | null {
  if (typeof uri !== "string") return null;
  const cid = /^ipfs:\/\/(?:ipfs\/)?([A-Za-z0-9]+(?:\/[^\s]*)?)$/.exec(uri.trim());
  if (cid) return IPFS_GATEWAY + cid[1];
  try {
    const url = new URL(uri);
    return url.protocol === "https:" && DOCUMENT_HOSTS.has(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

const ACTIVITY_LABELS: Record<string, string> = {
  ScoreChanged: "Property checks updated",
  Transfer: "Transferred",
  OperatingAgreementUpdated: "Trust agreement updated",
  MarketplaceListingStarted: "Listed for sale",
  MarketplaceListingExpired: "Listing expired",
  MarketplaceListingCanceled: "Listing canceled",
  MarketplaceSale: "Sold",
  LoanStarted: "Loan started",
  LoanRepaid: "Loan repaid",
  LoanRefinanced: "Loan refinanced",
  LoanLiquidated: "Loan liquidated",
  Minted: "Minted",
};

/** "LoanRepaid" -> "Loan repaid"; unknown types are split from CamelCase. */
export function activityLabel(type: unknown): string {
  if (typeof type !== "string" || type === "") return "Activity";
  if (ACTIVITY_LABELS[type]) return ACTIVITY_LABELS[type];
  const words = type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "2026-06-30T22:04:23Z" -> "Jun 30, 2026" (UTC, so the day does not shift with the viewer). */
export function shortDate(iso: unknown): string | null {
  if (typeof iso !== "string") return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
