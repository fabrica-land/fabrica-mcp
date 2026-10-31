import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * The repository is public: no internal tracker ids in tracked files. The API's
 * schema descriptions are copied verbatim from the live API and stay as they are.
 */

const EXEMPT = [/^schema\//, /^src\/clients\/generated\//, /^package-lock\.json$/, /\.(png|jpe?g|ttf|woff2?)$/];
const TRACKER_ID = /\b(?:P-)?(?:ENG|ASK)-\d+\b/;

describe("public repository", () => {
  it("has no internal tracker ids in tracked files", () => {
    const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
    const hits = files
      .filter((f) => !EXEMPT.some((re) => re.test(f)))
      .flatMap((f) => {
        let text: string;
        try {
          text = readFileSync(f, "utf8");
        } catch {
          return [];
        }
        return text.split("\n").flatMap((line, i) => (TRACKER_ID.test(line) ? [`${f}:${i + 1}`] : []));
      });
    expect(hits).toEqual([]);
  });
});
