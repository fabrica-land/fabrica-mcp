import { z } from "zod";
import { NETWORK_LABEL } from "../config.js";
import { hasScope, type AccountAuth } from "../auth/token.js";
import { AccountApiError, getAccountProfile, type AccountWallet } from "../clients/account.js";

/**
 * Once the person has signed in, the wallet-scoped public tools default to the connected person's own
 * wallet, so they never have to look up and paste their address. The reads stay public: only the
 * address comes from the account (portfolio:read).
 */

/** Stands for the connected person's own wallet in an address argument. */
export const OWN_WALLET = "me";

export interface OwnWalletUsed {
  address: string;
  kind: AccountWallet["kind"];
  /** The account's other wallets, each readable by passing its address. */
  otherWallets: string[];
  note: string;
}

/** The signed-in variant of an address argument: optional, "me" or omitted for the person's own wallet. */
export function ownWalletArg(what: string, omittedMeansOwn: boolean) {
  return z.string().optional().describe(omittedMeansOwn
    ? `${what} (0x...). Leave it out, or pass "${OWN_WALLET}", for the connected person's own wallet.`
    : `${what} (0x...). Pass "${OWN_WALLET}" for the connected person's own wallet.`);
}

/**
 * Every wallet on the connected account, the one Fabrica created at sign-up first (it is the one
 * most properties are held in), deduplicated. Needs portfolio:read.
 */
export async function getOwnWallets(auth: AccountAuth): Promise<AccountWallet[] | { error: string }> {
  if (!hasScope(auth, "portfolio:read")) {
    return { error: "This connection was not granted portfolio:read, so it cannot read the wallet on this account. Pass a wallet address, or reconnect Fabrica and approve \"See your properties, listings, offers and loans\"." };
  }
  try {
    const profile = await getAccountProfile(auth, "portfolio:read");
    if (!profile) return { error: `The Fabrica API on ${NETWORK_LABEL} does not serve account details yet, so this account's wallet is not known here. Pass a wallet address instead.` };
    const sorted = [...profile.wallets].sort((a, b) => Number(b.kind === "embedded") - Number(a.kind === "embedded"));
    const seen = new Set<string>();
    const wallets = sorted.filter((wallet) => {
      const key = wallet.address.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (wallets.length === 0) return { error: "No linked account (wallet address) is on this Fabrica account yet. Pass a wallet address instead." };
    return wallets;
  } catch (error) {
    if (error instanceof AccountApiError) return { error: error.message };
    throw error;
  }
}

async function resolveOwnWallet(auth: AccountAuth): Promise<OwnWalletUsed | { error: string }> {
  const wallets = await getOwnWallets(auth);
  if ("error" in wallets) return wallets;
  const [first, ...rest] = wallets;
  const otherWallets = rest.map((wallet) => wallet.address.toLowerCase());
  const which = first.kind === "embedded" ? "wallet Fabrica created for this account" : "wallet linked to this account";
  return {
    address: first.address,
    kind: first.kind,
    otherWallets,
    note: otherWallets.length > 0
      ? `Read for the ${which}. The account has ${otherWallets.length} more (otherWallets); pass one as the address to read it.`
      : `Read for the ${which}.`,
  };
}

export function isOwn(value: string | undefined): boolean {
  return value !== undefined && value.trim().toLowerCase() === OWN_WALLET;
}

async function readOwn<R extends object>(auth: AccountAuth, run: (address: string) => Promise<R>): Promise<(R & { walletUsed?: OwnWalletUsed }) | { error: string }> {
  const own = await resolveOwnWallet(auth);
  if ("error" in own) return own;
  const result = await run(own.address);
  return "error" in result ? result : { walletUsed: own, ...result };
}

/** For a tool that needs a wallet: the given address, or the person's own wallet when it is left out or "me". */
export function walletOrOwn<R extends object>(auth: AccountAuth, value: string | undefined, run: (address: string) => Promise<R>) {
  return value === undefined || isOwn(value) ? readOwn(auth, run) : run(value);
}

/** For a tool where leaving the wallet out means something else (all properties, the whole network): "me" only. */
export function walletIfMe<R extends object>(auth: AccountAuth, value: string | undefined, run: (address: string | undefined) => Promise<R>) {
  return isOwn(value) ? readOwn(auth, run) : run(value);
}

/** The signed-in variant of a sign request's wallet argument: optional, "me" or omitted for the account's wallets. */
export const ownSignerArg = z.string()
  .regex(/^(0x[0-9a-fA-F]{40}|\s*me\s*)$/i, `A 0x-prefixed Ethereum address, or "${OWN_WALLET}"`)
  .optional()
  .describe(`The wallet that will sign (0x address); the sign page only lets this wallet sign. Leave it out, or pass "${OWN_WALLET}", to use the connected account's wallet: the one that fits the action (holds the property, made the order, took the loan). When more than one fits, the answer lists them, and wallet takes the chosen one.`);

/**
 * Who signs a sign request once the person has signed in: the given address, or the account's wallets
 * when the argument is left out or "me" (the prepare step picks the one that fits the action).
 */
export async function signerFor(auth: AccountAuth, value: string | undefined): Promise<string | { own: AccountWallet[] } | { error: string }> {
  if (value !== undefined && !isOwn(value)) return value;
  const wallets = await getOwnWallets(auth);
  return "error" in wallets ? wallets : { own: wallets };
}
