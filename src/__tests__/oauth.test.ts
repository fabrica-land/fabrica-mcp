import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Connect Fabrica on the hosted server: the signed-in endpoint as an OAuth resource server, against
 * a mocked issuer (a local JWKS) and a mocked API (GET /oauth/account). Mainnet network (the test default).
 */

const RESOURCE = "https://mcp.fabrica.land/mcp/account";
const KID = "test-key";

let signingKey: CryptoKey;
let otherKey: CryptoKey;
let mock: Server;
let mockBase: string;
let accountStatus = 200;
const accountCalls: (string | undefined)[] = [];

async function token(overrides: { aud?: string; iss?: string; scope?: string; exp?: string | number; typ?: string; key?: CryptoKey; sub?: string } = {}): Promise<string> {
  return new SignJWT({ scope: overrides.scope ?? "profile:read portfolio:read onramp:read", client_id: "client-123" })
    .setProtectedHeader({ alg: "ES256", typ: overrides.typ ?? "at+jwt", kid: KID })
    .setIssuer(overrides.iss ?? mockBase)
    .setAudience(overrides.aud ?? RESOURCE)
    .setSubject(overrides.sub ?? "5f0c4f1e-1111-4222-8333-944455556666")
    .setIssuedAt()
    .setExpirationTime(overrides.exp ?? "15m")
    .sign(overrides.key ?? signingKey);
}

beforeAll(async () => {
  ({ privateKey: signingKey } = await generateKeyPair("ES256", { extractable: true }));
  ({ privateKey: otherKey } = await generateKeyPair("ES256"));
  const publicKey = await importPublic(signingKey);
  const jwks = { keys: [{ ...publicKey, kid: KID, alg: "ES256", use: "sig" }] };
  mock = createHttpServer((req: IncomingMessage, res) => {
    if (req.url === "/.well-known/jwks.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(jwks));
      return;
    }
    if (req.url === "/oauth/account") {
      accountCalls.push(req.headers.authorization);
      res.writeHead(accountStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify(accountStatus === 200
        ? { userId: "x", email: "owner@example.com", wallets: [{ address: "0x1111111111111111111111111111111111111111", kind: "embedded" }], kyc: { status: "approved" } }
        : { error: "nope" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address();
  if (address === null || typeof address === "string") throw new Error("mock has no port");
  mockBase = `http://127.0.0.1:${address.port}`;
});

/** The public half of the signing key, as a JWK. */
async function importPublic(key: CryptoKey): Promise<object> {
  const { d: _d, ...publicJwk } = await exportJWK(key);
  return publicJwk;
}

afterAll(async () => {
  await new Promise<void>((resolve) => mock.close(() => resolve()));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
  accountStatus = 200;
  accountCalls.length = 0;
});

function enable(): void {
  vi.stubEnv("FABRICA_OAUTH", "enabled");
  vi.stubEnv("FABRICA_OAUTH_JWKS_URL", `${mockBase}/.well-known/jwks.json`);
  vi.stubEnv("FABRICA_OAUTH_ISSUER", mockBase);
}

/** Serve the MCP handler and the well-known handler from a fresh module graph on a local port. */
async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
  const { handleMcpHttpRequest } = await import("../http.js");
  const { handleWellKnownHttp } = await import("../well-known.js");
  const server = createHttpServer((req, res) => void (req.url?.startsWith("/.well-known/") ? handleWellKnownHttp(req, res) : handleMcpHttpRequest(req, res)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const INITIALIZE = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });

function post(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: INITIALIZE });
}

/** The first content block's text, narrowed at runtime. */
function textOf(result: unknown): string {
  if (typeof result === "object" && result !== null && "content" in result && Array.isArray(result.content)) {
    const first: unknown = result.content[0];
    if (typeof first === "object" && first !== null && "type" in first && first.type === "text" && "text" in first && typeof first.text === "string") return first.text;
  }
  throw new Error("tool result has no text content");
}

async function connect(url: string, bearer: string): Promise<Client> {
  const client = new Client({ name: "oauth-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
  return client;
}

describe("access-token checks", () => {
  async function check(header: string | undefined) {
    enable();
    const { checkAccessToken } = await import("../auth/token.js");
    return checkAccessToken(header);
  }

  it("accepts a token issued for this endpoint and reads its scopes", async () => {
    const result = await check(`Bearer ${await token({ scope: "profile:read onramp:read" })}`);
    expect(result).toMatchObject({ ok: true, auth: { subject: "5f0c4f1e-1111-4222-8333-944455556666", clientId: "client-123", scopes: ["profile:read", "onramp:read"] } });
  });

  it("reports a missing header as missing, and a non-bearer header as invalid", async () => {
    expect(await check(undefined)).toEqual({ ok: false, reason: "missing" });
    expect(await check("Basic abc")).toMatchObject({ ok: false, reason: "invalid" });
  });

  it.each([
    ["the testnet endpoint's audience", { aud: "https://mcp-testnet.fabrica.land/mcp/account" }],
    ["the anonymous endpoint's audience", { aud: "https://mcp.fabrica.land/mcp" }],
    ["another issuer", { iss: "https://api-test.fabrica.land" }],
    ["a key the issuer does not publish", { otherKey: true }],
    ["a plain JWT type", { typ: "JWT" }],
  ])("rejects a token with %s", async (_label, overrides) => {
    const { otherKey: useOther, ...options } = { otherKey: false, ...overrides };
    expect(await check(`Bearer ${await token(useOther ? { ...options, key: otherKey } : options)}`)).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("rejects an expired token beyond the clock tolerance", async () => {
    const result = await check(`Bearer ${await token({ exp: Math.floor(Date.now() / 1000) - 120 })}`);
    expect(result).toEqual({ ok: false, reason: "invalid", description: "The access token has expired." });
  });

  it("rejects an unsigned token", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "at+jwt" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: mockBase, aud: RESOURCE, sub: "x", client_id: "c", iat: 1, exp: 4102444800 })).toString("base64url");
    expect(await check(`Bearer ${header}.${payload}.`)).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("answers unavailable, not a crash, when the inline keys are malformed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    enable();
    vi.stubEnv("FABRICA_NETWORK", "sepolia");
    vi.stubEnv("FABRICA_OAUTH_JWKS", "{not json");
    const { checkAccessToken } = await import("../auth/token.js");
    expect(await checkAccessToken("Bearer a.b.c")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("answers unavailable, not invalid, when the issuer's keys cannot be fetched", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    enable();
    vi.stubEnv("FABRICA_OAUTH_JWKS_URL", "http://127.0.0.1:1/.well-known/jwks.json");
    const { checkAccessToken } = await import("../auth/token.js");
    expect(await checkAccessToken(`Bearer ${await token()}`)).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("signed-in endpoint while Connect Fabrica is off", () => {
  it("answers 404 on /mcp/account and on the protected resource metadata", async () => {
    await withServer(async (base) => {
      expect((await post(`${base}/mcp/account`, { Authorization: `Bearer ${await token()}` })).status).toBe(404);
      expect((await fetch(`${base}/.well-known/oauth-protected-resource/mcp/account`)).status).toBe(404);
      expect((await fetch(`${base}/.well-known/oauth-protected-resource`)).status).toBe(404);
    });
  });

  it("leaves the anonymous endpoint as it is", async () => {
    await withServer(async (base) => {
      const response = await post(`${base}/mcp`);
      expect(response.status).toBe(200);
    });
  });
});

describe("signed-in endpoint with Connect Fabrica on", () => {
  it("challenges a request without a token, pointing at the resource metadata", async () => {
    enable();
    await withServer(async (base) => {
      const response = await post(`${base}/mcp/account`);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://mcp.fabrica.land/.well-known/oauth-protected-resource/mcp/account"');
      expect(response.headers.get("access-control-expose-headers")).toContain("WWW-Authenticate");
      expect(response.headers.get("cache-control")).toBe("no-store");
    });
  });

  it("challenges an invalid token with invalid_token, including a testnet token on mainnet", async () => {
    enable();
    await withServer(async (base) => {
      const response = await post(`${base}/mcp/account`, { Authorization: `Bearer ${await token({ aud: "https://mcp-testnet.fabrica.land/mcp/account" })}` });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toMatch(/^Bearer error="invalid_token", error_description="[^"]+", resource_metadata="https:\/\/mcp\.fabrica\.land\/\.well-known\/oauth-protected-resource\/mcp\/account"$/);
    });
  });

  it("answers 503 when the issuer's keys cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    enable();
    vi.stubEnv("FABRICA_OAUTH_JWKS_URL", "http://127.0.0.1:1/.well-known/jwks.json");
    await withServer(async (base) => {
      expect((await post(`${base}/mcp/account`, { Authorization: `Bearer ${await token()}` })).status).toBe(503);
    });
  });

  it("serves RFC 9728 metadata at both locations", async () => {
    enable();
    await withServer(async (base) => {
      for (const path of ["/.well-known/oauth-protected-resource/mcp/account", "/.well-known/oauth-protected-resource"]) {
        const response = await fetch(`${base}${path}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          resource: RESOURCE,
          authorization_servers: [mockBase],
          scopes_supported: ["profile:read", "portfolio:read", "onramp:read"],
          bearer_methods_supported: ["header"],
          resource_name: "Fabrica",
          resource_documentation: "https://docs.fabrica.land/docs/ai-agents",
        });
      }
    });
  });

  it("adds get_my_account only on the signed-in endpoint", async () => {
    enable();
    await withServer(async (base) => {
      const signedIn = await connect(`${base}/mcp/account`, await token());
      const names = (await signedIn.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("get_my_account");
      expect(names).toContain("search_land");
      expect(signedIn.getInstructions()).toContain("signed-in endpoint");
      await signedIn.close();

      const anonymous = new Client({ name: "oauth-test", version: "0.0.0" });
      await anonymous.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
      expect((await anonymous.listTools()).tools.map((tool) => tool.name)).not.toContain("get_my_account");
      expect(anonymous.getInstructions()).not.toContain("signed-in endpoint");
      await anonymous.close();
    });
  });

  it("lists every personal tool on the signed-in endpoint, in fabrica.land's words", async () => {
    // Same vocabulary rule as the anonymous endpoint's tools (http.test.ts); scope names
    // (onramp:read) are identifiers too.
    const jargon = /\bpre-?mints?\b|\bon-?ramp(s|ed|ing)?\b|\boff-?ramp(s|ed|ing)?\b|\bmint(s|ed|ing)?\b|\bburn(ed|s)?\b|\bNFTs?\b|\bon-chain\b/i;
    const prose = (text: string) => text.replace(/https?:\/\/\S+/g, "").replace(/'[a-z_]+'/g, "").replace(/\b[a-z]+:(?:read|write)\b/g, "").replace(/\b[a-z]+(?:_[a-z0-9]+)+\b|\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/g, "");
    enable();
    await withServer(async (base) => {
      const signedIn = await connect(`${base}/mcp/account`, await token());
      const { tools } = await signedIn.listTools();
      const personal = ["get_my_account", "get_my_properties", "get_my_offers", "get_my_loans", "get_my_properties_being_added", "get_adding_status", "what_needs_attention"];
      expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(personal));
      for (const tool of tools.filter((t) => personal.includes(t.name))) {
        expect(prose(`${tool.title ?? ""} ${tool.description ?? ""} ${JSON.stringify(tool.inputSchema)}`), tool.name).not.toMatch(jargon);
        expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      }
      expect(prose(signedIn.getInstructions() ?? "")).not.toMatch(jargon);
      await signedIn.close();
    });
  });

  it("get_my_account reads the profile with the caller's token and never logs it", async () => {
    enable();
    const bearer = await token();
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    }
    const result = await withServer(async (base) => {
      const client = await connect(`${base}/mcp/account`, bearer);
      const response = await client.callTool({ name: "get_my_account", arguments: {} });
      await client.close();
      return response;
    });
    expect(accountCalls).toEqual([`Bearer ${bearer}`]);
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(textOf(result));
    expect(body).toMatchObject({
      network: "Ethereum Mainnet",
      connection: { accountId: "5f0c4f1e-1111-4222-8333-944455556666", client: "client-123", scopes: ["profile:read", "portfolio:read", "onramp:read"] },
      email: "owner@example.com",
      wallets: [{ address: "0x1111111111111111111111111111111111111111", kind: "embedded" }],
      verification: "approved",
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(bearer);
    expect(lines.join("\n")).not.toContain(bearer.split(".")[2]);
  });

  it("get_my_account tells the agent to reconnect when the API revokes the token", async () => {
    enable();
    accountStatus = 401;
    const result = await withServer(async (base) => {
      const client = await connect(`${base}/mcp/account`, await token());
      const response = await client.callTool({ name: "get_my_account", arguments: {} });
      await client.close();
      return response;
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Reconnect Fabrica");
  });

  it("get_my_account says so while the API does not serve the profile yet", async () => {
    enable();
    accountStatus = 404;
    const { getMyAccount } = await import("../tools/account.js");
    const result = await getMyAccount({ token: await token(), subject: "s", clientId: "c", scopes: ["profile:read"], expiresAt: 4102444800 });
    expect(result.error).toBeUndefined();
    expect(result.wallets).toBeUndefined();
    expect(result.notes[0]).toContain("does not serve account details yet");
  });

  it("get_my_account does not call the API without profile:read", async () => {
    enable();
    const { getMyAccount } = await import("../tools/account.js");
    const result = await getMyAccount({ token: await token(), subject: "s", clientId: "c", scopes: ["portfolio:read"], expiresAt: 4102444800 });
    expect(accountCalls).toEqual([]);
    expect(result.notes[0]).toContain("not granted profile:read");
  });
});
