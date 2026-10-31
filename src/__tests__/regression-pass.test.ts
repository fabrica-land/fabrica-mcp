import { afterEach, describe, expect, it, vi } from "vitest";
import { FabricaApiError, getWallet, propertyLookupError } from "../clients/graphql.js";
import { getProperty } from "../tools/properties.js";
import { explainConfidenceScore } from "../tools/scoring.js";
import { normalizeSlug, stateCode } from "../links.js";

/** Regression pass findings: input forms agents actually send, and the wording of a miss. */

function stubApi(body: unknown, status = 200): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const NOT_FOUND = { errors: [{ message: "No token or premint found for token with ID 12345 on any network", extensions: { status: 404 } }], data: null };

describe("a missing property reads as missing, not as a rejected query", () => {
  it("names the token ID", () => {
    expect(propertyLookupError(new FabricaApiError(["No token or premint found for token with ID 12345 on any network"]), { tokenId: "12345" }, "get property"))
      .toBe("No property found with token ID 12345");
  });
  it("names the slug", () => {
    expect(propertyLookupError(new FabricaApiError(["No token or premint found with slug x on Ethereum"]), { slug: "x" }, "get property"))
      .toBe("No property found with slug x");
  });
  it("keeps the API's own message for any other failure", () => {
    expect(propertyLookupError(new Error("boom"), { tokenId: "1" }, "get property")).toBe("Failed to get property: boom");
  });
  it("get_land_property reports a 404 from the API as not found", async () => {
    stubApi(NOT_FOUND, 404);
    expect(await getProperty({ tokenId: "12345" })).toEqual({ error: "No property found with token ID 12345" });
  });
});

describe("a wallet the API has never seen is an empty portfolio, not an error", () => {
  it("getWallet returns null on the API's No user found error", async () => {
    stubApi({ errors: [{ message: 'No user found for "not-an-address"' }], data: null }, 404);
    await expect(getWallet("not-an-address")).resolves.toBeNull();
  });
  it("propagates a response that carries another error next to No user found", async () => {
    stubApi({ errors: [{ message: 'No user found for "0xabc"' }, { message: "Cannot query field tokens on WalletModel" }], data: null }, 400);
    await expect(getWallet("0xabc")).rejects.toBeInstanceOf(FabricaApiError);
  });
});

describe("explain_property_checks rejects numbers that are not an encoding", () => {
  it("rejects 99 (digits above their group maximum)", async () => {
    const result = await explainConfidenceScore({ score: 99 }) as { error?: string };
    expect(result.error).toContain("99 is not a Property checks encoding");
  });
  it("rejects a number above 75342", async () => {
    const result = await explainConfidenceScore({ score: 80000 }) as { error?: string };
    expect(result.error).toContain("0 to 75342");
  });
  it("still explains a valid encoding", async () => {
    const result = await explainConfidenceScore({ score: 73342 }) as { score?: number };
    expect(result.score).toBe(73342);
  });
});

describe("state names and slugs in the forms agents send", () => {
  it("maps names and codes to the two-letter code", () => {
    expect(stateCode("Nevada")).toBe("NV");
    expect(stateCode("new mexico")).toBe("NM");
    expect(stateCode("nv")).toBe("NV");
    expect(stateCode("ZZ")).toBeNull();
    expect(stateCode("")).toBeNull();
  });
  it("accepts a fabrica.land URL or a leading slash as the slug", () => {
    expect(normalizeSlug("https://fabrica.land/us/nevada/elko-county/elko/apn-00633b008")).toBe("us/nevada/elko-county/elko/apn-00633b008");
    expect(normalizeSlug("https://testnets.fabrica.land/us/nevada/x/")).toBe("us/nevada/x");
    expect(normalizeSlug("https://fabrica.land/us/nevada/x?utm_source=share#photos")).toBe("us/nevada/x");
    expect(normalizeSlug("us/nevada/x?ref=1")).toBe("us/nevada/x");
    expect(normalizeSlug("https://evilfabrica.land/us/nevada/x")).toBe("https://evilfabrica.land/us/nevada/x");
    expect(normalizeSlug("/us/nevada/x")).toBe("us/nevada/x");
    expect(normalizeSlug("us/nevada/x")).toBe("us/nevada/x");
    expect(normalizeSlug("   ")).toBeUndefined();
    expect(normalizeSlug(undefined)).toBeUndefined();
  });
});
