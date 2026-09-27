import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureData, type FetchLike } from "../src/data/cache.js";
import { SOURCES, SOURCE_KEYS } from "../src/data/sources.js";

const DAY = 24 * 60 * 60 * 1000;

function fakeFetch(handler: (url: string, headers: Record<string, string>) => Response) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl: FetchLike = async (url, init) => {
    const headers = init?.headers ?? {};
    calls.push({ url, headers });
    return handler(url, headers);
  };
  return { impl, calls };
}

const ok = (url: string) =>
  new Response(url.endsWith(".lua") ? `return { from = "${url}" }` : JSON.stringify({ from: url }), {
    status: 200,
    headers: { etag: `"v1-${url.length}"` },
  });

describe("ensureData", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "poe2bf-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("downloads every source on first run and records a manifest", async () => {
    const { impl, calls } = fakeFetch(ok);
    const results = await ensureData({ cacheDir: dir, fetchImpl: impl });
    expect(results.every((r) => r.status === "downloaded")).toBe(true);
    expect(calls).toHaveLength(SOURCE_KEYS.length);
    const tree = JSON.parse(await readFile(join(dir, SOURCES.tree.file), "utf8"));
    expect(tree.from).toBe(SOURCES.tree.url);
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
    expect(manifest.tree.etag).toBeDefined();
  });

  it("skips the network while the cache is fresh", async () => {
    await ensureData({ cacheDir: dir, fetchImpl: fakeFetch(ok).impl });
    const second = fakeFetch(ok);
    const results = await ensureData({ cacheDir: dir, fetchImpl: second.impl });
    expect(second.calls).toHaveLength(0);
    expect(results.every((r) => r.status === "fresh")).toBe(true);
  });

  it("re-checks with a conditional request once the cache is old", async () => {
    await ensureData({ cacheDir: dir, fetchImpl: fakeFetch(ok).impl });
    const later = () => new Date(Date.now() + 8 * DAY);
    const recheck = fakeFetch(() => new Response(null, { status: 304 }));
    const results = await ensureData({ cacheDir: dir, fetchImpl: recheck.impl, now: later });
    expect(results.every((r) => r.status === "not-modified")).toBe(true);
    expect(recheck.calls.every((c) => c.headers["If-None-Match"]?.startsWith('"v1-'))).toBe(true);
  });

  it("falls back to the cached copy when offline", async () => {
    await ensureData({ cacheDir: dir, fetchImpl: fakeFetch(ok).impl });
    const offline: FetchLike = async () => {
      throw new Error("network down");
    };
    const results = await ensureData({ cacheDir: dir, fetchImpl: offline, force: true });
    expect(results.every((r) => r.status === "stale-offline")).toBe(true);
  });

  it("fails clearly on first run without a network", async () => {
    const offline: FetchLike = async () => {
      throw new Error("network down");
    };
    await expect(ensureData({ cacheDir: dir, fetchImpl: offline })).rejects.toThrow(/Could not download/);
  });

  it("keeps the old file when a download is not valid", async () => {
    await ensureData({ cacheDir: dir, fetchImpl: fakeFetch(ok).impl });
    const broken = fakeFetch(() => new Response("<html>oops</html>", { status: 200 }));
    await expect(ensureData({ cacheDir: dir, fetchImpl: broken.impl, force: true })).rejects.toThrow();
    const tree = JSON.parse(await readFile(join(dir, SOURCES.tree.file), "utf8"));
    expect(tree.from).toBe(SOURCES.tree.url);
  });
});
