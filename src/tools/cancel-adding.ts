// cancel_adding_land: stop adding a property to Fabrica, as the connected person (onramp:write).
// The web app's own stop button does the same in three steps: it refuses while a listing the owner
// confirmed is open, takes the unconfirmed listings down, then deletes the record. Mirrored here, so
// a property never leaves Fabrica with a listing still on the marketplace.
import { AccountApiError, cancelOnRamp } from "../clients/account.js";
import { cancelOrderAs, FabricaApiError, type ListedOrder } from "../clients/graphql.js";
import { NETWORK_LABEL } from "../config.js";
import { type AccountAuth, hasScope } from "../auth/token.js";
import type { SignContextOrder } from "../types/index.js";
import { type ArgsOf, propertyRefInputs } from "./inputs.js";
import { isLiveOrder } from "./marketplace.js";
import { getOwnWallets } from "./own-wallet.js";
import { holds, isUnconfirmed, label, listedOrder, LISTING_GRANT, lookup, propertyOf, same } from "./sign-requests.js";

/** The consent line for onramp:write on the Fabrica sign-in page. */
export const ADDING_GRANT = "Start, change, or cancel adding a property to your account";

export const cancelAddingInput = { ...propertyRefInputs };
export type CancelAddingArgs = ArgsOf<typeof cancelAddingInput>;

/** The API's refusal, in the tool's answer; anything else is a server failure and is thrown. */
function refusal(error: unknown, what: string): { error: string } {
  if (error instanceof FabricaApiError) return { error: `Fabrica did not ${what}: ${error.graphQLErrors.join("; ")}` };
  if (error instanceof AccountApiError) return { error: error.message };
  throw error;
}

export async function cancelAdding(account: AccountAuth, { tokenId, slug }: CancelAddingArgs): Promise<object> {
  if (!hasScope(account, "onramp:write")) return { error: `This connection was not granted "${ADDING_GRANT}". Reconnect Fabrica and approve it, and this tool stops adding the property.` };
  const found = await lookup(tokenId, slug, { whileAdding: true });
  if ("error" in found) return found;
  const { token } = found;
  if (!token.isPremint) return { error: `${label(token)} is already set up on Fabrica (its token is issued), so there is no adding to stop. Removing a property from Fabrica is started on its property page.`, propertyLink: token.propertyLink };
  // The account's wallets, to say up front when the property is someone else's; without the grant to read them, the API's own check decides.
  let own: string[] | null = null;
  if (hasScope(account, "portfolio:read")) {
    const wallets = await getOwnWallets(account);
    if (!("error" in wallets)) {
      own = wallets.map(wallet => wallet.address);
      if (!own.some(address => holds(token, address))) return { error: `${label(token)} is not being added by the connected account (${own.length === 1 ? `wallet ${own[0]}` : `wallets ${own.join(", ")}`}); only the person adding it can stop it.` };
    }
  }
  const now = Date.now();
  const listings: SignContextOrder[] = (token.marketplaceListings ?? []).filter(order => isLiveOrder(order, now) && (own === null || own.some(address => same(order.makerAddress, address))));
  const confirmed = listings.filter(order => !isUnconfirmed(order));
  if (confirmed.length > 0) {
    return {
      error: `${label(token)} is listed for sale with a listing its owner confirmed (${confirmed.map(order => `order ${order.marketplaceId}`).join(", ")}). Take it down first with cancel_land_order, then call cancel_adding_land again. Nothing was changed.`,
      listings: confirmed.map(order => ({ orderHash: order.marketplaceId, priceUsd: order.usdPrice, wallet: order.makerAddress })),
    };
  }
  if (listings.length > 0 && !hasScope(account, "listing:write")) {
    return { error: `${label(token)} is listed for sale (${listings.map(order => `order ${order.marketplaceId}`).join(", ")}), and the listing comes down before the property does. This connection was not granted "${LISTING_GRANT}": reconnect Fabrica and approve it, then call cancel_adding_land again. Nothing was changed.` };
  }
  const takenDown: ListedOrder[] = [];
  for (const order of listings) {
    try {
      takenDown.push(await cancelOrderAs(account, order.marketplaceId));
    } catch (error) {
      const answer = refusal(error, "take the listing down");
      return { ...answer, error: `${answer.error} The property is still being added${takenDown.length > 0 ? `; ${takenDown.length} of its ${listings.length} listings came down` : ""}.`, listingsTakenDown: takenDown.map(listedOrder) };
    }
  }
  try {
    await cancelOnRamp(account, token.tokenId);
  } catch (error) {
    const answer = refusal(error, "stop adding it");
    return { ...answer, error: `${answer.error}${takenDown.length > 0 ? ` Its ${takenDown.length === 1 ? "listing was" : "listings were"} taken down.` : ""}`, listingsTakenDown: takenDown.map(listedOrder) };
  }
  return {
    network: NETWORK_LABEL,
    status: `Stopped. ${label(token)} is no longer being added to Fabrica; its record and its page on fabrica.land are gone.${takenDown.length > 0 ? ` Its ${takenDown.length === 1 ? "listing was" : `${takenDown.length} listings were`} taken off the marketplace first.` : ""}`,
    property: propertyOf(token),
    listingsTakenDown: takenDown.map(listedOrder),
    nextSteps: [
      "get_my_properties_being_added no longer lists it. Nothing was signed, paid or recorded, and the setup fee authorized for it is not charged.",
      "add_land starts it again from its parcel number with state and county, or its address.",
    ],
  };
}
