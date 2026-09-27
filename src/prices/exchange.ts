// Prices for stackable items (currency, runes, soul cores, Liquid Emotions, omens…) from GGG's
// public Currency Exchange data: https://web.poecdn.com/api/currency-exchange/poe2/{hour}.
// Hourly digests; the current hour is never available. Values are in Exalted Orbs, estimated from
// the volumes actually traded in each pair.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultCacheDir, type FetchLike } from "../data/cache.js";

const BASE = "https://web.poecdn.com/api/currency-exchange/poe2";
const USER_AGENT = "poe2-build-planner-claude-tool (+https://github.com/cornndawwg/PoE2-Build-Planner-Claude-Tool)";
export const EXALTED = "Metadata/Items/Currency/CurrencyAddModToRare";
const HUBS = ["Metadata/Items/Currency/CurrencyModValues", "Metadata/Items/Currency/CurrencyRerollRare"]; // Divine, Chaos

interface Market {
  league: string;
  market_pair: [string, string];
  volume_traded: Record<string, number>;
}

export interface PriceTable {
  league: string;
  /** Unix time of the hour the data covers. */
  hour: number;
  fetchedAt: string;
  /** Exalted Orb value by item metadata id. */
  exalted: Record<string, number>;
  /** Units traded in the hour (how reliable the price is). */
  volume: Record<string, number>;
  leagues: string[];
}

const HOUR = 3600;

/** The main trade league: the busiest one that isn't Standard, Hardcore or a private league. */
export function mainLeague(markets: Market[]): string | undefined {
  const counts = new Map<string, number>();
  for (const m of markets) counts.set(m.league, (counts.get(m.league) ?? 0) + 1);
  return [...counts]
    .filter(([name]) => !/^(Standard|Hardcore)$|^HC |\(PL\d+\)/i.test(name))
    .sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** Turn one hour of markets into Exalted values, directly or through Divine/Chaos. */
export function buildPrices(markets: Market[], league: string): Pick<PriceTable, "exalted" | "volume"> {
  // rate[a][b] = how many b one a is worth, from traded volumes; weight = volume of b traded.
  const rate = new Map<string, Map<string, { rate: number; weight: number }>>();
  const volume: Record<string, number> = {};
  for (const m of markets) {
    if (m.league !== league) continue;
    const [a, b] = m.market_pair;
    const va = m.volume_traded[a] ?? 0;
    const vb = m.volume_traded[b] ?? 0;
    if (va <= 0 || vb <= 0) continue;
    volume[a] = (volume[a] ?? 0) + va;
    volume[b] = (volume[b] ?? 0) + vb;
    for (const [from, to, vf, vt] of [[a, b, va, vb], [b, a, vb, va]] as const) {
      const edges = rate.get(from) ?? new Map();
      const existing = edges.get(to);
      if (!existing || vt > existing.weight) edges.set(to, { rate: vt / vf, weight: vt });
      rate.set(from, edges);
    }
  }
  const exalted: Record<string, number> = { [EXALTED]: 1 };
  const hubValue = new Map<string, number>();
  for (const hub of HUBS) {
    const direct = rate.get(hub)?.get(EXALTED);
    if (direct) hubValue.set(hub, direct.rate);
  }
  for (const [id, edges] of rate) {
    if (id === EXALTED) continue;
    const direct = edges.get(EXALTED);
    if (direct) {
      exalted[id] = direct.rate;
      continue;
    }
    // Through a hub: pick the one with the most traded volume.
    let best: { value: number; weight: number } | undefined;
    for (const [hub, value] of hubValue) {
      const edge = edges.get(hub);
      if (edge && (!best || edge.weight > best.weight)) best = { value: edge.rate * value, weight: edge.weight };
    }
    if (best) exalted[id] = best.value;
  }
  return { exalted, volume };
}

async function fetchHour(fetchImpl: FetchLike, hour: number): Promise<Market[]> {
  const response = await fetchImpl(`${BASE}/${hour}`, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`Currency Exchange returned HTTP ${response.status}`);
  const body = (await response.json()) as { markets?: Market[] };
  return body.markets ?? [];
}

/**
 * Prices for a league (default: the main trade league), cached for an hour. Walks back a few hours
 * if the latest digest is empty.
 */
export async function getPrices(options: { league?: string; cacheDir?: string; fetchImpl?: FetchLike; now?: () => Date } = {}): Promise<PriceTable> {
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = (options.now ?? (() => new Date()))();
  const cacheFile = join(cacheDir, `prices-${(options.league ?? "main").replace(/[^\w-]+/g, "_")}.json`);
  try {
    const cached = JSON.parse(await readFile(cacheFile, "utf8")) as PriceTable;
    if (now.getTime() - new Date(cached.fetchedAt).getTime() < HOUR * 1000) return cached;
  } catch {
    // no usable cache
  }

  const latest = Math.floor(now.getTime() / 1000 / HOUR) * HOUR - HOUR;
  for (let back = 0; back < 4; back++) {
    const hour = latest - back * HOUR;
    const markets = await fetchHour(fetchImpl, hour);
    const league = options.league ?? mainLeague(markets);
    if (!league || !markets.some((m) => m.league === league)) continue;
    const leagues = [...new Set(markets.map((m) => m.league))];
    const table: PriceTable = { league, hour, fetchedAt: now.toISOString(), leagues, ...buildPrices(markets, league) };
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cacheFile, JSON.stringify(table));
    return table;
  }
  throw new Error(`No Currency Exchange data found${options.league ? ` for ${options.league}` : ""} in the last few hours.`);
}

/** A friendly price: "12.5 ex", "0.3 ex", or "3 div" for big values. */
export function formatPrice(exalted: number | undefined, divineInExalted?: number): string | undefined {
  if (exalted === undefined) return undefined;
  if (divineInExalted && exalted >= divineInExalted) return `${(exalted / divineInExalted).toFixed(exalted / divineInExalted >= 10 ? 0 : 1)} div`;
  return `${exalted >= 10 ? Math.round(exalted) : exalted >= 1 ? exalted.toFixed(1) : exalted.toFixed(2)} ex`;
}

export const DIVINE = HUBS[0]!;
