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
  Flask: ["LifeFlask", "ManaFlask"],
  Charm: ["UtilityFlask"],
};

export const ARMOUR_AND_JEWELLERY = ["Helmet", "Body Armour", "Gloves", "Boots", "Amulet", "Ring", "Belt"];

/** Terms for the defensive baseline every build needs; reported separately from offence. */
export const DEFENCE_TERMS = ["maximum life", "maximum energy shield", "resistance", "armour", "evasion"];

/** Defence layers a build can lean on. Resistances are always included. */
export const DEFENCE_STYLES = ["life", "energy shield", "evasion", "armour"] as const;
export type DefenceStyle = (typeof DEFENCE_STYLES)[number];

const STYLE_PATTERNS: Record<DefenceStyle, RegExp> = {
  life: /\bmaximum life\b/i,
  "energy shield": /\benergy shield\b/i,
  evasion: /\bevasion\b/i,
  armour: /\barmour\b/i,
};
const RESISTANCE = /\bresistances?\b/i;
/** Mentions defence words but isn't a general defence mod for this slot. */
const NOT_BASELINE = /penetrat|\bbreak\b|equipped shield/i;

export interface ModFamily {
  /** RePoE mod type: every tier of the same mod shares it. */
  family: string;
  side: "prefix" | "suffix";
  /** Text of the best tier, with its value range. */
  bestTier: string;
  /** Item level the best tier needs. */
  bestTierLevel: number;
  tiers: number;
  /** Every tier, best (highest item level) first. */
  tierList: { text: string; level: number }[];
  /** Requested terms the mod text matches. */
  matched: string[];
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
    const tierList = tiers
      .map((t) => ({ text: stripMarkup(t.text ?? t.type), level: t.required_level }))
      .sort((a, b) => b.level - a.level);
    const best = tierList[0]!;
    return {
      family: tiers[0]!.type,
      side: tiers[0]!.generation_type as "prefix" | "suffix",
      bestTier: best.text,
      bestTierLevel: best.level,
      tiers: tiers.length,
      tierList,
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
 * Defence mods for the chosen styles: resistances always, plus the chosen layers, leaving out
 * mods tied to layers the build doesn't use (e.g. evasion hybrids for an energy shield build).
 */
function defenceMods(families: ModFamily[], styles: readonly DefenceStyle[]): ModFamily[] {
  const unused = DEFENCE_STYLES.filter((s) => s !== "life" && !styles.includes(s));
  return families
    .filter((f) => !NOT_BASELINE.test(f.bestTier))
    .map((f) => ({
      ...f,
      matched: [
        ...(RESISTANCE.test(f.bestTier) ? ["resistance"] : []),
        ...styles.filter((s) => STYLE_PATTERNS[s].test(f.bestTier)),
      ],
    }))
    .filter((f) => f.matched.length > 0 && !unused.some((s) => STYLE_PATTERNS[s].test(f.bestTier)))
    .sort((a, b) => b.matched.length - a.matched.length || b.bestTierLevel - a.bestTierLevel);
}

/** Alternate the build's own defence layer with resistances so neither crowds out the other. */
function interleaveDefence(mods: ModFamily[]): ModFamily[] {
  const layer = mods.filter((m) => m.matched.some((t) => t !== "resistance"));
  const resist = mods.filter((m) => !layer.includes(m));
  const out: ModFamily[] = [];
  for (let i = 0; i < Math.max(layer.length, resist.length); i++) {
    if (layer[i]) out.push(layer[i]!);
    if (resist[i]) out.push(resist[i]!);
  }
  return out;
}

export interface ModAdvice {
  side: "prefix" | "suffix";
  /** Best tier that can roll at the requested item level (or the overall best if none was given). */
  tier: string;
  tierItemLevel: number;
  /** The end-game best tier, when it's better than `tier`. */
  bestTier?: string;
  bestTierItemLevel?: number;
}

/** Pick the best tier available at an item level; undefined if none of its tiers can roll yet. */
export function adviseFor(family: ModFamily, itemLevel?: number): ModAdvice | undefined {
  const tier = itemLevel === undefined ? family.tierList[0] : family.tierList.find((t) => t.level <= itemLevel);
  if (!tier) return undefined;
  const advice: ModAdvice = { side: family.side, tier: tier.text, tierItemLevel: tier.level };
  if (tier.level < family.bestTierLevel) {
    advice.bestTier = family.bestTier;
    advice.bestTierItemLevel = family.bestTierLevel;
  }
  return advice;
}

export interface SlotAdvice {
  slot: string;
  mods: ModAdvice[];
}

/**
 * For each slot, the mod families that match what the build scales, best first, and a defence
 * baseline for the build's defence style. With an item level, each mod shows the best tier
 * that can roll at that level (mods with no tier yet are left out).
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
    /** Defence layers the build uses. Default: all of them. */
    defence?: DefenceStyle[];
    /** Item level to plan for (roughly the area level; during the campaign, about the character level). */
    itemLevel?: number;
  },
): { offence: SlotAdvice[]; defence: SlotAdvice[] } {
  const slots = query.slots ?? [...ARMOUR_AND_JEWELLERY, "Jewel"];
  const perSlot = query.perSlot ?? 6;
  const styles = query.defence?.length ? query.defence : DEFENCE_STYLES;
  const advise = (list: ModFamily[], limit: number) =>
    list.flatMap((f) => adviseFor(f, query.itemLevel) ?? []).slice(0, limit);

  const offence: SlotAdvice[] = [];
  const defence: SlotAdvice[] = [];
  for (const slot of slots) {
    const classes = SLOT_CLASSES[slot];
    if (!classes) throw new Error(`Unknown slot: ${slot}. Slots: ${Object.keys(SLOT_CLASSES).join(", ")}`);
    const families = modFamilies(data, classes);
    const offensive = matching(families, query.terms, query.avoid).filter((f) => !isDefence(f));
    offence.push({ slot, mods: advise(offensive, perSlot) });
    defence.push({ slot, mods: advise(interleaveDefence(defenceMods(families, styles)), 4) });
  }
  return { offence, defence };
}
