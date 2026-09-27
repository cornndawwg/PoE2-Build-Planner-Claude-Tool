// Extras on top of the assembled items for a calculation: amulet anoint, helmet instill (via a
// Raven-Touched Shard), socketables, a free-Spirit amulet skill, flasks and charms, and weapon swap.

import type { GameData, PlayerGem } from "../data/gamedata.js";
import { findGem, skillOf } from "../skills/skills.js";
import type { PassiveTree } from "../tree/tree.js";
import { assumeGear, pickBase, type GearRequest } from "./gear.js";

/** An item as sent to Path of Building. */
export interface EngineItem {
  raw?: string;
  unique?: string;
  slot?: string;
  /** Inserted under the base type line (sockets, runes). */
  specLines?: string[];
  /** Added as mods (anoints, instills). */
  extraLines?: string[];
}

export interface ItemExtras {
  /** Notable to anoint on the amulet with Liquid Emotions, e.g. "Potent Incantation". */
  anoint?: string;
  /** Notable to instill on the helmet; needs a Raven-Touched Shard socketed in it (level 60+). */
  helmetInstill?: string;
  /** Runes, soul cores, idols per slot, e.g. { slot: "Body Armour", names: ["Desert Rune", "Desert Rune"] }. */
  socketables?: { slot: string; names: string[] }[];
  /** A skill granted with no Spirit cost by a Lament, Portent or Absent Amulet (replaces the amulet). */
  amuletSkill?: string;
  /** Flasks and charms: uniques by name or item text; slots are worked out from the item. */
  flasks?: { unique?: string; raw?: string; slot?: string }[];
  /** Calculate with flasks active. */
  flasksActive?: boolean;
  /** Weapon swap (weapon set 2). */
  weaponSwap?: {
    /** Item classes to assume for set 2, e.g. ["Bow"] or ["Staff"]. */
    weapons?: string[];
    items?: { unique?: string; raw?: string; slot?: string }[];
    /** Passives that only apply while using weapon set 2 (tree keys). */
    passives?: string[];
    /** Skills used with weapon set 2. */
    skills?: { gem: PlayerGem; supports?: PlayerGem[] }[];
    /** Calculate with weapon set 2 active (its passives apply). */
    active?: boolean;
  };
}

export interface ExtrasResult {
  items: EngineItem[];
  /** Weapon-set passives for Path of Building: { [nodeKey]: 2 }. */
  weaponSets: Record<string, number>;
  swapSkillTexts: string[];
  config: Record<string, unknown>;
  useWeaponSet2: boolean;
  /** Spirit Path of Building reserves for the free amulet skill but shouldn't (added back). */
  spiritRefund: number;
  notes: string[];
}

const FLASK_SLOTS: Record<string, string[]> = {
  LifeFlask: ["Flask 1"],
  ManaFlask: ["Flask 2"],
  UtilityFlask: ["Charm 1", "Charm 2", "Charm 3"],
};

function itemClassOf(data: GameData, item: { unique?: string; raw?: string }): string | undefined {
  if (item.unique) return data.uniques.find((u) => u.name.toLowerCase() === item.unique!.toLowerCase())?.itemClass;
  const byBase = new Map(Object.values(data.baseItems).map((b) => [b.name, b.item_class]));
  return item.raw?.split(/\r?\n/).map((l) => byBase.get(l.trim())).find(Boolean);
}

export function applyItemExtras(
  data: GameData,
  tree: PassiveTree | undefined,
  level: number,
  gemLevel: number,
  items: EngineItem[],
  extras: ItemExtras,
  gear: GearRequest | undefined,
): ExtrasResult {
  const notes: string[] = [];
  const result: ExtrasResult = { items: [...items], weaponSets: {}, swapSkillTexts: [], config: {}, useWeaponSet2: false, spiritRefund: 0, notes };
  const bySlot = (slot: string) => result.items.find((i) => i.slot === slot);

  // Free-Spirit amulet: replaces the amulet, keeping fewer mods (it gives up an affix or two).
  if (extras.amuletSkill) {
    const base = data.skillAmuletBases.find((b) => b.skills.some((s) => s.toLowerCase() === extras.amuletSkill!.toLowerCase()));
    const current = bySlot("Amulet");
    if (!base) {
      notes.push(`No Lament, Portent or Absent Amulet grants ${extras.amuletSkill}.`);
    } else if (current?.unique || (current && !current.raw?.startsWith("Rarity: RARE\nAssumed"))) {
      notes.push(`Kept the chosen amulet; ${extras.amuletSkill} from a ${base.name} would replace it.`);
    } else {
      if (level < base.level) notes.push(`A ${base.name} needs level ${base.level}.`);
      const skillName = base.skills.find((s) => s.toLowerCase() === extras.amuletSkill!.toLowerCase())!;
      const keptMods = (current?.raw?.split("\n").slice(4) ?? []).slice(0, Math.max(0, 3 - base.cost.length));
      const raw = ["Rarity: RARE", "Free Skill Amulet", base.name, `Implicits: ${base.cost.length + 1}`, ...base.cost, `Grants Skill: Level ${gemLevel} ${skillName}`, ...keptMods].join("\n");
      result.items = result.items.filter((i) => i.slot !== "Amulet");
      result.items.push({ raw, slot: "Amulet" });
      try {
        const gem = findGem(data, skillName);
        const cost = skillOf(data, gem)?.static?.reservations?.spirit ?? 0;
        if (cost > 0) {
          result.spiritRefund = cost;
          notes.push(`${skillName} from the ${base.name} costs no Spirit (saves ${cost}); if Path of Building still reserves it, Spirit unreserved is corrected.`);
        }
      } catch {
        // skill not in the gem list; nothing to refund
      }
    }
  }

  // Sockets: runes, soul cores, idols, and the Raven-Touched Shard for a helmet instill.
  const socketsBySlot = new Map<string, string[]>();
  for (const { slot, names } of extras.socketables ?? []) {
    for (const name of names) {
      const socketable = data.socketables.find((s) => s.name.toLowerCase() === name.toLowerCase());
      if (!socketable) {
        notes.push(`Unknown rune or soul core "${name}".`);
        continue;
      }
      if (socketable.levelReq > level) notes.push(`${socketable.name} needs level ${socketable.levelReq}.`);
      socketsBySlot.set(slot, [...(socketsBySlot.get(slot) ?? []), socketable.name]);
    }
  }
  if (extras.helmetInstill) {
    if (level < 60) notes.push("A helmet instill needs a Raven-Touched Shard, which needs level 60.");
    socketsBySlot.set("Helmet", [...(socketsBySlot.get("Helmet") ?? []), "Raven-Touched Shard"]);
  }
  for (const [slot, names] of socketsBySlot) {
    const item = bySlot(slot);
    if (!item) {
      notes.push(`No ${slot} to socket ${names.join(", ")} into.`);
      continue;
    }
    item.specLines = [`Sockets: ${names.map(() => "S").join(" ")}`, ...names.map((n) => `Rune: ${n}`)];
  }

  // Anoint and instill: "Allocates <notable>" on the amulet / helmet.
  const notableExists = (name: string) =>
    tree ? [...tree.nodes.values()].some((n) => n.isNotable && !n.ascendancyId && n.name?.toLowerCase() === name.toLowerCase()) : true;
  for (const [slot, notable] of [["Amulet", extras.anoint], ["Helmet", extras.helmetInstill]] as const) {
    if (!notable) continue;
    if (!notableExists(notable)) {
      notes.push(`"${notable}" isn't a notable passive, so it can't be ${slot === "Amulet" ? "anointed" : "instilled"}.`);
      continue;
    }
    const item = bySlot(slot);
    if (!item) {
      notes.push(`No ${slot} for the ${slot === "Amulet" ? "anoint" : "instill"}.`);
      continue;
    }
    item.extraLines = [...(item.extraLines ?? []), `Allocates ${notable}`];
  }

  // Flasks and charms: chosen ones first, then the best plain life and mana flask for the level.
  const takenFlaskSlots = new Set<string>();
  for (const flask of extras.flasks ?? []) {
    const itemClass = itemClassOf(data, flask);
    const slot = flask.slot ?? (itemClass ? FLASK_SLOTS[itemClass]?.find((s) => !takenFlaskSlots.has(s)) : undefined);
    if (!slot) {
      notes.push(`Couldn't tell which flask or charm slot ${flask.unique ?? "an item"} goes in.`);
      continue;
    }
    takenFlaskSlots.add(slot);
    result.items.push({ ...flask, slot });
  }
  if (gear) {
    for (const [itemClass, slot] of [["LifeFlask", "Flask 1"], ["ManaFlask", "Flask 2"]] as const) {
      if (takenFlaskSlots.has(slot)) continue;
      const base = pickBase(data, itemClass, Math.min(level, 82));
      if (base) result.items.push({ raw: `Rarity: NORMAL\n${base.name}`, slot });
    }
  }
  if (extras.flasksActive) result.config.conditionUsingFlask = true;

  // Weapon swap: set-2 weapons (assumed or chosen), set-2 passives, and set-2 skills.
  const swap = extras.weaponSwap;
  if (swap) {
    const swapItems = (swap.items ?? []).map((item, i) => ({ ...item, slot: item.slot ?? (i === 0 ? "Weapon 1 Swap" : "Weapon 2 Swap") }));
    if (!swapItems.length && swap.weapons?.length && gear) {
      const assumed = assumeGear(data, { ...gear, weapons: swap.weapons });
      for (const a of assumed.filter((x) => x.slot === "Weapon 1" || x.slot === "Weapon 2")) {
        swapItems.push({ raw: a.raw, slot: `${a.slot} Swap` });
      }
    }
    result.items.push(...swapItems);
    for (const key of swap.passives ?? []) result.weaponSets[key] = 2;
    for (const { gem, supports } of swap.skills ?? []) {
      result.swapSkillTexts.push(
        ["Weapon Set: Set 2", `${gem.name} ${gemLevel}/0  1`, ...(supports ?? []).map((s) => `${s.name} 1/0  1`)].join("\n") + "\n",
      );
    }
    result.useWeaponSet2 = swap.active ?? false;
  }
  return result;
}
