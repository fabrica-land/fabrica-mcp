// Pending sign requests. A prepare tool writes one record; the Soil sign page reads it
// by id, the person signs there with their own wallet, and the page reports the order hash or
// transaction hash back. The record never holds a key or a signature. Records live in the MCP's
// own store (Vercel KV / Upstash Redis over REST), expire 15 minutes after creation, and carry an
// HMAC of their contents so a record the server did not write (or that changed under it) is
// refused on read.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** How long a sign request stays open. */
export const SIGN_REQUEST_TTL_SECONDS = 15 * 60;
/** How long the record is kept, so the sign page can tell an expired link (410) from an unknown one (404). */
export const SIGN_REQUEST_RETENTION_SECONDS = 24 * 60 * 60;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

export const signRequestActions = ["make_land_offer", "list_land_for_sale", "accept_land_offer", "buy_land", "cancel_land_order"] as const;

const warningSchema = z.object({
  level: z.enum(["info", "warning"]),
  message: z.string(),
});

export const signRequestSchema = z.object({
  id: z.string().regex(/^sr_[A-Za-z0-9_-]{22}$/),
  status: z.enum(["pending", "completed"]),
  network: z.enum(["ethereum", "sepolia"]),
  chainId: z.number().int(),
  action: z.enum(signRequestActions),
  // typedData: an EIP-712 signature (offer, listing, accepting an offer); transaction: an onchain
  // transaction the signer's client broadcasts (buy_land); offchain: a signed-in confirmation with no
  // signature (cancel, which the API records).
  kind: z.enum(["typedData", "transaction", "offchain"]),
  wallet: z.string().regex(ADDRESS),
  property: z.object({
    tokenId: z.string(),
    contractAddress: z.string(),
    name: z.string().nullable(),
    link: z.string(),
  }),
  order: z.object({
    side: z.enum(["buy", "sell"]),
    priceUsd: z.string(),
    price: z.string(),
    symbol: z.string(),
    decimals: z.number().int(),
    durationDays: z.number().int(),
    supply: z.string(),
  }).optional(),
  orderHash: z.string().regex(HASH).optional(),
  signLink: z.string(),
  summary: z.array(z.string()),
  warnings: z.array(warningSchema),
  // The EIP-712 typed data or unsigned transaction. Null until the MCP can build orders for a
  // connected user (Connect Fabrica); the sign page builds them meanwhile.
  payload: z.null(),
  createdAt: z.string(),
  expiresAt: z.string(),
  result: z.object({
    orderHash: z.string().regex(HASH).optional(),
    transactionHash: z.string().regex(HASH).optional(),
    completedAt: z.string(),
  }).optional(),
});
export type SignRequest = z.infer<typeof signRequestSchema>;
export type SignRequestWarning = z.infer<typeof warningSchema>;

const storedSchema = z.object({ record: signRequestSchema, mac: z.string() });

/** A random, unguessable id: "sr_" and 128 bits in base64url. */
export function newSignRequestId(): string {
  return `sr_${randomBytes(16).toString("base64url")}`;
}

export function isSignRequestId(value: string): boolean {
  return /^sr_[A-Za-z0-9_-]{22}$/.test(value);
}

/** Where records are kept: Redis over REST in production, a map in tests and local runs. */
export interface SignRequestBackend {
  /** Store with the given time to live; `keepTtl` keeps the key's remaining time instead. */
  set(key: string, value: string, ttl: { seconds: number } | "keep"): Promise<void>;
  get(key: string): Promise<string | null>;
}

export class MemoryBackend implements SignRequestBackend {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();
  async set(key: string, value: string, ttl: { seconds: number } | "keep"): Promise<void> {
    const current = this.entries.get(key);
    const expiresAt = ttl === "keep" ? current?.expiresAt ?? Date.now() : Date.now() + ttl.seconds * 1000;
    this.entries.set(key, { value, expiresAt });
  }
  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }
}

const restResponse = z.object({ result: z.unknown().optional(), error: z.string().optional() });

/** Vercel KV / Upstash Redis REST API: one command per POST, JSON array body. */
export class RedisRestBackend implements SignRequestBackend {
  constructor(private readonly url: string, private readonly token: string) {}
  private async command(args: readonly (string | number)[]): Promise<unknown> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(5_000),
    });
    const body = restResponse.safeParse(await response.json().catch(() => null));
    if (!response.ok || !body.success || body.data.error) {
      throw new Error(`Sign request store failed (HTTP ${response.status}${body.success && body.data.error ? `: ${body.data.error}` : ""}).`);
    }
    return body.data.result;
  }
  async set(key: string, value: string, ttl: { seconds: number } | "keep"): Promise<void> {
    await this.command(ttl === "keep" ? ["SET", key, value, "KEEPTTL", "XX"] : ["SET", key, value, "EX", ttl.seconds]);
  }
  async get(key: string): Promise<string | null> {
    const result = await this.command(["GET", key]);
    return typeof result === "string" ? result : null;
  }
}

export class SignRequestStore {
  constructor(private readonly backend: SignRequestBackend, private readonly secret: string) {}

  /** Over the schema's canonical key order, so a record and its parsed copy sign the same. */
  private mac(record: SignRequest): string {
    return createHmac("sha256", this.secret).update(JSON.stringify(signRequestSchema.parse(record))).digest("base64url");
  }

  private key(id: string): string {
    return `sign-request:${id}`;
  }

  async create(input: SignRequest): Promise<void> {
    const record = signRequestSchema.parse(input);
    await this.backend.set(this.key(record.id), JSON.stringify({ record, mac: this.mac(record) }), { seconds: SIGN_REQUEST_RETENTION_SECONDS });
  }

  /** The record, expired or not (see isExpired), or null when it is unknown or fails its integrity check. */
  async get(id: string): Promise<SignRequest | null> {
    if (!isSignRequestId(id)) return null;
    const raw = await this.backend.get(this.key(id));
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const stored = storedSchema.safeParse(parsed);
    if (!stored.success) return null;
    const expected = Buffer.from(this.mac(stored.data.record));
    const actual = Buffer.from(stored.data.mac);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    return stored.data.record;
  }

  /** Record the signer's result. Keeps the original expiry. */
  async complete(record: SignRequest, result: { orderHash?: string; transactionHash?: string }): Promise<SignRequest> {
    const updated: SignRequest = {
      ...record,
      status: "completed",
      result: { ...result, completedAt: new Date().toISOString() },
    };
    await this.backend.set(this.key(record.id), JSON.stringify({ record: updated, mac: this.mac(updated) }), "keep");
    return updated;
  }
}

/** Past its 15-minute window: the link no longer opens a prefilled dialog. */
export function isExpired(record: SignRequest): boolean {
  return Date.parse(record.expiresAt) <= Date.now();
}

let store: SignRequestStore | null | undefined;

/**
 * The store for this process. Redis when KV_REST_API_URL and KV_REST_API_TOKEN (Vercel KV) or
 * UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set, which also requires
 * SIGN_REQUEST_SECRET; otherwise an in-process map with a random secret, which only works where
 * one process serves every request (stdio, tests). Null when Redis is configured without a secret,
 * and on Vercel without Redis: there each request may land on a different instance, so a map
 * would hand out ids the sign page could never read.
 */
export function getSignRequestStore(): SignRequestStore | null {
  if (store !== undefined) return store;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  const secret = process.env.SIGN_REQUEST_SECRET;
  if (url && token) {
    store = secret ? new SignRequestStore(new RedisRestBackend(url, token), secret) : null;
  } else if (process.env.VERCEL) {
    store = null;
  } else {
    store = new SignRequestStore(new MemoryBackend(), secret ?? randomBytes(32).toString("base64url"));
  }
  return store;
}

/** Tests: replace the process store. */
export function setSignRequestStore(next: SignRequestStore | null | undefined): void {
  store = next;
}
