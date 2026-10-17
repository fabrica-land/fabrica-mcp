// Operation result types for every document the client sends, generated from the schema
// snapshot (schema/api-schema.graphql) and the gql documents in src/clients/graphql.ts.
// Output: src/clients/generated/operations.ts (committed). Run `npm run codegen` after
// changing a query or refreshing the schema; CI fails when the committed file is stale.
//
// This drives @graphql-codegen/core directly instead of @graphql-codegen/cli: the CLI's
// dependency tree (listr2, the graphql-tools loaders) requires Node 22, while this package
// supports Node 20. Documents are plucked from the gql template literals; `${FRAGMENT}`
// interpolations are dropped because every fragment is itself a gql literal in the same file.
import { readFile, writeFile } from "node:fs/promises";
import { codegen } from "@graphql-codegen/core";
import * as typescriptOperations from "@graphql-codegen/typescript-operations";
import { parse } from "graphql";

const SCHEMA_PATH = new URL("../schema/api-schema.graphql", import.meta.url);
const DOCUMENTS_PATH = new URL("../src/clients/graphql.ts", import.meta.url);
const OUTPUT_PATH = new URL("../src/clients/generated/operations.ts", import.meta.url);

/** Every gql`...` template literal in the source, with `${...}` interpolations removed. */
export function pluckDocuments(source) {
  const documents = [];
  const pattern = /gql`([^`]*)`/g;
  for (const match of source.matchAll(pattern)) {
    documents.push(match[1].replace(/\$\{[^}]*\}/g, ""));
  }
  return documents;
}

const [schemaSdl, clientSource] = await Promise.all([
  readFile(SCHEMA_PATH, "utf8"),
  readFile(DOCUMENTS_PATH, "utf8"),
]);
const documents = pluckDocuments(clientSource);
if (documents.length === 0) throw new Error(`No gql documents found in ${DOCUMENTS_PATH.pathname}`);

const output = await codegen({
  filename: OUTPUT_PATH.pathname,
  schema: parse(schemaSdl),
  documents: [{ location: DOCUMENTS_PATH.pathname, document: parse(documents.join("\n")) }],
  plugins: [{ "typescript-operations": {} }],
  pluginMap: { "typescript-operations": typescriptOperations },
  config: {
    skipTypename: true,
    enumsAsTypes: true,
    avoidOptionals: { field: true, inputValue: false, object: true },
    scalars: { JSON: "Record<string, unknown>", JSONObject: "Record<string, unknown>", DateTime: "string", BigInt: "string" },
  },
});

await writeFile(OUTPUT_PATH, output);
console.log(`Wrote ${OUTPUT_PATH.pathname} from ${documents.length} documents`);
