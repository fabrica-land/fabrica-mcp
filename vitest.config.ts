import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests stub fetch per case; the upstream read cache would replay an earlier stub.
    env: { FABRICA_CACHE_TTL_MS: "0" },
  },
});
