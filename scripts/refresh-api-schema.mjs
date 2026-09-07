#!/usr/bin/env node
/**
 * Refresh schema/api-schema.graphql from a live Fabrica API.
 *
 * The snapshot is what src/__tests__/schema-drift.test.ts validates every query
 * against, so refreshing it is the deliberate act of accepting an upstream schema
 * change: run this, then run the tests and fix whatever the diff broke.
 *
 * Usage:
 *   npm run schema:refresh                       # api-test.fabrica.land (staging)
 *   FABRICA_API_URL=<url> npm run schema:refresh
 */
import { writeFileSync } from "node:fs";
import { buildClientSchema, getIntrospectionQuery, printSchema } from "graphql";

const url = process.env.FABRICA_API_URL ?? "https://api-test.fabrica.land/graphql";
const out = new URL("../schema/api-schema.graphql", import.meta.url);
const response = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query: getIntrospectionQuery() }),
});
if (!response.ok) {
  console.error(`Introspection failed: HTTP ${response.status} from ${url}`);
  process.exit(1);
}
const body = await response.json();
if (body.errors) {
  console.error(`Introspection failed: ${body.errors.map(e => e.message).join("; ")}`);
  process.exit(1);
}
const sdl = `${printSchema(buildClientSchema(body.data))}\n`;
writeFileSync(out, sdl);
console.log(`Wrote ${sdl.split("\n").length - 1} lines to schema/api-schema.graphql from ${url}`);
