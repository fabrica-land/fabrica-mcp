// Property card: the MCP App view for get_property. Renders inside the host's sandboxed
// frame from the tool result's structuredContent. The parcel map is always shown first;
// owner photos follow when the property has any. All data arrives from the tool result,
// and user-provided text is only ever set through textContent.
import { App } from "@modelcontextprotocol/ext-apps";

type Theme = "light" | "dark";

const root = document.getElementById("root");
const app = new App({ name: "Fabrica property card", version: "0.1.0" });
let theme: Theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
let current: Record<string, unknown> | null = null;

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

/** "12345.6 USDC" → "Can borrow up to 12,346 USDC"; nothing when there is no capacity. */
function borrowCapacity(maxPrincipal: unknown): string | null {
  const amount = Number.parseFloat(str(maxPrincipal) ?? "");
  return Number.isFinite(amount) && amount > 0 ? `Can borrow up to ${amount.toLocaleString("en-US", { maximumFractionDigits: 0 })} USDC` : null;
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
  if (url) void app.openLink({ url });
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

function fact(label: string, value: string | null): HTMLDivElement | null {
  if (!value) return null;
  const node = el("div", "fact");
  node.append(el("div", "k", label), el("div", "v", value));
  return node;
}

function render(): void {
  document.documentElement.dataset.theme = theme;
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
  const link = str(data.propertyLink);
  const isTestnet = str(data.network) === "sepolia";

  const gallery = el("div", "gallery");
  const mapImage = str(obj(media.mapImage)[theme]);
  if (mapImage) gallery.append(slide(mapImage, "Parcel map", "Map unavailable", link));
  const photos = arr(media.photos).map(obj);
  photos.forEach((photo, index) => {
    const src = str(photo.thumbnailUrl) ?? str(photo.url);
    if (src) gallery.append(slide(src, `Photo ${index + 1} of ${photos.length}`, "Photo unavailable", link));
  });

  const head = el("div", "head");
  const titles = el("div");
  const place = [str(location.place), str(location.district), str(location.regionCode) ?? str(location.region)].filter(Boolean).join(", ");
  const acres = num(data.acres);
  const sub = [place, acres !== null ? `${acres.toLocaleString("en-US", { maximumFractionDigits: 2 })} acres` : null].filter(Boolean).join(" · ");
  titles.append(el("h2", undefined, str(data.name) ?? `Token ${str(data.tokenId) ?? ""}`), el("div", "sub", sub));
  head.append(titles, el("span", "pill", isTestnet ? "Sepolia testnet" : "Ethereum mainnet"));

  const listing = obj(arr(marketplace.listings)[0]);
  const activeLoans = arr(lending.activeLoans);
  const poolLiquidity = obj(lending.lendingPoolLiquidity);
  const score = num(valuation.confidenceScore);
  const recoveryLabel = str(recovery.label);
  const facts = el("div", "facts");
  const factNodes = [
    fact("Confidence score", score !== null ? `${score}${recoveryLabel && recoveryLabel !== "Normal" ? ` · ${recoveryLabel}` : ""}` : null),
    fact("Estimated value", str(valuation.estimatedValue)),
    fact("Listed for sale", str(listing.price)),
    fact("Lending", activeLoans.length > 0 ? `${activeLoans.length} active loan${activeLoans.length > 1 ? "s" : ""}` : borrowCapacity(poolLiquidity.maxPrincipal)),
  ].filter((node): node is HTMLDivElement => node !== null);
  facts.append(...factNodes);

  const children: HTMLElement[] = [];
  if (gallery.childElementCount > 0) children.push(gallery);
  children.push(head);
  if (factNodes.length > 0) children.push(facts);
  arr(data.warnings).forEach((warning) => {
    const text = str(warning);
    if (text) children.push(el("div", "warn", text));
  });
  const description = str(media.userDescription);
  if (description) children.push(el("p", "desc", description));

  if (link) children.push(actions(link, str(listing.price), data.isPremint === true));
  children.push(el("div", "notice", isTestnet
    ? "Test property on Sepolia, with no real-world effect."
    : "A real US property. Acquiring its token has legal and financial consequences set out in its trust agreement."));
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
  if (context.theme === "light" || context.theme === "dark") {
    theme = context.theme;
    render();
  }
};

await app.connect();
const hostTheme = app.getHostContext()?.theme;
if (hostTheme === "light" || hostTheme === "dark") theme = hostTheme;
render();
