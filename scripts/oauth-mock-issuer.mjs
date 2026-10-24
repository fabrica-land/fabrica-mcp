// Mocked Connect Fabrica issuer, for running the signed-in endpoint (/mcp/account) before the
// Fabrica API's authorization server is live. Generates a throwaway ES256 key, prints the env
// for a local or testnet server and an access token for MCP Inspector, and optionally serves a
// mock of the API's GET /oauth/account so get_my_account has something to read.
//
//   node scripts/oauth-mock-issuer.mjs [--scope "profile:read portfolio:read onramp:read"]
//     [--origin http://localhost:3000] [--sub <account id>] [--hours 1] [--serve 8787]
//
// Then start the server with the printed env (FABRICA_NETWORK=sepolia: mainnet ignores an
// inline JWKS) and call <origin>/mcp/account with "Authorization: Bearer <token>".
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const origin = option("origin", "http://localhost:3000").replace(/\/+$/, "");
const scope = option("scope", "profile:read portfolio:read onramp:read");
const sub = option("sub", randomUUID());
const hours = Number(option("hours", "1"));
const serve = option("serve", null);
// Personal reads go to the issuer, so with --serve the mock API is the issuer.
const issuer = serve ? `http://localhost:${serve}` : "https://api-test.fabrica.land";

const { publicKey, privateKey } = await generateKeyPair("ES256");
const kid = `mock-${randomUUID().slice(0, 8)}`;
const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" }] };
const token = await new SignJWT({ scope, client_id: "mock-client" })
  .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid })
  .setIssuer(issuer)
  .setAudience(`${origin}/mcp/account`)
  .setSubject(sub)
  .setIssuedAt()
  .setJti(randomUUID())
  .setExpirationTime(`${hours}h`)
  .sign(privateKey);

console.log("# Server env");
console.log("FABRICA_NETWORK=sepolia");
console.log("FABRICA_OAUTH=enabled");
console.log(`FABRICA_OAUTH_ISSUER=${issuer}`);
console.log(`FABRICA_MCP_ORIGIN=${origin}`);
console.log(`FABRICA_OAUTH_JWKS='${JSON.stringify(jwks)}'`);
console.log("\n# Access token (Authorization: Bearer ...)");
console.log(token);

if (serve) {
  createServer((req, res) => {
    const authorized = req.headers.authorization === `Bearer ${token}`;
    if (req.url === "/oauth/account" && req.method === "GET") {
      res.writeHead(authorized ? 200 : 401, { "Content-Type": "application/json" });
      res.end(JSON.stringify(authorized
        ? { userId: sub, email: "connected.user@example.com", wallets: [{ address: "0x000000000000000000000000000000000000dEaD", kind: "embedded" }], kyc: { status: "approved" } }
        : { error: "invalid_token" }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  }).listen(Number(serve), () => console.log(`\n# Mock API serving GET /oauth/account on http://localhost:${serve}`));
}
