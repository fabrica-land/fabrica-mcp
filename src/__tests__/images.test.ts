import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config
vi.mock("../config.js", () => ({
  NETWORK: "ethereum",
  IS_MAINNET: true,
  CONTRACTS: {
    fabricaToken: "0x5cbeb7A0df7Ed85D82a472FD56d81ed550f3Ea95",
  },
}));

// Mock graphql client
const mockGetToken = vi.fn();
vi.mock("../clients/graphql.js", () => ({
  getToken: (...args: unknown[]) => mockGetToken(...args),
}));

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mocks
const { getPropertyImage, getPortfolioImage } = await import("../tools/images.js");

describe("getPropertyImage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when neither tokenId nor slug provided", async () => {
    const result = await getPropertyImage({});
    expect(result).toEqual({ error: "Either tokenId or slug is required" });
  });

  it("returns error when token not found", async () => {
    mockGetToken.mockResolvedValue(null);
    const result = await getPropertyImage({ tokenId: "999" });
    expect(result).toEqual({ error: "No property found with token ID 999" });
  });

  it("returns image data on success", async () => {
    mockGetToken.mockResolvedValue({
      tokenId: "123",
      name: "Test Property",
      vanityName: null,
      contractAddress: "0x5cbeb7A0df7Ed85D82a472FD56d81ed550f3Ea95",
    });
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: () => Promise.resolve(pngBytes.buffer),
    });
    const result = await getPropertyImage({ tokenId: "123", theme: "light" });
    expect(result).toHaveProperty("tokenId", "123");
    expect(result).toHaveProperty("name", "Test Property");
    expect(result).toHaveProperty("image");
    const image = (result as { image: { data: string; mimeType: string } }).image;
    expect(image.mimeType).toBe("image/png");
    expect(image.data).toBe(Buffer.from(pngBytes).toString("base64"));
    // Verify the URL was constructed correctly
    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    expect(fetchUrl).toContain("media.fabrica.land");
    expect(fetchUrl).toContain("ethereum");
    expect(fetchUrl).toContain("123/image");
    expect(fetchUrl).toContain("theme=light");
    expect(fetchUrl).toContain("0x5cbeb7A0df7Ed85D82a472FD56d81ed550f3Ea95");
  });

  it("uses token contractAddress in media URL", async () => {
    const altContract = "0xALTERNATIVEcontractAddress00000000000000";
    mockGetToken.mockResolvedValue({
      tokenId: "789",
      name: "Alt Contract Token",
      vanityName: null,
      contractAddress: altContract,
    });
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });
    await getPropertyImage({ tokenId: "789" });
    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    expect(fetchUrl).toContain(altContract);
  });

  it("clamps dimensions to valid range", async () => {
    mockGetToken.mockResolvedValue({
      tokenId: "123",
      name: "Test",
      vanityName: null,
      contractAddress: "0x5cbeb7A0df7Ed85D82a472FD56d81ed550f3Ea95",
    });
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });
    await getPropertyImage({ tokenId: "123", width: 5000, height: 10 });
    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    expect(fetchUrl).toContain("width=1280");
    expect(fetchUrl).toContain("height=100");
  });

  it("returns error when image fetch fails", async () => {
    mockGetToken.mockResolvedValue({
      tokenId: "123",
      name: "Test",
      vanityName: null,
      contractAddress: "0x5cbeb7A0df7Ed85D82a472FD56d81ed550f3Ea95",
    });
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });
    const result = await getPropertyImage({ tokenId: "123" });
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Image fetch failed");
  });

  it("uses slug lookup and falls back to vanityName", async () => {
    mockGetToken.mockResolvedValue({
      tokenId: "456",
      name: null,
      vanityName: "My Land",
      contractAddress: "0x5cbeb7A0df7Ed85D82a472FD56d81ed550f3Ea95",
    });
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });
    const result = await getPropertyImage({ slug: "us/nevada/test" });
    expect(result).toHaveProperty("name", "My Land");
    expect(mockGetToken).toHaveBeenCalledWith({ tokenId: undefined, slug: "us/nevada/test" });
  });
});

describe("getPortfolioImage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when address not provided", async () => {
    const result = await getPortfolioImage({});
    expect(result).toEqual({ error: "Wallet address is required" });
  });

  it("returns image data on success", async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: () => Promise.resolve(pngBytes.buffer),
    });
    const result = await getPortfolioImage({ address: "0xabc123" });
    expect(result).toHaveProperty("address", "0xabc123");
    expect(result).toHaveProperty("image");
    const image = (result as { image: { data: string; mimeType: string } }).image;
    expect(image.mimeType).toBe("image/png");
    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    expect(fetchUrl).toContain("0xabc123/image");
    expect(fetchUrl).toContain("theme=dark");
    expect(fetchUrl).toContain("width=640");
    expect(fetchUrl).toContain("height=640");
  });

  it("returns error when fetch fails", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });
    const result = await getPortfolioImage({ address: "0xabc123" });
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Failed to get portfolio image");
  });
});
