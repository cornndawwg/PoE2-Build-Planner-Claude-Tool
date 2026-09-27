// Assumed "budget" gear for a calculation: a realistic base per slot for the character's level and
// defence style, with a few mods at tiers that can roll at that item level (values at the middle
// of each range). It stands in for self-found gear so numbers aren't those of a naked character.

import type { GameData, PlayerGem } from "../data/gamedata.js";
import type { BaseItem } from "../data/types.js";
import { adviseFor, modFamilies, statPriorities, type DefenceStyle } from "../gear/priorities.js";
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

/** "(45-54)% increased Fire Damage" → "50% increased Fire Damage"; hybrid mods become several lines. */
export function midRoll(text: string): string[] {
  return text
    .replace(/\((-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)\)/g, (_, a: string, b: string) => String(Math.round((Number(a) + Number(b)) / 2)))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function itemText(name: string, base: string, itemLevel: number, mods: string[]): string {
  return ["Rarity: RARE", name, base, `Item Level: ${itemLevel}`, ...mods].join("\n");
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
}

export function assumeGear(data: GameData, req: GearRequest): AssumedItem[] {
  const itemLevel = Math.max(1, Math.min(req.level, 82));
  const tag = armourTag(req.defence);
  const items: AssumedItem[] = [];
  const priorities = statPriorities(data, {
    terms: req.terms,
    avoid: req.avoid,
    slots: ["Wand", "Staff", "Sceptre", "Bow", "Crossbow", "One Hand Mace", "Two Hand Mace", "Spear", "Quarterstaff", "Talisman", "Focus", "Shield", "Quiver", "Helmet", "Body Armour", "Gloves", "Boots", "Amulet", "Ring", "Belt"],
    perSlot: 3,
    defence: req.defence,
    itemLevel,
  });
  const offence = (slot: string, n: number) =>
    (priorities.offence.find((s) => s.slot === slot)?.mods ?? []).slice(0, n).flatMap((m) => midRoll(m.tier));

  // Defence: the build's own layer plus resistances spread across items so all three get covered.
  const elements = ["Lightning", "Cold", "Fire"]; // four armour pieces: lightning, usually hardest to cap, gets two
  let nextElement = 0;
  const resistance = (slotClasses: string[]) => {
    const element = elements[nextElement++ % elements.length]!;
    const family = modFamilies(data, slotClasses).find((f) => termPattern(`${element} Resistance`).test(f.bestTier) && !/all Elemental/i.test(f.bestTier));
    const advice = family && adviseFor(family, itemLevel);
    return advice ? midRoll(advice.tier) : [];
  };
  const allResistances = (slotClasses: string[]) => {
    const family = modFamilies(data, slotClasses).find((f) => /to all Elemental Resistances/i.test(f.bestTier));
    const advice = family && adviseFor(family, itemLevel);
    return advice ? midRoll(advice.tier) : resistance(slotClasses);
  };
  const layer = (slot: string) => {
    const mods = priorities.defence.find((s) => s.slot === slot)?.mods ?? [];
    const own = mods.find((m) => !/Resistance/i.test(m.tier));
    return own ? midRoll(own.tier) : [];
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
    const mods = [...layer(slot), ...resistance([itemClass]), ...offence(slot, offenceCount)];
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
