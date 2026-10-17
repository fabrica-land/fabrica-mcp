// Pure view logic for the property card: layout choice from the host context, and the
// fact lines built from the get_property result. No DOM access, so it is unit tested.

export type Layout = "compact" | "regular";

/** The host context fields the card reads (MCP Apps McpUiHostContext, all optional). */
export interface HostContextLike {
  platform?: "web" | "desktop" | "mobile";
  containerDimensions?: { width?: number; maxWidth?: number };
  deviceCapabilities?: { touch?: boolean; hover?: boolean };
  safeAreaInsets?: { top: number; right: number; bottom: number; left: number };
}

/** Below this container width the card uses one column whatever the platform. */
export const COMPACT_MAX_WIDTH = 480;
/** On a mobile host the compact layout holds up to this width (a phone in landscape). */
export const MOBILE_COMPACT_MAX_WIDTH = 700;

/**
 * The width the card lays out against: the host's fixed or maximum container width when it
 * sends one, else the frame's own width.
 */
export function layoutWidth(context: HostContextLike | undefined, viewportWidth: number): number {
  const dims = context?.containerDimensions;
  const hostWidth = dims?.width ?? dims?.maxWidth;
  return typeof hostWidth === "number" && hostWidth > 0 ? Math.min(hostWidth, viewportWidth || hostWidth) : viewportWidth;
}

export function chooseLayout(context: HostContextLike | undefined, viewportWidth: number): Layout {
  const width = layoutWidth(context, viewportWidth);
  if (width > 0 && width < COMPACT_MAX_WIDTH) return "compact";
  if (context?.platform === "mobile" && width < MOBILE_COMPACT_MAX_WIDTH) return "compact";
  return "regular";
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
  value?: unknown;
}

/**
 * The line under the estimate: which source it equals, and the county assessor's figure
 * when it differs. Nothing when no source matches (the estimate is shown on its own).
 */
export function estimateSourceLine(estimate: string | null, pricing: PricingEntry[]): string | null {
  if (!estimate) return null;
  const parts: string[] = [];
  const match = pricing.find((p) => p.value === estimate && typeof p.source === "string" && p.source !== "regrid-county-assessor");
  if (match && typeof match.source === "string") parts.push(SOURCE_LABELS[match.source] ?? match.source);
  const assessor = pricing.find((p) => p.source === "regrid-county-assessor" && typeof p.value === "string");
  if (assessor && typeof assessor.value === "string" && assessor.value !== estimate) parts.push(`assessor ${assessor.value}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

interface CheckResult {
  check?: unknown;
  passed?: unknown;
}

/** Names of the Property checks that did not pass, in the API's order. */
export function failedChecks(results: CheckResult[]): string[] {
  return results.filter((r) => r.passed === false && typeof r.check === "string").map((r) => r.check as string);
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
