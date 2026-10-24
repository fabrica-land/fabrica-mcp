/**
 * Where a property is in its life on Fabrica, from fields the public API returns to
 * anonymous callers. Setup step detail is not public (`token.onRamp` is null without
 * auth), so a claimed premint reads as "being added" without saying which step. Stage
 * values use the names people see on fabrica.land ("Unclaimed", adding a property,
 * removal); the API's premint, mint and burn vocabulary stays in identifiers.
 */
export type PropertyStage =
  | "unclaimed"
  | "being_added"
  | "replaced"
  | "live"
  | "removal_in_progress"
  | "removed"
  | "retired";

export interface LifecycleFields {
  isPremint: boolean;
  isBurned: boolean;
  claimState?: "CLAIMED" | "UNCLAIMED" | null;
  supersededByTokenId?: string | null;
  offRampStatus?: string | null;
}

const STAGE_DESCRIPTIONS: Record<PropertyStage, string> = {
  unclaimed: "Unclaimed: the property is being added to Fabrica and its owner has not claimed it yet. Its token is not issued yet.",
  being_added: "Being added: the owner has claimed the property and is adding it to Fabrica. Its token is not issued yet.",
  replaced: "Replaced: this record was replaced by the token issued for the property (see successorTokenId).",
  live: "Live: the token is issued onchain and represents the beneficial interest in the trust that holds the property.",
  removal_in_progress: "Removal in progress: the owner has started taking the property off Fabrica, back to traditional title ownership. Completing it retires the token and transfers title out of the trust.",
  removed: "Removed: the property has been taken off Fabrica and is back in traditional title ownership.",
  retired: "Retired: the token no longer represents a property on Fabrica.",
};

export function propertyStage(t: LifecycleFields): PropertyStage {
  if (t.isBurned) return "retired";
  if (t.isPremint) {
    if (t.supersededByTokenId) return "replaced";
    return t.claimState === "CLAIMED" ? "being_added" : "unclaimed";
  }
  if (t.offRampStatus === "in-progress") return "removal_in_progress";
  if (t.offRampStatus === "complete") return "removed";
  return "live";
}

export function describeStage(stage: PropertyStage): string {
  return STAGE_DESCRIPTIONS[stage];
}
