import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const run = promisify(execFile);
const scriptUrl = new URL("../../scripts/build-knowledge.mjs", import.meta.url).href;

const frontmatterResultSchema = z.object({
  attributes: z.record(z.string(), z.string()),
  body: z.string(),
});

const passagesResultSchema = z.array(
  z.object({
    sectionTitle: z.string(),
    text: z.string(),
  }),
);

async function parseFrontmatter(markdown: string) {
  const code = `import { parseFrontmatter } from ${JSON.stringify(scriptUrl)}; console.log(JSON.stringify(parseFrontmatter(${JSON.stringify(markdown)})));`;
  const { stdout } = await run("node", ["--input-type=module", "-e", code]);
  return frontmatterResultSchema.parse(JSON.parse(stdout));
}

async function splitIntoPassages(text: string, pageTitle: string) {
  const code = `import { splitIntoPassages } from ${JSON.stringify(scriptUrl)}; console.log(JSON.stringify(splitIntoPassages(${JSON.stringify(text)}, ${JSON.stringify(pageTitle)})));`;
  const { stdout } = await run("node", ["--input-type=module", "-e", code]);
  return passagesResultSchema.parse(JSON.parse(stdout));
}

describe("build-knowledge frontmatter parser", () => {
  it("reads folded block-scalar excerpts (>- and >) into their indented text", async () => {
    const markdown = [
      "---",
      "title: Configuration Object",
      "excerpt: >-",
      "  Details and data about the property configuration,",
      "  including title proof and media information.",
      "hidden: false",
      "---",
      "Body text follows.",
    ].join("\n");
    const result = await parseFrontmatter(markdown);
    expect(result.attributes.title).toBe("Configuration Object");
    expect(result.attributes.excerpt).toBe(
      "Details and data about the property configuration, including title proof and media information.",
    );
    expect(result.attributes.hidden).toBe("false");
    expect(result.body).toBe("Body text follows.");
    const nested = [
      "---",
      "title: Nested Folded",
      "content:",
      "  excerpt: >",
      "    First folded line",
      "    and second folded line.",
      "---",
      "Nested body.",
    ].join("\n");
    const nestedResult = await parseFrontmatter(nested);
    expect(nestedResult.attributes["content.excerpt"]).toBe("First folded line and second folded line.");
  });

  it("reads literal block-scalar excerpts (| and |-) preserving line breaks", async () => {
    const markdown = [
      "---",
      "title: Literal Excerpt",
      "excerpt: |",
      "  First line of the summary.",
      "  Second line of the summary.",
      "---",
      "Literal body.",
    ].join("\n");
    const result = await parseFrontmatter(markdown);
    expect(result.attributes.excerpt).toBe("First line of the summary.\nSecond line of the summary.");
    expect(result.body).toBe("Literal body.");
    const stripped = [
      "---",
      "title: Stripped Literal",
      "excerpt: |-",
      "  Line one.",
      "  Line two.",
      "---",
      "Body.",
    ].join("\n");
    const strippedResult = await parseFrontmatter(stripped);
    expect(strippedResult.attributes.excerpt).toBe("Line one.\nLine two.");
  });

  it("preserves relative indentation in literal block-scalar excerpts (|)", async () => {
    const markdown = [
      "---",
      "title: Nested Literal",
      "excerpt: |",
      "  Summary heading:",
      "    - First indented item",
      "      - Deeper nested item",
      "",
      "  Closing line.",
      "---",
      "Body text.",
    ].join("\n");
    const result = await parseFrontmatter(markdown);
    expect(result.attributes.excerpt).toBe(
      "Summary heading:\n  - First indented item\n    - Deeper nested item\n\nClosing line.",
    );
    expect(result.body).toBe("Body text.");
  });

  it("keeps plain and quoted single-line excerpts unchanged", async () => {
    const plain = [
      "---",
      "title: Plain Page",
      "excerpt: A plain single-line excerpt for a docs page.",
      "---",
      "Plain body.",
    ].join("\n");
    const plainResult = await parseFrontmatter(plain);
    expect(plainResult.attributes.excerpt).toBe("A plain single-line excerpt for a docs page.");
    expect(plainResult.body).toBe("Plain body.");
    const quoted = [
      "---",
      'title: "Quoted Page"',
      'excerpt: "A quoted single-line excerpt."',
      "content:",
      "  excerpt: 'A nested single-quoted excerpt.'",
      "---",
      "Quoted body.",
    ].join("\n");
    const quotedResult = await parseFrontmatter(quoted);
    expect(quotedResult.attributes.title).toBe("Quoted Page");
    expect(quotedResult.attributes.excerpt).toBe("A quoted single-line excerpt.");
    expect(quotedResult.attributes["content.excerpt"]).toBe("A nested single-quoted excerpt.");
  });
});

describe("build-knowledge passage splitting", () => {
  it("folds a short opening excerpt into the following section", async () => {
    const text = [
      "Your land. Unlocked.",
      "",
      "## Websites",
      "",
      "Fabrica App and Marketplace are here: https://fabrica.land.",
    ].join("\n");
    const passages = await splitIntoPassages(text, "Why Fabrica");
    expect(passages).toHaveLength(1);
    expect(passages[0].sectionTitle).toBe("Why Fabrica");
    expect(passages[0].text).toContain("Your land. Unlocked.");
    expect(passages[0].text).toContain("## Websites");
    expect(passages[0].text.length).toBeGreaterThan(20);
  });
});
