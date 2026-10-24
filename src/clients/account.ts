import { oauthIssuer } from "../auth/config.js";
import { CONTRACTS, NETWORK } from "../config.js";
import type { AccountAuth } from "../auth/token.js";

/**
 * Personal reads from the Fabrica API, made with the connected user's access token. Separate from
 * the anonymous GraphQL client on purpose: the token goes only on these calls (the API rejects an
 * OAuth token on any route not scoped for it), nothing here is cached across requests, and the
 * token never reaches a log line or an error message.
 */

/**
 * Personal reads go to the API that issued the token (the issuer of this deployment's network),
 * never to the anonymous client's FABRICA_API_URL: a token is only ever sent back to its issuer.
 */
function apiBase(): string {
  return oauthIssuer();
}
const ACCOUNT_TIMEOUT_MS = 10_000;

/** The API refused the connection or the read; the message is safe to show the agent. */
export class AccountApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AccountApiError";
    this.status = status;
  }
}

export const RECONNECT_MESSAGE = "Fabrica no longer accepts this connection: it expired or was revoked in Connected apps on fabrica.land. Reconnect Fabrica in your AI client, then retry.";

export interface AccountWallet {
  address: string;
  /** "embedded": the wallet Fabrica created at sign-up; "external": one the user connected (MetaMask and others). */
  kind: "embedded" | "external";
}

/** The user's profile as the API serves it under profile:read (GET /oauth/account). */
export interface AccountProfile {
  email: string | null;
  wallets: AccountWallet[];
  /** Identity verification (KYC) state, as the API words it. */
  kycStatus: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseProfile(body: unknown): AccountProfile | null {
  if (!isRecord(body) || !Array.isArray(body.wallets)) return null;
  const wallets: AccountWallet[] = [];
  for (const wallet of body.wallets) {
    if (!isRecord(wallet) || typeof wallet.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(wallet.address)) return null;
    wallets.push({ address: wallet.address, kind: wallet.kind === "embedded" ? "embedded" : "external" });
  }
  const kyc = isRecord(body.kyc) && typeof body.kyc.status === "string" ? body.kyc.status : null;
  return { email: typeof body.email === "string" ? body.email : null, wallets, kycStatus: kyc };
}

async function accountFetch(auth: AccountAuth, path: string): Promise<Response> {
  try {
    return await fetch(`${apiBase()}${path}`, {
      headers: { Authorization: `Bearer ${auth.token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(ACCOUNT_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new AccountApiError(504, `Fabrica API did not respond within ${ACCOUNT_TIMEOUT_MS / 1000} s. Try again shortly.`);
    }
    throw new AccountApiError(502, "Fabrica API could not be reached. Try again shortly.");
  }
}

function refusal(status: number, scope: string): AccountApiError {
  if (status === 401) return new AccountApiError(401, RECONNECT_MESSAGE);
  if (status === 403) return new AccountApiError(403, `This connection was not granted ${scope}. Reconnect Fabrica and approve it to read this.`);
  return new AccountApiError(status, `Fabrica API request failed (HTTP ${status}). Try again shortly.`);
}

/**
 * The connected user's profile; null while the API does not serve it yet (404). `scope` names the
 * grant the calling tool relies on, for the refusal message.
 */
export async function getAccountProfile(auth: AccountAuth, scope = "profile:read"): Promise<AccountProfile | null> {
  const response = await accountFetch(auth, "/oauth/account");
  if (response.status === 404) return null;
  if (!response.ok) throw refusal(response.status, scope);
  const profile = parseProfile(await response.json().catch(() => null));
  if (!profile) throw new AccountApiError(502, "Fabrica API returned an account record this server does not understand. Try again shortly.");
  return profile;
}

/** One action the API offers the owner on a step (a form, an approval, a signing session). */
export interface OnRampUserAction {
  label: string;
  prompt: string;
  detail: string | null;
  /** Owner-only: the API leaves it off a non-owner read. Empty or absent when the action has no page. */
  url: string | null;
}

export interface OnRampStep {
  order: number;
  key: string;
  status: "not-started" | "in-progress" | "complete" | "failed";
  text: string;
  textCompleted: string;
  visible: boolean;
  expectedCompletion: string | null;
  completed: string | null;
  userActions: OnRampUserAction[];
}

export interface OnRampGrantor {
  /** The individual's full name or the entity's legal name, as the owner entered it. */
  name: string;
  kind: "individual" | "entity" | "concurrent";
  role: string | null;
}

/** An on-ramp as the API serves it to its owner (GET /on-ramp/:network/:contract[/:tokenId]). */
export interface OnRampRecord {
  tokenId: string;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
  address: string | null;
  county: string | null;
  state: string | null;
  parcelNumber: string | null;
  missingRequiredFields: string[];
  steps: OnRampStep[];
  collectedFields: Record<string, string>;
  grantors: OnRampGrantor[];
}

const STEP_STATUSES: ReadonlySet<string> = new Set(["not-started", "in-progress", "complete", "failed"]);

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isStepStatus(value: unknown): value is OnRampStep["status"] {
  return typeof value === "string" && STEP_STATUSES.has(value);
}

function parseAction(action: unknown): OnRampUserAction | null {
  if (!isRecord(action)) return null;
  const label = text(action.label);
  if (!label) return null;
  return { label, prompt: text(action.prompt) ?? label, detail: text(action.detail), url: text(action.url) };
}

function parseStep(step: unknown): OnRampStep | null {
  if (!isRecord(step) || typeof step.key !== "string" || !isStepStatus(step.status)) return null;
  const actions = Array.isArray(step.userActions) ? step.userActions.map(parseAction).filter((a): a is OnRampUserAction => a !== null) : [];
  return {
    order: typeof step.order === "number" ? step.order : 0,
    key: step.key,
    status: step.status,
    text: text(step.text) ?? step.key,
    textCompleted: text(step.textCompleted) ?? text(step.text) ?? step.key,
    visible: step.visibility !== false,
    expectedCompletion: text(step.expectedCompletion),
    completed: text(step.completed),
    userActions: actions,
  };
}

function parseGrantors(value: unknown): OnRampGrantor[] {
  if (!Array.isArray(value)) return [];
  const grantors: OnRampGrantor[] = [];
  for (const signer of value) {
    if (!isRecord(signer)) continue;
    if (signer.signerType === "individual") {
      const name = text(signer.fullName);
      if (name) grantors.push({ name, kind: "individual", role: text(signer.role) });
    } else if (signer.signerType === "entity") {
      const name = text(signer.name);
      if (name) grantors.push({ name, kind: "entity", role: text(signer.type) });
    } else if (signer.signerType === "concurrent") {
      for (const inner of parseGrantors(signer.signers)) grantors.push({ ...inner, kind: inner.kind === "individual" ? "concurrent" : inner.kind });
    }
  }
  return grantors;
}

/**
 * Null for anything that is not the owner's view: the API's non-owner read has no tokenId and no
 * recipients, and a record without them is not this person's to show.
 */
function parseOnRamp(body: unknown): OnRampRecord | null {
  if (!isRecord(body) || typeof body.tokenId !== "string" || !isRecord(body.recipients)) return null;
  const steps = Array.isArray(body.steps) ? body.steps.map(parseStep).filter((s): s is OnRampStep => s !== null) : [];
  const collected: Record<string, string> = {};
  if (isRecord(body.collectedFields)) {
    for (const [key, value] of Object.entries(body.collectedFields)) if (typeof value === "string") collected[key] = value;
  }
  return {
    tokenId: body.tokenId,
    status: text(body.status) ?? "premint",
    createdAt: text(body.createdAt),
    updatedAt: text(body.updatedAt),
    address: text(body.address),
    county: text(body.district),
    state: text(body.regionCode),
    parcelNumber: text(body.propertyId),
    missingRequiredFields: Array.isArray(body.missingRequiredFields) ? body.missingRequiredFields.filter((f): f is string => typeof f === "string") : [],
    steps: steps.sort((a, b) => a.order - b.order),
    collectedFields: collected,
    grantors: parseGrantors(body.grantors),
  };
}

function onRampPath(): string {
  return `/on-ramp/${NETWORK}/${CONTRACTS.fabricaToken}`;
}

const UNREADABLE_ONRAMP = "Fabrica API returned an on-ramp record this server does not understand. Try again shortly.";

/** The on-ramps that will mint to one of the user's wallets (onramp:read). */
export async function getOnRampsForWallet(auth: AccountAuth, wallet: string): Promise<OnRampRecord[]> {
  const response = await accountFetch(auth, `${onRampPath()}?wallet=${encodeURIComponent(wallet)}`);
  if (!response.ok) throw refusal(response.status, "onramp:read");
  const body: unknown = await response.json().catch(() => null);
  if (!Array.isArray(body)) throw new AccountApiError(502, UNREADABLE_ONRAMP);
  return body.map(parseOnRamp).filter((record): record is OnRampRecord => record !== null);
}

/**
 * One on-ramp by token id; null when there is none, or when the API answers with the non-owner
 * view (the property is not being added by this account).
 */
export async function getOnRampRecord(auth: AccountAuth, tokenId: string): Promise<OnRampRecord | null> {
  const response = await accountFetch(auth, `${onRampPath()}/${encodeURIComponent(tokenId)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw refusal(response.status, "onramp:read");
  return parseOnRamp(await response.json().catch(() => null));
}
