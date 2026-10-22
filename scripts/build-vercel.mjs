// Builds the hosted (Streamable HTTP) server as a Vercel Build Output API bundle:
// one self-contained function at /mcp plus a landing page at /. The network is
// fixed per Vercel project by FABRICA_NETWORK (read at runtime by the function,
// and at build time for the landing page copy).
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { build } from "tsup";

const OUTPUT = ".vercel/output";
const FUNCTION_DIR = `${OUTPUT}/functions/mcp.func`;
// Sign requests: the sign page reads and completes them at /sign-requests/{id}.
const SIGN_REQUESTS_DIR = `${OUTPUT}/functions/sign-requests.func`;
// Discovery documents: /.well-known/mcp.json, /.well-known/mcp/server-card.json and /.well-known/ai-catalog.json.
const WELL_KNOWN_DIR = `${OUTPUT}/functions/well-known.func`;
const isSepolia = process.env.FABRICA_NETWORK?.toLowerCase() === "sepolia";
const networkLabel = isSepolia ? "Sepolia testnet" : "Ethereum mainnet";

await rm(OUTPUT, { recursive: true, force: true });
for (const [entry, dir] of [["src/vercel.ts", FUNCTION_DIR], ["src/vercel-sign-requests.ts", SIGN_REQUESTS_DIR], ["src/vercel-well-known.ts", WELL_KNOWN_DIR]]) {
  await build({
    config: false,
    entry: { index: entry },
    format: ["cjs"],
    platform: "node",
    target: "node20",
    outDir: dir,
    outExtension: () => ({ js: ".js" }),
    noExternal: [/.*/],
    splitting: false,
    shims: true,
    dts: false,
    silent: true,
  });
  await writeFile(`${dir}/package.json`, JSON.stringify({ type: "commonjs" }));
  await writeFile(`${dir}/.vc-config.json`, JSON.stringify({
    runtime: "nodejs22.x",
    handler: "index.js",
    launcherType: "Nodejs",
    shouldAddHelpers: true,
    maxDuration: 60,
  }, null, 2));
}
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
<p>Agent skill file: <a href="/skill.md">/skill.md</a></p>
<p>Source and tool list: <a href="https://github.com/fabrica-land/fabrica-mcp">github.com/fabrica-land/fabrica-mcp</a></p>
<script>
const url = location.origin + "/mcp";
document.getElementById("url").textContent = url;
document.getElementById("cmd").textContent = "claude mcp add --transport http ${isSepolia ? "fabrica-testnet" : "fabrica"} " + url;
</script>
</body>
</html>
`);
// The Fabrica skill file (Agent Skills format), for agents that never connect to the server.
await copyFile("skills/fabrica/SKILL.md", `${OUTPUT}/static/skill.md`);
// Brand font for the property card (ui/property-card/index.html), with its licence. The card
// loads it cross-origin from the host's sandboxed frame, so it needs CORS.
await mkdir(`${OUTPUT}/static/fonts`, { recursive: true });
for (const file of await readdir("ui/fonts")) await copyFile(`ui/fonts/${file}`, `${OUTPUT}/static/fonts/${file}`);
await writeFile(`${OUTPUT}/config.json`, JSON.stringify({
  version: 3,
  routes: [
    {
      src: "^/fonts/(.*)$",
      headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=31536000, immutable" },
      continue: true,
    },
    { src: "^/sign-requests/([^/]+)/result/?$", dest: "/sign-requests?id=$1&op=result" },
    { src: "^/sign-requests/([^/]+)/?$", dest: "/sign-requests?id=$1" },
    { src: "^/\\.well-known/mcp\\.json$", dest: "/well-known?doc=manifest" },
    { src: "^/\\.well-known/mcp/server-card\\.json$", dest: "/well-known?doc=server-card" },
    { src: "^/\\.well-known/ai-catalog\\.json$", dest: "/well-known?doc=ai-catalog" },
    { handle: "filesystem" },
  ],
}, null, 2));
console.log(`Built Vercel output for ${networkLabel} in ${OUTPUT}`);
