import { hasScope, type AccountAuth } from "../auth/token.js";
import { isTokenNotFound } from "../clients/graphql.js";

/**
 * Once the person has signed in, get_land_property and estimate_land_borrowing read the token as the
 * connected person, so the API personalizes it (the lending pool's capacity for that viewer). The
 * public record is the same; only the viewer-dependent fields can differ.
 */

export interface PersonalView {
  /** True when the read was made as the connected person. */
  personalized: boolean;
  note?: string;
}

export const PERSONALIZED_NOTE = "Read as the connected person: borrowing capacity reflects their own credit history, as on fabrica.land when signed in.";
const NO_GRANT_NOTE = "This connection was not granted portfolio:read, so this is the public view (borrowing capacity is not personalized).";

/**
 * Runs `read` as the connected person when the connection holds portfolio:read, and anonymously
 * otherwise. A personal read that fails for any reason other than an unknown property falls back to
 * the public read, with a note, so the tool still answers.
 */
export async function readAsViewer<T>(auth: AccountAuth | undefined, read: (as?: AccountAuth) => Promise<T>): Promise<{ value: T; view?: PersonalView }> {
  if (!auth) return { value: await read() };
  if (!hasScope(auth, "portfolio:read")) return { value: await read(), view: { personalized: false, note: NO_GRANT_NOTE } };
  try {
    return { value: await read(auth), view: { personalized: true, note: PERSONALIZED_NOTE } };
  } catch (error) {
    if (isTokenNotFound(error)) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    return { value: await read(), view: { personalized: false, note: `The personalized read failed (${reason}); this is the public view.` } };
  }
}
