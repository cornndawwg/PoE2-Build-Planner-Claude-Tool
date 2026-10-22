// A player's real character, imported from a Path of Building code: what it is, how it performs,
// where its defences are weak, and which gear changes help most (each one calculated).

import type { Goals } from "../build/goals.js";
import { goalCheck, type GoalCheck } from "../build/goals.js";
import type { GameData } from "../data/gamedata.js";
import { SLOT_CLASSES, statPriorities, type DefenceStyle } from "../gear/priorities.js";
import { itemClassOfBase, rareSearchLink, type TradeLink } from "../prices/trade.js";
import { rollAt } from "./gear.js";
import { areaLevelFor, resistancePenalty, scenarioOf, type PobResult, type Scenario } from "./evaluate.js";
import type { PobEngine } from "./pob.js";
import { verdict, type Content, type Verdict } from "./verdict.js";

interface LoadResult extends PobResult {
  level: number;
  character?: {
    passives: { id: number; name?: string; ascendancy?: string }[];
    skills: { index: number; label?: string; enabled: boolean; slot?: string; gems: { name: string; level: number; quality?: number; enabled: boolean; support: boolean }[] }[];
    mainSkill: number;
    items: { slot: string; name: string; rarity: string; raw: string }[];
  };
}

export interface CharacterItem {
  slot: string;
  name: string;
  rarity: string;
  base?: string;
  itemClass?: string;
  mods: string[];
}

export interface CharacterNumbers {
  clear: Scenario;
  boss: Scenario;
  defence: {
    life?: number;
    energyShield?: number;
    effectiveHp?: number;
    resistances: { fire?: number; cold?: number; lightning?: number; chaos?: number };
    /** Biggest hit of each damage type the character survives. */
    maxHit: { physical?: number; fire?: number; cold?: number; lightning?: number; chaos?: number };
    armour?: number;
    evasion?: number;
    blockChance?: number;
  };
  survival: { hitsFromNormal?: number; hitsFromBoss?: number };
  resources: { spirit?: number; spiritUnreserved?: number; manaUnreserved?: number };
  verdicts: Verdict[];
  goalCheck?: GoalCheck;
}

export interface CharacterReport {
  className: string;
  ascendancy?: string;
  level: number;
  mainSkill?: string;
  skills: { label?: string; enabled: boolean; gems: string[] }[];
  keyPassives: string[];
  passiveCount: number;
  items: CharacterItem[];
  numbers: CharacterNumbers;
  /** Plain findings about defences: uncapped or negative resistances, weak hit types, one-shot risk. */
  defenceAudit: string[];
  notes: string[];
}

const round = (n: number | undefined) => (n === undefined ? undefined : Math.round(n));

/** Calculation settings matching evaluate_build, so imported and planned builds compare fairly. */
function configFor(level: number, enemy: "None" | "Boss" | "Pinnacle") {
  return { enemyIsBoss: enemy, enemyLevel: areaLevelFor(level), resistancePenalty: resistancePenalty(level), ...(level < 65 ? { questsUpToLevel: level } : {}) };
}

/** Item text → base, item class and mod lines (what's under the header). */
function readItem(data: GameData, slot: string, name: string, rarity: string, raw: string): CharacterItem {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let base: string | undefined;
  let itemClass: string | undefined;
  for (const line of lines.slice(1, 4)) {
    itemClass = itemClassOfBase(data, line);
    if (itemClass) {
      base = line;
      break;
    }
  }
  const skip = /^(Rarity|Item Level|Quality|Sockets|Rune|LevelReq|Implicits|Unique ID|Requires|Crafted|Prefix|Suffix|Radius|Limited to|Variant|Selected Variant|Item Class)\b|^\{|^(Corrupted|Mirrored|Fractured Item|Synthesised Item)$/;
  const mods = lines.slice(base ? lines.indexOf(base) + 1 : 3).filter((l) => !skip.test(l)).map((l) => l.replace(/^\{[^}]*\}/, ""));
  return { slot, name: name.replace(/, .*$/, ""), rarity, base, itemClass, mods };
}

export async function loadCharacter(engine: PobEngine, data: GameData, xml: string, goals?: Goals): Promise<CharacterReport> {
  const first = await engine.request<LoadResult>("loadXml", { xml, describe: true, config: { enemyIsBoss: "None" } });
  const level = first.level;
  const bossTier = level >= 65 ? "Pinnacle" : "Boss";
  const clearRun = await engine.request<LoadResult>("loadXml", { xml, config: configFor(level, "None") });
  const bossRun = await engine.request<LoadResult>("loadXml", { xml, config: configFor(level, bossTier) });
  const c = first.character!;
  const s = clearRun.stats;
  const clear = scenarioOf(clearRun, "normal monsters");
  const boss = scenarioOf(bossRun, bossTier === "Pinnacle" ? "a pinnacle boss" : "a boss");
  const tenth = (n?: number) => (n === undefined ? undefined : Math.round(n * 10) / 10);
  const numbersForVerdict = {
    rareSeconds: clear.secondsToKill.rare,
    bossSeconds: boss.secondsToKill.boss,
    normalHits: tenth(s.TotalNumberOfHits),
    bossHits: tenth(bossRun.stats.TotalNumberOfHits),
    missingResistance: { fire: s.MissingFireResist, cold: s.MissingColdResist, lightning: s.MissingLightningResist },
  };
  const contents: Content[] = level >= 65 ? ["early maps", "T15", "T16 juiced", ...(goals?.push === "pinnacle" ? (["pinnacle"] as const) : [])] : ["campaign"];
  const numbers: CharacterNumbers = {
    clear,
    boss,
    defence: {
      life: round(s.Life),
      energyShield: round(s.EnergyShield),
      effectiveHp: round(s.TotalEHP),
      resistances: { fire: s.FireResist, cold: s.ColdResist, lightning: s.LightningResist, chaos: s.ChaosResist },
      maxHit: {
        physical: round(s.PhysicalMaximumHitTaken),
        fire: round(s.FireMaximumHitTaken),
        cold: round(s.ColdMaximumHitTaken),
        lightning: round(s.LightningMaximumHitTaken),
        chaos: round(s.ChaosMaximumHitTaken),
      },
      armour: round(s.Armour),
      evasion: round(s.Evasion),
      blockChance: s.BlockChance,
    },
    survival: { hitsFromNormal: numbersForVerdict.normalHits, hitsFromBoss: numbersForVerdict.bossHits },
    resources: { spirit: round(s.Spirit), spiritUnreserved: round(s.SpiritUnreserved), manaUnreserved: round(s.ManaUnreserved) },
    verdicts: contents.map((content) => verdict({ ...numbersForVerdict, content }, goals)),
    goalCheck: goals ? goalCheck(numbersForVerdict, level, goals) : undefined,
  };

  const mainGroup = c.skills.find((g) => g.index === c.mainSkill);
  return {
    className: first.className,
    ascendancy: first.ascendancy || undefined,
    level,
    mainSkill: mainGroup ? mainGroup.label ?? mainGroup.gems.find((g) => !g.support)?.name : undefined,
    skills: c.skills.map((g) => ({ label: g.label, enabled: g.enabled, gems: g.gems.map((x) => `${x.name} ${x.level}${x.quality ? `/${x.quality}` : ""}${x.enabled ? "" : " (off)"}`) })),
    keyPassives: c.passives
      .filter((p) => p.id && data.nodes.get(String(p.id)) && (data.nodes.get(String(p.id))!.isNotable || data.nodes.get(String(p.id))!.isKeystone))
      .map((p) => data.nodes.get(String(p.id))!.name ?? p.name ?? String(p.id)),
    passiveCount: c.passives.filter((p) => !p.ascendancy).length,
    items: c.items.map((i) => readItem(data, i.slot, i.name, i.rarity, i.raw)),
    numbers,
    defenceAudit: auditDefences(numbers, level),
    notes: [...new Set([...first.notes, ...clearRun.notes, ...bossRun.notes])],
  };
}

/** Plain findings about where the character is fragile. */
export function auditDefences(n: CharacterNumbers, level: number): string[] {
  const out: string[] = [];
  const r = n.defence.resistances;
  const cap = 75;
  for (const [element, value] of Object.entries({ fire: r.fire, cold: r.cold, lightning: r.lightning })) {
    if (value !== undefined && value < cap) out.push(`${element[0]!.toUpperCase()}${element.slice(1)} resistance is ${Math.round(value)}% (cap ${cap}%): ${element} hits do ${Math.round(cap - value)}% more damage than they would capped. Fix this first.`);
  }
  if (level >= 65 && r.chaos !== undefined && r.chaos < 0) {
    out.push(`Chaos resistance is ${Math.round(r.chaos)}%: chaos damage (common in maps) hits harder than anything else. Aim for 0% or better.`);
  }
  const hits = Object.entries(n.defence.maxHit).filter((e): e is [string, number] => typeof e[1] === "number" && e[1] > 0);
  if (hits.length >= 3) {
    const sorted = [...hits].sort((a, b) => a[1] - b[1]);
    const median = sorted[Math.floor(sorted.length / 2)]![1];
    const [weakest, value] = sorted[0]!;
    if (value < median * 0.6) out.push(`The biggest ${weakest} hit you survive is ${value.toLocaleString("en-US")}, far below the others (around ${median.toLocaleString("en-US")}). That's the damage type most likely to kill you.`);
  }
  if ((n.survival.hitsFromBoss ?? 99) < 1) out.push("A single big boss hit can kill you: more life or energy shield, or a defence layer (armour, evasion, block), would help most.");
  if ((n.resources.spiritUnreserved ?? 0) >= 30) out.push(`${n.resources.spiritUnreserved} Spirit is unused: a Spirit skill (herald, aura or buff) is free power.`);
  return out;
}

// --- Upgrade advisor ---

export interface AdviceOptions {
  /** What the build scales (for offensive mods), e.g. ["fire", "spell"]. */
  terms: string[];
  avoid?: string[];
  defence: DefenceStyle[];
  objective: "clear" | "boss" | "balanced";
  slots?: string[];
  league: string;
  /** Calculations to spend (default 70). */
  maxTests?: number;
}

export interface SlotAdvice {
  slot: string;
  item: string;
  rarity: string;
  /** What the current item's mods give: damage and effective HP compared with a plain item of the same base. */
  contribution: { damage: string; effectiveHp: string };
  /** Mods to look for on a replacement, each calculated on this character. */
  bestAdditions: { mod: string; damage: string; effectiveHp: string; maxHit: string; score: number }[];
  tradeSearch?: TradeLink;
  note?: string;
}

export interface UpgradeAdvice {
  baseline: { damage: number; effectiveHp: number; minMaxHit: number };
  /** The best single changes across all slots, best first. */
  topUpgrades: { slot: string; mod: string; damage: string; effectiveHp: string; maxHit: string }[];
  slots: SlotAdvice[];
  tests: number;
  notes: string[];
}

const GEAR_SLOTS = ["Weapon 1", "Weapon 2", "Helmet", "Body Armour", "Gloves", "Boots", "Amulet", "Ring 1", "Ring 2", "Belt"];
const pct = (value: number, base: number) => {
  if (!base) return "0%";
  const change = Math.round(((value - base) / base) * 1000) / 10;
  return `${change > 0 ? "+" : ""}${change}%`;
};

/** stat_priorities slot name for an item class ("Ring" → "Ring", "Warstaff" → "Quarterstaff"). */
function priorityKey(itemClass: string | undefined): string | undefined {
  if (!itemClass) return undefined;
  return Object.entries(SLOT_CLASSES).find(([, classes]) => classes.includes(itemClass))?.[0];
}

export async function adviseUpgrades(
  engine: PobEngine,
  data: GameData,
  xml: string,
  character: CharacterReport,
  options: AdviceOptions,
): Promise<UpgradeAdvice> {
  const level = character.level;
  const enemy = options.objective === "boss" ? (level >= 65 ? "Pinnacle" : "Boss") : "None";
  const config = configFor(level, enemy);
  let tests = 0;
  const budget = options.maxTests ?? 70;
  const notes: string[] = [];
  type Edit = { slot: string; addLines?: string[]; remove?: boolean; raw?: string };
  const failed: string[] = [];
  const measure = async (edits: Edit[]) => {
    tests++;
    let r: LoadResult;
    try {
      r = await engine.request<LoadResult>("loadXml", { xml, config, edits }, 15_000);
    } catch {
      // Path of Building occasionally gets stuck on a change; skip it (the engine restarts itself).
      failed.push(edits.map((e) => `${e.slot}${e.addLines ? " + " + e.addLines.join(" / ") : " plain"}`).join(", "));
      return undefined;
    }
    const s = r.stats;
    const dps = Math.max(s.CombinedDPS ?? s.TotalDPS ?? 0, s.MinionCombinedDPS ?? 0);
    const hits = [s.PhysicalMaximumHitTaken, s.FireMaximumHitTaken, s.ColdMaximumHitTaken, s.LightningMaximumHitTaken, s.ChaosMaximumHitTaken].filter((x): x is number => typeof x === "number" && x > 0);
    return { dps, ehp: s.TotalEHP ?? 0, minHit: hits.length ? Math.min(...hits) : 0, missingRes: (s.MissingFireResist ?? 0) + (s.MissingColdResist ?? 0) + (s.MissingLightningResist ?? 0) };
  };
  const base = await measure([]);
  if (!base) throw new Error("Path of Building couldn't calculate this character.");
  const score = (m: NonNullable<Awaited<ReturnType<typeof measure>>>) =>
    (base.dps ? (m.dps - base.dps) / base.dps : 0) + 0.7 * (base.ehp ? (m.ehp - base.ehp) / base.ehp : 0) + 0.5 * (base.minHit ? (m.minHit - base.minHit) / base.minHit : 0);

  const itemLevel = Math.min(Math.max(level, 1), 82);
  const missingRes = (["Fire", "Cold", "Lightning"] as const).filter((e) => (character.numbers.defence.resistances[e.toLowerCase() as "fire"] ?? 75) < 75);
  // Test chaos resistance when it's negative in maps, or when chaos is the hit type most likely to kill.
  const maxHit = character.numbers.defence.maxHit;
  const weakest = Object.entries(maxHit).filter((e): e is [string, number] => typeof e[1] === "number" && e[1] > 0).sort((x, y) => x[1] - y[1])[0]?.[0];
  const chaosLow = ((character.numbers.defence.resistances.chaos ?? 0) < 0 && level >= 65) || weakest === "chaos";

  const slots: SlotAdvice[] = [];
  const allAdditions: (SlotAdvice["bestAdditions"][number] & { slot: string })[] = [];
  const wanted = options.slots?.length ? options.slots : GEAR_SLOTS;
  for (const slot of wanted) {
    const item = character.items.find((i) => i.slot === slot);
    if (!item) continue;
    if (tests >= budget) {
      notes.push(`Stopped after ${budget} calculations; ask for specific slots to look further.`);
      break;
    }
    // What the item's mods are worth: swap it for a plain item of the same base.
    const without = await measure([item.base ? { slot, raw: `Rarity: NORMAL\n${item.base}` } : { slot, remove: true }]);
    const advice: SlotAdvice = {
      slot,
      item: item.name,
      rarity: item.rarity,
      contribution: without
        ? { damage: pct(base.dps, without.dps), effectiveHp: pct(base.ehp, without.ehp) }
        : { damage: "?", effectiveHp: "?" },
      bestAdditions: [],
    };
    const key = priorityKey(item.itemClass);
    if (item.rarity === "UNIQUE") advice.note = "Unique: its mods can't be added to. Compare a rare with the mods below, or another unique, with compare_builds or by importing an edited code.";
    if (key) {
      // Candidate mods: what the build scales on this slot, its defence layer, and resistances it's missing.
      const pr = statPriorities(data, { terms: options.terms, avoid: options.avoid, slots: [key], perSlot: 4, defence: options.defence, itemLevel });
      const offence = (pr.offence[0]?.mods ?? []).slice(0, 4).map((m) => m.tier);
      const defence = (pr.defence[0]?.mods ?? []).filter((m) => !/Resistance/i.test(m.tier)).slice(0, 2).map((m) => m.tier);
      const resists = (pr.defence[0]?.mods ?? []).filter((m) => missingRes.some((e) => new RegExp(`${e} Resistance`).test(m.tier)) || (chaosLow && /Chaos Resistance/.test(m.tier))).slice(0, 2).map((m) => m.tier);
      const candidates = [...new Set([...resists, ...defence, ...offence])];
      for (const tier of candidates) {
        if (tests >= budget) break;
        const lines = rollAt(tier, 0.75);
        const m = await measure([{ slot, addLines: lines }]);
        if (!m) continue;
        const entry = {
          mod: lines.join(" / "),
          damage: pct(m.dps, base.dps),
          effectiveHp: pct(m.ehp, base.ehp),
          maxHit: pct(m.minHit, base.minHit),
          score: Math.round(score(m) * 1000) / 1000,
        };
        if (entry.score > 0.002) {
          advice.bestAdditions.push(entry);
          allAdditions.push({ ...entry, slot });
        }
      }
      advice.bestAdditions.sort((a, b) => b.score - a.score);
      const mods = advice.bestAdditions.slice(0, 4).map((a) => a.mod.split(" / ")[0]!);
      if (item.itemClass && mods.length) {
        advice.tradeSearch = rareSearchLink(data, { league: options.league, itemClass: item.itemClass, mods, maxLevel: level, strictness: 0.7 });
      }
    }
    slots.push(advice);
  }
  allAdditions.sort((a, b) => b.score - a.score);
  if (failed.length) notes.push(`Path of Building got stuck on (skipped): ${failed.join("; ")}.`);
  notes.push(
    "Each mod is tested by adding it to the current item (a good roll at your level), so it shows what that stat is worth to this character. A replacement item also loses the current item's mods: compare with its contribution.",
  );
  return {
    baseline: { damage: Math.round(base.dps), effectiveHp: Math.round(base.ehp), minMaxHit: Math.round(base.minHit) },
    topUpgrades: allAdditions.slice(0, 8).map(({ slot, mod, damage, effectiveHp, maxHit }) => ({ slot, mod, damage, effectiveHp, maxHit })),
    slots,
    tests,
    notes,
  };
}
