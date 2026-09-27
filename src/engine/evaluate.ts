// Real numbers for a planned build at a character level, from Path of Building, with assumed
// budget gear and the campaign's quest rewards and resistance penalty for that level.

import type { GameData, PlayableClass, PlayerGem } from "../data/gamedata.js";
import type { DefenceStyle } from "../gear/priorities.js";
import { gemLevelForCharacter } from "../skills/levels.js";
import { completePassives } from "../tree/complete.js";
import type { PassiveTree } from "../tree/tree.js";
import { assumeGear, assumeJewel, JEWEL_FOR_ATTRIBUTE, mainAttribute, type AssumedItem, type GearTier } from "./gear.js";
import { applyItemExtras, type ItemExtras } from "./itemExtras.js";
import type { PobEngine } from "./pob.js";
import { verdict, type Verdict } from "./verdict.js";

/** A specific item: a unique by name, or pasted item text. Replaces the assumed item in its slot. */
export interface ItemChoice {
  unique?: string;
  raw?: string;
  /** Path of Building slot ("Weapon 1", "Weapon 2", "Helmet", "Body Armour", "Gloves", "Boots", "Amulet", "Ring 1", "Ring 2", "Belt"). */
  slot?: string;
}

export interface EvaluateInput {
  cls: PlayableClass;
  ascendancyName?: string;
  ascendancyId?: string;
  level: number;
  /** Main-tree and ascendancy passives (tree keys). Missing connecting passives are added. */
  passives: string[];
  skills: { gem: PlayerGem; supports?: PlayerGem[] }[];
  /** 0-based index of the main damage skill in `skills`. */
  mainSkill?: number;
  gear:
    | { kind: "none" }
    | { kind: "budget"; terms: string[]; avoid?: string[]; defence: DefenceStyle[]; weapons?: string[]; tier?: GearTier };
  /** Specific items (uniques or pasted text); they replace the assumed item in their slot. */
  items?: ItemChoice[];
  /** Gem quality to assume (default: 0 in the campaign, 20 at level 65+). */
  quality?: number;
  /** Needed to fill in missing connecting passives and spend "+5 to any Attribute" nodes. */
  tree?: PassiveTree;
  /** Anoint, helmet instill, socketables, free-Spirit amulet skill, flasks, weapon swap. */
  extras?: ItemExtras;
}

interface PobResult {
  stats: Record<string, number>;
  enemyBaseLife: number;
  enemyLevel: number;
  className: string;
  ascendancy: string;
  allocatedPassives: number;
  skills: { label?: string; gems: { name: string; level: number; found: boolean }[] }[];
  notes: string[];
}

/** Campaign resistance penalty by character level, using Path of Building's per-act values. */
export function resistancePenalty(level: number): number {
  if (level <= 15) return 0; // Act 1
  if (level <= 30) return -10; // Act 2
  if (level <= 44) return -20; // Act 3
  if (level <= 52) return -30; // Act 4
  if (level <= 64) return -40; // Interludes (approximate)
  return -60; // maps
}

/** Area level of the content a character of this level is doing (maps top out around 82-83). */
export const areaLevelFor = (level: number) => Math.min(level, 83);

const round = (n: number | undefined) => (n === undefined ? undefined : Math.round(n));

export interface Scenario {
  enemy: "normal monsters" | "a boss" | "a pinnacle boss";
  /** Total damage per second, hits plus damage over time (or minions, if they deal more). */
  dps: number;
  /** Where the damage comes from. */
  breakdown: { hits?: number; ignite?: number; poison?: number; bleed?: number; otherDamageOverTime?: number; minions?: number };
  averageHit?: number;
  /** Seconds to kill, using PoB's normal-monster life for the area level and rough rarity multipliers. */
  secondsToKill: { normal?: number; rare?: number; boss?: number };
}

export interface Evaluation {
  level: number;
  areaLevel: number;
  gemLevel: number;
  clear: Scenario;
  boss: Scenario;
  defence: {
    life?: number;
    energyShield?: number;
    effectiveHp?: number;
    resistances: { fire?: number; cold?: number; lightning?: number; chaos?: number };
    missingResistance: { fire?: number; cold?: number; lightning?: number };
    armour?: number;
    evasion?: number;
    blockChance?: number;
  };
  survival: {
    /** Average hits from normal monsters at this area level you can take (Path of Building). */
    hitsFromNormal?: number;
    /** Average hits from a boss you can take. */
    hitsFromBoss?: number;
    /** Biggest single hit you survive (the second-weakest damage type). */
    maxHit?: number;
  };
  /** Campaign levels get one verdict; level 65+ gets early maps, T15 and juiced T16. */
  verdicts: Verdict[];
  resources: { mana?: number; manaUnreserved?: number; spirit?: number; spiritUnreserved?: number };
  attributes: {
    str?: number;
    dex?: number;
    int?: number;
    /** From Path of Building: gems, weapon and armour, after Giant's Blood and similar. */
    required: { str?: number; dex?: number; int?: number };
    /** How the "+5 to any Attribute" passives were spent. */
    flexibleNodes: { str: number; dex: number; int: number };
  };
  passives: { allocated: number; addedToConnect: string[]; unreachable: string[] };
  /** Skill groups Path of Building calculated (including skills granted by items). */
  skillGroups: string[];
  assumedGear: { slot: string; base: string; mods: string[] }[];
  itemsUsed: string[];
  notes: string[];
}

/** Rough life multipliers by monster rarity (not in the game data; a labelled heuristic). */
export const RARITY_LIFE = { normal: 1, rare: 5, boss: 25 } as const;

const CLASS_TO_SLOT: Record<string, string[]> = {
  Helmet: ["Helmet"],
  "Body Armour": ["Body Armour"],
  Gloves: ["Gloves"],
  Boots: ["Boots"],
  Amulet: ["Amulet"],
  Ring: ["Ring 1", "Ring 2"],
  Belt: ["Belt"],
  Focus: ["Weapon 2"],
  Shield: ["Weapon 2"],
  Buckler: ["Weapon 2"],
  Quiver: ["Weapon 2"],
};

/** The Path of Building slot a chosen item goes in. */
function slotFor(data: GameData, item: ItemChoice, taken: Set<string>): string | undefined {
  if (item.slot) return item.slot;
  let itemClass: string | undefined;
  if (item.unique) itemClass = data.uniques.find((u) => u.name.toLowerCase() === item.unique!.toLowerCase())?.itemClass;
  if (!itemClass && item.raw) {
    const lines = item.raw.split(/\r?\n/).map((l) => l.trim());
    const classLine = lines.find((l) => l.startsWith("Item Class:"));
    if (classLine) itemClass = classLine.replace("Item Class:", "").trim().replace(/s$/, "");
    const byBase = new Map(Object.values(data.baseItems).map((b) => [b.name, b.item_class]));
    itemClass ??= lines.map((l) => byBase.get(l)).find(Boolean);
  }
  if (!itemClass) return undefined;
  if (itemClass === "Jewel") return "Jewel"; // placed in an allocated socket later
  const options = CLASS_TO_SLOT[itemClass] ?? ["Weapon 1"];
  return options.find((s) => !taken.has(s)) ?? options[0];
}

export async function evaluateBuild(engine: PobEngine, data: GameData, input: EvaluateInput): Promise<Evaluation> {
  const level = input.level;
  const gemLevel = gemLevelForCharacter(level);
  const quality = input.quality ?? (level >= 65 ? 20 : 0);
  const areaLevel = areaLevelFor(level);
  const mainIndex = input.mainSkill ?? 0;
  const main = input.skills[mainIndex]?.gem;
  if (!main) throw new Error("The build needs at least one skill to calculate.");
  const notes: string[] = [];

  // A connected tree: add missing connecting passives rather than evaluating floating nodes.
  let passives = input.passives;
  let addedToConnect: string[] = [];
  let unreachable: string[] = [];
  if (input.tree) {
    const swapPassives = input.extras?.weaponSwap?.passives ?? [];
    const completed = completePassives(input.tree, input.cls.startNode, [...input.passives, ...swapPassives], input.ascendancyId);
    passives = [...completed.main, ...completed.ascendancy];
    addedToConnect = completed.added;
    unreachable = completed.unreachable;
    if (addedToConnect.length) notes.push(`Added ${addedToConnect.length} connecting passives so the tree is reachable.`);
    if (unreachable.length) notes.push(`Left out passives this character can't reach: ${unreachable.join(", ")}.`);
  }

  // Gear: assumed budget rares, with chosen items replacing their slots.
  const gearRequest =
    input.gear.kind === "budget"
      ? { level, terms: input.gear.terms, avoid: input.gear.avoid, defence: input.gear.defence, mainSkill: main, weapons: input.gear.weapons, tier: input.gear.tier }
      : undefined;
  let assumed: AssumedItem[] = [];
  if (input.gear.kind === "budget") {
    assumed = assumeGear(data, gearRequest!);
  }
  // Jewel sockets the tree actually takes; jewels go in these, in order.
  const sockets = input.tree ? passives.filter((k) => input.tree!.nodes.get(k)?.isJewelSocket) : [];
  const freeSockets = [...sockets];
  const chosen: { raw?: string; unique?: string; slot?: string }[] = [];
  const takenSlots = new Set<string>();
  const itemsUsed: string[] = [];
  for (const item of input.items ?? []) {
    let slot = slotFor(data, item, takenSlots);
    if (!slot) {
      notes.push(`Couldn't tell which slot ${item.unique ?? "an item"} goes in${item.unique ? "" : "; give its slot"}.`);
      continue;
    }
    if (slot === "Jewel") {
      const socket = freeSockets.shift();
      if (!socket) {
        notes.push(`No free jewel socket for ${item.unique ?? "a jewel"}: take a jewel socket passive on the tree.`);
        continue;
      }
      slot = `Jewel ${socket}`;
    }
    takenSlots.add(slot);
    chosen.push({ ...item, slot });
    itemsUsed.push(`${item.unique ?? item.raw?.split(/\r?\n/)[1] ?? "item"} (${slot.startsWith("Jewel ") ? "jewel socket" : slot})`);
  }
  const remainingAssumed = assumed.filter((a) => !takenSlots.has(a.slot));
  // Budget jewels for sockets nothing was chosen for.
  if (input.gear.kind === "budget") {
    const jewelBase = JEWEL_FOR_ATTRIBUTE[mainAttribute(main)];
    for (const socket of freeSockets) {
      const jewel = assumeJewel(data, jewelBase, input.gear);
      if (jewel) remainingAssumed.push({ ...jewel, slot: `Jewel ${socket}` });
    }
  }
  const baseItems = [...remainingAssumed.map((a) => ({ raw: a.raw, slot: a.slot })), ...chosen];
  const extrasResult = applyItemExtras(data, input.tree, level, gemLevel, baseItems, input.extras ?? {}, gearRequest);
  const items = extrasResult.items;
  // Items the extras added: flasks, the free-Spirit amulet, weapon swap.
  for (const item of items.filter((i) => !baseItems.includes(i))) {
    itemsUsed.push(`${item.unique ?? item.raw?.split(/\r?\n/).slice(1).find((l) => !/^Assumed /.test(l)) ?? "item"} (${item.slot})`);
  }
  notes.push(...extrasResult.notes);

  const skillTexts = input.skills.map(({ gem, supports }) =>
    [`${gem.name} ${gemLevel}/${quality}  1`, ...(supports ?? []).map((s) => `${s.name} 1/0  1`)].join("\n") + "\n",
  );
  const params = (enemyIsBoss: string, attributes: Record<string, number>) => ({
    className: input.ascendancyName ?? input.cls.name,
    level,
    passives,
    attributes,
    weaponSets: extrasResult.weaponSets,
    useWeaponSet2: extrasResult.useWeaponSet2,
    skills: [...skillTexts, ...extrasResult.swapSkillTexts],
    mainSkill: mainIndex + 1,
    items,
    config: { enemyIsBoss, enemyLevel: areaLevel, resistancePenalty: resistancePenalty(level), questsUpToLevel: level, ...extrasResult.config },
  });

  // Spend "+5 to any Attribute" passives where Path of Building says attributes are short
  // (its requirement includes gems, weapon and armour, and Giant's Blood-style multipliers).
  const flexibleKeys = input.tree ? passives.filter((k) => input.tree!.nodes.get(k)?.isGenericAttribute) : [];
  const flexible = { str: 0, dex: 0, int: 0 };
  let attributes: Record<string, number> = {};
  let clearRun = await engine.request<PobResult>("evaluate", params("None", attributes));
  if (flexibleKeys.length) {
    const s0 = clearRun.stats;
    const missing = {
      str: Math.max(0, (s0.ReqStr ?? 0) - (s0.Str ?? 0)),
      dex: Math.max(0, (s0.ReqDex ?? 0) - (s0.Dex ?? 0)),
      int: Math.max(0, (s0.ReqInt ?? 0) - (s0.Int ?? 0)),
    };
    const index = { str: 1, dex: 2, int: 3 } as const;
    const order = (["str", "dex", "int"] as const).slice().sort((a, b) => missing[b] - missing[a]);
    const queue = [...flexibleKeys];
    for (const a of order) {
      while (missing[a] > 0 && queue.length) {
        attributes[queue.shift()!] = index[a];
        flexible[a]++;
        missing[a] -= 5;
      }
    }
    // Anything left over goes to the main skill's attribute.
    const weights = main.gem.requirement_weights;
    const mainAttr = weights && weights.strength >= weights.dexterity && weights.strength >= weights.intelligence ? "str" : weights && weights.dexterity >= weights.intelligence ? "dex" : "int";
    for (const key of queue) {
      attributes[key] = index[mainAttr];
      flexible[mainAttr]++;
    }
    attributes = { ...attributes };
    clearRun = await engine.request<PobResult>("evaluate", params("None", attributes));
  }
  const bossTier = level >= 65 ? "Pinnacle" : "Boss";
  const bossRun = await engine.request<PobResult>("evaluate", params(bossTier, attributes));

  const scenario = (run: PobResult, enemy: Scenario["enemy"]): Scenario => {
    const s = run.stats;
    const own = s.CombinedDPS ?? s.TotalDPS ?? 0;
    const minions = s.MinionCombinedDPS;
    const dps = minions && minions > own ? minions : own;
    const ignite = s.IgniteDPS || undefined;
    const poison = s.PoisonDPS || undefined;
    const bleed = s.BleedDPS || undefined;
    const otherDot = s.TotalDot || undefined;
    const kill = (mult: number) => (dps > 0 ? Math.round(((run.enemyBaseLife * mult) / dps) * 10) / 10 : undefined);
    return {
      enemy,
      dps: Math.round(dps),
      breakdown: {
        hits: round(s.TotalDPS),
        ignite: round(ignite),
        poison: round(poison),
        bleed: round(bleed),
        otherDamageOverTime: round(otherDot),
        minions: round(minions),
      },
      averageHit: round(s.AverageHit),
      secondsToKill:
        enemy === "normal monsters"
          ? { normal: kill(RARITY_LIFE.normal), rare: kill(RARITY_LIFE.rare) }
          : { boss: kill(RARITY_LIFE.boss) },
    };
  };

  const s = clearRun.stats;
  notes.push(...new Set([...clearRun.notes, ...bossRun.notes]));
  const missingGem = clearRun.skills.flatMap((g) => g.gems).find((g) => !g.found);
  if (missingGem) notes.push(`Path of Building didn't recognise ${missingGem.name}; its numbers are missing.`);
  if (input.gear.kind === "none" && !chosen.length) notes.push("Calculated with no gear at all, so numbers are far below a real character's.");
  if (remainingAssumed.length) notes.push("Slots without a chosen item use assumed budget rares (a few mid-roll mods per slot), not real items.");
  for (const a of ["Str", "Dex", "Int"] as const) {
    const req = s[`Req${a}`] ?? 0;
    const have = s[a] ?? 0;
    if (req > have) {
      const name = { Str: "Strength", Dex: "Dexterity", Int: "Intelligence" }[a];
      notes.push(`Still short ${Math.round(req - have)} ${name} (need ${Math.round(req)}, have ${Math.round(have)}): gear or more ${name} passives needed, or some gems and items can't be used.`);
    }
  }

  const clear = scenario(clearRun, "normal monsters");
  const boss = scenario(bossRun, bossTier === "Pinnacle" ? "a pinnacle boss" : "a boss");
  const hitsFromNormal = s.TotalNumberOfHits === undefined ? undefined : Math.round(s.TotalNumberOfHits * 10) / 10;
  const hitsFromBoss = bossRun.stats.TotalNumberOfHits === undefined ? undefined : Math.round(bossRun.stats.TotalNumberOfHits * 10) / 10;
  const missingResistance = { fire: s.MissingFireResist, cold: s.MissingColdResist, lightning: s.MissingLightningResist };
  const contents = level >= 65 ? (["early maps", "T15", "T16 juiced"] as const) : (["campaign"] as const);
  const verdicts = contents.map((content) =>
    verdict({
      content,
      rareSeconds: clear.secondsToKill.rare,
      bossSeconds: boss.secondsToKill.boss,
      normalHits: hitsFromNormal,
      bossHits: hitsFromBoss,
      missingResistance,
    }),
  );

  return {
    level,
    areaLevel,
    gemLevel,
    clear,
    boss,
    defence: {
      life: round(s.Life),
      energyShield: round(s.EnergyShield),
      effectiveHp: round(s.TotalEHP),
      resistances: { fire: s.FireResist, cold: s.ColdResist, lightning: s.LightningResist, chaos: s.ChaosResist },
      missingResistance,
      armour: round(s.Armour),
      evasion: round(s.Evasion),
      blockChance: s.BlockChance,
    },
    survival: { hitsFromNormal, hitsFromBoss, maxHit: round(s.SecondMinimalMaximumHitTaken) },
    verdicts,
    resources: {
      mana: round(s.Mana),
      manaUnreserved: round(s.ManaUnreserved),
      spirit: round(s.Spirit),
      // Path of Building sometimes still reserves Spirit for a free amulet skill; give back only
      // what it actually reserved, never more than the total.
      spiritUnreserved:
        s.SpiritUnreserved === undefined
          ? undefined
          : Math.round(s.SpiritUnreserved + Math.min(extrasResult.spiritRefund, Math.max(0, (s.Spirit ?? 0) - s.SpiritUnreserved))),
    },
    attributes: { str: s.Str, dex: s.Dex, int: s.Int, required: { str: s.ReqStr, dex: s.ReqDex, int: s.ReqInt }, flexibleNodes: flexible },
    passives: { allocated: clearRun.allocatedPassives, addedToConnect, unreachable },
    skillGroups: clearRun.skills.map((g) => g.label ?? g.gems.map((x) => x.name).join(" + ")),
    assumedGear: remainingAssumed
      .filter((a) => items.some((i) => i.slot === a.slot && i.raw === a.raw))
      .map(({ slot, base, mods }) => ({ slot: slot.startsWith("Jewel ") ? "Jewel socket" : slot, base, mods })),
    itemsUsed,
    notes,
  };
}
