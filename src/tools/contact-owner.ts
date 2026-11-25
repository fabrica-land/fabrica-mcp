// contact_land_owner: email a message to a property's owner through Fabrica, as the connected
// person (message:write). Fabrica sends it from the person's own email address, so the owner
// replies directly; the server sees neither address. The web app's contact form, mirrored.
import { z } from "zod";
import { FabricaApiError, getSignContext, isTokenNotFound, sendMessageAs } from "../clients/graphql.js";
import { NETWORK_LABEL } from "../config.js";
import { type AccountAuth, hasScope } from "../auth/token.js";
import type { SignContextToken } from "../types/index.js";
import { type ArgsOf, propertyRefInputs } from "./inputs.js";
import { getOwnWallets, ownSignerArg, signerFor } from "./own-wallet.js";
import { label, propertyOf, same, shorten } from "./sign-requests.js";
import { containsSecret } from "./support.js";

/** The consent line for message:write on the Fabrica sign-in page. */
export const MESSAGE_GRANT = "Send messages to other Fabrica users for you";
/** The web app's limit on a message. */
export const MAX_MESSAGE_LENGTH = 1000;

export const contactOwnerInput = {
  ...propertyRefInputs,
  message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH).describe(`The message, in the person's words, up to ${MAX_MESSAGE_LENGTH} characters. Fabrica emails it to the owner from the person's own email address, so the owner can reply directly; say who is asking and what about.`),
  wallet: ownSignerArg.describe(`The person's own wallet the message is sent from (0x address); it must be linked to the connected account. Leave it out, or pass "me", for the account's main wallet.`),
};
export type ContactOwnerArgs = ArgsOf<typeof contactOwnerInput>;

type Owner = { address: string; displayName: string; contactable: boolean };

/** The property and its owner of record, or why there is nobody to write to. */
async function findOwner(tokenId: string | undefined, slug: string | undefined): Promise<{ token: SignContextToken; owner: Owner } | { error: string; propertyLink?: string | null }> {
  if (!tokenId && !slug) return { error: "Either tokenId or slug is required" };
  const name = tokenId ? `token ID ${tokenId}` : `slug ${slug}`;
  let token: SignContextToken;
  try {
    token = await getSignContext({ tokenId, slug });
  } catch (e) {
    if (isTokenNotFound(e)) return { error: `No property found with ${name}` };
    return { error: `Failed to load the property: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (token.isPremint && token.supersededByTokenId) return { error: `Token ${token.tokenId} was the record of this property before its token was issued; it has been replaced by token ${token.supersededByTokenId}. Write to the owner of ${token.supersededByTokenId}.` };
  if (token.isBurned) return { error: `${label(token)} has been retired from Fabrica, so it has no owner on Fabrica to write to.` };
  if (token.isPremint && token.claimState === "UNCLAIMED") return { error: `${label(token)} is being added to Fabrica but nobody has claimed it yet, so there is no owner on Fabrica to write to. Its page says who lists it elsewhere.`, propertyLink: token.propertyLink };
  const address = token.majorityOwner?.address ?? token.majorityOwnerAddress;
  if (!address) return { error: `${label(token)} has no owner on record to write to.`, propertyLink: token.propertyLink };
  return { token, owner: { address, displayName: token.majorityOwner?.displayName ?? shorten(address), contactable: token.majorityOwner?.contactable ?? false } };
}

export async function contactOwner(account: AccountAuth, { tokenId, slug, message, wallet }: ContactOwnerArgs): Promise<object> {
  if (!hasScope(account, "message:write")) return { error: `This connection was not granted "${MESSAGE_GRANT}". Reconnect Fabrica and approve it, and this tool sends the message.` };
  if (containsSecret(message)) return { error: "The message looks like it contains a private key or seed phrase. Those are never needed and are left out of any message; remove them and call again." };
  const found = await findOwner(tokenId, slug);
  if ("error" in found) return found;
  const { token, owner } = found;
  if (!owner.contactable) return { error: `${owner.displayName}, the owner of ${label(token)}, cannot be reached through Fabrica right now: Fabrica delivers messages by email, and this owner has no verified email address on their account. The property page shows what else the owner has made public.`, propertyLink: token.propertyLink };
  const signer = await signerFor(account, wallet);
  if (typeof signer === "object" && "error" in signer) return signer;
  // The owner's wallet on the account, whichever wallet would send: writing to oneself is refused.
  // A chosen sender is checked against the account's other wallets too; when they cannot be read, the
  // chosen one alone is checked (the API refuses that exact match as well).
  const wallets = typeof signer === "string" ? [signer] : signer.own.map(own => own.address);
  const own = typeof signer === "string" ? await getOwnWallets(account) : signer.own;
  const everyWallet = "error" in own ? wallets : [...wallets, ...own.map(wallet => wallet.address)];
  if (everyWallet.some(address => same(address, owner.address))) return { error: `${label(token)} is held by wallet ${shorten(owner.address)}, which is the connected person's own: there is nobody else to write to.` };
  const sender = wallets[0];
  if (!sender) return { error: "No linked account (wallet address) is on this Fabrica account yet, so there is nothing to send the message from." };
  try {
    const sent = await sendMessageAs(account, { sender, recipient: owner.address, message, property: { contractAddress: token.contractAddress, tokenId: token.tokenId } });
    if (!sent) return { error: `Fabrica did not send the message to ${owner.displayName}: the API answered that nothing went out. Try again shortly, or write to the owner from the property page.`, propertyLink: token.propertyLink };
  } catch (error) {
    if (error instanceof FabricaApiError) return { error: `Fabrica did not send the message: ${error.graphQLErrors.join("; ")}` };
    throw error;
  }
  return {
    network: NETWORK_LABEL,
    status: `Sent. Fabrica emailed the message to ${owner.displayName}, the owner of ${label(token)}, from the email address on the connected account; the owner can reply to it directly.`,
    to: { displayName: owner.displayName, wallet: owner.address },
    from: sender,
    property: propertyOf(token),
    message,
    nextSteps: ["Replies arrive by email, at the address on the person's Fabrica account; this server does not see them. get_land_order_book shows the property's listings and offers if the conversation leads to one."],
  };
}
