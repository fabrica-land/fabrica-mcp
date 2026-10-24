import { createLocalJWKSet, createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { accountResource, inlineJwks, oauthIssuer, oauthJwksUrl, type OAuthScope } from "./config.js";

/**
 * Access-token checks for the signed-in endpoint. Tokens are JWTs (RFC 9068) signed ES256 by the
 * Fabrica API; they are verified here before any tool runs: signature against the issuer's JWKS,
 * issuer, audience (this endpoint), expiry, and the at+jwt type. A token is never logged, never
 * cached and only ever sent back to the Fabrica API that issued it.
 *
 * Revocation is enforced by the API: a revoked grant's token stops working on the next personal
 * read (the API answers 401) and expires here within its 15-minute lifetime.
 */

/** The connected user, as the verified token describes them. Passed to the personal tools. */
export interface AccountAuth {
  /** The raw bearer, for calls to the Fabrica API only. */
  readonly token: string;
  /** The user's Fabrica account id. */
  readonly subject: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  /** Seconds since the epoch. */
  readonly expiresAt: number;
}

export function hasScope(auth: AccountAuth, scope: OAuthScope): boolean {
  return auth.scopes.includes(scope);
}

export type TokenCheck =
  | { ok: true; auth: AccountAuth }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "invalid"; description: string }
  | { ok: false; reason: "unavailable" };

const CLOCK_TOLERANCE_SECONDS = 30;

let remoteKeys: { url: string; keys: JWTVerifyGetKey } | null = null;
let localKeys: { jwks: string; keys: JWTVerifyGetKey } | null = null;

/** The issuer's keys: fetched once per instance and cached an hour (rotation overlap is longer). */
function issuerKeys(): JWTVerifyGetKey {
  const inline = inlineJwks();
  if (inline) {
    if (localKeys?.jwks !== inline) localKeys = { jwks: inline, keys: createLocalJWKSet(JSON.parse(inline)) };
    return localKeys.keys;
  }
  const url = oauthJwksUrl();
  if (remoteKeys?.url !== url) {
    remoteKeys = { url, keys: createRemoteJWKSet(new URL(url), { timeoutDuration: 5_000, cooldownDuration: 30_000, cacheMaxAge: 60 * 60 * 1000 }) };
  }
  return remoteKeys.keys;
}

/** The bearer from an Authorization header: undefined when absent, "" when present but not a bearer. */
export function bearerFrom(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || value.trim() === "") return undefined;
  const match = /^Bearer[ ]+([A-Za-z0-9\-._~+/]+=*)\s*$/i.exec(value.trim());
  return match ? match[1] : "";
}

export async function checkAccessToken(header: string | string[] | undefined, keys?: JWTVerifyGetKey): Promise<TokenCheck> {
  const token = bearerFrom(header);
  if (token === undefined) return { ok: false, reason: "missing" };
  if (token === "") return { ok: false, reason: "invalid", description: "The Authorization header must be a Bearer token." };
  try {
    // Inside the try: a bad key configuration (malformed inline JWKS, invalid URL) is "unavailable", not a crash.
    const { payload } = await jwtVerify(token, keys ?? issuerKeys(), {
      issuer: oauthIssuer(),
      audience: accountResource(),
      algorithms: ["ES256"],
      typ: "at+jwt",
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["sub", "exp", "iat", "client_id"],
    });
    const clientId = payload.client_id;
    if (typeof payload.sub !== "string" || payload.sub === "" || typeof clientId !== "string" || typeof payload.exp !== "number") {
      return { ok: false, reason: "invalid", description: "The access token is missing its subject or client." };
    }
    const scopes = typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [];
    return { ok: true, auth: { token, subject: payload.sub, clientId, scopes, expiresAt: payload.exp } };
  } catch (error) {
    if (error instanceof errors.JWTExpired) return { ok: false, reason: "invalid", description: "The access token has expired." };
    if (TOKEN_ERRORS.some((type) => error instanceof type)) return { ok: false, reason: "invalid", description: "The access token is not valid for this server." };
    // Anything else (the issuer's keys could not be fetched, a bad key configuration) is not
    // the caller's fault, so not a 401. Only the error's name is logged, never the token.
    console.error("Access-token check failed:", error instanceof Error ? error.name : "unknown error");
    return { ok: false, reason: "unavailable" };
  }
}

/** Failures that mean the token itself is wrong. */
const TOKEN_ERRORS = [
  errors.JWTClaimValidationFailed,
  errors.JWTInvalid,
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
];
