import type { GameData } from "../data/gamedata.js";
import { termPattern } from "../tree/scaling.js";
import { SLOT_CLASSES } from "./priorities.js";

export interface UniqueMatch {
  name: string;
  baseType: string;
  itemClass?: string;
  requiredLevel?: number;
  implicits: string[];
  mods: string[];
  /** Requested terms found in the mod text. */
  matched: string[];
  source?: string;
  /** Drops only from a specific boss — usually rarer and pricier. */
  bossDrop: boolean;
}

export interface UniqueQuery {
  terms: string[];
  avoid?: string[];
  /** Gear slot names from SLOT_CLASSES, e.g. ["Amulet", "Wand"]. */
  slots?: string[];
  /** Only uniques a character of this level can wear. */
  maxRequiredLevel?: number;
  limit?: number;
}

export function findUniques(data: GameData, query: UniqueQuery): UniqueMatch[] {
  const patterns = query.terms.map((t) => [t, termPattern(t)] as const);
  const avoid = (query.avoid ?? []).map(termPattern);
  const classes = query.slots ? new Set(query.slots.flatMap((s) => SLOT_CLASSES[s] ?? [])) : undefined;
  if (query.slots) {
    const unknown = query.slots.filter((s) => !SLOT_CLASSES[s]);
    if (unknown.length) throw new Error(`Unknown slot(s): ${unknown.join(", ")}. Slots: ${Object.keys(SLOT_CLASSES).join(", ")}`);
  }

  const results: UniqueMatch[] = [];
  for (const unique of data.uniques) {
    if (classes && !(unique.itemClass && classes.has(unique.itemClass))) continue;
    if (query.maxRequiredLevel !== undefined && (unique.requiredLevel ?? 0) > query.maxRequiredLevel) continue;
    const text = [...unique.implicits, ...unique.mods].join("\n");
    if (avoid.some((re) => re.test(text))) continue;
    // Text only: PoB tags also mark defensive lines (e.g. "fire" on elemental resistances).
    const matched = patterns.filter(([, re]) => re.test(text)).map(([t]) => t);
    if (matched.length === 0) continue;
    results.push({
      name: unique.name,
      baseType: unique.baseType,
      itemClass: unique.itemClass,
      requiredLevel: unique.requiredLevel,
      implicits: unique.implicits,
      mods: unique.mods,
      matched,
      source: unique.source,
      bossDrop: /drops from/i.test(unique.source ?? ""),
    });
  }
  return results
    .sort((a, b) => b.matched.length - a.matched.length || Number(a.bossDrop) - Number(b.bossDrop) || a.name.localeCompare(b.name))
    .slice(0, query.limit ?? 20);
}
