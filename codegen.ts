import type { CodegenConfig } from "@graphql-codegen/cli";

/**
 * Operation result types for every document the client sends, generated from the schema
 * snapshot (schema/api-schema.graphql) and the gql documents in src/clients/graphql.ts.
 * Output: src/clients/generated/operations.ts (committed). Run `npm run codegen` after
 * changing a query or refreshing the schema; CI fails when the committed file is stale.
 */
const config: CodegenConfig = {
  schema: "schema/api-schema.graphql",
  documents: ["src/clients/graphql.ts"],
  generates: {
    "src/clients/generated/operations.ts": {
      // The base plugin emits only the enums and input types the operations need (never the
      // whole schema as object types); the operations plugin emits one result type per document.
      plugins: ["typescript-operations"],
      config: {
        skipTypename: true,
        enumsAsTypes: true,
        avoidOptionals: { field: true, inputValue: false, object: true },
        scalars: { JSON: "Record<string, unknown>", JSONObject: "Record<string, unknown>", DateTime: "string", BigInt: "string" },
      },
    },
  },
};

export default config;
