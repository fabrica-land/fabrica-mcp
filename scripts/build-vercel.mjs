// Builds the hosted (Streamable HTTP) server as a Vercel Build Output API bundle:
// one self-contained function at /mcp plus a landing page at /. The network is
// fixed per Vercel project by FABRICA_NETWORK (read at runtime by the function,
// and at build time for the landing page copy).
import { mkdir, rm, writeFile } from "node:fs/promises";
import { build } from "tsup";

const OUTPUT = ".vercel/output";
const FUNCTION_DIR = `${OUTPUT}/functions/mcp.func`;
const isSepolia = process.env.FABRICA_NETWORK?.toLowerCase() === "sepolia";
const networkLabel = isSepolia ? "Sepolia testnet" : "Ethereum mainnet";

await rm(OUTPUT, { recursive: true, force: true });
await build({
  config: false,
  entry: { index: "src/vercel.ts" },
  format: ["cjs"],
  platform: "node",
  target: "node20",
  outDir: FUNCTION_DIR,
  outExtension: () => ({ js: ".js" }),
  noExternal: [/.*/],
  splitting: false,
  shims: true,
  dts: false,
  silent: true,
});
await writeFile(`${FUNCTION_DIR}/package.json`, JSON.stringify({ type: "commonjs" }));
await writeFile(`${FUNCTION_DIR}/.vc-config.json`, JSON.stringify({
  runtime: "nodejs22.x",
  handler: "index.js",
  launcherType: "Nodejs",
  shouldAddHelpers: true,
  maxDuration: 60,
}, null, 2));
await mkdir(`${OUTPUT}/static`, { recursive: true });
await writeFile(`${OUTPUT}/static/index.html`, `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fabrica MCP</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5}code{background:#f2f2f2;padding:.1rem .3rem;border-radius:3px;word-break:break-all}</style>
</head>
<body>
<h1>Fabrica MCP server</h1>
<p>Network: <strong>${networkLabel}</strong>.${isSepolia ? " Test properties only, no real-world consequences." : " Properties are real parcels of US land; actions on them have real legal and financial consequences."}</p>
<p>Add this URL to any MCP client (Claude, ChatGPT, Cursor, and others) as a remote server. No install, no API key:</p>
<p><code id="url">/mcp</code></p>
<p>Claude Code: <code id="cmd">claude mcp add --transport http fabrica /mcp</code></p>
<p>Source and tool list: <a href="https://github.com/fabrica-land/fabrica-mcp">github.com/fabrica-land/fabrica-mcp</a></p>
<script>
const url = location.origin + "/mcp";
document.getElementById("url").textContent = url;
document.getElementById("cmd").textContent = "claude mcp add --transport http ${isSepolia ? "fabrica-testnet" : "fabrica"} " + url;
</script>
</body>
</html>
`);
await writeFile(`${OUTPUT}/config.json`, JSON.stringify({ version: 3 }, null, 2));
console.log(`Built Vercel output for ${networkLabel} in ${OUTPUT}`);
