import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { PROPERTY_CARD_HTML } from "./generated/property-card.js";
import { WIDGET_IMAGE_ORIGINS } from "../tools/media.js";

/** MCP App view for get_land_property: parcel map, owner photos and key facts. */
export const PROPERTY_CARD_URI = "ui://fabrica/property-card";

/**
 * Origin of the card's brand font files: the mainnet server's static /fonts (copied there
 * by scripts/build-vercel.mjs). ui/property-card/index.html names the same origin.
 */
export const FONT_ORIGIN = "https://mcp.fabrica.land";

export function registerPropertyCard(server: McpServer): void {
  registerAppResource(
    server,
    "Fabrica property card",
    PROPERTY_CARD_URI,
    { description: "Card view for get_land_property: parcel map, photos and key facts" },
    async () => ({
      contents: [{
        uri: PROPERTY_CARD_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: PROPERTY_CARD_HTML,
        _meta: { ui: { csp: { resourceDomains: [...WIDGET_IMAGE_ORIGINS, FONT_ORIGIN] }, prefersBorder: true } },
      }],
    }),
  );
}
