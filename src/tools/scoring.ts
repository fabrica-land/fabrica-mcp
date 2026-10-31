import { getToken, propertyLookupError } from "../clients/graphql.js";
import { z } from "zod";
import type { ArgsOf } from "./inputs.js";

const MAX_SCORE = 75342;

const GROUP_WEIGHTS = [
  { name: "recoveryStatus", weight: 10000, max: 7, title: "Recovery Status", description: "Recovery/integrity status of the token-property link" },
  { name: "pastTitleAndLoad", weight: 1000, max: 5, title: "Past Title & Load", description: "Level of confidence on title history up to and after tokenization" },
  { name: "ownership", weight: 100, max: 3, title: "Ownership", description: "Level of confidence in the token ownership" },
  { name: "onChainHistory", weight: 10, max: 4, title: "Onchain History", description: "Level of confidence in transactions performed onchain" },
  { name: "basicValidation", weight: 1, max: 2, title: "Basic Validation", description: "Is the token correctly formed?" },
] as const;

/**
 * A ScoreChanged event in words: the new encoding, the one before it (when known) and which
 * groups moved, e.g. "Past Title & Load 2 to 3 (of 5)".
 */
export function describeScoreChange(newValue: string | null | undefined, previousValue: string | null | undefined) {
  const next = Number.parseInt(newValue ?? "", 10);
  if (!Number.isInteger(next) || invalidScoreReason(next) !== null) return null;
  const before = Number.parseInt(previousValue ?? "", 10);
  const previous = Number.isInteger(before) && invalidScoreReason(before) === null ? before : null;
  const digit = (score: number, weight: number) => Math.floor(score / weight) % 10;
  const changed = previous === null ? [] : GROUP_WEIGHTS.flatMap(g => {
    const from = digit(previous, g.weight);
    const to = digit(next, g.weight);
    return from === to ? [] : [`${g.title} ${from} to ${to} (of ${g.max})`];
  });
  return { encoding: next, previousEncoding: previous, ...(previous !== null ? { changed } : {}) };
}

/** The recovery digit as the API defines it: 1=Void, 4=Distressed, 5=Stolen, 6=Recovery Pending, 7=Normal. */
const RECOVERY_STATUSES: Record<number, { label: string; meaning: string }> = {
  7: { label: "Normal", meaning: "no recovery claim" },
  6: { label: "Recovery pending", meaning: "a recovery claim is pending" },
  5: { label: "Reported stolen", meaning: "the token was reported stolen" },
  4: { label: "Tax sale or foreclosure", meaning: "the property went through a tax sale or foreclosure" },
  1: { label: "Void", meaning: "the link between the token and the property is void" },
  0: { label: "Unknown", meaning: "no recovery status recorded" },
};

/** The recovery digit of the numeric encoding, with the label the Fabrica app shows. */
export function getRecoveryStatus(score: number | null): { value: number; label: string; meaning: string } | null {
  if (score === null) return null;
  const value = Math.floor(score / 10000);
  const status = RECOVERY_STATUSES[value] ?? { label: `Unknown (${value})`, meaning: "a recovery status this server does not recognize" };
  return { value, ...status };
}

export interface CheckResult {
  check: string;
  group: string;
  passed: boolean;
}

/** Pass counts from the individual check results, which (unlike the digits) are counts. */
export function countChecks(checks: readonly CheckResult[]): { passed: number; total: number } {
  return { passed: checks.filter(c => c.passed).length, total: checks.length };
}

/**
 * Each digit is a category value set by the group's rules, not a count of passing checks,
 * so the label states the value against the group's highest; pass counts come from the
 * individual check results.
 */
/** Why a number is not a Property checks encoding: one digit per group, each at most the group's maximum (75342 is the highest). */
export function invalidScoreReason(score: number): string | null {
  if (!Number.isInteger(score) || score < 0 || score > MAX_SCORE) {
    return `${score} is not a Property checks encoding. The encoding is a whole number from 0 to ${MAX_SCORE}: one digit per group (recovery status, past title and load, ownership, onchain history, basic validation).`;
  }
  let remaining = score;
  for (const group of GROUP_WEIGHTS) {
    const value = Math.floor(remaining / group.weight);
    remaining = remaining % group.weight;
    if (value > group.max) return `${score} is not a Property checks encoding: its ${group.title} digit is ${value}, and the highest is ${group.max}.`;
  }
  return null;
}

function decomposeScore(score: number) {
  let remaining = score;
  const digits: { name: string; value: number; max: number; title: string; description: string; label: string }[] = [];
  for (const group of GROUP_WEIGHTS) {
    const value = Math.floor(remaining / group.weight);
    remaining = remaining % group.weight;
    const label = group.name === "recoveryStatus"
      ? getRecoveryStatus(score)?.label ?? "Unknown"
      : value === group.max ? `${value}, the highest value` : `${value} (highest is ${group.max})`;
    digits.push({ name: group.name, value, max: group.max, title: group.title, description: group.description, label });
  }
  return digits;
}

export const explainConfidenceScoreInput = {
  tokenId: z.string().optional().describe("Look up and explain the Property checks of this property"),
  score: z.number().int().min(0).optional().describe("The 5-digit Property checks number to explain, as an integer (e.g. 73242)"),
};
export type ExplainConfidenceScoreArgs = ArgsOf<typeof explainConfidenceScoreInput>;

export async function explainConfidenceScore(args: ExplainConfidenceScoreArgs) {
  const { tokenId, score: rawScore } = args;
  if (!tokenId && rawScore === undefined) {
    return { error: "Provide either tokenId or score to explain" };
  }
  try {
    let score = rawScore;
    let checks: CheckResult[] | null = null;
    let propertyName: string | null = null;
    if (tokenId) {
      const token = await getToken({ tokenId });
      if (!token) {
        return { error: `No property found with token ID ${tokenId}` };
      }
      score = token.score ?? undefined;
      propertyName = token.name ?? token.vanityName ?? null;
      if (token.scoringCheckResults) {
        checks = token.scoringCheckResults.map(c => ({
          check: c.title,
          group: c.group,
          passed: c.value,
        }));
      }
    }
    if (score === undefined || score === null) {
      return { error: "No Property checks available for this property" };
    }
    const invalid = invalidScoreReason(score);
    if (invalid) return { error: invalid };
    const breakdown = decomposeScore(score);
    const warnings: string[] = [];
    const recovery = breakdown.find(d => d.name === "recoveryStatus");
    if (recovery && recovery.value !== 7) {
      warnings.push(`Recovery status: ${recovery.label}: ${getRecoveryStatus(score)?.meaning ?? "unknown"}`);
    }
    const pastTitle = breakdown.find(d => d.name === "pastTitleAndLoad");
    if (pastTitle && pastTitle.value < 3) {
      warnings.push(`Title verification is low (past title value ${pastTitle.value}, highest is ${pastTitle.max}): title checks may be incomplete`);
    }
    const result: Record<string, unknown> = {
      score,
      maxScore: MAX_SCORE,
      ...(propertyName ? { property: propertyName } : {}),
      breakdown: Object.fromEntries(breakdown.map(d => {
        const groupChecks = checks?.filter(c => c.group === d.name) ?? [];
        return [d.name, {
          value: d.value,
          max: d.max,
          label: d.label,
          description: d.description,
          ...(groupChecks.length > 0 ? { checks: countChecks(groupChecks) } : {}),
        }];
      })),
    };
    if (checks && checks.length > 0) {
      result.checksPassed = countChecks(checks);
      result.checks = checks;
    }
    if (warnings.length > 0) {
      result.warnings = warnings;
    }
    result.howToRead = "This is the numeric encoding of Property checks: a 5-digit positional number, not a percentage or a grade. Each digit position represents a verification group: recovery status (ten-thousands), past title (thousands), ownership (hundreds), onchain history (tens), basic validation (ones). Higher is better. Max: 75342. Digits are category values, not counts; checksPassed counts the individual checks, like the checklist in the Fabrica app. Property checks are a starting point for your own research, not a title search or title insurance.";
    return result;
  } catch (e) {
    return { error: propertyLookupError(e, { tokenId }, "explain Property checks") };
  }
}
