import type { TokenDetail } from "../types/index.js";
import { formatUsd } from "../format.js";

type Assessor = NonNullable<NonNullable<TokenDetail["parcelFacts"]>["assessor"]>;

const ABOUT = "Facts from the county assessor's record, read from Fabrica's parcel data cache. They can lag the county and Fabrica does not verify them. Zoning and land use are the assessor's labels; the county planning office is the authority on what a zone allows.";
const ZERO_SALE_NOTE = "The record shows $0: the price was not disclosed, or the transfer was nominal (such as a deed into the trust).";

function opportunityZone(flag: string | null | undefined): boolean | string | null {
  if (!flag) return null;
  const v = flag.trim().toLowerCase();
  if (["yes", "y", "true", "1"].includes(v)) return true;
  if (["no", "n", "false", "0"].includes(v)) return false;
  return flag;
}

function usd(value: number | null): string | null {
  return value === null ? null : formatUsd(String(value));
}

function codeAndDescription(code: string | null | undefined, description: string | null | undefined) {
  return code || description ? { code: code ?? null, description: description ?? null } : null;
}

/** get_land_property's countyRecord block: the assessor facts the API serves on token.parcelFacts. */
export function countyRecordOf(assessor: Assessor | null | undefined) {
  if (!assessor) return null;
  if (assessor.status !== "checked") {
    return { status: "not-checked", source: assessor.source, about: "No county assessor record is cached for this parcel yet." };
  }
  const hasAssessed = [assessor.assessedLand, assessor.assessedImprovements, assessor.assessedTotal].some(v => v !== null);
  const zeroSale = assessor.lastSalePrice === 0;
  const s = assessor.structure;
  const hasStructure = s && (s.present !== null || s.count !== null || s.yearBuilt !== null);
  return {
    status: "checked",
    source: assessor.source,
    asOf: assessor.fetchedAt,
    zoning: codeAndDescription(assessor.zoning, assessor.zoningDescription),
    landUse: codeAndDescription(assessor.landUseCode, assessor.landUse),
    assessedValue: hasAssessed ? {
      land: usd(assessor.assessedLand),
      improvements: usd(assessor.assessedImprovements),
      total: usd(assessor.assessedTotal),
      type: assessor.assessmentType,
      year: assessor.assessmentYear,
    } : null,
    lastSale: assessor.lastSaleDate || assessor.lastSalePrice !== null ? {
      date: assessor.lastSaleDate,
      price: zeroSale ? null : usd(assessor.lastSalePrice),
      ...(zeroSale ? { priceNote: ZERO_SALE_NOTE } : {}),
    } : null,
    opportunityZone: opportunityZone(assessor.opportunityZone),
    censusTract: assessor.censusTract,
    ...(hasStructure ? { structure: { present: s.present, count: s.count, yearBuilt: s.yearBuilt } } : {}),
    about: ABOUT,
  };
}
