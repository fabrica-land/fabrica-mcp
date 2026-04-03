import { getToken } from "../clients/graphql.js";
import { NETWORK, CONTRACTS } from "../config.js";

type ImageTheme = "dark" | "light";

const MEDIA_BASE_URL = process.env.FABRICA_MEDIA_URL ?? "https://media.fabrica.land";

function buildMediaUrl(
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
  return `${MEDIA_BASE_URL}/${NETWORK}/${CONTRACTS.fabricaToken}/${target}/image?${params}`;
}

async function fetchImageAsBase64(url: string): Promise<{ data: string; mimeType: string }> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Image fetch failed (${response.status}): ${response.statusText}`);
  }
  const contentType = response.headers.get("content-type") ?? "image/png";
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");
  return { data: base64, mimeType: contentType };
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
    const url = buildMediaUrl(token.tokenId, theme, width, height);
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
  try {
    const url = buildMediaUrl(address, theme, width, height);
    const image = await fetchImageAsBase64(url);
    return {
      address,
      image,
    };
  } catch (e) {
    return { error: `Failed to get portfolio image: ${e instanceof Error ? e.message : String(e)}` };
  }
}
