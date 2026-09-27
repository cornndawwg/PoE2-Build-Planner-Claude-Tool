// Real numbers for a planned build at a character level, from Path of Building, with assumed
// budget gear and the campaign's quest rewards and resistance penalty for that level.

import type { GameData, PlayableClass, PlayerGem } from "../data/gamedata.js";
import type { DefenceStyle } from "../gear/priorities.js";
import { gemLevelForCharacter } from "../skills/levels.js";
import { assumeGear, type AssumedItem } from "./gear.js";
import type { PobEngine } from "./pob.js";
import { verdict, type Verdict } from "./verdict.js";

export interface EvaluateInput {
  cls: PlayableClass;
  ascendancyName?: string;
  level: number;
  /** Main-tree and ascendancy passives (tree keys). */
  passives: string[];
  skills: { gem: PlayerGem; supports?: PlayerGem[] }[];
  /** 0-based index of the main damage skill in `skills`. */
  mainSkill?: number;
  gear:
    | { kind: "none" }
    | { kind: "budget"; terms: string[]; avoid?: string[]; defence: DefenceStyle[]; weapons?: string[] }
    | { kind: "items"; items: { raw: string; slot?: string }[] };
  /** Gem quality to assume (default: 0 in the campaign, 20 at level 65+). */
  quality?: number;
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
  dps: number;
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
  attributes: { str?: number; dex?: number; int?: number; required: { str?: number; dex?: number; int?: number } };
  assumedGear: { slot: string; base: string; mods: string[] }[];
  notes: string[];
}

/** Rough life multipliers by monster rarity (not in the game data; a labelled heuristic). */
export const RARITY_LIFE = { normal: 1, rare: 5, boss: 25 } as const;

export async function evaluateBuild(engine: PobEngine, data: GameData, input: EvaluateInput): Promise<Evaluation> {
  const level = input.level;
  const gemLevel = gemLevelForCharacter(level);
  const quality = input.quality ?? (level >= 65 ? 20 : 0);
  const areaLevel = areaLevelFor(level);
  const mainIndex = input.mainSkill ?? 0;
  const main = input.skills[mainIndex]?.gem;
  if (!main) throw new Error("The build needs at least one skill to calculate.");

  let items: { raw: string; slot?: string }[] = [];
  let assumed: AssumedItem[] = [];
  if (input.gear.kind === "budget") {
    assumed = assumeGear(data, { level, terms: input.gear.terms, avoid: input.gear.avoid, defence: input.gear.defence, mainSkill: main, weapons: input.gear.weapons });
    items = assumed.map((a) => ({ raw: a.raw, slot: a.slot }));
  } else if (input.gear.kind === "items") {
    items = input.gear.items;
  }

  const skillTexts = input.skills.map(({ gem, supports }) =>
    [`${gem.name} ${gemLevel}/${quality}  1`, ...(supports ?? []).map((s) => `${s.name} 1/0  1`)].join("\n") + "\n",
  );
  const params = (enemyIsBoss: string) => ({
    className: input.ascendancyName ?? input.cls.name,
    level,
    passives: input.passives,
    skills: skillTexts,
    mainSkill: mainIndex + 1,
    items,
    config: { enemyIsBoss, enemyLevel: areaLevel, resistancePenalty: resistancePenalty(level), questsUpToLevel: level },
  });

  const bossTier = level >= 65 ? "Pinnacle" : "Boss";
  const clearRun = await engine.request<PobResult>("evaluate", params("None"));
  const bossRun = await engine.request<PobResult>("evaluate", params(bossTier));

  const scenario = (run: PobResult, enemy: Scenario["enemy"]): Scenario => {
    const s = run.stats;
    const dps = s.MinionCombinedDPS && s.MinionCombinedDPS > (s.CombinedDPS ?? 0) ? s.MinionCombinedDPS : (s.CombinedDPS ?? s.TotalDPS ?? 0);
    const kill = (mult: number) => (dps > 0 ? Math.round(((run.enemyBaseLife * mult) / dps) * 10) / 10 : undefined);
    return {
      enemy,
      dps: Math.round(dps),
      averageHit: round(s.AverageHit),
      secondsToKill:
        enemy === "normal monsters"
          ? { normal: kill(RARITY_LIFE.normal), rare: kill(RARITY_LIFE.rare) }
          : { boss: kill(RARITY_LIFE.boss) },
    };
  };

  const s = clearRun.stats;
  const notes = [...new Set([...clearRun.notes, ...bossRun.notes])];
  const missingGem = clearRun.skills.flatMap((g) => g.gems).find((g) => !g.found);
  if (missingGem) notes.push(`Path of Building didn't recognise ${missingGem.name}; its numbers are missing.`);
  if (input.gear.kind === "none") notes.push("Calculated with no gear at all, so numbers are far below a real character's.");
  if (input.gear.kind === "budget") notes.push("Calculated with assumed budget rares (a few mid-roll mods per slot), not real items.");

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
    resources: { mana: round(s.Mana), manaUnreserved: round(s.ManaUnreserved), spirit: round(s.Spirit), spiritUnreserved: round(s.SpiritUnreserved) },
    attributes: { str: s.Str, dex: s.Dex, int: s.Int, required: { str: s.ReqStr, dex: s.ReqDex, int: s.ReqInt } },
    assumedGear: assumed.map(({ slot, base, mods }) => ({ slot, base, mods })),
    notes,
  };
}
