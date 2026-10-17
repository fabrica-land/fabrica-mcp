import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const script = new URL("../../scripts/knowledge-diff.mjs", import.meta.url).pathname;

function passage(url: string, title: string, text: string, source = "docs") {
  return { id: `${source}:${url}`, source, title, sectionTitle: title, url, text, updatedAt: "2026-10-17" };
}

describe("knowledge-diff", () => {
  it("names the moved sources in the title and lists added, removed and changed pages", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "knowledge-diff-"));
    const before = {
      builtAt: "2026-10-01",
      sources: { docs: { url: "https://docs.fabrica.land", commit: "aaaaaaa1111", documents: 2 }, help: { url: "https://help.fabrica.land", fingerprint: "f1", documents: 1 }, "trust-agreement": { url: "https://github.com/x", commit: "ccccccc", documents: 1 } },
      passages: [
        passage("https://docs.fabrica.land/docs/fees", "Fees", "Fees are 1 percent."),
        passage("https://docs.fabrica.land/docs/old", "Old page", "Gone soon."),
        passage("https://help.fabrica.land/en/articles/1-x", "Help one", "Help text.", "help"),
        passage("https://github.com/x", "Trust", "Trust text.", "trust-agreement"),
      ],
    };
    const after = {
      ...before,
      builtAt: "2026-10-17",
      sources: { ...before.sources, docs: { ...before.sources.docs, commit: "bbbbbbb2222", documents: 2 } },
      passages: [
        passage("https://docs.fabrica.land/docs/fees", "Fees", "Fees are 2 percent."),
        passage("https://docs.fabrica.land/docs/new", "New page", "Brand new."),
        passage("https://help.fabrica.land/en/articles/1-x", "Help one", "Help text.", "help"),
        passage("https://github.com/x", "Trust", "Trust text.", "trust-agreement"),
      ],
    };
    await writeFile(path.join(dir, "before.json"), JSON.stringify(before));
    await writeFile(path.join(dir, "after.json"), JSON.stringify(after));
    const { stdout } = await run("node", [script, path.join(dir, "before.json"), path.join(dir, "after.json"), "--out", path.join(dir, "out")]);
    const title = await readFile(path.join(dir, "out", "title.txt"), "utf8");
    expect(title.trim()).toBe("Knowledge index: docs.fabrica.land bbbbbbb");
    expect(stdout).toContain("docs.fabrica.land: aaaaaaa to bbbbbbb (2 documents)");
    expect(stdout).toContain("help center: unchanged at f1");
    expect(stdout).toContain("1 added, 1 removed, 1 changed");
    expect(stdout).toContain("- New page (docs.fabrica.land): https://docs.fabrica.land/docs/new");
    expect(stdout).toContain("- Old page (docs.fabrica.land): https://docs.fabrica.land/docs/old");
    expect(stdout).toContain("- Fees (docs.fabrica.land): https://docs.fabrica.land/docs/fees");
    expect(stdout).not.toContain("—");
  });
});
