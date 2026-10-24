import { NETWORK_LABEL } from "../config.js";
import { hasScope, type AccountAuth } from "../auth/token.js";
import { AccountApiError, getAccountProfile, type AccountWallet } from "../clients/account.js";

/**
 * Personal tools: registered only on the signed-in endpoint (/mcp/account), where every request
 * carries a verified access token. They read the connected user's own data with that token.
 */

export interface MyAccountResult {
  network: string;
  connection: {
    /** The user's Fabrica account id. */
    accountId: string;
    /** The AI client the user connected, as registered with Fabrica. */
    client: string;
    /** What the user approved for this client. */
    scopes: readonly string[];
    accessExpiresAt: string;
  };
  email?: string | null;
  wallets?: AccountWallet[];
  /** Identity verification (KYC) state. */
  verification?: string | null;
  notes: string[];
  error?: string;
}

export async function getMyAccount(auth: AccountAuth): Promise<MyAccountResult> {
  const result: MyAccountResult = {
    network: NETWORK_LABEL,
    connection: {
      accountId: auth.subject,
      client: auth.clientId,
      scopes: auth.scopes,
      accessExpiresAt: new Date(auth.expiresAt * 1000).toISOString(),
    },
    notes: [],
  };
  if (!hasScope(auth, "profile:read")) {
    result.notes.push("This connection was not granted profile:read, so email, linked accounts and verification status are not shown. Reconnect Fabrica and approve it to see them.");
    return result;
  }
  try {
    const profile = await getAccountProfile(auth);
    if (!profile) {
      result.notes.push(`The Fabrica API on ${NETWORK_LABEL} does not serve account details yet; email, linked accounts and verification status will appear here once it does.`);
      return result;
    }
    result.email = profile.email;
    result.wallets = profile.wallets;
    result.verification = profile.kycStatus;
    if (profile.wallets.length === 0) result.notes.push("No linked account (wallet address) is on this Fabrica account yet.");
    return result;
  } catch (error) {
    if (error instanceof AccountApiError) return { ...result, error: error.message };
    throw error;
  }
}
