// Extra Path of Building data: amulet bases that grant skills without Spirit, socketables
// (runes, soul cores, idols, shards), and the trade site's stat ids.

import { stripMarkup } from "../text.js";
import type { LuaValue } from "./lua.js";

export interface SkillAmuletBase {
  name: string;
  level: number;
  /** e.g. "-1 Prefix Modifier allowed" — the price of the free skill. */
  cost: string[];
  /** Skills this base can grant (one per amulet, random). */
  skills: string[];
}

/**
 * Amulet bases whose granted skill has no reservation (PoB's grantedSkillsHaveNoReservation),
 * read from src/Data/Bases/amulet.lua.
 */
export function parseSkillAmuletBases(text: string): SkillAmuletBase[] {
  const result: SkillAmuletBase[] = [];
  for (const block of text.split(/\nitemBases\[/).slice(1)) {
    if (!/grantedSkillsHaveNoReservation\s*=\s*true/.test(block)) continue;
    const name = /^"([^"]+)"/.exec(block)?.[1];
    const variants = /variantList\s*=\s*\{([^}]*)\}/.exec(block)?.[1];
    const implicit = /implicit\s*=\s*"([^"]*)"/.exec(block)?.[1] ?? "";
    const level = Number(/req\s*=\s*\{\s*level\s*=\s*(\d+)/.exec(block)?.[1] ?? 1);
    if (!name || !variants) continue;
    result.push({
      name,
      level,
      cost: implicit.split("\\n").filter((l) => /Modifier allowed/.test(l)),
      skills: [...variants.matchAll(/"([^"]+)"/g)].map((m) => m[1]!),
    });
  }
  return result;
}

export interface Socketable {
  name: string;
  /** Rune, SoulCore, Idol, CongealedMist… */
  type: string;
  levelReq: number;
  /** Mods by the item kind it's socketed in ("helmet", "body armour", "weapon", "caster", …). */
  mods: Record<string, string[]>;
  canSocketInUniques: boolean;
}

export function parseSocketables(value: LuaValue): Socketable[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const result: Socketable[] = [];
  for (const [name, bySlot] of Object.entries(value)) {
    if (!bySlot || typeof bySlot !== "object" || Array.isArray(bySlot)) continue;
    let type = "";
    let levelReq = 0;
    let canSocketInUniques = false;
    const mods: Record<string, string[]> = {};
    for (const [slot, entry] of Object.entries(bySlot)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const e = entry as Record<string, LuaValue>;
      type = typeof e.type === "string" ? e.type : type;
      levelReq = typeof e.levelReq === "number" ? e.levelReq : levelReq;
      canSocketInUniques ||= e.canSocketInUniqueItems === true;
      // Positional entries are the mod lines.
      mods[slot] = Object.entries(e)
        .filter(([k, v]) => /^\d+$/.test(k) && typeof v === "string")
        .map(([, v]) => stripMarkup(v as string));
    }
    result.push({ name, type, levelReq, mods, canSocketInUniques });
  }
  return result;
}

/**
 * Mod text with numbers replaced by "#", lower-cased: the key the trade site's stat list uses.
 * The trade site drops the leading "+" ("+23% to Fire Resistance" → "#% to fire resistance").
 */
export const tradeTemplate = (text: string) =>
  stripMarkup(text)
    .replace(/[+-]?\(-?\d+(?:\.\d+)?-(-?\d+(?:\.\d+)?)\)/g, "#")
    .replace(/[+-]?\d+(?:\.\d+)?/g, "#")
    .trim()
    .toLowerCase();

/** Trade site stat ids by mod template, e.g. "#% increased spell damage" → "explicit.stat_2974417149". */
export function parseTradeStats(value: LuaValue): Map<string, string> {
  const result = new Map<string, string>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const group of Object.values(value)) {
    if (!group || typeof group !== "object" || Array.isArray(group)) continue;
    for (const entry of Object.values(group)) {
      const trade = (entry as Record<string, LuaValue>)?.tradeMod as Record<string, LuaValue> | undefined;
      if (!trade || typeof trade.id !== "string" || typeof trade.text !== "string") continue;
      const key = trade.text.toLowerCase();
      // Prefer explicit stats (what rares roll) over implicit/rune ones.
      if (!result.has(key) || trade.type === "explicit") result.set(key, trade.id);
    }
  }
  return result;
}
