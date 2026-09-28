import { describe, expect, it } from "vitest";
import { propertyMapImage, propertyPhotos, toGatewayUrl } from "../tools/media.js";

const photo = (source: string, order: string | null = null, type: string | null = "image") => ({
  source,
  type,
  description: null,
  order,
});

describe("property media", () => {
  it("maps ipfs:// sources to the Fabrica gateway and keeps https URLs", () => {
    expect(toGatewayUrl("ipfs://bafyabc")).toBe("https://ipfs.fabrica.land/ipfs/bafyabc");
    expect(toGatewayUrl("ipfs://ipfs/bafyabc")).toBe("https://ipfs.fabrica.land/ipfs/bafyabc");
    expect(toGatewayUrl("https://ipfs.fabrica.land/ipfs/bafyabc")).toBe("https://ipfs.fabrica.land/ipfs/bafyabc");
    expect(toGatewayUrl("http://example.com/a.png")).toBeNull();
  });

  it("returns photos in the owner's order with resized gateway thumbnails", () => {
    const photos = propertyPhotos([
      photo("ipfs://second", "2"),
      photo("ipfs://doc", null, "document"),
      photo("ipfs://first", "1"),
      photo("https://ipfs.fabrica.land/ipfs/unordered"),
    ]);
    expect(photos.map((p) => p.url)).toEqual([
      "https://ipfs.fabrica.land/ipfs/first",
      "https://ipfs.fabrica.land/ipfs/second",
      "https://ipfs.fabrica.land/ipfs/unordered",
    ]);
    expect(photos[0]?.thumbnailUrl).toBe("https://ipfs.fabrica.land/ipfs/first?img-width=800&img-format=webp");
  });

  it("caps photos and handles missing media", () => {
    expect(propertyPhotos(null)).toEqual([]);
    expect(propertyPhotos(Array.from({ length: 12 }, (_, i) => photo(`ipfs://p${i}`)))).toHaveLength(8);
  });

  it("builds light and dark parcel map URLs from the media service", () => {
    const map = propertyMapImage("0xabc", "123");
    expect(map.light).toContain("/0xabc/123/image?theme=light");
    expect(map.dark).toContain("theme=dark");
  });
});

describe("property media allowlist", () => {
  it("drops photos hosted outside the widget's allowed origins", () => {
    const photos = propertyPhotos([
      { source: "https://images.example.com/lot.jpg", type: "image", description: null, order: "1" },
      { source: "ipfs://bafykept", type: "image", description: null, order: "2" },
    ]);
    expect(photos.map((p) => p.url)).toEqual(["https://ipfs.fabrica.land/ipfs/bafykept"]);
  });
});
