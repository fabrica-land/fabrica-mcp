import { NETWORK_LABEL } from "../config.js";
import { hasScope, type AccountAuth } from "../auth/token.js";
import { AccountApiError, getAccountProfile } from "../clients/account.js";
import { getScoreRecord, getToken } from "../clients/graphql.js";
import { formatFeeAmount } from "../fees.js";
import type { ScoreRecord, TokenDetail } from "../types/index.js";
import { getMyProperties, type MyPropertyRow } from "./account.js";
import { getMyLoans, isOpenLoan } from "./my-loans.js";
import { getMyOffers } from "./offers.js";
import { getMyOnRamps } from "./onramps.js";
import { getRecoveryStatus } from "./scoring.js";
import { loadTaxSignals, taxSummary } from "./tax.js";

/**
 * One ranked list of what waits on the connected person: derived from the other personal reads
 * plus each live property's fees and checks. Reads only; every item links to where it is done.
 */

/** Single-property lookups per call, for fees and checks. */
export const ATTENTION_TOKEN_BUDGET = 20;

export type AttentionKind = "loan" | "offer" | "adding" | "fee" | "check" | "removal";

export interface AttentionItem {
  kind: AttentionKind;
  tokenId: string | null;
  title: string;
  why: string;
  dueBy: string | null;
  link: string | null;
  whoActs: string;
}

export interface AttentionResult {
  network: string;
  items: AttentionItem[];
  /** What was looked at, so an empty list can be trusted. */
  checked: string[];
  notes: string[];
}

/** Money and deadlines first, then on-ramp steps, then fees, then checks. */
const RANK: Record<AttentionKind, number> = { loan: 0, offer: 0, adding: 1, fee: 2, removal: 3, check: 3 };

function byRank(a: AttentionItem, b: AttentionItem): number {
  return RANK[a.kind] - RANK[b.kind] || (a.dueBy ?? "￿").localeCompare(b.dueBy ?? "￿");
}

function label(row: { name: string | null; tokenId: string | null }): string {
  return row.name ?? (row.tokenId ? `property ${row.tokenId}` : "a property");
}

async function loanItems(auth: AccountAuth, items: AttentionItem[], checked: string[], notes: string[]): Promise<void> {
  const loans = await getMyLoans(auth);
  if (loans.error) return void notes.push(`Loans were not checked: ${loans.error}`);
  checked.push(`loans (${loans.totals.activeTaken} active against your properties)`);
  for (const loan of loans.taken) {
    if (!isOpenLoan(loan) || loan.daysToMaturity === undefined) continue;
    if (loan.daysToMaturity < 0) {
      items.push({ kind: "loan", tokenId: loan.property.tokenId, title: `Loan on ${label(loan.property)} is past its maturity date`, why: `It matured ${-loan.daysToMaturity} day${loan.daysToMaturity === -1 ? "" : "s"} ago; payoff today ${loan.payoffToday ?? "unknown"}. An unpaid loan past maturity can lose the property to the lender.`, dueBy: loan.maturityDate, link: loan.links.property, whoActs: "You" });
    } else if (loan.maturingSoon) {
      items.push({ kind: "loan", tokenId: loan.property.tokenId, title: `Loan on ${label(loan.property)} matures in ${loan.daysToMaturity} day${loan.daysToMaturity === 1 ? "" : "s"}`, why: `Payoff today ${loan.payoffToday ?? "unknown"}.`, dueBy: loan.maturityDate, link: loan.links.property, whoActs: "You" });
    }
  }
}

async function offerItems(auth: AccountAuth, items: AttentionItem[], checked: string[], notes: string[]): Promise<void> {
  const offers = await getMyOffers(auth);
  if (offers.error) return void notes.push(`Offers were not checked: ${offers.error}`);
  checked.push(`offers (${offers.totals.received} waiting on your properties, ${offers.totals.made} you made)`);
  for (const property of offers.received ?? []) {
    const soonest = [...property.offers].sort((a, b) => (a.expiresAt ?? "￿").localeCompare(b.expiresAt ?? "￿"))[0];
    const top = property.offers[0];
    const count = property.offers.length;
    items.push({
      kind: "offer",
      tokenId: property.tokenId,
      title: `${count} offer${count === 1 ? "" : "s"} waiting on ${label(property)}`,
      why: `Highest ${top.price ?? top.amount}; the soonest ends ${soonest.expires ?? "with no end date"}.${property.underLoan ? " The property is under a loan, so a sale pays it off from the proceeds." : ""}`,
      dueBy: soonest.expiresAt,
      link: property.links.respond,
      whoActs: "You",
    });
  }
  for (const offer of offers.made ?? []) {
    if (!offer.expiringSoon) continue;
    items.push({ kind: "offer", tokenId: offer.tokenId, title: `Your offer on ${label(offer)} ends ${offer.expires ?? "soon"}`, why: `Offer of ${offer.price ?? offer.amount}, still open.`, dueBy: offer.expiresAt, link: offer.links.property, whoActs: "You" });
  }
}

async function onRampItems(auth: AccountAuth, items: AttentionItem[], checked: string[], notes: string[]): Promise<void> {
  const onRamps = await getMyOnRamps(auth);
  if (onRamps.error) return void notes.push(`Properties being added were not checked: ${onRamps.error}`);
  checked.push(`properties being added (${onRamps.totals.inProgress} in progress)`);
  for (const row of onRamps.onRamps) {
    const next = row.nextStep;
    if (!next || (next.who !== "You" && !next.problem)) continue;
    const place = [row.property.address, row.property.county && `${row.property.county} County`].filter(Boolean).join(", ") || `property ${row.tokenId}`;
    items.push({
      kind: "adding",
      tokenId: row.tokenId,
      title: next.problem ? `Adding ${place}: a step needs Fabrica` : `Adding ${place}: ${next.what}`,
      why: [next.problem ? next.note : `${row.stepsDone} steps done; next is "${next.step}".`, row.missingDetails.length ? `Missing details: ${row.missingDetails.join(", ")}.` : null, !next.problem && next.note ? next.note : null].filter(Boolean).join(" "),
      dueBy: next.expectedBy,
      link: next.link,
      whoActs: next.who,
    });
  }
}

/**
 * A check as the score record stores it: 1/true passes, 0/false fails, anything else was never
 * verified. The GraphQL check list reports an unverified check as false, so it cannot tell a failed
 * check from a missing one; only a failure read from the record is flagged.
 */
function recordCheck(record: ScoreRecord | null, name: string): boolean | null {
  const value = record?.checks[name];
  if (value === 1 || value === true) return true;
  if (value === 0 || value === false) return false;
  return null;
}

/** Adds the property's items; false when its Property checks record could not be read. */
async function tokenItems(row: MyPropertyRow, token: TokenDetail, items: AttentionItem[]): Promise<boolean> {
  const base = { tokenId: row.tokenId, dueBy: null, link: row.links.property };
  const name = label(row);
  for (const fee of token.fees.fees) {
    if (fee.paid) continue;
    const amount = formatFeeAmount(fee.amount, fee.currency);
    items.push(fee.approved
      ? { ...base, kind: "fee", title: `Fee on ${name} approved, not paid yet`, why: `${amount}, collected from the approved payment.`, whoActs: "Fabrica" }
      : { ...base, kind: "fee", title: `Approve the fee on ${name}`, why: `${amount} waiting on your approval.`, link: `${row.links.property}?action=approve_fee`, whoActs: "You" });
  }
  // The same resolution as get_land_tax_status: the raw check, its expiry and the lending block reason.
  const tax = await loadTaxSignals(token);
  const taxWhy = taxSummary(tax.status, tax.checkedAt, token.isPremint, tax);
  if (tax.status === "delinquent") items.push({ ...base, kind: "check", title: `Property taxes on ${name} look past due`, why: `${taxWhy} The county treasurer holds the official record and takes payment.`, whoActs: "You" });
  else if (tax.status === "unknown" && !tax.recordUnavailable && tax.basis !== "conflicting") items.push({ ...base, kind: "check", title: `Property taxes on ${name} are not verified`, why: taxWhy, whoActs: "Fabrica" });
  // Cached from the tax read above; a failed read flags nothing.
  const record = tax.recordUnavailable ? null : await getScoreRecord(token.contractAddress, token.tokenId).catch(() => null);
  if (recordCheck(record, "feesInGoodStanding") === false) items.push({ ...base, kind: "check", title: `Fees on ${name} are not in good standing`, why: "A Fabrica fee on this property is unpaid.", whoActs: "You" });
  if (recordCheck(record, "ownerHasVerifiedContact") === false) items.push({ ...base, kind: "check", title: `No verified contact for the owner of ${name}`, why: "Fabrica cannot reach the owner about this property until a contact is verified.", whoActs: "You" });
  const recovery = getRecoveryStatus(token.score ?? null);
  if (recovery && recovery.value !== 7 && recovery.value !== 0) items.push({ ...base, kind: "check", title: `${name}: ${recovery.label}`, why: `Recovery status: ${recovery.meaning}. Fabrica support can say what happens next.`, whoActs: "Fabrica" });
  if (row.stage === "removal_in_progress") items.push({ ...base, kind: "removal", title: `Removal of ${name} from Fabrica is in progress`, why: "The property is being converted back to traditional title.", whoActs: "Fabrica" });
  return !tax.recordUnavailable;
}

async function propertyItems(auth: AccountAuth, items: AttentionItem[], checked: string[], notes: string[]): Promise<void> {
  const properties = await getMyProperties(auth, { includePremints: false });
  if (properties.error) return void notes.push(`Fees and checks were not read: ${properties.error}`);
  const live = properties.properties.filter((row) => row.stage === "live" || row.stage === "removal_in_progress");
  const looked = live.slice(0, ATTENTION_TOKEN_BUDGET);
  const tokens = await Promise.all(looked.map((row) => getToken({ tokenId: row.tokenId }).catch(() => null)));
  let read = 0;
  let checksMissing = 0;
  await Promise.all(looked.map(async (row, index) => {
    const token = tokens[index];
    if (!token) return;
    read += 1;
    if (!(await tokenItems(row, token, items))) checksMissing += 1;
  }));
  checked.push(`fees, property taxes, owner contact and recovery status on ${read} live propert${read === 1 ? "y" : "ies"}`);
  if (live.length > looked.length) notes.push(`And ${live.length - looked.length} more properties not checked for fees and checks (limit ${ATTENTION_TOKEN_BUDGET} per call).`);
  if (checksMissing > 0) notes.push(`Property checks could not be read right now for ${checksMissing} propert${checksMissing === 1 ? "y" : "ies"}, so their property taxes, fee standing and owner contact were not checked.`);
  if (read < looked.length) notes.push(`${looked.length - read} propert${looked.length - read === 1 ? "y" : "ies"} could not be read right now.`);
}

export async function whatNeedsAttention(auth: AccountAuth): Promise<AttentionResult> {
  const items: AttentionItem[] = [];
  const checked: string[] = [];
  const notes: string[] = [];
  const scope = hasScope(auth, "portfolio:read") ? "portfolio:read" : hasScope(auth, "onramp:read") ? "onramp:read" : null;
  if (!scope) {
    return { network: NETWORK_LABEL, items: [], checked, notes: ["Nothing was read: this connection was granted neither portfolio:read nor onramp:read."] };
  }
  // Every read below starts from the account's wallets. Without them nothing can be checked, and
  // an empty list must not read as an all-clear.
  try {
    if (!(await getAccountProfile(auth, scope))) {
      return { network: NETWORK_LABEL, items: [], checked, notes: [`The Fabrica API on ${NETWORK_LABEL} does not serve account details yet, so nothing on this account could be checked.`] };
    }
  } catch (error) {
    if (error instanceof AccountApiError) return { network: NETWORK_LABEL, items: [], checked, notes: [error.message] };
    throw error;
  }
  // One category failing (a GraphQL read that throws) must not drop what the others found.
  const guarded = (what: string, read: typeof loanItems) => read(auth, items, checked, notes).catch((error: unknown) => {
    notes.push(`${what} could not be read right now${error instanceof AccountApiError ? `: ${error.message}` : ""}. Try again shortly.`);
  });
  const work: Array<Promise<void>> = [];
  if (hasScope(auth, "portfolio:read")) {
    work.push(guarded("Loans", loanItems), guarded("Offers", offerItems), guarded("Fees and checks", propertyItems));
  } else {
    notes.push("Loans, offers, fees and checks were not read: this connection was not granted portfolio:read.");
  }
  if (hasScope(auth, "onramp:read")) work.push(guarded("Properties being added", onRampItems));
  else notes.push("Properties being added were not read: this connection was not granted onramp:read.");
  await Promise.all(work);
  if (items.length === 0 && checked.length > 0) {
    // An all-clear only when every part was read; otherwise say what was clear and point at the gaps.
    notes.push(notes.length === 0
      ? `Nothing is waiting on this account. Checked: ${checked.join("; ")}.`
      : `Nothing found in what was checked (${checked.join("; ")}), but not everything could be read: see the notes above.`);
  }
  return { network: NETWORK_LABEL, items: items.sort(byRank), checked, notes };
}
