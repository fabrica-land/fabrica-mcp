import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const server = readFileSync("src/server.ts", "utf8");
const entries = [
  { file: "server.json", name: "land.fabrica/mcp", url: "https://mcp.fabrica.land/mcp" },
  { file: "server.testnet.json", name: "land.fabrica/mcp-testnet", url: "https://mcp-testnet.fabrica.land/mcp" },
];

describe.each(entries)("MCP Registry entry $file", ({ file, name, url }) => {
  const entry = JSON.parse(readFileSync(file, "utf8"));

  it("names the namespace the fabrica.land DNS record grants and the host's own URL", () => {
    expect(entry.name).toBe(name);
    expect(entry.remotes).toEqual([{ type: "streamable-http", url }]);
    expect(entry.repository.url).toBe("https://github.com/fabrica-land/fabrica-mcp");
  });

  it("moves with the package version, so a bump republishes", () => {
    expect(entry.version).toBe(pkg.version);
  });

  it("keeps the description inside the registry limit and the wording rules", () => {
    expect(entry.description.length).toBeLessThanOrEqual(100);
    expect(entry.description).not.toMatch(/—|--|land loan|600\+|confidence score/i);
  });
});

describe("server version", () => {
  it("matches package.json in the server info", () => {
    expect(server).toContain(`version: "${pkg.version}"`);
  });
});
