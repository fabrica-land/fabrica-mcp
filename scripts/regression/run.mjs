#!/usr/bin/env node
/**
 * The ENG-2970 regression list: every tool, happy path and edge case, called over
 * JSON-RPC against a hosted server. Prints one line per case and exits 1 on a miss.
 *
 *   node scripts/regression/run.mjs                      # mainnet, https://mcp.fabrica.land/mcp
 *   node scripts/regression/run.mjs sepolia              # testnet
 *   node scripts/regression/run.mjs ethereum http://localhost:3000/mcp
 *
 * Cases live in cases.json. "$name" in an argument is replaced from the network's
 * fixtures. `expect` is one of: ok (no error), results (properties array non-empty),
 * image (an image content block), contains:<text>, error:<text>.
 */
import { readFile } from "node:fs/promises";

const URLS = { ethereum: "https://mcp.fabrica.land/mcp", sepolia: "https://mcp-testnet.fabrica.land/mcp" };
const network = process.argv[2] ?? "ethereum";
const url = process.argv[3] ?? URLS[network];
if (!url) {
  console.error(`Unknown network "${network}". Use ethereum or sepolia, or pass a URL.`);
  process.exit(2);
}
const { fixtures, cases } = JSON.parse(await readFile(new URL("./cases.json", import.meta.url), "utf8"));
const fixture = fixtures[network] ?? {};

function fill(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\$(\w+)/g, (match, name) => (name in fixture ? fixture[name] : match));
}

async function call(tool, args) {
  const started = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    signal: AbortSignal.timeout(90_000),
  });
  // A gateway error page or a body with neither a JSON-RPC result nor an error means no tool ran: a failure, never a pass.
  const body = response.ok ? await response.json().catch(() => null) : null;
  const outcome = body !== null && typeof body === "object" && (body.result !== undefined || body.error !== undefined);
  const content = outcome ? body.result?.content ?? [] : [];
  const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return {
    ms: Date.now() - started,
    isError: !response.ok || !outcome || Boolean(body.error) || Boolean(body.result?.isError),
    hasImage: content.some((c) => c.type === "image"),
    text: !response.ok ? `HTTP ${response.status}` : !outcome ? "no JSON-RPC result or error in the response" : body.error ? JSON.stringify(body.error) : text,
  };
}

function judge(expect, result) {
  if (expect === "ok") return !result.isError;
  if (expect === "image") return !result.isError && result.hasImage;
  if (expect === "results") {
    try { return !result.isError && JSON.parse(result.text).properties.length > 0; } catch { return false; }
  }
  if (expect.startsWith("contains:")) return !result.isError && result.text.includes(expect.slice("contains:".length));
  if (expect.startsWith("error:")) return result.isError && result.text.includes(expect.slice("error:".length));
  return false;
}

let failed = 0;
for (const testCase of cases) {
  const args = Object.fromEntries(Object.entries(testCase.args).map(([key, value]) => [key, fill(value)]));
  let result;
  try {
    result = await call(testCase.tool, args);
  } catch (error) {
    result = { ms: 0, isError: true, hasImage: false, text: error instanceof Error ? error.message : String(error) };
  }
  const pass = judge(testCase.expect, result);
  if (!pass) failed += 1;
  const preview = result.text.replace(/\s+/g, " ").slice(0, 100);
  console.log(`${pass ? "PASS" : "FAIL"} ${String(result.ms).padStart(6)}ms ${testCase.tool.padEnd(24)} ${testCase.id.padEnd(30)} ${preview}`);
}
console.log(`\n${cases.length - failed}/${cases.length} passed on ${network} (${url})`);
process.exit(failed === 0 ? 0 : 1);
