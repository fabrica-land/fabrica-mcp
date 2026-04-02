import { getToken } from "../clients/graphql.js";

const MAX_SCORE = 75342;

const GROUP_WEIGHTS = [
  { name: "recoveryStatus", weight: 10000, max: 7, title: "Recovery Status", description: "Recovery/integrity status of the token-property link" },
  { name: "pastTitleAndLoad", weight: 1000, max: 5, title: "Past Title & Load", description: "Level of confidence on title history up to and after tokenization" },
  { name: "ownership", weight: 100, max: 3, title: "Ownership", description: "Level of confidence in the token ownership" },
  { name: "onChainHistory", weight: 10, max: 4, title: "On-Chain History", description: "Level of confidence in transactions performed on chain" },
  { name: "basicValidation", weight: 1, max: 2, title: "Basic Validation", description: "Is the NFT correctly formed?" },
] as const;

const RECOVERY_LABELS: Record<number, string> = {
  7: "Normal — no recovery claims",
  6: "Under review — quiet period active",
  5: "Recovery in progress — property may be disputed",
  1: "Voided — token-property link is permanently broken",
  0: "Unknown — no recovery status recorded",
};

function decomposeScore(score: number) {
  let remaining = score;
  const digits: { name: string; value: number; max: number; title: string; description: string; label: string }[] = [];
  for (const group of GROUP_WEIGHTS) {
    const value = Math.floor(remaining / group.weight);
    remaining = remaining % group.weight;
    let label: string;
    if (group.name === "recoveryStatus") {
      label = RECOVERY_LABELS[value] ?? `Unknown (${value})`;
    } else if (value === group.max) {
      label = "Complete — all checks pass";
    } else if (value === 0) {
      label = "None — no checks pass";
    } else {
      label = `${value}/${group.max} checks pass`;
    }
    digits.push({ name: group.name, value, max: group.max, title: group.title, description: group.description, label });
  }
  return digits;
}

export async function explainConfidenceScore(args: Record<string, unknown>) {
  const tokenId = args.tokenId as string | undefined;
  const rawScore = args.score as number | undefined;
  if (!tokenId && rawScore === undefined) {
    return { error: "Provide either tokenId or score to explain" };
  }
  try {
    let score = rawScore;
    let checks: { check: string; group: string; passed: boolean }[] | null = null;
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
      return { error: "No confidence score available for this property" };
    }
    const breakdown = decomposeScore(score);
    const warnings: string[] = [];
    const recovery = breakdown.find(d => d.name === "recoveryStatus");
    if (recovery && recovery.value !== 7) {
      warnings.push(`Recovery status: ${recovery.label}`);
    }
    const pastTitle = breakdown.find(d => d.name === "pastTitleAndLoad");
    if (pastTitle && pastTitle.value < 3) {
      warnings.push(`Title verification is low (${pastTitle.value}/${pastTitle.max}) — title checks may be incomplete`);
    }
    const result: Record<string, unknown> = {
      score,
      maxScore: MAX_SCORE,
      percentage: `${((score / MAX_SCORE) * 100).toFixed(1)}%`,
      ...(propertyName ? { property: propertyName } : {}),
      breakdown: Object.fromEntries(breakdown.map(d => [d.name, {
        value: d.value,
        max: d.max,
        label: d.label,
        description: d.description,
      }])),
    };
    if (checks && checks.length > 0) {
      result.checks = checks;
    }
    if (warnings.length > 0) {
      result.warnings = warnings;
    }
    result.howToRead = "The score is a 5-digit positional number. Each digit position represents a verification group: recovery status (ten-thousands), past title (thousands), ownership (hundreds), on-chain history (tens), basic validation (ones). Higher is better. Max: 75342.";
    return result;
  } catch (e) {
    return { error: `Failed to explain score: ${e instanceof Error ? e.message : String(e)}` };
  }
}
