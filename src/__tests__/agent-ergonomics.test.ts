import { describe, expect, it } from "vitest";
import { formatActivity, previousScores } from "../tools/activity.js";
import { legalDescriptionPreview } from "../tools/properties.js";
import { describeScoreChange } from "../tools/scoring.js";
import { activity } from "./fixtures.js";

const scoreEvent = (tokenId: string, time: string, newValue: string) => activity({ tokenId, time, newValue });

describe("ScoreChanged detail", () => {
  it("names the groups that moved", () => {
    expect(describeScoreChange("73342", "72342")).toEqual({ encoding: 73342, previousEncoding: 72342, changed: ["Past Title & Load 2 to 3 (of 5)"] });
  });

  it("gives the encoding alone when the one before is unknown, and nothing for a bad value", () => {
    expect(describeScoreChange("73342", null)).toEqual({ encoding: 73342, previousEncoding: null });
    expect(describeScoreChange("not-a-score", null)).toBeNull();
  });

  it("pairs each change with the older one for the same token", () => {
    const feed = [scoreEvent("1", "2026-10-03", "73342"), scoreEvent("2", "2026-10-02", "75342"), scoreEvent("1", "2026-10-01", "72342")];
    const previous = previousScores(feed);
    expect(previous.get(0)).toBe("72342");
    expect(previous.get(1)).toBeNull();
    expect(formatActivity(feed[0], previous.get(0)).propertyChecks?.changed).toEqual(["Past Title & Load 2 to 3 (of 5)"]);
  });
});

describe("legal description preview", () => {
  it("keeps a short description whole and cuts a long one at a word", () => {
    expect(legalDescriptionPreview("Lot 1, Block 2")).toEqual({ description: "Lot 1, Block 2", truncated: false });
    const long = legalDescriptionPreview("parcel ".repeat(200));
    expect(long.truncated).toBe(true);
    expect(long.description?.length ?? 0).toBeLessThanOrEqual(606);
    expect(long.description).toMatch(/parcel \[\.\.\.\]$/);
    expect(legalDescriptionPreview(null)).toEqual({ description: null, truncated: false });
  });
});
