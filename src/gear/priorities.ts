import type { GameData } from "../data/gamedata.js";
import { rollableMods } from "../data/mods.js";
import type { Mod } from "../data/types.js";
import { stripMarkup } from "../text.js";
import { termPattern } from "../tree/scaling.js";

/** Gear slots and the item classes that can go in them. */
export const SLOT_CLASSES: Record<string, string[]> = {
  Helmet: ["Helmet"],
  "Body Armour": ["Body Armour"],
  Gloves: ["Gloves"],
  Boots: ["Boots"],
  Amulet: ["Amulet"],
  Ring: ["Ring"],
  Belt: ["Belt"],
  Shield: ["Shield", "Buckler"],
  Focus: ["Focus"],
  Quiver: ["Quiver"],
  Wand: ["Wand"],
  Staff: ["Staff"],
  Sceptre: ["Sceptre"],
  Bow: ["Bow"],
  Crossbow: ["Crossbow"],
  "One Hand Mace": ["One Hand Mace"],
  "Two Hand Mace": ["Two Hand Mace"],
  Spear: ["Spear"],
  Quarterstaff: ["Warstaff"],
  Talisman: ["Talisman"],
  Jewel: ["Jewel"],
};

export const ARMOUR_AND_JEWELLERY = ["Helmet", "Body Armour", "Gloves", "Boots", "Amulet", "Ring", "Belt"];

/** Terms for the defensive baseline every build needs; reported separately from offence. */
export const DEFENCE_TERMS = ["maximum life", "maximum energy shield", "resistance", "armour", "evasion"];

export interface ModFamily {
  /** RePoE mod type: every tier of the same mod shares it. */
  family: string;
  side: "prefix" | "suffix";
  /** Text of the best tier, with its value range. */
  bestTier: string;
  /** Item level the best tier needs. */
  bestTierLevel: number;
  tiers: number;
  /** Requested terms the mod text matches. */
  matched: string[];
}

export interface SlotPriorities {
  slot: string;
  mods: ModFamily[];
}

const JEWEL_SOCKETABLE = ["Ruby", "Emerald", "Sapphire"];

/** Damage types: a mod naming only damage types the build doesn't use is dropped. */
const DAMAGE_TYPES = ["fire", "cold", "lightning", "chaos", "physical"];

const familyCache = new WeakMap<GameData, Map<string, ModFamily[]>>();

/** Every random mod family that can roll on any released base in these item classes. */
export function modFamilies(data: GameData, itemClasses: string[]): ModFamily[] {
  const cacheKey = itemClasses.join("|");
  const cache = familyCache.get(data) ?? new Map<string, ModFamily[]>();
  familyCache.set(data, cache);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const allBases = Object.values(data.baseItems).filter(
    (b) =>
      itemClasses.includes(b.item_class) &&
      b.release_state === "released" &&
      // Only the three socketable jewel types; the rest are special or unique-only.
      (b.item_class !== "Jewel" || JEWEL_SOCKETABLE.includes(b.name)),
  );
  // Many bases share a tag set; the mod pool only depends on the tags.
  const bases = [...new Map(allBases.map((b) => [[...b.tags].sort().join(","), b])).values()];
  const byFamily = new Map<string, Mod[]>();
  const seen = new Set<Mod>();
  for (const base of bases) {
    for (const mod of rollableMods(data.mods, base)) {
      if (seen.has(mod)) continue;
      seen.add(mod);
      const key = `${mod.generation_type}:${mod.type}`;
      byFamily.set(key, [...(byFamily.get(key) ?? []), mod]);
    }
  }
  const families = [...byFamily.values()].map((tiers) => {
    const best = tiers.reduce((a, b) => (b.required_level > a.required_level ? b : a));
    return {
      family: best.type,
      side: best.generation_type as "prefix" | "suffix",
      bestTier: stripMarkup(best.text ?? best.type),
      bestTierLevel: best.required_level,
      tiers: tiers.length,
      matched: [],
    };
  });
  cache.set(cacheKey, families);
  return families;
}

const DEFENCE_PATTERNS = DEFENCE_TERMS.map(termPattern);

function matching(families: ModFamily[], terms: string[], avoid: string[] = []): ModFamily[] {
  const patterns = terms.map((t) => [t, termPattern(t)] as const);
  const avoidPatterns = avoid.map(termPattern);
  const wantedDamage = DAMAGE_TYPES.filter((d) => terms.some((t) => termPattern(d).test(t)));
  return families
    .map((f) => ({ ...f, matched: patterns.filter(([, re]) => re.test(f.bestTier)).map(([t]) => t) }))
    .filter((f) => {
      if (f.matched.length === 0) return false;
      if (avoidPatterns.some((re) => re.test(f.bestTier))) return false;
      const named = DAMAGE_TYPES.filter((d) => termPattern(d).test(f.bestTier));
      return named.length === 0 || named.some((d) => wantedDamage.includes(d));
    })
    .sort((a, b) => b.matched.length - a.matched.length || b.bestTierLevel - a.bestTierLevel);
}

// "Penetrates Fire Resistance" mentions resistance but is offence.
const isDefence = (f: ModFamily) => !/penetrat/i.test(f.bestTier) && DEFENCE_PATTERNS.some((re) => re.test(f.bestTier));

/**
 * For each slot, the mod families that match what the build scales, best first.
 * Terms are plain words from mod text, e.g. ["fire", "spell", "cast speed", "critical"].
 */
export function statPriorities(
  data: GameData,
  query: {
    terms: string[];
    /** Words that rule a mod out, e.g. ["attack"] for a caster. */
    avoid?: string[];
    slots?: string[];
    perSlot?: number;
  },
): { offence: SlotPriorities[]; defence: SlotPriorities[] } {
  const slots = query.slots ?? [...ARMOUR_AND_JEWELLERY, "Jewel"];
  const perSlot = query.perSlot ?? 6;
  const offence: SlotPriorities[] = [];
  const defence: SlotPriorities[] = [];
  for (const slot of slots) {
    const classes = SLOT_CLASSES[slot];
    if (!classes) throw new Error(`Unknown slot: ${slot}`);
    const families = modFamilies(data, classes);
    const offensive = matching(families, query.terms, query.avoid).filter((f) => !isDefence(f));
    offence.push({ slot, mods: offensive.slice(0, perSlot) });
    defence.push({ slot, mods: matching(families, DEFENCE_TERMS).slice(0, 3) });
  }
  return { offence, defence };
}
