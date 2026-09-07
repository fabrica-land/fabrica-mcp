import { readFileSync } from "node:fs";
import { buildSchema, parse, validate } from "graphql";
import { describe, expect, it } from "vitest";
import { API_DOCUMENTS } from "../clients/graphql.js";

/**
 * Guards against the ENG-4054 failure mode: the API renamed TokenModel.metaStreetLiquidity
 * to poolLendingLiquidity, every get_property call started failing schema validation, and
 * the client reported the 400 to agents as "No property found with token ID X".
 *
 * The snapshot is checked in rather than introspected here on purpose. A test that calls
 * api-test at run time fails whenever staging is down, CI has no egress, or a lane sits
 * behind a proxy — and a red suite for those reasons trains people to ignore it. A
 * snapshot also makes an upstream schema change show up as a reviewable diff in the PR
 * that accepts it. Refresh it with `npm run schema:refresh` (see scripts/refresh-api-schema.mjs).
 */
const schema = buildSchema(
  readFileSync(new URL("../../schema/api-schema.graphql", import.meta.url), "utf8"),
);

describe("API documents validate against the schema snapshot", () => {
  it("covers every document the client sends", () => {
    expect(API_DOCUMENTS.length).toBeGreaterThan(0);
  });
  it.each(API_DOCUMENTS.map(d => [d.name, d.document] as const))(
    "%s",
    (_name, document) => {
      const errors = validate(schema, parse(document));
      expect(errors.map(e => e.message)).toEqual([]);
    },
  );
});

describe("the guard actually catches drift", () => {
  it("reports a field that is absent from the schema", () => {
    const errors = validate(
      schema,
      parse("query Drifted { token(tokenId: \"1\") { metaStreetLiquidity { maxPrincipalUsdc } } }"),
    );
    expect(errors.map(e => e.message)).toEqual([
      'Cannot query field "metaStreetLiquidity" on type "TokenModel".',
    ]);
  });
});
