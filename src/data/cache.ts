import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseLuaData } from "./lua.js";
import { SOURCES, SOURCE_KEYS, type SourceKey } from "./sources.js";

const USER_AGENT = "poe2-build-planner-claude-tool/0.0.1";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface ManifestEntry {
  url: string;
  etag?: string;
  lastModified?: string;
  /** When we last confirmed the file is current (ISO time). */
  checkedAt: string;
  bytes: number;
}

export type Manifest = Partial<Record<SourceKey, ManifestEntry>>;

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

export interface EnsureOptions {
  cacheDir?: string;
  /** Re-check a cached file with the server once it is older than this. Default: one week. */
  maxAgeMs?: number;
  /** Always re-check with the server (a cheap conditional request). */
  force?: boolean;
  fetchImpl?: FetchLike;
  now?: () => Date;
  log?: (message: string) => void;
}

export type EnsureStatus = "fresh" | "not-modified" | "downloaded" | "stale-offline";

export interface EnsureResult {
  key: SourceKey;
  path: string;
  status: EnsureStatus;
}

export function defaultCacheDir(): string {
  if (process.env.POE2BF_CACHE_DIR) return process.env.POE2BF_CACHE_DIR;
  const base = process.env.APPDATA ?? join(homedir(), ".cache");
  return join(base, "poe2-build-finder", "data");
}

async function readManifest(dir: string): Promise<Manifest> {
  try {
    return JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Manifest;
  } catch {
    return {};
  }
}

async function writeManifest(dir: string, manifest: Manifest): Promise<void> {
  const target = join(dir, "manifest.json");
  await writeFile(`${target}.tmp`, JSON.stringify(manifest, null, 2));
  await rename(`${target}.tmp`, target);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureOne(
  key: SourceKey,
  dir: string,
  manifest: Manifest,
  opts: Required<Pick<EnsureOptions, "maxAgeMs" | "force" | "fetchImpl" | "now" | "log">>,
): Promise<EnsureResult> {
  const source = SOURCES[key];
  const path = join(dir, source.file);
  const entry = manifest[key];
  const cached = entry !== undefined && entry.url === source.url && (await fileExists(path));

  if (cached && !opts.force) {
    const age = opts.now().getTime() - new Date(entry.checkedAt).getTime();
    if (age < opts.maxAgeMs) return { key, path, status: "fresh" };
  }

  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (cached && entry.etag) headers["If-None-Match"] = entry.etag;
  if (cached && entry.lastModified) headers["If-Modified-Since"] = entry.lastModified;

  let response: Response;
  try {
    response = await opts.fetchImpl(source.url, { headers });
  } catch (error) {
    if (cached) {
      opts.log(`${source.description}: offline, using cached copy`);
      return { key, path, status: "stale-offline" };
    }
    throw new Error(`Could not download ${source.description} (${source.url}): ${String(error)}`);
  }

  if (response.status === 304 && cached) {
    manifest[key] = { ...entry, checkedAt: opts.now().toISOString() };
    return { key, path, status: "not-modified" };
  }

  if (!response.ok) {
    if (cached) {
      opts.log(`${source.description}: server returned ${response.status}, using cached copy`);
      return { key, path, status: "stale-offline" };
    }
    throw new Error(`Could not download ${source.description}: HTTP ${response.status}`);
  }

  const body = Buffer.from(await response.arrayBuffer());
  // Validate before replacing a good cached copy with a broken download.
  const text = body.toString("utf8");
  if (source.format === "json") JSON.parse(text);
  else parseLuaData(text);
  await writeFile(`${path}.tmp`, body);
  await rename(`${path}.tmp`, path);

  manifest[key] = {
    url: source.url,
    etag: response.headers.get("etag") ?? undefined,
    lastModified: response.headers.get("last-modified") ?? undefined,
    checkedAt: opts.now().toISOString(),
    bytes: body.length,
  };
  opts.log(`${source.description}: downloaded ${(body.length / 1024 / 1024).toFixed(1)} MB`);
  return { key, path, status: "downloaded" };
}

/**
 * Make sure every data source is in the cache, downloading or re-checking as needed.
 * Uses conditional requests, so re-checks of unchanged files cost almost nothing.
 */
export async function ensureData(options: EnsureOptions = {}): Promise<EnsureResult[]> {
  const dir = options.cacheDir ?? defaultCacheDir();
  const opts = {
    maxAgeMs: options.maxAgeMs ?? WEEK_MS,
    force: options.force ?? false,
    fetchImpl: options.fetchImpl ?? ((url, init) => fetch(url, init)),
    now: options.now ?? (() => new Date()),
    log: options.log ?? (() => {}),
  } satisfies Parameters<typeof ensureOne>[3];

  await mkdir(dir, { recursive: true });
  const manifest = await readManifest(dir);
  const results = await Promise.all(SOURCE_KEYS.map((key) => ensureOne(key, dir, manifest, opts)));
  await writeManifest(dir, manifest);
  return results;
}

export async function readCachedManifest(cacheDir: string = defaultCacheDir()): Promise<Manifest> {
  return readManifest(cacheDir);
}
