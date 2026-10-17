/**
 * Short-lived cache with in-flight de-duplication for upstream reads.
 *
 * Every user of the hosted server reaches the Fabrica API from the same egress, so they share
 * one per-IP rate-limit bucket. Caching each read for a few seconds, and letting concurrent
 * callers share one in-flight request, keeps repeated and parallel tool calls from spending
 * that bucket twice. Entries live in the process: a warm serverless instance reuses them, a
 * cold one starts empty. Failed loads are never cached.
 */

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 200;

/** `FABRICA_CACHE_TTL_MS` (milliseconds, 0 disables caching); 30 s by default. */
export function cacheTtlMs(): number {
  const value = Number.parseInt(process.env.FABRICA_CACHE_TTL_MS ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_TTL_MS;
}

export class TtlCache<V> {
  /** `expiresAt` is Infinity while the load is pending; the TTL starts when it resolves. */
  private readonly entries = new Map<string, { expiresAt: number; value: Promise<V> }>();

  constructor(
    private readonly ttlMs: number = cacheTtlMs(),
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
  ) {}

  /** The cached or in-flight value for `key`, or the result of `load()`, shared with concurrent callers. */
  get(key: string, load: () => Promise<V>): Promise<V> {
    if (this.ttlMs <= 0) return load();
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) return hit.value;
    if (hit) this.entries.delete(key);
    const value = load();
    const entry = { expiresAt: Number.POSITIVE_INFINITY, value };
    this.entries.set(key, entry);
    value.then(
      () => { entry.expiresAt = Date.now() + this.ttlMs; this.trim(); },
      () => { if (this.entries.get(key) === entry) this.entries.delete(key); },
    );
    this.trim();
    return value;
  }

  /** Evict the oldest settled entries past the bound; pending loads may briefly exceed it so they stay shared. */
  private trim(): void {
    for (const [oldest, candidate] of this.entries) {
      if (this.entries.size <= this.maxEntries) break;
      if (candidate.expiresAt !== Number.POSITIVE_INFINITY) this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
