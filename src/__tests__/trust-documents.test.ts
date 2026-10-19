import { describe, it, expect, vi } from "vitest";

vi.mock("../clients/graphql.js", () => ({
  getTrustDocuments: vi.fn(),
  propertyLookupError: (e: unknown, _lookup: unknown, action: string) => `Failed to ${action}: ${e instanceof Error ? e.message : String(e)}`,
}));

import { getTrustDocuments as fetchTrustDocuments } from "../clients/graphql.js";
import { getTrustDocuments, parseAgreementVersion, orderDocuments } from "../tools/documents.js";
import type { TrustDocumentsToken } from "../types/index.js";
import { IS_MAINNET } from "../config.js";

function makeToken(overrides: Partial<TrustDocumentsToken> = {}): TrustDocumentsToken {
  return {
    tokenId: "3484741603659410548",
    network: "ethereum",
    contractAddress: "0x5cbeb7a0df7ed85d82a472fd56d81ed550f3ea95",
    name: "92 Cuatro Ruedas Dr, Carson, NM",
    vanityName: null,
    propertyLink: "https://fabrica.land/us/new-mexico/taos-county/carson/92-cuatro-ruedas-dr",
    isPremint: false,
    district: "Taos County",
    regionCode: "NM",
    validator: "0x170511f95560a1f280c29026f73a9cd6a4ba8ab0",
    metadataUri: "https://metadata.fabrica.land/ethereum/0x5cbeb7a0df7ed85d82a472fd56d81ed550f3ea95/3484741603659410548",
    operatingAgreementName: "Fabrica US Trust v4.4",
    operatingAgreementUrl: "ipfs://bafkreiagreement",
    definition: {
      claim: "Tract C-1, a certain tract of land in Carson, Taos County, New Mexico",
      holdingEntity: "Fabrica 61E4M1MC4KP78 Trust",
      offchainRegistrar: { admin: "Taos", adminId: "35055", country: "US", propertyId: "1063145400040" },
    },
    configuration: {
      holdingEntityDate: "2024-08-03T21:00:30.785Z",
      proofOfTitle: { document: "ipfs://QmDeed", documentId: null, documentName: "Deed", grantor: "Sven Hermann and Mary Wall", source: "Taos, NM County Records" },
      documents: [
        { type: "survey", source: "ipfs://QmSurvey", description: "Boundary survey", order: "2" },
        { type: "plat", source: "https://ipfs.fabrica.land/ipfs/QmPlat", description: null, order: "1" },
      ],
      media: [{ type: "image" }, { type: "image" }],
    },
    ...overrides,
  };
}

describe("parseAgreementVersion", () => {
  it("reads the version from the agreement name", () => {
    expect(parseAgreementVersion("Fabrica US Trust v4.4")).toBe("4.4");
    expect(parseAgreementVersion("Fabrica Trust V3")).toBe("3");
    expect(parseAgreementVersion("Fabrica Trust")).toBeNull();
    expect(parseAgreementVersion(null)).toBeNull();
  });
});

describe("orderDocuments", () => {
  it("sorts by the owner's order and maps ipfs sources to the gateway", () => {
    const docs = orderDocuments([
      { type: "b", source: "ipfs://second", description: null, order: "2" },
      { type: "z", source: "ipfs://unordered", description: null, order: null },
      { type: "a", source: "ipfs://first", description: null, order: "1" },
    ]);
    expect(docs.map(d => d.type)).toEqual(["a", "b", "z"]);
    expect(docs[0].url).toBe("https://ipfs.fabrica.land/ipfs/first");
  });
});

describe("get_land_trust_documents", () => {
  it("requires a tokenId or slug", async () => {
    expect(await getTrustDocuments({})).toEqual({ error: "Either tokenId or slug is required" });
  });

  it("reports a missing property", async () => {
    vi.mocked(fetchTrustDocuments).mockResolvedValueOnce(null);
    const result = await getTrustDocuments({ tokenId: "1" }) as Record<string, unknown>;
    expect(result.error).toBe("No property found with token ID 1");
  });

  it("renders a minted token with a deed and uploaded documents", async () => {
    vi.mocked(fetchTrustDocuments).mockResolvedValueOnce(makeToken());
    const result = await getTrustDocuments({ tokenId: "3484741603659410548" }) as Record<string, unknown>;
    expect(vi.mocked(fetchTrustDocuments)).toHaveBeenLastCalledWith({ tokenId: "3484741603659410548", slug: undefined, withText: false });
    const trust = result.trust as Record<string, unknown>;
    expect(trust.holdingEntity).toBe("Fabrica 61E4M1MC4KP78 Trust");
    expect(trust.formedOn).toBe("2024-08-03T21:00:30.785Z");
    expect(trust.agreementVersion).toBe("4.4");
    expect(trust.agreementUrl).toBe("https://ipfs.fabrica.land/ipfs/bafkreiagreement");
    expect(trust.agreementText).toBeUndefined();
    expect(result.parcel).toEqual({ fips: "35055", apn: "1063145400040", county: "Taos County", state: "NM" });
    const deed = result.deed as Record<string, unknown>;
    expect(deed.url).toBe("https://ipfs.fabrica.land/ipfs/QmDeed");
    expect(deed.grantor).toBe("Sven Hermann and Mary Wall");
    expect((result.documents as Array<Record<string, unknown>>).map(d => d.type)).toEqual(["plat", "survey"]);
    expect(result.mediaCount).toBe(2);
    expect((result.links as Record<string, unknown>).propertyPage).toContain("fabrica.land");
    expect(result.notes).toBeUndefined();
    expect(result.notIncluded).toContain("not a title search or title insurance");
    expect(Boolean(result.legalNotice)).toBe(IS_MAINNET);
  });

  it("renders a premint with no documents yet", async () => {
    vi.mocked(fetchTrustDocuments).mockResolvedValueOnce(makeToken({
      isPremint: true,
      validator: null,
      definition: { claim: "", holdingEntity: "Fabrica PJ3HC8X8STR0A Trust", offchainRegistrar: { admin: "Santa Cruz", adminId: "06087", country: "US", propertyId: "074-132-05" } },
      district: null,
      configuration: { holdingEntityDate: "2026-10-17T00:31:34.367Z", proofOfTitle: null, documents: [], media: null },
    }));
    const result = await getTrustDocuments({ tokenId: "13008390391094751237" }) as Record<string, unknown>;
    expect(result.deed).toBeNull();
    expect(result.documents).toEqual([]);
    expect(result.legalDescription).toBeNull();
    expect(result.mediaCount).toBe(0);
    expect((result.parcel as Record<string, unknown>).county).toBe("Santa Cruz");
    const notes = result.notes as string[];
    expect(notes.join(" ")).toContain("premint");
    expect(notes.join(" ")).toContain("No deed is on file");
  });

  it("returns the agreement text only when asked", async () => {
    vi.mocked(fetchTrustDocuments).mockResolvedValueOnce(makeToken({ operatingAgreement: "# Fabrica Trust Agreement" }));
    const result = await getTrustDocuments({ tokenId: "1", includeAgreementText: true }) as Record<string, unknown>;
    expect(vi.mocked(fetchTrustDocuments)).toHaveBeenLastCalledWith({ tokenId: "1", slug: undefined, withText: true });
    expect((result.trust as Record<string, unknown>).agreementText).toBe("# Fabrica Trust Agreement");
  });

  it("uses Fabrica's legal wording: beneficial interest, trustee designated by the holder, no em dashes", async () => {
    vi.mocked(fetchTrustDocuments).mockResolvedValueOnce(makeToken());
    const text = JSON.stringify(await getTrustDocuments({ tokenId: "1" }));
    if (IS_MAINNET) {
      expect(text).toContain("beneficial interest in this trust");
      expect(text).toContain("designated by the token holder");
    } else {
      expect(text).toContain("no real-world legal or financial effect");
    }
    expect(text).not.toMatch(/token is the property|clean title|—/i);
    expect(text).not.toMatch(/Fabrica (manages|administers|operates|controls|holds)/);
  });

  it("reports API failures as errors", async () => {
    vi.mocked(fetchTrustDocuments).mockRejectedValueOnce(new Error("boom"));
    const result = await getTrustDocuments({ tokenId: "1" }) as Record<string, unknown>;
    expect(result.error).toBe("Failed to get trust documents: boom");
  });
});
