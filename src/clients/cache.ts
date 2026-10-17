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
    this.entries.set(key, { expiresAt: now + this.ttlMs, value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(oldest);
    }
    return value;
  }

  get size(): number {
    return this.entries.size;
  }
}
