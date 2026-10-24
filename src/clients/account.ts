import { oauthIssuer } from "../auth/config.js";
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

/** The connected user's profile; null while the API does not serve it yet (404). */
export async function getAccountProfile(auth: AccountAuth): Promise<AccountProfile | null> {
  const response = await accountFetch(auth, "/oauth/account");
  if (response.status === 404) return null;
  if (!response.ok) throw refusal(response.status, "profile:read");
  const profile = parseProfile(await response.json().catch(() => null));
  if (!profile) throw new AccountApiError(502, "Fabrica API returned an account record this server does not understand. Try again shortly.");
  return profile;
}
