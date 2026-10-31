# Fabrica Land plugin

The same hosted server (`https://mcp.fabrica.land/mcp`, read-only, no account) packaged for plugin directories.

- **ChatGPT:** `plugin.json` is an Agent Plugins manifest with the ChatGPT listing and review test cases under `extensions.com.openai`. Upload a ZIP of this folder's contents at platform.openai.com/plugins: `cd plugin && zip -r ../fabrica-land-chatgpt.zip . -x README.md`. The domain challenge is served at `https://mcp.fabrica.land/.well-known/openai-apps-challenge` from the `OPENAI_APPS_CHALLENGE` environment variable.
- **Cursor:** `.cursor-plugin/plugin.json` at the repository root points at `mcp.json` here and at the repository's `skills/`. Submit the repository at cursor.com/marketplace/publish.

`src/__tests__/plugin.test.ts` keeps the listing inside ChatGPT's field limits and the test cases on tools the server registers.
