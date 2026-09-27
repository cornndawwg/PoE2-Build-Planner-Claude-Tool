// Assumed "budget" gear for a calculation: a realistic base per slot for the character's level and
// defence style, with a few mods at tiers that can roll at that item level (values at the middle
// of each range). It stands in for self-found gear so numbers aren't those of a naked character.

import type { GameData, PlayerGem } from "../data/gamedata.js";
import type { BaseItem } from "../data/types.js";
import { rollableMods } from "../data/mods.js";
import { adviseFor, modFamilies, statPriorities, type DefenceStyle } from "../gear/priorities.js";
import { stripMarkup } from "../text.js";
import { termPattern } from "../tree/scaling.js";

export interface AssumedItem {
  /** Path of Building slot name. */
  slot: string;
  base: string;
  mods: string[];
  raw: string;
}

/** Weapon requirement names (from Path of Building) → RePoE item classes. */
const WEAPON_CLASS: Record<string, string> = {
  Bow: "Bow",
  Crossbow: "Crossbow",
  "One Hand Mace": "One Hand Mace",
  "Two Hand Mace": "Two Hand Mace",
  Spear: "Spear",
  Quarterstaff: "Warstaff",
  Staff: "Staff",
  Wand: "Wand",
  Sceptre: "Sceptre",
  Talisman: "Talisman",
};
const TWO_HANDED = new Set(["Bow", "Crossbow", "Two Hand Mace", "Warstaff", "Staff", "Talisman"]);

/** Armour base tag for a defence style. */
function armourTag(styles: readonly DefenceStyle[]): string | undefined {
  const s = new Set(styles);
  const str = s.has("armour");
  const dex = s.has("evasion");
  const int = s.has("energy shield");
  if (str && dex) return "str_dex_armour";
  if (str && int) return "str_int_armour";
  if (dex && int) return "dex_int_armour";
  if (int) return "int_armour";
  if (dex) return "dex_armour";
  if (str) return "str_armour";
  return undefined;
}

/** The best base of an item class a character can find by this item level. */
export function pickBase(data: GameData, itemClass: string, itemLevel: number, tag?: string): BaseItem | undefined {
  const bases = Object.values(data.baseItems).filter(
    (b) =>
      b.item_class === itemClass &&
      b.release_state === "released" &&
      b.name &&
      !b.tags.includes("not_for_sale") &&
      (b.drop_level ?? 1) <= itemLevel &&
      (!tag || b.tags.includes(tag)),
  );
  return bases.sort((a, b) => (b.drop_level ?? 0) - (a.drop_level ?? 0))[0];
}

/** How good the assumed gear is. */
export type GearTier = "budget" | "mid" | "high";
/** Where in each value range the tier's rolls land (0 = worst, 1 = best), and how many extra mods it gets. */
const TIER = {
  budget: { roll: 0.5, extraOffence: 0, extraResistance: 0 },
  mid: { roll: 0.75, extraOffence: 1, extraResistance: 1 },
  high: { roll: 1, extraOffence: 2, extraResistance: 1 },
} as const;

/** "(45-54)% increased Fire Damage" → "50% increased Fire Damage"; hybrid mods become several lines. */
export function midRoll(text: string): string[] {
  return rollAt(text, 0.5);
}

/** Fill every "(min-max)" range at a point between min (0) and max (1). */
export function rollAt(text: string, fraction: number): string[] {
  return text
    .replace(/\((-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)\)/g, (_, a: string, b: string) => String(Math.round(Number(a) + (Number(b) - Number(a)) * fraction)))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function itemText(name: string, base: string, itemLevel: number, mods: string[]): string {
  return ["Rarity: RARE", name, base, `Item Level: ${itemLevel}`, ...mods].join("\n");
}

/** Socketable jewel base for a main attribute. */
export const JEWEL_FOR_ATTRIBUTE = { str: "Ruby", dex: "Emerald", int: "Sapphire" } as const;

/** The attribute a gem leans on most. */
export function mainAttribute(gem: PlayerGem): "str" | "dex" | "int" {
  const w = gem.gem.requirement_weights;
  if (!w) return "int";
  if (w.strength >= w.dexterity && w.strength >= w.intelligence) return "str";
  return w.dexterity >= w.intelligence ? "dex" : "int";
}

/**
 * A budget rare jewel: two mods matching what the build scales and one defensive mod
 * (life, energy shield or a resistance), from the pool of that jewel type.
 */
export function assumeJewel(
  data: GameData,
  jewelBase: string,
  req: { terms: string[]; avoid?: string[]; defence: DefenceStyle[] },
): AssumedItem | undefined {
  const base = Object.values(data.baseItems).find((b) => b.name === jewelBase && b.item_class === "Jewel");
  if (!base) return undefined;
  const pool = rollableMods(data.mods, base, ["item", "misc"]);
  const avoid = (req.avoid ?? []).map(termPattern);
  const text = (m: (typeof pool)[number]) => stripMarkup(m.text ?? "");
  // Offensive: matches the build's terms, isn't avoided, and isn't a resistance (penetration is fine).
  const isResistance = (t: string) => /resistance/i.test(t) && !/penetrat/i.test(t);
  const offensive = pool
    .map((m) => ({ m, score: req.terms.filter((t) => termPattern(t).test(text(m))).length }))
    .filter(({ m, score }) => score > 0 && !avoid.some((re) => re.test(text(m))) && !isResistance(text(m)))
    .sort((a, b) => b.score - a.score);
  const layerWords = req.defence.includes("energy shield") ? /energy shield/i : /maximum life/i;
  const defensive = pool.find((m) => layerWords.test(text(m))) ?? pool.find((m) => /Resistance/i.test(text(m)) && !/penetrat/i.test(text(m)));
  const chosen = [...offensive.slice(0, 2).map((x) => x.m), ...(defensive ? [defensive] : [])];
  const mods = chosen.flatMap((m) => midRoll(text(m)));
  return { slot: "Jewel", base: base.name, mods, raw: itemText("Assumed Jewel", base.name, 60, mods) };
}

export interface GearRequest {
  /** Character level; items are assumed to drop at about this level (capped at 82). */
  level: number;
  /** Words the build scales (as for stat_priorities). */
  terms: string[];
  avoid?: string[];
  defence: DefenceStyle[];
  /** The main skill, to pick a weapon it can use. */
  mainSkill: PlayerGem;
  /** Item classes to use instead of the default weapon choice, e.g. ["Staff"] or ["Wand", "Focus"]. */
  weapons?: string[];
  /** budget (default): mid rolls, few mods. mid: good rolls, more mods. high: perfect rolls, full mods. */
  tier?: GearTier;
}

export function assumeGear(data: GameData, req: GearRequest): AssumedItem[] {
  const itemLevel = Math.max(1, Math.min(req.level, 82));
  const tier = TIER[req.tier ?? "budget"];
  const roll = (text: string) => rollAt(text, tier.roll);
  const tag = armourTag(req.defence);
  const items: AssumedItem[] = [];
  const priorities = statPriorities(data, {
    terms: req.terms,
    avoid: req.avoid,
    slots: ["Wand", "Staff", "Sceptre", "Bow", "Crossbow", "One Hand Mace", "Two Hand Mace", "Spear", "Quarterstaff", "Talisman", "Focus", "Shield", "Quiver", "Helmet", "Body Armour", "Gloves", "Boots", "Amulet", "Ring", "Belt"],
    perSlot: 3 + tier.extraOffence,
    defence: req.defence,
    itemLevel,
  });
  const offence = (slot: string, n: number) =>
    (priorities.offence.find((s) => s.slot === slot)?.mods ?? []).slice(0, n + tier.extraOffence).flatMap((m) => roll(m.tier));

  // Defence: the build's own layer plus resistances spread across items so all three get covered.
  const elements = ["Lightning", "Cold", "Fire"]; // four armour pieces: lightning, usually hardest to cap, gets two
  let nextElement = 0;
  const resistance = (slotClasses: string[]) => {
    const element = elements[nextElement++ % elements.length]!;
    const family = modFamilies(data, slotClasses).find((f) => termPattern(`${element} Resistance`).test(f.bestTier) && !/all Elemental/i.test(f.bestTier));
    const advice = family && adviseFor(family, itemLevel);
    return advice ? roll(advice.tier) : [];
  };
  const allResistances = (slotClasses: string[]) => {
    const family = modFamilies(data, slotClasses).find((f) => /to all Elemental Resistances/i.test(f.bestTier));
    const advice = family && adviseFor(family, itemLevel);
    return advice ? roll(advice.tier) : resistance(slotClasses);
  };
  const layer = (slot: string) => {
    const mods = priorities.defence.find((s) => s.slot === slot)?.mods ?? [];
    const own = mods.find((m) => !/Resistance/i.test(m.tier));
    return own ? roll(own.tier) : [];
  };

  // Weapons.
  const requirement = req.mainSkill.weaponRequirements[0];
  const weaponClasses = req.weapons?.length
    ? req.weapons.map((w) => WEAPON_CLASS[w] ?? w)
    : requirement
      ? [WEAPON_CLASS[requirement] ?? requirement]
      : ["Wand", "Focus"];
  const [mainClass, offClass] = weaponClasses;
  const mainSlotName = Object.entries(WEAPON_CLASS).find(([, c]) => c === mainClass)?.[0] ?? mainClass!;
  const mainBase = pickBase(data, mainClass!, itemLevel);
  if (mainBase) {
    const mods = offence(mainSlotName === "Quarterstaff" ? "Quarterstaff" : mainSlotName, 3);
    items.push({ slot: "Weapon 1", base: mainBase.name, mods, raw: itemText("Assumed Weapon", mainBase.name, itemLevel, mods) });
  }
  // Two-handers have no off hand, except bows, which take a quiver.
  const off = offClass ?? (mainClass === "Bow" ? "Quiver" : undefined);
  if (off && TWO_HANDED.has(mainClass!) && mainClass !== "Bow") throw new Error(`${mainClass} is two-handed and can't have an off hand`);
  if (off) {
    const offBase = pickBase(data, off, itemLevel, off === "Shield" ? tag : undefined);
    if (offBase) {
      const slotName = off === "Focus" ? "Focus" : off === "Quiver" ? "Quiver" : "Shield";
      const mods = [...offence(slotName, 2), ...layer(slotName)];
      items.push({ slot: "Weapon 2", base: offBase.name, mods, raw: itemText("Assumed Off Hand", offBase.name, itemLevel, mods) });
    }
  }

  // Armour and jewellery.
  const armour: [string, string, number][] = [
    ["Helmet", "Helmet", 0],
    ["Body Armour", "Body Armour", 0],
    ["Gloves", "Gloves", 1],
    ["Boots", "Boots", 0],
  ];
  for (const [slot, itemClass, offenceCount] of armour) {
    const base = pickBase(data, itemClass, itemLevel, tag) ?? pickBase(data, itemClass, itemLevel);
    if (!base) continue;
    const extraResistances = Array.from({ length: tier.extraResistance }, () => resistance([itemClass])).flat();
    const mods = [...layer(slot), ...resistance([itemClass]), ...extraResistances, ...offence(slot, offenceCount)];
    items.push({ slot, base: base.name, mods, raw: itemText(`Assumed ${slot}`, base.name, itemLevel, mods) });
  }
  const jewellery: [string, string, string, number][] = [
    ["Amulet", "Amulet", "Amulet", 2],
    ["Ring 1", "Ring", "Ring", 1],
    ["Ring 2", "Ring", "Ring", 1],
    ["Belt", "Belt", "Belt", 0],
  ];
  for (const [slot, itemClass, prioritySlot, offenceCount] of jewellery) {
    const base = pickBase(data, itemClass, itemLevel);
    if (!base) continue;
    const mods = [...offence(prioritySlot, offenceCount), ...layer(prioritySlot), ...allResistances([itemClass])];
    items.push({ slot, base: base.name, mods, raw: itemText(`Assumed ${slot}`, base.name, itemLevel, mods) });
  }
  return items;
}
