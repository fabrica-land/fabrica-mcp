import type { ConfigurationMedia } from "../types/index.js";
import { buildMediaUrl } from "./images.js";

const IPFS_GATEWAY = "https://ipfs.fabrica.land/ipfs/";

/**
 * Origins the property card may load images from. The MCP App sandbox only allows origins
 * declared up front, so this list is both the widget's CSP and the photo filter: photos
 * hosted anywhere else (premints can carry third-party image URLs) are left out.
 * Owner photos come from the IPFS gateway; the parcel map comes from the media service,
 * which redirects to Mapbox Static Images.
 */
export const WIDGET_IMAGE_ORIGINS = ["https://ipfs.fabrica.land", "https://media.fabrica.land", "https://api.mapbox.com"];

function isAllowedImageUrl(url: string): boolean {
  try {
    return WIDGET_IMAGE_ORIGINS.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

const MAX_PHOTOS = 8;
// The gateway resizes on the fly: a multi-MB original becomes a ~50 KB WebP.
const THUMBNAIL_PARAMS = "img-width=800&img-format=webp";

export interface PropertyPhoto {
  url: string;
  thumbnailUrl: string;
  description: string | null;
}

/** Owner-uploaded photos arrive as gateway URLs or bare `ipfs://` URIs. */
export function toGatewayUrl(source: string): string | null {
  if (source.startsWith("ipfs://")) return IPFS_GATEWAY + source.slice("ipfs://".length).replace(/^ipfs\//, "");
  if (source.startsWith("https://")) return source;
  return null;
}

function thumbnailUrl(url: string): string {
  return url.startsWith(IPFS_GATEWAY) && !url.includes("?") ? `${url}?${THUMBNAIL_PARAMS}` : url;
}

function orderKey(media: ConfigurationMedia, index: number): number {
  const order = media.order === null ? Number.NaN : Number(media.order);
  return Number.isFinite(order) ? order : 1_000_000 + index;
}

/** Photos from allowed origins, in the owner's order, capped, each with a resized thumbnail. */
export function propertyPhotos(media: ConfigurationMedia[] | null | undefined): PropertyPhoto[] {
  return (media ?? [])
    .map((m, index) => ({ m, key: orderKey(m, index) }))
    .filter(({ m }) => m.type === null || m.type === "image")
    .sort((a, b) => a.key - b.key)
    .flatMap(({ m }) => {
      const url = toGatewayUrl(m.source);
      return url && isAllowedImageUrl(url) ? [{ url, thumbnailUrl: thumbnailUrl(url), description: m.description }] : [];
    })
    .slice(0, MAX_PHOTOS);
}

/** Static parcel-boundary map, served by the Fabrica media service in both themes. */
export function propertyMapImage(contractAddress: string, tokenId: string): { light: string; dark: string } {
  return {
    light: buildMediaUrl(contractAddress, tokenId, "light", 800, 500),
    dark: buildMediaUrl(contractAddress, tokenId, "dark", 800, 500),
  };
}
