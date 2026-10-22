// Publishes server.json (mainnet) and server.testnet.json to the official MCP Registry
// (https://registry.modelcontextprotocol.io) under the land.fabrica/* namespace.
// Auth is DNS: fabrica.land carries TXT "v=MCPv1; k=ed25519; p=<public key>". The private key
// comes from MCP_REGISTRY_PRIVATE_KEY (PEM text, for CI) or the file at MCP_REGISTRY_KEY_PATH
// (default ~/.config/mcp-registry/fabrica-land-ed25519.pem). It is never printed or committed.
// Bump "version" in package.json and both server files first: the registry keeps every version
// and refuses a version it already has. Usage: npm run registry:publish [-- --dry-run]
import { createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const REGISTRY = "https://registry.modelcontextprotocol.io";
const FILES = ["server.json", "server.testnet.json"];
const MAX_DESCRIPTION = 100;

// Every failure is one line on stderr and exit code 1, never a stack trace.
function fail(message) {
  console.error(message);
  process.exit(1);
}

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const servers = await Promise.all(FILES.map(async (file) => JSON.parse(await readFile(file, "utf8"))));
for (const [index, server] of servers.entries()) {
  if (server.version !== pkg.version) fail(`${FILES[index]} is at ${server.version}, package.json at ${pkg.version}`);
  if (server.description.length > MAX_DESCRIPTION) fail(`${FILES[index]}: description is ${server.description.length} characters, the registry allows ${MAX_DESCRIPTION}`);
}

if (process.argv.includes("--dry-run")) {
  console.log(JSON.stringify(servers, null, 2));
  process.exit(0);
}

async function request(method, path, body, token) {
  try {
    const response = await fetch(REGISTRY + path, {
      method,
      headers: { "content-type": "application/json", accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text.slice(0, 600); }
    return { status: response.status, json };
  } catch (error) {
    fail(`Registry request ${method} ${path} failed: ${error.cause?.code ?? error.message}`);
  }
}

// Key order does not matter when comparing an entry with the registry's copy.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

// Preflight before any write: a version already in the registry is skipped when it matches
// (a rerun after a partial publish), and stops the run when it differs (bump the version).
const pending = [];
for (const server of servers) {
  const existing = await request("GET", `/v0.1/servers/${encodeURIComponent(server.name)}/versions/${server.version}`);
  if (existing.status === 404) {
    pending.push(server);
  } else if (existing.status === 200 && JSON.stringify(canonical(existing.json.server)) === JSON.stringify(canonical(server))) {
    console.log(`${server.name} ${server.version}: already published, skipped`);
  } else if (existing.status === 200) {
    fail(`${server.name} ${server.version} is already in the registry with different content. Bump the version in package.json and both server files.`);
  } else {
    fail(`Registry lookup for ${server.name} ${server.version} failed: HTTP ${existing.status}: ${JSON.stringify(existing.json)}`);
  }
}
if (pending.length === 0) process.exit(0);

const keyPath = process.env.MCP_REGISTRY_KEY_PATH ?? join(homedir(), ".config/mcp-registry/fabrica-land-ed25519.pem");
let key;
try {
  key = createPrivateKey(process.env.MCP_REGISTRY_PRIVATE_KEY ?? await readFile(keyPath, "utf8"));
} catch (error) {
  const source = process.env.MCP_REGISTRY_PRIVATE_KEY ? "MCP_REGISTRY_PRIVATE_KEY" : keyPath;
  fail(`No usable registry key at ${source} (${error.code ?? error.message}). Set MCP_REGISTRY_PRIVATE_KEY to the PEM text, or MCP_REGISTRY_KEY_PATH to the PEM file of the fabrica.land DNS key.`);
}
const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const signature = sign(null, Buffer.from(timestamp), key).toString("hex");
const auth = await request("POST", "/v0.1/auth/dns", { domain: "fabrica.land", timestamp, signed_timestamp: signature });
if (auth.status !== 200) fail(`Registry auth failed: HTTP ${auth.status}: ${JSON.stringify(auth.json)}`);

let failed = false;
for (const server of pending) {
  const result = await request("POST", "/v0.1/publish", server, auth.json.registry_token);
  const ok = result.status === 200;
  failed ||= !ok;
  console.log(`${server.name} ${server.version}: HTTP ${result.status} ${ok ? "published" : "FAILED"} ${JSON.stringify(ok ? result.json._meta : result.json).slice(0, 300)}`);
}
if (failed) process.exit(1);
