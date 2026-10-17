/**
 * Where a property is in its life on Fabrica, from fields the public API returns to
 * anonymous callers. On-ramp step detail is not public (`token.onRamp` is null without
 * auth), so a claimed premint reads as "in on-ramp" without saying which step.
 */
export type PropertyStage =
  | "premint_unclaimed"
  | "premint_claimed"
  | "premint_superseded"
  | "minted"
  | "off_ramp_in_progress"
  | "off_ramped"
  | "burned";

export interface LifecycleFields {
  isPremint: boolean;
  isBurned: boolean;
  claimState?: "CLAIMED" | "UNCLAIMED" | null;
  supersededByTokenId?: string | null;
  offRampStatus?: string | null;
}

const STAGE_DESCRIPTIONS: Record<PropertyStage, string> = {
  premint_unclaimed: "Premint: the property is still being added to Fabrica and its owner has not claimed it yet. The token is not minted.",
  premint_claimed: "Premint claimed by its owner: the property is still being added to Fabrica (on-ramp). The token is not minted yet.",
  premint_superseded: "Premint replaced by a minted token (see successorTokenId).",
  minted: "Minted: the token is live onchain and represents the beneficial interest in the trust that holds the property.",
  off_ramp_in_progress: "Removal in progress (off-ramp): the owner has started converting the token back to traditional title ownership. Completing it burns the token and transfers title out of the trust.",
  off_ramped: "Removed (off-ramp complete): the property has been converted back to traditional title ownership.",
  burned: "Burned: the token no longer represents a property on Fabrica.",
};

export function propertyStage(t: LifecycleFields): PropertyStage {
  if (t.isBurned) return "burned";
  if (t.isPremint) {
    if (t.supersededByTokenId) return "premint_superseded";
    return t.claimState === "CLAIMED" ? "premint_claimed" : "premint_unclaimed";
  }
  if (t.offRampStatus === "in-progress") return "off_ramp_in_progress";
  if (t.offRampStatus === "complete") return "off_ramped";
  return "minted";
}

export function describeStage(stage: PropertyStage): string {
  return STAGE_DESCRIPTIONS[stage];
}
