import { z } from "zod";
import { NETWORK, NETWORK_LABEL, WEB_BASE } from "../config.js";
import { hasScope, type AccountAuth } from "../auth/token.js";
import {
  AccountApiError,
  getAccountProfile,
  getOnRampRecord,
  getOnRampsForWallet,
  type OnRampGrantor,
  type OnRampRecord,
  type OnRampStep,
} from "../clients/account.js";
import { getPremintSuccessor } from "../clients/graphql.js";
import type { ArgsOf } from "./inputs.js";

/**
 * The connected person's on-ramps (the properties they are adding to Fabrica), read with their
 * token under onramp:read. Signed-in endpoint only.
 */

type Actor = "you" | "fabrica" | "county";

/** Steps only the owner can move: the details form, the fee approval and the notarized signature. */
const OWNER_STEPS: ReadonlySet<string> = new Set(["CollectInfoFromUser", "GetFeeApproval", "SignAndNotarize"]);
/** Steps waiting on the county recorder. */
const COUNTY_STEPS: ReadonlySet<string> = new Set(["RecordingAndMinting", "RecordingDocuments"]);

const ACTOR_WORDS: Record<Actor, string> = {
  you: "You",
  fabrica: "Fabrica",
  county: "The county recorder",
};

const STAGE_WORDS: Record<string, string> = {
  premint: "Being added to Fabrica",
  minted: "Live on Fabrica",
  canceled: "Stopped",
  unsupportedJurisdiction: "County not supported yet",
};

const FINISHED: ReadonlySet<string> = new Set(["minted", "canceled", "unsupportedJurisdiction"]);

const SIGNING_NOTE = "The notarized signature is the owner's own step: they sign in a live session with a notary, and it cannot be completed through this connection.";
const FAILED_NOTE = "This step hit a problem on Fabrica's side. Fabrica support can say what happens next (contact_fabrica_support).";

export interface OnRampNextStep {
  step: string;
  who: string;
  /** What the step asks, in the API's words for the current action when there is one. */
  what: string;
  link: string;
  expectedBy: string | null;
  problem?: boolean;
  note?: string;
}

export interface MyOnRampRow {
  tokenId: string;
  property: { address: string | null; county: string | null; state: string | null; parcelNumber: string | null };
  status: string;
  stepsDone: string;
  nextStep: OnRampNextStep | null;
  /** Required details the owner has not given yet; the details step cannot finish until they are in. */
  missingDetails: string[];
  startedAt: string | null;
  updatedAt: string | null;
  /** Set once the property is live: the token it became. */
  liveTokenId?: string;
  links: { property: string };
}

export interface MyOnRampsResult {
  network: string;
  totals: { inProgress: number; waitingOnYou: number; finished: number };
  onRamps: MyOnRampRow[];
  notes: string[];
  error?: string;
}

export interface OnRampStepDetail {
  step: string;
  status: OnRampStep["status"];
  completedAt: string | null;
  expectedBy: string | null;
}

export interface OnRampActionDetail {
  label: string;
  prompt: string;
  detail: string | null;
  link: string | null;
}

export interface OnRampStatusResult extends Partial<MyOnRampRow> {
  network: string;
  steps?: OnRampStepDetail[];
  /** Actions open on the current step, with the owner's own links (forms, approvals, signing sessions). */
  actions?: OnRampActionDetail[];
  /** What the owner entered so far: the owners named on the deed and the details asked by the county. */
  provided?: { owners: OnRampGrantor[]; details: Record<string, string> };
  notes: string[];
  error?: string;
}

export const getOnRampStatusInput = {
  tokenId: z.string().regex(/^\d+$/, "tokenId is the numeric token id").describe("Token id of the property being added (tokenId from get_my_onramps)"),
};
export type GetOnRampStatusArgs = ArgsOf<typeof getOnRampStatusInput>;

function propertyPage(tokenId: string): string {
  return `${WEB_BASE}/property/${NETWORK}/${encodeURIComponent(tokenId)}`;
}

function stepLink(key: string, tokenId: string): string {
  if (key === "CollectInfoFromUser") return `${WEB_BASE}/go?token-id=${encodeURIComponent(tokenId)}`;
  if (key === "GetFeeApproval") return `${propertyPage(tokenId)}?action=approve_fee`;
  return propertyPage(tokenId);
}

function visibleSteps(record: OnRampRecord): OnRampStep[] {
  return record.steps.filter((step) => step.visible);
}

function currentStep(record: OnRampRecord, liveTokenId: string | null = null): OnRampStep | undefined {
  if (FINISHED.has(record.status) || liveTokenId) return undefined;
  const steps = visibleSteps(record);
  return steps.find((step) => step.status === "in-progress" || step.status === "failed") ?? steps.find((step) => step.status === "not-started");
}

function actorFor(step: OnRampStep): Actor {
  if (OWNER_STEPS.has(step.key)) return "you";
  if (COUNTY_STEPS.has(step.key)) return "county";
  return step.userActions.length > 0 ? "you" : "fabrica";
}

function nextStepOf(record: OnRampRecord, liveTokenId: string | null): OnRampNextStep | null {
  const step = currentStep(record, liveTokenId);
  if (!step) return null;
  const who = step.status === "failed" ? "fabrica" : actorFor(step);
  const next: OnRampNextStep = {
    step: step.text,
    who: ACTOR_WORDS[who],
    what: step.userActions[0]?.prompt ?? step.text,
    link: stepLink(step.key, record.tokenId),
    expectedBy: step.expectedCompletion,
  };
  if (step.status === "failed") {
    next.problem = true;
    next.note = FAILED_NOTE;
  } else if (step.key === "SignAndNotarize") {
    next.note = SIGNING_NOTE;
  }
  return next;
}

function toRow(record: OnRampRecord, liveTokenId: string | null): MyOnRampRow {
  const steps = visibleSteps(record);
  const done = steps.filter((step) => step.status === "complete").length;
  const row: MyOnRampRow = {
    tokenId: record.tokenId,
    property: { address: record.address, county: record.county, state: record.state, parcelNumber: record.parcelNumber },
    status: liveTokenId ? STAGE_WORDS.minted : STAGE_WORDS[record.status] ?? record.status,
    stepsDone: `${done} of ${steps.length}`,
    nextStep: nextStepOf(record, liveTokenId),
    missingDetails: record.missingRequiredFields,
    startedAt: record.createdAt,
    updatedAt: record.updatedAt,
    links: { property: propertyPage(liveTokenId ?? record.tokenId) },
  };
  if (liveTokenId) row.liveTokenId = liveTokenId;
  return row;
}

/**
 * The live token this on-ramp became: the successor the API records for a replaced premint, or
 * the token itself once minted. Null while it is still being added.
 */
async function liveTokenOf(record: OnRampRecord): Promise<string | null> {
  if (record.status === "canceled" || record.status === "unsupportedJurisdiction") return null;
  const successor = await getPremintSuccessor(record.tokenId).catch(() => null);
  if (successor) return successor;
  return record.status === "minted" ? record.tokenId : null;
}

function rank(row: MyOnRampRow): number {
  if (row.nextStep?.who === ACTOR_WORDS.you) return 0;
  return row.nextStep ? 1 : 2;
}

const NO_GRANT = "This connection was not granted onramp:read. Reconnect Fabrica and approve \"See the properties you're adding to Fabrica\" to read them.";

function emptyOnRamps(notes: string[], error?: string): MyOnRampsResult {
  return { network: NETWORK_LABEL, totals: { inProgress: 0, waitingOnYou: 0, finished: 0 }, onRamps: [], notes, ...(error ? { error } : {}) };
}

/** Every on-ramp minting to a wallet on the connected person's account, those waiting on them first. */
export async function getMyOnRamps(auth: AccountAuth): Promise<MyOnRampsResult> {
  if (!hasScope(auth, "onramp:read")) return emptyOnRamps([NO_GRANT]);
  try {
    const profile = await getAccountProfile(auth, "onramp:read");
    if (!profile) return emptyOnRamps([`The Fabrica API on ${NETWORK_LABEL} does not serve account details yet, so the properties being added cannot be listed here.`]);
    const wallets = [...new Set(profile.wallets.map((wallet) => wallet.address.toLowerCase()))];
    if (wallets.length === 0) return emptyOnRamps(["No linked account (wallet address) is on this Fabrica account yet, so no property is being added to it."]);

    const lists = await Promise.all(wallets.map((wallet) => getOnRampsForWallet(auth, wallet)));
    const byId = new Map<string, OnRampRecord>();
    for (const record of lists.flat()) if (!byId.has(record.tokenId)) byId.set(record.tokenId, record);
    const records = [...byId.values()];
    const live = await Promise.all(records.map(liveTokenOf));
    const rows = records
      .map((record, index) => toRow(record, live[index]))
      .sort((a, b) => rank(a) - rank(b) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return {
      network: NETWORK_LABEL,
      totals: {
        inProgress: rows.filter((row) => row.nextStep !== null).length,
        waitingOnYou: rows.filter((row) => rank(row) === 0).length,
        finished: rows.filter((row) => row.nextStep === null).length,
      },
      onRamps: rows,
      notes: rows.length === 0 ? ["This account is not adding any property to Fabrica."] : [],
    };
  } catch (error) {
    if (error instanceof AccountApiError) return emptyOnRamps([], error.message);
    throw error;
  }
}

/** One on-ramp in detail: every step, the open actions with their links, and what the owner entered. */
export async function getOnRampStatus(auth: AccountAuth, args: GetOnRampStatusArgs): Promise<OnRampStatusResult> {
  if (!hasScope(auth, "onramp:read")) return { network: NETWORK_LABEL, notes: [NO_GRANT] };
  try {
    const record = await getOnRampRecord(auth, args.tokenId);
    if (!record) {
      return { network: NETWORK_LABEL, notes: [`Token ${args.tokenId} is not a property this account is adding to Fabrica. get_my_onramps lists the ones it is.`] };
    }
    const liveTokenId = await liveTokenOf(record);
    const row = toRow(record, liveTokenId);
    const current = currentStep(record, liveTokenId);
    return {
      network: NETWORK_LABEL,
      ...row,
      steps: visibleSteps(record).map((step) => ({
        step: step.status === "complete" ? step.textCompleted : step.text,
        status: step.status,
        completedAt: step.completed,
        expectedBy: step.expectedCompletion,
      })),
      actions: (current?.userActions ?? []).map((action) => ({ label: action.label, prompt: action.prompt, detail: action.detail, link: action.url })),
      provided: { owners: record.grantors, details: record.collectedFields },
      notes: [],
    };
  } catch (error) {
    if (error instanceof AccountApiError) return { network: NETWORK_LABEL, notes: [], error: error.message };
    throw error;
  }
}
