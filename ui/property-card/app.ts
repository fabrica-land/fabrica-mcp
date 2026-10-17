// Property card: the MCP App view for get_property. Renders inside the host's sandboxed
// frame from the tool result's structuredContent. The parcel map is always shown first;
// owner photos follow when the property has any. All data arrives from the tool result,
// and user-provided text is only ever set through textContent.
import { App } from "@modelcontextprotocol/ext-apps";
import {
  activityLabel, canExpand, canHover, checksSubline, chooseLayout, documentUrl, estimateSourceLine, fabricaUrl, failedChecks,
  isFullscreen, pricingRows, safeArea, shortDate, TABS, taxChip, usdcAmount,
  type HostContextLike, type Layout, type Tab,
} from "./view.js";

type Theme = "light" | "dark";

const root = document.getElementById("root");
const app = new App({ name: "Fabrica property card", version: "0.1.0" }, { availableDisplayModes: ["inline", "fullscreen"] });
let theme: Theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
let current: Record<string, unknown> | null = null;
let checksOpen = false;
let tab: Tab = "Overview";

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

function actions(link: string, buyablePrice: string | null, isPremint: boolean): HTMLDivElement {
  const row = el("div", "actions");
  // Premints can take offers but can't be bought until they are minted.
  const canBuy = buyablePrice !== null && !isPremint;
  if (canBuy) row.append(button(`Buy · ${buyablePrice}`, "cta", actionLink(link, "buy")));
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

function openDocument(uri: unknown): void {
  const safe = documentUrl(uri);
  if (safe) void app.openLink({ url: safe }).catch(() => undefined);
}

function openTransaction(hash: string, testnet: boolean): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return;
  void app.openLink({ url: `https://${testnet ? "sepolia." : ""}etherscan.io/tx/${hash}` }).catch(() => undefined);
}

function setDisplayMode(mode: "inline" | "fullscreen"): void {
  void app.requestDisplayMode({ mode }).catch(() => undefined);
}

function iconButton(label: string, path: string, onClick: () => void): HTMLButtonElement {
  const node = el("button", "icon");
  node.type = "button";
  node.setAttribute("aria-label", label);
  node.title = label;
  // Static markup: the icon paths are constants in this file, never data.
  node.innerHTML = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"></path></svg>`;
  node.onclick = onClick;
  return node;
}
const EXPAND_ICON = "M11 2h5v5M7 16H2v-5M16 2l-6 6M2 16l6-6";
const COLLAPSE_ICON = "M10 2l-6 7 6 7";

/** Label and value rows, for the fullscreen panels. Rows without a value are left out. */
function rows(entries: [string, string | null][]): HTMLElement | null {
  const kept = entries.filter((e): e is [string, string] => e[1] !== null);
  if (kept.length === 0) return null;
  const list = el("dl", "rows");
  kept.forEach(([k, v]) => list.append(el("dt", undefined, k), el("dd", undefined, v)));
  return list;
}

function section(title: string, ...body: (HTMLElement | null)[]): HTMLElement | null {
  const kept = body.filter((n): n is HTMLElement => n !== null);
  if (kept.length === 0) return null;
  const node = el("section", "panel-section");
  node.append(el("h3", undefined, title), ...kept);
  return node;
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

function screenShortSide(): number {
  return Math.min(window.screen?.width ?? 0, window.screen?.height ?? 0);
}

function applyHostContext(): Layout {
  const context = app.getHostContext();
  const layout = chooseLayout(context, window.innerWidth, screenShortSide());
  const html = document.documentElement;
  html.dataset.theme = theme;
  html.dataset.layout = layout;
  html.dataset.mode = isFullscreen(context) ? "fullscreen" : "inline";
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
  const context = app.getHostContext();
  const full = isFullscreen(context);
  const headEnd = el("div", "head-end");
  headEnd.append(el("span", "pill", isTestnet ? "Sepolia testnet" : "Ethereum mainnet"));
  if (canExpand(context)) headEnd.append(iconButton("Expand to fullscreen", EXPAND_ICON, () => setDisplayMode("fullscreen")));
  head.append(titles, headEnd);

  const listingRows = arr(marketplace.listings).map(obj);
  const listing = listingRows[0] ?? {};
  const listingPrice = str(listing.price);
  // Buy only a listing the API says can be bought now; an encumbered one may be blocked by its loan.
  const buyablePrice = str(listingRows.find((l) => l.buyable !== false)?.price);
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

  const warnings = arr(data.warnings).map(str).filter((w): w is string => w !== null).map((w) => el("div", "warn", w));
  const description = str(media.userDescription);
  const notice = el("div", "notice", isTestnet
    ? "Test property on Sepolia, with no real-world effect."
    : "A real US property. Acquiring its token has legal and financial consequences set out in its trust agreement.");
  const actionRow = link ? actions(link, buyablePrice, data.isPremint === true) : null;

  if (!full) {
    const children: HTMLElement[] = [];
    if (slides.length > 0) children.push(...gallery(slides, layout));
    children.push(head);
    if (chipNodes.length > 0) children.push(chips);
    if (factNodes.length > 0) children.push(facts);
    children.push(...warnings);
    if (description) children.push(el("p", "desc", description));
    children.push(notice);
    if (actionRow) children.push(actionRow);
    root.replaceChildren(...children);
    return;
  }

  // Fullscreen: a bar to go back to the chat, the gallery large, then one panel per tab.
  const bar = el("div", "bar");
  bar.append(iconButton("Back to chat", COLLAPSE_ICON, () => setDisplayMode("inline")), el("span", "bar-title", "Back to chat"));
  const panels: Record<Tab, () => HTMLElement[]> = {
    Overview: () => {
      const out: HTMLElement[] = [];
      if (chipNodes.length > 0) out.push(chips);
      if (factNodes.length > 0) out.push(facts);
      out.push(...warnings);
      if (description) out.push(el("p", "desc full", description));
      return out;
    },
    Value: () => {
      const sources = pricingRows(arr(valuation.pricing).map(obj));
      // The estimate row only when no source row already shows the same figure.
      const estimateRow: [string, string | null][] = sources.some((r) => r.value === estimate) ? [] : [["Estimate", estimate]];
      const sourceRows = sources.map((r): [string, string] => [r.label, r.asOf ? `${r.value} · ${r.asOf}` : r.value]);
      return [
        section("Estimated value", rows([...estimateRow, ...sourceRows])),
        section("Property checks", checkList(arr(checks.results).map(obj)),
          el("p", "muted small", "Property checks are a starting point for your own research, not a title search or title insurance.")),
      ].filter((n): n is HTMLElement => n !== null);
    },
    Lending: () => {
      // The tool caps the bids it lists; offerCount is the full count.
      const offerCount = num(marketplace.offerCount) ?? arr(marketplace.bids).length;
      const loans = activeLoans.map(obj).map((loan) => rows([
        ["Principal", str(loan.principal)], ["APR", str(loan.apr)], ["Duration", str(loan.duration)],
        ["Matures", shortDate(loan.maturityDate)], ["Provider", str(loan.provider)],
      ]));
      return [
        section("Borrow now (estimate)", rows([
          ["DeFi lending pool can lend", capacity !== null ? `Up to ${capacity.toLocaleString("en-US")} USDC` : null],
        ]), el("p", "muted small", "What the pool can lend today. Ask for a borrow quote to see this property's own terms.")),
        section(activeLoans.length > 0 ? "Active loans" : "No active loan", ...loans),
        section("Marketplace", rows([
          ["Listed at", listingPrice], ["Listing ends", shortDate(listing.expiresAt)],
          ["Offers", offerCount > 0 ? offerCount.toLocaleString("en-US") : "None"],
        ])),
      ].filter((n): n is HTMLElement => n !== null);
    },
    Documents: () => {
      const registrar = obj(legal.registrar);
      const proof = obj(legal.proofOfTitle);
      const docs = el("div", "docs");
      const agreement = documentUrl(legal.operatingAgreement);
      if (agreement) docs.append(docButton(str(legal.operatingAgreementName) ?? "Trust agreement", "Trust agreement", legal.operatingAgreement));
      if (documentUrl(proof.document)) docs.append(docButton(str(proof.documentName) ?? "Proof of title", str(proof.source) ?? "Proof of title", proof.document));
      return [
        section("Documents", docs.childElementCount > 0 ? docs : null),
        section("Trust and parcel", rows([
          ["Holding entity", str(legal.holdingEntity)],
          ["County", str(registrar.admin)],
          ["Parcel number", str(registrar.propertyId)],
          ["Minted", shortDate(data.mintedAt)],
        ])),
      ].filter((n): n is HTMLElement => n !== null);
    },
    Activity: () => {
      const items = arr(data.recentActivity).map(obj);
      if (items.length === 0) return [el("p", "muted", "No recent activity.")];
      const list = el("ol", "activity");
      items.forEach((item) => {
        const row = el("li");
        const what = [activityLabel(item.type), str(item.amount)].filter(Boolean).join(" · ");
        row.append(el("span", "what", what), el("span", "when", shortDate(item.time)));
        const hash = str(item.txHash);
        if (hash) {
          const tx = el("button", "tx", "Transaction");
          tx.type = "button";
          tx.onclick = () => openTransaction(hash, isTestnet);
          row.append(tx);
        }
        list.append(row);
      });
      return [list];
    },
  };
  const tabBar = el("div", "tabs");
  tabBar.setAttribute("role", "tablist");
  const panel = el("div", "panel");
  panel.setAttribute("role", "tabpanel");
  const tabButtons = TABS.map((name) => {
    const node = el("button", "tab", name);
    node.type = "button";
    node.setAttribute("role", "tab");
    node.onclick = () => {
      // Swap only the panel: re-rendering the whole card would reload the gallery.
      tab = name;
      tabButtons.forEach((b) => b.setAttribute("aria-selected", String(b === node)));
      panel.replaceChildren(...panels[name]());
    };
    node.setAttribute("aria-selected", String(name === tab));
    return node;
  });
  tabBar.append(...tabButtons);
  panel.replaceChildren(...panels[tab]());

  const children: HTMLElement[] = [bar];
  if (slides.length > 0) children.push(...gallery(slides, layout));
  children.push(head, tabBar, panel, notice);
  if (actionRow) children.push(actionRow);
  root.replaceChildren(...children);
}

function docButton(title: string, subtitle: string, uri: unknown): HTMLButtonElement {
  const node = el("button", "doc");
  node.type = "button";
  node.append(el("span", "doc-title", title), el("span", "doc-sub", subtitle));
  node.onclick = () => openDocument(uri);
  return node;
}

function checkList(results: Record<string, unknown>[]): HTMLElement | null {
  const named = results.filter((r) => typeof r.check === "string");
  if (named.length === 0) return null;
  const list = el("ul", "checklist");
  named.forEach((r) => {
    const item = el("li", r.passed === true ? "pass" : "fail");
    item.append(el("span", "mark", r.passed === true ? "Pass" : "Not passed"), el("span", undefined, str(r.check)));
    list.append(item);
  });
  return list;
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
  // The agent can ask for the card fullscreen (get_property display: "fullscreen"); the host may decline.
  if (obj(current.card).displayMode === "fullscreen" && canExpand(app.getHostContext())) setDisplayMode("fullscreen");
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
  const context = app.getHostContext();
  if (chooseLayout(context, window.innerWidth, screenShortSide()) !== document.documentElement.dataset.layout) render();
});

await app.connect();
const hostTheme = app.getHostContext()?.theme;
if (hostTheme === "light" || hostTheme === "dark") theme = hostTheme;
render();
