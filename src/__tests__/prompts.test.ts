import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import { dueDiligencePrompt, howToAddLandPrompt, walletReviewPrompt, workParcelListPrompt } from "../prompts.js";
import { IS_MAINNET } from "../config.js";

const SKILL = readFileSync(new URL("../../skills/fabrica/SKILL.md", import.meta.url), "utf8");

/** Public wording (AGENTS.md "Public Wording Rules") that prompts and the skill file must not break. */
const FORBIDDEN: ReadonlyArray<[RegExp, string]> = [
  [/—/, "em dash"],
  [/open[- ]source/i, "open source"],
  [/on-chain/i, "on-chain (write onchain)"],
  [/Fabrica lending pool/i, "retired pool name"],
  [/\bProvenance Score\b|\btoken score\b/i, "retired names for Property checks"],
  [/(?<!")\binstantly\b(?!")/i, "instantly"],
  [/always equal \$1/i, "stablecoin promise"],
  [/repayment rate/i, "aggregate repayment rate"],
  [/Fabrica (manages|administers|operates|controls|oversees|handles|holds) (your|the|their|someone)/i, "Fabrica as a party"],
];

function promptText(result: { messages: Array<{ content: { type: string; text?: string } }> }): string {
  return result.messages.map((message) => message.content.text ?? "").join("\n");
}

const PROMPTS = {
  due_diligence: promptText(dueDiligencePrompt("4737315677965897536")),
  work_parcel_list: promptText(workParcelListPrompt("1707 Jones St, San Francisco, CA")),
  wallet_review: promptText(walletReviewPrompt("0x0000000000000000000000000000000000000001")),
  how_to_add_land: promptText(howToAddLandPrompt("1707 Jones St, Greenville, TX")),
};

describe("MCP prompts", () => {
  it("lists the four prompts with titles and arguments", async () => {
    const server = createServer();
    const client = new Client({ name: "prompt-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["due_diligence", "how_to_add_land", "wallet_review", "work_parcel_list"]);
    for (const p of prompts) {
      expect(p.title, p.name).toBeTruthy();
      expect(p.arguments?.length, p.name).toBe(1);
      expect(p.description ?? "", p.name).not.toMatch(/—/);
    }
    const result = await client.getPrompt({ name: "due_diligence", arguments: { tokenId: "123" } });
    expect(promptText(result)).toContain("property 123");
    await client.close();
  });

  it("carries the wording rules and the network notice in every prompt", () => {
    for (const [name, text] of Object.entries(PROMPTS)) {
      expect(text, name).toContain("Property checks");
      if (IS_MAINNET) {
        expect(text, name).toContain("beneficial interest in the trust");
        expect(text, name).toContain("Legal notice (Ethereum Mainnet)");
      } else {
        expect(text, name).toContain("not ownership of any real property");
      }
    }
  });

  it("never calls a test token ownership on Sepolia", async () => {
    vi.stubEnv("FABRICA_NETWORK", "sepolia");
    vi.resetModules();
    try {
      const testnet = await import("../prompts.js");
      const text = promptText(testnet.walletReviewPrompt("0xabc"));
      expect(text).toContain("not ownership of any real property");
      expect(text).not.toContain("Owning a Fabrica token means owning");
      const addLand = promptText(testnet.howToAddLandPrompt("1 Main St"));
      expect(addLand).toContain("No trust is created");
      expect(addLand).not.toContain("the deed is recorded at the county");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("ends due diligence with independent verification and no recommendation", () => {
    expect(PROMPTS.due_diligence).toContain("What to verify yourself");
    expect(PROMPTS.due_diligence).toContain("No recommendation to buy");
  });

  it("uses find_parcel for parcel lists and adding land", () => {
    expect(PROMPTS.work_parcel_list).toContain("find_parcel");
    expect(PROMPTS.how_to_add_land).toContain("find_parcel");
  });
});

describe("public wording in prompts and the skill file", () => {
  for (const [name, text] of [...Object.entries(PROMPTS), ["skills/fabrica/SKILL.md", SKILL] as const]) {
    it(name, () => {
      for (const [pattern, label] of FORBIDDEN) expect(text, `${name}: ${label}`).not.toMatch(pattern);
    });
  }
});

describe("skills/fabrica/SKILL.md", () => {
  it("has Agent Skills frontmatter", () => {
    expect(SKILL).toMatch(/^---\nname: fabrica\ndescription: .+\n---\n/);
  });

  it("lists every tool the server registers", async () => {
    const server = createServer();
    const client = new Client({ name: "skill-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    await client.close();
    for (const tool of tools) expect(SKILL, tool.name).toContain(`\`${tool.name}\``);
  });

  it("states the legal red lines and both server URLs", () => {
    expect(SKILL).toContain("beneficial interest in the trust");
    expect(SKILL).toContain("by default, the holder");
    expect(SKILL).toContain("not a title search");
    expect(SKILL).toContain("https://mcp.fabrica.land/mcp");
    expect(SKILL).toContain("https://mcp-testnet.fabrica.land/mcp");
  });
});
