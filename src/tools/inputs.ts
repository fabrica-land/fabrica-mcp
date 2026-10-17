// Pieces shared by the tools' input schemas. Each tool exports its own zod shape next to the
// function that reads the arguments, and the server registers that shape, so the handler's
// parameter type and the schema the MCP client sees come from one definition.
import { z } from "zod";
import { normalizeSlug } from "../links.js";

/** The parsed arguments of a tool whose inputSchema is `Shape`: what the MCP SDK hands the handler. */
export type ArgsOf<Shape extends z.ZodRawShape> = z.infer<z.ZodObject<Shape>>;

/** A property named by token ID or by its fabrica.land slug (the URL, a path or the bare slug). */
export const propertyRefInputs = {
  tokenId: z.string().optional().describe("The token ID of the property"),
  slug: z.string().transform(normalizeSlug).optional().describe("Property slug from the URL"),
};

export const imageInputs = {
  theme: z.enum(["dark", "light"]).optional().describe("Map theme (default: 'dark')"),
  width: z.number().int().min(100).max(1280).optional().describe("Image width in pixels (100-1280, default 640)"),
  height: z.number().int().min(100).max(1280).optional().describe("Image height in pixels (100-1280, default 640)"),
};
