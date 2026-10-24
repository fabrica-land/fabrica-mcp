import { IS_MAINNET } from "../config.js";

/**
 * Connect Fabrica: the hosted server as an OAuth 2.1 resource server (RFC 9728, RFC 8707).
 *
 * The anonymous /mcp endpoint never changes. The signed-in endpoint /mcp/account accepts
 * access tokens issued by the Fabrica API for this deployment only: the mainnet API issues
 * tokens for mcp.fabrica.land, the staging API for mcp-testnet.fabrica.land, and the token's
 * audience is the signed-in endpoint's URL, so a testnet token never works on mainnet.
 *
 * Off until the authorization server is live: FABRICA_OAUTH=enabled turns it on per deployment.
 * While off, /mcp/account and the protected resource metadata answer 404.
 */

export const ACCOUNT_PATH = "/mcp/account";

/** The scopes the authorization server issues (read-only). A tool names the one it needs. */
export const OAUTH_SCOPES = ["profile:read", "portfolio:read", "onramp:read"] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

export function oauthEnabled(): boolean {
  return process.env.FABRICA_OAUTH?.toLowerCase() === "enabled";
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** The authorization server: the Fabrica API of this deployment's environment. */
export function oauthIssuer(): string {
  return trimSlash(process.env.FABRICA_OAUTH_ISSUER ?? (IS_MAINNET ? "https://api.fabrica.land" : "https://api-test.fabrica.land"));
}

/** The issuer's public signing keys. */
export function oauthJwksUrl(): string {
  return process.env.FABRICA_OAUTH_JWKS_URL ?? `${oauthIssuer()}/.well-known/jwks.json`;
}

/**
 * Inline public JWKS (JSON) in place of the issuer's: the mocked issuer for local runs and the
 * testnet before the authorization server is live (scripts/oauth-mock-issuer.mjs prints one).
 * Never honored on mainnet.
 */
export function inlineJwks(): string | null {
  if (IS_MAINNET) return null;
  return process.env.FABRICA_OAUTH_JWKS?.trim() || null;
}

/** This deployment's public origin; tokens are bound to it. */
export function mcpOrigin(): string {
  return trimSlash(process.env.FABRICA_MCP_ORIGIN ?? (IS_MAINNET ? "https://mcp.fabrica.land" : "https://mcp-testnet.fabrica.land"));
}

/** The resource identifier (token audience): the signed-in endpoint's URL. */
export function accountResource(): string {
  return `${mcpOrigin()}${ACCOUNT_PATH}`;
}

/** Where clients read the protected resource metadata (RFC 9728 path-inserted form). */
export function resourceMetadataUrl(): string {
  return `${mcpOrigin()}/.well-known/oauth-protected-resource${ACCOUNT_PATH}`;
}
