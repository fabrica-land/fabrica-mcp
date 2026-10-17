// Property card: the MCP App view for get_property. Renders inside the host's sandboxed
// frame from the tool result's structuredContent. The parcel map is always shown first;
// owner photos follow when the property has any. All data arrives from the tool result,
// and user-provided text is only ever set through textContent.
import { App } from "@modelcontextprotocol/ext-apps";
import {
  canHover, checksSubline, chooseLayout, estimateSourceLine, failedChecks, safeArea, taxChip, usdcAmount,
  type HostContextLike, type Layout,
} from "./view.js";

type Theme = "light" | "dark";

const root = document.getElementById("root");
const app = new App({ name: "Fabrica property card", version: "0.1.0" });
let theme: Theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
let current: Record<string, unknown> | null = null;
let checksOpen = false;

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string | null): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

// Buttons may only open Fabrica's own pages over https.
const FABRICA_HOSTS = new Set(["fabrica.land", "testnets.fabrica.land"]);

function fabricaUrl(link: string | null): string | null {
  if (!link) return null;
  try {
    const url = new URL(link);
    return url.protocol === "https:" && FABRICA_HOSTS.has(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Every action opens the property page on Fabrica, where the user completes it and signs.
 * The `action` hint lets the page open the matching dialog; the connector itself never
 * prepares or submits a transaction.
 */
function actionLink(link: string, action: "buy" | "offer" | "contact"): string {
  const url = new URL(link);
  url.searchParams.set("action", action);
  return url.toString();
}

function button(label: string, className: string, url: string): HTMLButtonElement {
  const node = el("button", className, label);
  node.type = "button";
  node.onclick = () => openOnFabrica(url);
  return node;
}

function actions(link: string, listingPrice: string | null, isPremint: boolean): HTMLDivElement {
  const row = el("div", "actions");
  // Premints can take offers but can't be bought until they are minted.
  const canBuy = listingPrice !== null && !isPremint;
  if (canBuy) row.append(button(`Buy · ${listingPrice}`, "cta", actionLink(link, "buy")));
  row.append(
    button("Make an offer", canBuy ? "secondary" : "cta", actionLink(link, "offer")),
    button("Contact owner", "secondary", actionLink(link, "contact")),
    button("View on Fabrica", "link", link),
  );
  return row;
}

function openOnFabrica(url: string | null): void {
  const safe = fabricaUrl(url);
  if (safe) void app.openLink({ url: safe }).catch(() => undefined);
}

function slide(src: string, tag: string, fallbackText: string, link: string | null): HTMLButtonElement {
  const button = el("button", "slide");
  button.type = "button";
  const img = el("img");
  img.src = src;
  img.alt = tag;
  // Eager: lazy loading never fires for off-screen slides inside the sandboxed frame,
  // and a card carries at most nine small images.
  img.loading = "eager";
  img.decoding = "async";
  img.onerror = () => img.replaceWith(el("div", "fallback", fallbackText));
  button.append(img, el("span", "tag", tag));
  button.onclick = () => openOnFabrica(link);
  return button;
}

function fact(label: string, value: string | null, subline: string | null = null): HTMLDivElement | null {
  if (!value) return null;
  const node = el("div", "fact");
  node.append(el("div", "k", label), el("div", "v", value));
  if (subline) node.append(el("div", "s", subline));
  return node;
}

function chip(text: string | null): HTMLSpanElement | null {
  return text ? el("span", "chip", text) : null;
}

/** Property checks as a fact that opens the list of checks that did not pass. */
function checksFact(text: string, subline: string | null, failed: string[]): HTMLElement {
  const wrap = el("div", "fact checks");
  const toggle = el("button", "fact-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", String(checksOpen));
  toggle.append(el("div", "k", "Property checks"), el("div", "v", text));
  if (subline) toggle.append(el("div", "s", subline));
  wrap.append(toggle);
  if (failed.length > 0) {
    // Toggled in place: a full re-render would reload the images and reset the gallery.
    wrap.classList.toggle("open", checksOpen);
    toggle.onclick = () => {
      checksOpen = !checksOpen;
      wrap.classList.toggle("open", checksOpen);
      toggle.setAttribute("aria-expanded", String(checksOpen));
    };
    const list = el("ul", "tip");
    list.setAttribute("aria-label", "Checks not passed");
    failed.forEach((name) => list.append(el("li", undefined, name)));
    wrap.append(list);
  } else {
    toggle.disabled = true;
  }
  return wrap;
}

function gallery(slides: HTMLButtonElement[], layout: Layout): HTMLElement[] {
  const strip = el("div", "gallery");
  strip.append(...slides);
  if (layout !== "compact" || slides.length < 2) return [strip];
  // Swipe position, shown as dots under the strip on touch layouts.
  const dots = el("div", "dots");
  dots.setAttribute("aria-hidden", "true");
  const marks = slides.map((_, index) => el("span", index === 0 ? "dot on" : "dot"));
  dots.append(...marks);
  strip.onscroll = () => {
    const width = strip.clientWidth || 1;
    const active = Math.min(marks.length - 1, Math.round(strip.scrollLeft / width));
    marks.forEach((mark, index) => mark.classList.toggle("on", index === active));
  };
  return [strip, dots];
}

function applyHostContext(): Layout {
  const context = app.getHostContext() as HostContextLike | undefined;
  const layout = chooseLayout(context, window.innerWidth);
  const html = document.documentElement;
  html.dataset.theme = theme;
  html.dataset.layout = layout;
  html.dataset.hover = String(canHover(context, window.matchMedia("(hover: hover)").matches));
  const insets = safeArea(context);
  html.style.setProperty("--safe-top", `${insets.top}px`);
  html.style.setProperty("--safe-right", `${insets.right}px`);
  html.style.setProperty("--safe-bottom", `${insets.bottom}px`);
  html.style.setProperty("--safe-left", `${insets.left}px`);
  return layout;
}

function render(): void {
  const layout = applyHostContext();
  if (!root || !current) return;
  const data = current;
  const error = str(data.error);
  if (error) {
    root.replaceChildren(el("p", "warn", error));
    return;
  }
  const location = obj(data.location);
  const valuation = obj(data.valuation);
  const lending = obj(data.lending);
  const marketplace = obj(data.marketplace);
  const media = obj(data.media);
  const recovery = obj(data.recoveryStatus);
  const legal = obj(data.legal);
  const taxes = obj(data.taxes);
  const link = fabricaUrl(str(data.propertyLink));
  const isTestnet = str(data.network) === "sepolia";

  const slides: HTMLButtonElement[] = [];
  const mapImage = str(obj(media.mapImage)[theme]);
  if (mapImage) slides.push(slide(mapImage, "Parcel map", "Map unavailable", link));
  const photos = arr(media.photos).map(obj);
  photos.forEach((photo, index) => {
    const src = str(photo.thumbnailUrl) ?? str(photo.url);
    if (src) slides.push(slide(src, `Photo ${index + 1} of ${photos.length}`, "Photo unavailable", link));
  });

  const head = el("div", "head");
  const titles = el("div", "titles");
  const place = [str(location.place), str(location.district), str(location.regionCode) ?? str(location.region)].filter(Boolean).join(", ");
  const acres = num(data.acres);
  const sub = [place, acres !== null ? `${acres.toLocaleString("en-US", { maximumFractionDigits: 2 })} acres` : null].filter(Boolean).join(" · ");
  titles.append(el("h2", undefined, str(data.name) ?? `Token ${str(data.tokenId) ?? ""}`), el("div", "sub", sub));
  head.append(titles, el("span", "pill", isTestnet ? "Sepolia testnet" : "Ethereum mainnet"));

  const listing = obj(arr(marketplace.listings)[0]);
  const listingPrice = str(listing.price);
  const activeLoans = arr(lending.activeLoans);
  const poolLiquidity = obj(lending.lendingPoolLiquidity);
  const recoveryLabel = str(recovery.label);

  const chips = el("div", "chips");
  const chipNodes = [
    chip(listingPrice ? `Listed at ${listingPrice}` : "Not listed for sale"),
    chip(activeLoans.length > 0 ? `${activeLoans.length} active loan${activeLoans.length > 1 ? "s" : ""}` : "No active loan"),
    chip(taxChip(taxes.status)),
    chip(str(legal.operatingAgreementName)),
  ].filter((node): node is HTMLSpanElement => node !== null);
  chips.append(...chipNodes);

  const checks = obj(data.propertyChecks);
  const passed = num(checks.passed);
  const total = num(checks.total);
  // Like fabrica.land: the pass count, falling back to the numeric encoding, labelled as such.
  const encoding = num(checks.encoding) ?? num(valuation.confidenceScore);
  const checksText = passed !== null && total !== null && total > 0
    ? `${passed} of ${total} pass`
    : encoding !== null ? `Encoding ${encoding}` : null;
  const checksLine = recoveryLabel && recoveryLabel !== "Normal" ? recoveryLabel : checksSubline(passed, total);
  const failed = failedChecks(arr(checks.results).map(obj));

  const estimate = str(valuation.estimatedValue);
  const capacity = usdcAmount(poolLiquidity.maxPrincipal);
  const facts = el("div", "facts");
  const factNodes = [
    fact("Estimated value", estimate, estimateSourceLine(estimate, arr(valuation.pricing).map(obj))),
    checksText !== null ? checksFact(checksText, checksLine, failed) : null,
    activeLoans.length > 0
      ? fact("Lending", `${activeLoans.length} active loan${activeLoans.length > 1 ? "s" : ""}`)
      : fact("Borrow now (estimate)", capacity !== null ? `Up to ${capacity.toLocaleString("en-US")} USDC` : null, "What the DeFi lending pool can lend today"),
  ].filter((node): node is HTMLElement => node !== null);
  facts.append(...factNodes);
  if (layout === "regular" && factNodes.length > 1) facts.classList.add(`n${Math.min(factNodes.length, 4)}`);

  const children: HTMLElement[] = [];
  if (slides.length > 0) children.push(...gallery(slides, layout));
  children.push(head);
  if (chipNodes.length > 0) children.push(chips);
  if (factNodes.length > 0) children.push(facts);
  arr(data.warnings).forEach((warning) => {
    const text = str(warning);
    if (text) children.push(el("div", "warn", text));
  });
  const description = str(media.userDescription);
  if (description) children.push(el("p", "desc", description));

  children.push(el("div", "notice", isTestnet
    ? "Test property on Sepolia, with no real-world effect."
    : "A real US property. Acquiring its token has legal and financial consequences set out in its trust agreement."));
  if (link) children.push(actions(link, listingPrice, data.isPremint === true));
  root.replaceChildren(...children);
}

app.ontoolresult = (result) => {
  const structured = obj(result.structuredContent);
  if (Object.keys(structured).length > 0) {
    current = structured;
  } else {
    const text = arr(result.content).map(obj).find((c) => c.type === "text");
    try {
      current = obj(JSON.parse(str(text?.text) ?? "{}"));
    } catch {
      current = { error: "Could not read the property data." };
    }
  }
  render();
};

app.onhostcontextchanged = (context) => {
  // The SDK merges each partial update into getHostContext(); re-render on any of them
  // (theme, container size, platform, safe area).
  if (context.theme === "light" || context.theme === "dark") theme = context.theme;
  render();
};

// The frame itself can change width (a resized chat column) without a host notification.
// Re-render only when that changes the layout: autoResize changes the frame height too.
window.addEventListener("resize", () => {
  const context = app.getHostContext() as HostContextLike | undefined;
  if (chooseLayout(context, window.innerWidth) !== document.documentElement.dataset.layout) render();
});

await app.connect();
const hostTheme = app.getHostContext()?.theme;
if (hostTheme === "light" || hostTheme === "dark") theme = hostTheme;
render();
