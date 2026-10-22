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

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const servers = await Promise.all(FILES.map(async (file) => JSON.parse(await readFile(file, "utf8"))));
for (const [index, server] of servers.entries()) {
  if (server.version !== pkg.version) throw new Error(`${FILES[index]} is at ${server.version}, package.json at ${pkg.version}`);
  if (server.description.length > MAX_DESCRIPTION) throw new Error(`${FILES[index]}: description is ${server.description.length} characters, the registry allows ${MAX_DESCRIPTION}`);
}

if (process.argv.includes("--dry-run")) {
  console.log(JSON.stringify(servers, null, 2));
  process.exit(0);
}

async function post(path, body, token) {
  const response = await fetch(REGISTRY + path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text.slice(0, 600); }
  return { status: response.status, json };
}

const pem = process.env.MCP_REGISTRY_PRIVATE_KEY
  ?? await readFile(process.env.MCP_REGISTRY_KEY_PATH ?? join(homedir(), ".config/mcp-registry/fabrica-land-ed25519.pem"), "utf8");
const key = createPrivateKey(pem);
const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const signature = sign(null, Buffer.from(timestamp), key).toString("hex");
const auth = await post("/v0.1/auth/dns", { domain: "fabrica.land", timestamp, signed_timestamp: signature });
if (auth.status !== 200) throw new Error(`Registry auth failed: HTTP ${auth.status}: ${JSON.stringify(auth.json)}`);

let failed = false;
for (const server of servers) {
  const result = await post("/v0.1/publish", server, auth.json.registry_token);
  const ok = result.status === 200;
  failed ||= !ok;
  console.log(`${server.name} ${server.version}: HTTP ${result.status} ${ok ? "published" : "FAILED"} ${JSON.stringify(ok ? result.json._meta : result.json).slice(0, 300)}`);
}
if (failed) process.exit(1);
