import { getToken } from "../clients/graphql.js";
import { NETWORK, CONTRACTS } from "../config.js";

type ImageTheme = "dark" | "light";

const MEDIA_BASE_URL = process.env.FABRICA_MEDIA_URL ?? "https://media.fabrica.land";
/** Origin of the configured media service (parcel map images). */
export const MEDIA_ORIGIN = new URL(MEDIA_BASE_URL).origin;

export function buildMediaUrl(
  contractAddress: string,
  target: string,
  theme: ImageTheme,
  width: number,
  height: number,
): string {
  const params = new URLSearchParams({
    theme,
    width: String(width),
    height: String(height),
  });
  return `${MEDIA_BASE_URL}/${NETWORK}/${encodeURIComponent(contractAddress)}/${encodeURIComponent(target)}/image?${params}`;
}

const IMAGE_TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// The media service answers with a redirect to Mapbox Static Images.
const IMAGE_HOSTS = new Set([new URL(MEDIA_BASE_URL).host, "api.mapbox.com"]);
const ETH_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TOKEN_ID = /^[0-9]{1,80}$/;

async function fetchImageAsBase64(url: string): Promise<{ data: string; mimeType: string }> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`Image fetch failed (${response.status}): ${response.statusText}`);
  }
  if (!IMAGE_HOSTS.has(new URL(response.url).host)) {
    throw new Error("Image service redirected to an unexpected host");
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    throw new Error(`Image service returned ${contentType || "no content type"} instead of an image`);
  }
  if (Number(response.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) {
    throw new Error("Map image is larger than 5 MB; request a smaller width and height");
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error("Map image is larger than 5 MB; request a smaller width and height");
  }
  const base64 = Buffer.from(buffer).toString("base64");
  return { data: base64, mimeType: contentType.split(";")[0] };
}

export async function getPropertyImage(args: Record<string, unknown>) {
  const tokenId = args.tokenId as string | undefined;
  const slug = args.slug as string | undefined;
  const theme = (args.theme as ImageTheme | undefined) ?? "dark";
  const width = Math.min(Math.max((args.width as number | undefined) ?? 640, 100), 1280);
  const height = Math.min(Math.max((args.height as number | undefined) ?? 640, 100), 1280);
  if (!tokenId && !slug) {
    return { error: "Either tokenId or slug is required" };
  }
  try {
    const token = await getToken({ tokenId, slug });
    if (!token) {
      return { error: `No property found with ${tokenId ? `token ID ${tokenId}` : `slug ${slug}`}` };
    }
    const url = buildMediaUrl(token.contractAddress, token.tokenId, theme, width, height);
    const image = await fetchImageAsBase64(url);
    return {
      tokenId: token.tokenId,
      name: token.name ?? token.vanityName,
      image,
    };
  } catch (e) {
    return { error: `Failed to get property image: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function getPortfolioImage(args: Record<string, unknown>) {
  const address = args.address as string | undefined;
  const theme = (args.theme as ImageTheme | undefined) ?? "dark";
  const width = Math.min(Math.max((args.width as number | undefined) ?? 640, 100), 1280);
  const height = Math.min(Math.max((args.height as number | undefined) ?? 640, 100), 1280);
  if (!address) {
    return { error: "Wallet address is required" };
  }
  if (!ETH_ADDRESS.test(address)) {
    return { error: "address must be an Ethereum address: 0x followed by 40 hex characters" };
  }
  try {
    const url = buildMediaUrl(CONTRACTS.fabricaToken, address, theme, width, height);
    const image = await fetchImageAsBase64(url);
    return {
      address,
      image,
    };
  } catch (e) {
    return { error: `Failed to get portfolio image: ${e instanceof Error ? e.message : String(e)}` };
  }
}
