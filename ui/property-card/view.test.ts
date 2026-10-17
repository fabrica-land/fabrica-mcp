import { describe, expect, it } from "vitest";
import {
  activityLabel, canExpand, canHover, checksSubline, chooseLayout, documentUrl, estimateSourceLine, failedChecks, isFullscreen,
  layoutWidth, pricingRows, safeArea, shortDate, taxChip, usdcAmount,
} from "./view.js";

describe("chooseLayout", () => {
  it("is compact in a narrow container whatever the platform", () => {
    expect(chooseLayout({ platform: "desktop", containerDimensions: { maxWidth: 420 } }, 900)).toBe("compact");
    expect(chooseLayout(undefined, 380)).toBe("compact");
  });

  it("is compact on a mobile host up to landscape phone width", () => {
    expect(chooseLayout({ platform: "mobile" }, 640)).toBe("compact");
    expect(chooseLayout({ platform: "mobile" }, 820)).toBe("regular");
  });

  it("is regular in a desktop or web chat column", () => {
    expect(chooseLayout({ platform: "web", containerDimensions: { width: 720 } }, 720)).toBe("regular");
    expect(chooseLayout({}, 680)).toBe("regular");
  });

  it("lays out against the smaller of the host width and the frame", () => {
    expect(layoutWidth({ containerDimensions: { maxWidth: 900 } }, 600)).toBe(600);
    expect(layoutWidth({ containerDimensions: { width: 400 } }, 0)).toBe(400);
    expect(layoutWidth(undefined, 500)).toBe(500);
  });
});

describe("host capabilities", () => {
  it("uses the host's hover capability, else the frame's media query", () => {
    expect(canHover({ deviceCapabilities: { touch: true, hover: false } }, true)).toBe(false);
    expect(canHover({ deviceCapabilities: { hover: true } }, false)).toBe(true);
    expect(canHover({}, true)).toBe(true);
  });

  it("reads safe area insets as whole non-negative pixels", () => {
    expect(safeArea({ safeAreaInsets: { top: 47.4, right: 0, bottom: 34, left: -2 } })).toEqual({ top: 47, right: 0, bottom: 34, left: 0 });
    expect(safeArea(undefined)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
});

describe("fact lines", () => {
  const pricing = [
    { source: "fabrica-avm", value: null },
    { source: "prycd", value: "$771,075" },
    { source: "regrid-county-assessor", value: "$357,000" },
  ];

  it("names the source the estimate equals and the assessor figure", () => {
    expect(estimateSourceLine("$771,075", pricing)).toBe("Prycd · assessor $357,000");
    expect(estimateSourceLine("$357,000", pricing)).toBeNull();
    expect(estimateSourceLine(null, pricing)).toBeNull();
  });

  it("lists the checks that did not pass and counts them", () => {
    const results = [
      { check: "Proof of Title Verified", passed: true },
      { check: "Holding Entity Matches Owner from County Assessor", passed: false },
    ];
    expect(failedChecks(results)).toEqual(["Holding Entity Matches Owner from County Assessor"]);
    expect(checksSubline(16, 18)).toBe("2 not passed");
    expect(checksSubline(18, 18)).toBe("All pass");
    expect(checksSubline(null, 18)).toBeNull();
  });

  it("reads pool capacity in whole USDC and drops zero", () => {
    expect(usdcAmount("966 USDC")).toBe(966);
    expect(usdcAmount("2,500 USDC")).toBe(2500);
    expect(usdcAmount("0 USDC")).toBeNull();
    expect(usdcAmount(null)).toBeNull();
  });

  it("shows a tax chip only for a known status", () => {
    expect(taxChip("current")).toBe("Taxes current");
    expect(taxChip("delinquent")).toBe("Taxes past due");
    expect(taxChip("unknown")).toBeNull();
  });
});

describe("display modes", () => {
  it("offers Expand only when the host lists fullscreen and the card is inline", () => {
    expect(canExpand({ availableDisplayModes: ["inline", "fullscreen"], displayMode: "inline" })).toBe(true);
    expect(canExpand({ availableDisplayModes: ["inline"] })).toBe(false);
    expect(canExpand(undefined)).toBe(false);
    expect(canExpand({ availableDisplayModes: ["inline", "fullscreen"], displayMode: "fullscreen" })).toBe(false);
    expect(isFullscreen({ displayMode: "fullscreen" })).toBe(true);
  });
});

describe("fullscreen panels", () => {
  it("lists each pricing source that has a value once", () => {
    expect(pricingRows([
      { source: "fabrica-avm", value: null },
      { source: "prycd", value: "$771,075" },
      { source: "prycd", value: "$771,075" },
      { source: "regrid-county-assessor", value: "$357,000" },
    ])).toEqual([{ label: "Prycd", value: "$771,075" }, { label: "County assessor", value: "$357,000" }]);
  });

  it("opens documents only on Fabrica's IPFS gateway", () => {
    expect(documentUrl("ipfs://bafybeiea37nz")).toBe("https://ipfs.fabrica.land/ipfs/bafybeiea37nz");
    expect(documentUrl("https://ipfs.fabrica.land/ipfs/bafkrei")).toBe("https://ipfs.fabrica.land/ipfs/bafkrei");
    expect(documentUrl("https://evil.example/ipfs/x")).toBeNull();
    expect(documentUrl("javascript:alert(1)")).toBeNull();
    expect(documentUrl(null)).toBeNull();
  });

  it("names activity in plain words and dates it in UTC", () => {
    expect(activityLabel("LoanRepaid")).toBe("Loan repaid");
    expect(activityLabel("ScoreChanged")).toBe("Property checks updated");
    expect(activityLabel("SomethingNewHappened")).toBe("Something new happened");
    expect(shortDate("2026-06-30T22:04:23.000Z")).toBe("Jun 30, 2026");
    expect(shortDate("not a date")).toBeNull();
  });
});
