import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FONT_ORIGIN } from "../ui/property-card.js";

describe("property card brand font", () => {
  it("is loaded from the origin the card's CSP allows, and every file ships in ui/fonts", () => {
    const html = readFileSync(join(process.cwd(), "ui/property-card/index.html"), "utf8");
    const urls = [...html.matchAll(/url\("([^"]+)"\)/g)].map((m) => new URL(m[1]));
    expect(urls.length).toBe(3);
    for (const url of urls) {
      expect(url.origin).toBe(FONT_ORIGIN);
      expect(url.pathname.startsWith("/fonts/")).toBe(true);
      const file = url.pathname.slice("/fonts/".length);
      expect(readFileSync(join(process.cwd(), "ui/fonts", file)).byteLength).toBeGreaterThan(1000);
    }
  });
});
