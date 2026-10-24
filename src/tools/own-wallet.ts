import { z } from "zod";
import { NETWORK_LABEL } from "../config.js";
import { hasScope, type AccountAuth } from "../auth/token.js";
import { AccountApiError, getAccountProfile, type AccountWallet } from "../clients/account.js";

/**
 * On the signed-in endpoint, the wallet-scoped public tools default to the connected person's own
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

async function resolveOwnWallet(auth: AccountAuth): Promise<OwnWalletUsed | { error: string }> {
  if (!hasScope(auth, "portfolio:read")) {
    return { error: "This connection was not granted portfolio:read, so it cannot read the wallet on this account. Pass a wallet address, or reconnect Fabrica and approve \"See your properties, listings, offers and loans\"." };
  }
  try {
    const profile = await getAccountProfile(auth, "portfolio:read");
    if (!profile) return { error: `The Fabrica API on ${NETWORK_LABEL} does not serve account details yet, so this account's wallet is not known here. Pass a wallet address instead.` };
    // The wallet Fabrica created at sign-up first: it is the one most properties are held in.
    const wallets = [...profile.wallets].sort((a, b) => Number(b.kind === "embedded") - Number(a.kind === "embedded"));
    const [first, ...rest] = wallets;
    if (!first) return { error: "No linked account (wallet address) is on this Fabrica account yet. Pass a wallet address instead." };
    const otherWallets = [...new Set(rest.map((wallet) => wallet.address.toLowerCase()))].filter((address) => address !== first.address.toLowerCase());
    return {
      address: first.address,
      kind: first.kind,
      otherWallets,
      note: otherWallets.length > 0
        ? `Read for the ${first.kind === "embedded" ? "wallet Fabrica created for this account" : "wallet linked to this account"}. The account has ${otherWallets.length} more (otherWallets); pass one as the address to read it.`
        : `Read for the ${first.kind === "embedded" ? "wallet Fabrica created for this account" : "wallet linked to this account"}.`,
    };
  } catch (error) {
    if (error instanceof AccountApiError) return { error: error.message };
    throw error;
  }
}

function isOwn(value: string | undefined): boolean {
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
