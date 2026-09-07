import { afterEach, describe, expect, it, vi } from "vitest";
import { FabricaApiError, getToken } from "../clients/graphql.js";
import { getProperty, getPropertyMap } from "../tools/properties.js";

/** Answer the next fetch with a GraphQL response body under the given HTTP status. */
function stubApi(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getToken distinguishes a schema error from a missing token", () => {
  it("throws FabricaApiError carrying the API's message when the query is rejected", async () => {
    stubApi({ errors: [{ message: 'Cannot query field "someField" on type "TokenModel".' }] }, 400);
    await expect(getToken({ tokenId: "1" })).rejects.toThrowError(FabricaApiError);
    stubApi({ errors: [{ message: 'Cannot query field "someField" on type "TokenModel".' }] }, 400);
    await expect(getToken({ tokenId: "1" })).rejects.toThrowError(
      'Fabrica API rejected the query: Cannot query field "someField" on type "TokenModel".',
    );
  });
  it("returns null — without throwing — when the token genuinely does not exist", async () => {
    stubApi({ data: { token: null } });
    await expect(getToken({ tokenId: "1" })).resolves.toBeNull();
  });
});

describe("getProperty reports the two cases differently", () => {
  it("surfaces the schema error instead of claiming the property is missing", async () => {
    stubApi({ errors: [{ message: 'Cannot query field "someField" on type "TokenModel".' }] }, 400);
    const result = await getProperty({ tokenId: "9497396897386364623" });
    expect(result).toEqual({
      error: 'Failed to get property: Fabrica API rejected the query: Cannot query field "someField" on type "TokenModel".',
    });
  });
  it("still says not-found when the token genuinely does not exist", async () => {
    stubApi({ data: { token: null } });
    const result = await getProperty({ tokenId: "9497396897386364623" });
    expect(result).toEqual({ error: "No property found with token ID 9497396897386364623" });
  });
});

describe("getPropertyMap degrades on a county-outline failure instead of swallowing it", () => {
  it("still returns the property feature and reports the county failure as a warning", async () => {
    const token = {
      tokenId: "1",
      name: "Test Property",
      acres: "0.5",
      district: "Los Angeles County",
      geoJson: { type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
      coordinates: { lat: 1, lon: 2 },
      definition: { offchainRegistrar: { propertyId: "06037-018-007" } },
    };
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call += 1;
      // First request is GetToken, second is GetCountyBounds — only the latter fails.
      const body = call === 1
        ? { data: { token } }
        : { errors: [{ message: 'Cannot query field "geoJson" on type "CountyBoundsModel".' }] };
      return new Response(JSON.stringify(body), {
        status: call === 1 ? 200 : 400,
        headers: { "content-type": "application/json" },
      });
    }));
    const result = await getPropertyMap({ tokenId: "1" }) as Record<string, unknown>;
    expect(result.type).toBe("FeatureCollection");
    expect((result.features as unknown[]).length).toBe(1);
    expect(result.warnings).toEqual([
      'County outline for FIPS 06037 unavailable: Fabrica API rejected the query: Cannot query field "geoJson" on type "CountyBoundsModel".',
    ]);
  });
});
