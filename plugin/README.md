# Fabrica Land plugin

The hosted server packaged for plugin directories. ChatGPT and Cursor both get the full server, `https://mcp.fabrica.land/mcp`. Its write tools only prepare sign requests that the person signs on fabrica.land with their own wallet; the server holds no keys and submits nothing. The read-only profile `https://mcp.fabrica.land/mcp/read` stays available for directories that need it.

- **ChatGPT:** `plugin.json` is an Agent Plugins manifest with the ChatGPT listing and review test cases under `extensions.com.openai`. Upload a ZIP of this folder's contents at platform.openai.com/plugins: `cd plugin && zip -r ../fabrica-land-chatgpt.zip . -x README.md`. The domain challenge is served at `https://mcp.fabrica.land/.well-known/openai-apps-challenge` from the `OPENAI_APPS_CHALLENGE` environment variable.
- **Cursor:** `.cursor-plugin/plugin.json` at the repository root points at `.cursor-plugin/mcp.json` and at the repository's `skills/`. Submit the repository at cursor.com/marketplace/publish.

`src/__tests__/plugin.test.ts` keeps the listing inside ChatGPT's field limits and the test cases on tools the server registers.
