import { getTrustDocuments as fetchTrustDocuments, propertyLookupError } from "../clients/graphql.js";
import type { ConfigurationDocument } from "../types/index.js";
import { IS_MAINNET, MAINNET_WARNING } from "../config.js";
import { toGatewayUrl } from "./media.js";

const TRUST_NOTE = IS_MAINNET
  ? "The token represents the beneficial interest in this trust. The trustee is designated by the token holder and is, by default, the holder."
  : "This is a test token on Sepolia: it carries no beneficial interest and has no real-world legal or financial effect.";

const NOT_INCLUDED = "Not available here: a title search report, title insurance, and county records beyond the deed reference above. Property checks are a starting point for your own research, not a title search or title insurance.";

/** The agreement name carries its version ("Fabrica US Trust v4.4"); the API has no separate field. */
export function parseAgreementVersion(name: string | null | undefined): string | null {
  const match = name?.match(/\bv(\d+(?:\.\d+)*)\b/i);
  return match ? match[1] : null;
}

function gatewayOrRaw(source: string | null | undefined): string | null {
  if (!source) return null;
  return toGatewayUrl(source) ?? source;
}

function orderKey(document: ConfigurationDocument, index: number): number {
  const order = document.order === null ? Number.NaN : Number(document.order);
  return Number.isFinite(order) ? order : 1_000_000 + index;
}

/** Owner-uploaded documents in the owner's order; unordered ones keep their API order at the end. */
export function orderDocuments(documents: ConfigurationDocument[] | null | undefined) {
  return (documents ?? [])
    .map((d, index) => ({ d, key: orderKey(d, index) }))
    .sort((a, b) => a.key - b.key)
    .map(({ d }) => ({ type: d.type, description: d.description, url: gatewayOrRaw(d.source) }));
}

export async function getTrustDocuments(args: Record<string, unknown>) {
  const tokenId = args.tokenId as string | undefined;
  const slug = args.slug as string | undefined;
  const includeAgreementText = (args.includeAgreementText as boolean | undefined) ?? false;
  if (!tokenId && !slug) {
    return { error: "Either tokenId or slug is required" };
  }
  try {
    const token = await fetchTrustDocuments({ tokenId, slug, withText: includeAgreementText });
    if (!token) {
      return { error: `No property found with ${tokenId ? `token ID ${tokenId}` : `slug ${slug}`}` };
    }
    const registrar = token.definition?.offchainRegistrar ?? null;
    const proof = token.configuration?.proofOfTitle ?? null;
    const documents = orderDocuments(token.configuration?.documents);
    const notes: string[] = [];
    if (token.isPremint) {
      notes.push("This property is a premint: it is not minted onchain yet, so the deed and documents may not be on file.");
    }
    if (!proof?.document) notes.push("No deed is on file for this property.");
    if (documents.length === 0) notes.push("The owner has not uploaded other documents.");
    return {
      ...(MAINNET_WARNING ? { legalNotice: MAINNET_WARNING } : {}),
      tokenId: token.tokenId,
      name: token.name ?? token.vanityName,
      isPremint: token.isPremint,
      trust: {
        holdingEntity: token.definition?.holdingEntity || null,
        formedOn: token.configuration?.holdingEntityDate ?? null,
        agreementName: token.operatingAgreementName,
        agreementVersion: parseAgreementVersion(token.operatingAgreementName),
        agreementUrl: gatewayOrRaw(token.operatingAgreementUrl),
        about: TRUST_NOTE,
        ...(includeAgreementText ? { agreementText: token.operatingAgreement ?? null } : {}),
      },
      legalDescription: token.definition?.claim || null,
      parcel: {
        fips: registrar?.adminId || null,
        apn: registrar?.propertyId || null,
        county: token.district ?? registrar?.admin ?? null,
        state: token.regionCode,
      },
      deed: proof ? {
        name: proof.documentName,
        grantor: proof.grantor,
        source: proof.source,
        documentId: proof.documentId,
        url: gatewayOrRaw(proof.document),
      } : null,
      documents,
      mediaCount: token.configuration?.media?.length ?? 0,
      validator: token.validator,
      metadataUrl: token.metadataUri,
      links: { propertyPage: token.propertyLink },
      ...(notes.length > 0 ? { notes } : {}),
      notIncluded: NOT_INCLUDED,
    };
  } catch (e) {
    return { error: propertyLookupError(e, { tokenId, slug }, "get trust documents") };
  }
}
