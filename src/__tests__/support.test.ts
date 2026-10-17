import { describe, expect, it, vi } from "vitest";

vi.mock("../clients/graphql.js", () => ({
  getPropertyLink: vi.fn(async (tokenId: string) => (tokenId === "123" ? "https://fabrica.land/us/arizona/navajo-county/lot-123" : null)),
}));

const { containsSecret, contactSupport, SUPPORT_EMAIL } = await import("../tools/support.js");

function bodyOf(mailto: string): string {
  return decodeURIComponent(new URL(mailto).searchParams.get("body") ?? "");
}

describe("contact_support (links and email)", () => {
  it("returns the topic's help center page, the support address and a mailto with the summary", async () => {
    const result = await contactSupport({ summary: "The notary step says my session expired and I cannot book a new one.", topic: "adding_property", tokenId: "123" });
    if ("error" in result) throw new Error(result.error);
    expect(result.email).toBe(SUPPORT_EMAIL);
    expect(result.helpCenterUrl).toContain("help.fabrica.land/en/collections/");
    const url = new URL(result.mailto);
    expect(url.protocol).toBe("mailto:");
    expect(url.pathname).toBe(SUPPORT_EMAIL);
    expect(url.searchParams.get("subject")).toContain("token 123");
    expect(bodyOf(result.mailto)).toContain("notary step");
    expect(bodyOf(result.mailto)).toContain("Property: https://fabrica.land/us/arizona/navajo-county/lot-123");
    expect(bodyOf(result.mailto)).toContain("Drafted with an AI agent");
    expect(result.note).toContain("Nothing has been sent");
  });

  it("keeps the mailto short enough for mail clients", async () => {
    const result = await contactSupport({ summary: "the parcel and the deed ".repeat(80) });
    if ("error" in result) throw new Error(result.error);
    expect(result.mailto.length).toBeLessThanOrEqual(1900);
  });

  it("refuses key material but not talk about keys or transaction hashes", async () => {
    expect(containsSecret(`my key is ${"ab".repeat(32)}`)).toBe(true);
    expect(containsSecret("abandon ability able about above absent absorb abstract absurd abuse access accident")).toBe(true);
    expect(containsSecret("I lost my private key and my seed phrase, what can I do?")).toBe(false);
    expect(containsSecret(`Transaction hash: 0x${"ab".repeat(32)} failed.`)).toBe(false);
    expect(containsSecret(`transaction signing key: 0x${"ab".repeat(32)}`)).toBe(true);
    expect(containsSecret(`The transaction 0x${"ab".repeat(32)} failed.`)).toBe(true);
    expect(containsSecret(`key 0x${"ab".repeat(32)}`)).toBe(true);
    expect(containsSecret(`https://etherscan.io/tx/0x${"ab".repeat(32)}`)).toBe(false);
    expect(containsSecret("My seed phrase is: abandon ability able about above absent absorb abstract absurd abuse access accident. Help!")).toBe(true);
    expect(containsSecret("1. abandon 2. ability 3. able 4. about 5. above 6. absent 7. absorb 8. abstract 9. absurd 10. abuse 11. access 12. accident")).toBe(true);
    expect(containsSecret("I tried to add my parcel in Texas but the upload of the deed keeps failing after the identity check, and support said to email you with the token number.")).toBe(false);
    expect(await contactSupport({ summary: `please help, key: ${"cd".repeat(32)}` })).toMatchObject({ error: expect.stringContaining("private key") });
  });

  it("keeps the property link when the summary is cut and refuses a non-numeric token ID", async () => {
    const result = await contactSupport({ summary: "the parcel and the deed ".repeat(80), tokenId: "123" });
    if ("error" in result) throw new Error(result.error);
    expect(result.mailto.length).toBeLessThanOrEqual(1900);
    expect(decodeURIComponent(result.mailto)).toContain("navajo-county/lot-123");
    expect(await contactSupport({ summary: "A question about my property listing.", tokenId: `0x${"ab".repeat(32)}` })).toMatchObject({ error: expect.stringContaining("digits only") });
  });

  it("catches a capitalized seed phrase and survives malformed Unicode", async () => {
    expect(containsSecret("Abandon ability able about above absent absorb abstract absurd abuse access accident")).toBe(true);
    expect(containsSecret(`key 0X${"AB".repeat(32)}`)).toBe(true);
    expect(containsSecret(`${"abandon ".repeat(11)}about`)).toBe(true);
    expect(containsSecret("wrong habit note fury wink plate film account shed wood eight please")).toBe(true);
    expect(containsSecret(`- ${"abandon\n- ".repeat(11)}about`)).toBe(true);
    expect(containsSecret(`${"abandon, ".repeat(11)}about`)).toBe(true);
    expect(containsSecret("frase semilla: ábaco abdomen abeja abierto abogado abono aborto abrazo abrir abuelo abuso acabar")).toBe(true);
    expect(containsSecret(`my private key is /tx/0x${"ab".repeat(32)}`)).toBe(true);
    expect(containsSecret(`https://sepolia.etherscan.io/tx/0x${"ab".repeat(32)}`)).toBe(false);
    expect(containsSecret("Mi seed phrase: ábaco abdomen abeja abierto abogado abono aborto abrazo abrir abuelo abuso acabar")).toBe(true);
    expect(containsSecret("recovery phrase: あいこくしん あいさつ あいだ あおぞら あかちゃん あきる あけがた あける あこがれる あさい あさひ あしあと")).toBe(true);
    expect(containsSecret("I lost my seed phrase and cannot open the wallet that holds my parcel token.")).toBe(false);
    expect(containsSecret("的 一 是 在 不 了 有 和 人 这 中 大")).toBe(true);
    expect(containsSecret("我想出售我在德州的土地，但是系统一直不接受我的身份证明文件，请问应该怎么办？")).toBe(false);
    expect(containsSecret("seed phrase: 的一是在不了有和人这中大")).toBe(true);
    expect(containsSecret("recovery phrase: あいこくしん あいさつ あいだ あおぞら あかちゃん あきる あけがた あける あこがれる あさい あさひ あしあと".normalize("NFKD"))).toBe(true);
    expect(containsSecret("Cannot upload deed because identity check failed during final review step again.")).toBe(false);
    const result = await contactSupport({ summary: "A question about my parcel \ud800 listing." });
    expect("mailto" in result).toBe(true);
  });

  it("writes its strings without em dashes", async () => {
    const result = await contactSupport({ summary: "A question about selling my parcel while it is being added." });
    expect(JSON.stringify(result)).not.toMatch(/—/);
  });

  it("keeps emoji intact when the summary is cut", async () => {
    const summary = `${"x".repeat(1799)}\u{1F600}${"y".repeat(199)}`;
    const result = await contactSupport({ summary });
    expect("mailto" in result && result.mailto.length).toBeLessThanOrEqual(1900);
  });
});

describe("contact_support subject, disclosure and link", () => {
  it("uses the caller's subject and leaves the disclosure out on request", async () => {
    const result = await contactSupport({ summary: "My on-ramp has been stuck at title review for two weeks.", subject: "Title review stuck", discloseAgent: false });
    if ("error" in result) throw new Error(result.error);
    const url = new URL(result.mailto);
    expect(url.searchParams.get("subject")).toBe("Title review stuck");
    expect(bodyOf(result.mailto)).not.toContain("AI agent");
  });

  it("falls back to the stable property link when the API has none", async () => {
    const result = await contactSupport({ summary: "A question about the deed for this property.", tokenId: "999" });
    if ("error" in result) throw new Error(result.error);
    expect(result.propertyLink).toMatch(/\/property\/(ethereum|sepolia)\/999$/);
  });
});
