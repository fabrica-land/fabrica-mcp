import { describe, expect, it } from "vitest";
import { containsSecret, contactSupport, SUPPORT_EMAIL } from "../tools/support.js";

function bodyOf(mailto: string): string {
  return decodeURIComponent(new URL(mailto).searchParams.get("body") ?? "");
}

describe("contact_support (links and email)", () => {
  it("returns the topic's help center page, the support address and a mailto with the summary", () => {
    const result = contactSupport({ summary: "The notary step says my session expired and I cannot book a new one.", topic: "adding_property", tokenId: "123" });
    if ("error" in result) throw new Error(result.error);
    expect(result.email).toBe(SUPPORT_EMAIL);
    expect(result.helpCenterUrl).toContain("help.fabrica.land/en/collections/");
    const url = new URL(result.mailto);
    expect(url.protocol).toBe("mailto:");
    expect(url.pathname).toBe(SUPPORT_EMAIL);
    expect(url.searchParams.get("subject")).toContain("token 123");
    expect(bodyOf(result.mailto)).toContain("notary step");
    expect(bodyOf(result.mailto)).toContain("/property/");
    expect(result.note).toContain("Nothing has been sent");
  });

  it("keeps the mailto short enough for mail clients", () => {
    const result = contactSupport({ summary: "word ".repeat(390) });
    if ("error" in result) throw new Error(result.error);
    expect(result.mailto.length).toBeLessThanOrEqual(1900);
  });

  it("refuses key material but not talk about keys or transaction hashes", () => {
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
    expect(contactSupport({ summary: `please help, key: ${"cd".repeat(32)}` })).toMatchObject({ error: expect.stringContaining("private key") });
  });

  it("keeps the property link when the summary is cut and refuses a non-numeric token ID", () => {
    const result = contactSupport({ summary: "word ".repeat(390), tokenId: "123" });
    if ("error" in result) throw new Error(result.error);
    expect(result.mailto.length).toBeLessThanOrEqual(1900);
    expect(decodeURIComponent(result.mailto)).toContain("/property/");
    expect(contactSupport({ summary: "A question about my property listing.", tokenId: `0x${"ab".repeat(32)}` })).toMatchObject({ error: expect.stringContaining("digits only") });
  });

  it("catches a capitalized seed phrase and survives malformed Unicode", () => {
    expect(containsSecret("Abandon ability able about above absent absorb abstract absurd abuse access accident")).toBe(true);
    const result = contactSupport({ summary: "A question about my parcel \ud800 listing." });
    expect("mailto" in result).toBe(true);
  });

  it("writes its strings without em dashes", () => {
    const result = contactSupport({ summary: "A question about selling my parcel while it is being added." });
    expect(JSON.stringify(result)).not.toMatch(/—/);
  });
});
