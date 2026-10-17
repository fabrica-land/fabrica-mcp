import { afterEach, describe, expect, it, vi } from "vitest";
import { TtlCache, cacheTtlMs } from "../clients/cache.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("TtlCache", () => {
  it("shares one in-flight load between concurrent callers", async () => {
    const cache = new TtlCache<number>(1_000);
    const load = vi.fn(async () => 42);
    const results = await Promise.all([cache.get("k", load), cache.get("k", load), cache.get("k", load)]);
    expect(results).toEqual([42, 42, 42]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reloads after the TTL", async () => {
    vi.useFakeTimers();
    const cache = new TtlCache<number>(1_000);
    const load = vi.fn(async () => 1);
    await cache.get("k", load);
    vi.advanceTimersByTime(999);
    await cache.get("k", load);
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2);
    await cache.get("k", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps sharing a load that outlasts the TTL, and starts the TTL when it settles", async () => {
    vi.useFakeTimers();
    const cache = new TtlCache<number>(1_000);
    let resolve: (n: number) => void = () => {};
    const slow = vi.fn(() => new Promise<number>(r => { resolve = r; }));
    const first = cache.get("k", slow);
    vi.advanceTimersByTime(5_000);
    const second = cache.get("k", slow);
    expect(slow).toHaveBeenCalledTimes(1);
    resolve(9);
    await expect(Promise.all([first, second])).resolves.toEqual([9, 9]);
    vi.advanceTimersByTime(999);
    await cache.get("k", slow);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failure", async () => {
    const cache = new TtlCache<number>(1_000);
    const load = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(7);
    await expect(cache.get("k", load)).rejects.toThrow("down");
    await expect(cache.get("k", load)).resolves.toBe(7);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps separate keys apart and evicts the oldest past the size bound", async () => {
    const cache = new TtlCache<string>(1_000, 2);
    await cache.get("a", async () => "a");
    await cache.get("b", async () => "b");
    await cache.get("c", async () => "c");
    expect(cache.size).toBe(2);
    const reload = vi.fn(async () => "a2");
    await expect(cache.get("a", reload)).resolves.toBe("a2");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("never evicts a pending load to make room, and trims settled ones back to the bound", async () => {
    const cache = new TtlCache<string>(1_000, 1);
    let resolve: (v: string) => void = () => {};
    const slow = vi.fn(() => new Promise<string>(r => { resolve = r; }));
    const pending = cache.get("a", slow);
    await cache.get("b", async () => "b");
    expect(cache.size).toBe(1);
    void cache.get("a", slow);
    expect(slow).toHaveBeenCalledTimes(1);
    resolve("a");
    await expect(pending).resolves.toBe("a");
    expect(cache.size).toBe(1);
  });

  it("is disabled with a zero TTL", async () => {
    const cache = new TtlCache<number>(0);
    const load = vi.fn(async () => 1);
    await cache.get("k", load);
    await cache.get("k", load);
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  it("reads the TTL from FABRICA_CACHE_TTL_MS, 30 s by default", () => {
    vi.stubEnv("FABRICA_CACHE_TTL_MS", "");
    expect(cacheTtlMs()).toBe(30_000);
    vi.stubEnv("FABRICA_CACHE_TTL_MS", "5000");
    expect(cacheTtlMs()).toBe(5_000);
    vi.stubEnv("FABRICA_CACHE_TTL_MS", "-1");
    expect(cacheTtlMs()).toBe(30_000);
  });
});
