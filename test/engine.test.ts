import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { defaultCacheDir } from "../src/data/cache.js";
import { loadGameData } from "../src/data/gamedata.js";
import { ALL_SOURCES } from "../src/data/sources.js";
import { evaluateBuild, resistancePenalty } from "../src/engine/evaluate.js";
import { assumeGear, midRoll, pickBase } from "../src/engine/gear.js";
import { findEngine, PobEngine } from "../src/engine/pob.js";
import { verdict } from "../src/engine/verdict.js";
import { findGem } from "../src/skills/skills.js";

describe("verdict", () => {
  const base = { content: "campaign" as const, missingResistance: {} };

  it("rates fast kills and good survival as comfortable", () => {
    const v = verdict({ ...base, rareSeconds: 2, bossSeconds: 30, normalHits: 10, bossHits: 3 });
    expect(v.overall).toBe("Comfortable");
    expect(v.weakPoint).toBeUndefined();
  });

  it("names the weakest area and what to fix first", () => {
    const v = verdict({ ...base, rareSeconds: 20, bossSeconds: 30, normalHits: 10, bossHits: 3 });
    expect(v.overall).toBe("Not yet");
    expect(v.weakPoint).toBe("damage for clearing");
  });

  it("requires capped resistances in maps", () => {
    const v = verdict({ content: "T15", rareSeconds: 1, bossSeconds: 10, normalHits: 20, bossHits: 5, missingResistance: { lightning: 12 } });
    expect(v.survival).toBe("Borderline");
    expect(v.fixFirst).toMatch(/12% lightning/);
  });

  it("assumes tougher monsters for harder content", () => {
    const early = verdict({ content: "early maps", rareSeconds: 2.5, bossSeconds: 30, normalHits: 10, bossHits: 3, missingResistance: {} });
    const juiced = verdict({ content: "T16 juiced", rareSeconds: 2.5, bossSeconds: 30, normalHits: 10, bossHits: 3, missingResistance: {} });
    expect(early.clearing).toBe("Comfortable");
    expect(juiced.clearing).not.toBe("Comfortable");
  });

  it("doesn't let slow bossing alone make clearing content 'Not yet'", () => {
    expect(verdict({ ...base, rareSeconds: 2, bossSeconds: 999, normalHits: 10, bossHits: 3 }).overall).toBe("Borderline");
  });
});

describe("gear helpers", () => {
  it("rolls ranges to their middle and splits hybrid mods", () => {
    expect(midRoll("(45-54)% increased Fire Damage")).toEqual(["50% increased Fire Damage"]);
    expect(midRoll("Adds (3-5) to (8-10) Fire Damage")).toEqual(["Adds 4 to 9 Fire Damage"]);
    expect(midRoll("(14-20)% increased Energy Shield\n+(11-19) to maximum Life")).toEqual(["17% increased Energy Shield", "+15 to maximum Life"]);
  });

  it("uses the campaign's resistance penalty by level", () => {
    expect(resistancePenalty(10)).toBe(0);
    expect(resistancePenalty(40)).toBe(-20);
    expect(resistancePenalty(80)).toBe(-60);
  });
});

const hasCache = Object.values(ALL_SOURCES).every((s) => existsSync(join(defaultCacheDir(), s.file)));

describe.skipIf(!hasCache)("assumed gear against real data", () => {
  it("picks bases a character can find by then, matching the defence style", async () => {
    const data = await loadGameData();
    const early = pickBase(data, "Helmet", 10, "int_armour")!;
    const late = pickBase(data, "Helmet", 70, "int_armour")!;
    expect(early.drop_level).toBeLessThanOrEqual(10);
    expect(late.drop_level!).toBeGreaterThan(early.drop_level!);
    expect(late.tags).toContain("int_armour");

    const gear = assumeGear(data, { level: 45, terms: ["fire", "spell"], avoid: ["attack"], defence: ["energy shield"], mainSkill: findGem(data, "Fireball") });
    expect(gear.map((g) => g.slot)).toEqual(expect.arrayContaining(["Weapon 1", "Weapon 2", "Helmet", "Ring 1", "Ring 2", "Belt"]));
    expect(gear.find((g) => g.slot === "Weapon 1")!.raw).toMatch(/^Rarity: RARE\n/);
    const bow = assumeGear(data, { level: 45, terms: ["cold"], defence: ["evasion"], mainSkill: findGem(data, "Ice Shot") });
    expect(data.baseItems[Object.keys(data.baseItems).find((k) => data.baseItems[k]!.name === bow[0]!.base)!]!.item_class).toBe("Bow");
  });
});

const enginePaths = findEngine();

describe.skipIf(!hasCache || !enginePaths)("Path of Building engine", () => {
  const engine = enginePaths ? new PobEngine(enginePaths) : undefined;
  afterAll(() => engine?.stop());

  it("calculates a build with real numbers and a verdict", async () => {
    const data = await loadGameData();
    const witch = data.classes.find((c) => c.name === "Witch")!;
    const result = await evaluateBuild(engine!, data, {
      cls: witch,
      ascendancyName: "Infernalist",
      level: 30,
      passives: [],
      skills: [{ gem: findGem(data, "Fireball"), supports: [findGem(data, "Fiery Death")] }],
      gear: { kind: "budget", terms: ["fire", "spell"], avoid: ["attack"], defence: ["energy shield"] },
    });
    expect(result.clear.dps).toBeGreaterThan(0);
    expect(result.boss.dps).toBeLessThan(result.clear.dps); // bosses resist more
    expect(result.resources.spirit).toBe(30); // only Act 1's Spirit quest by level 30
    expect(result.verdicts).toHaveLength(1);
    expect(result.assumedGear.length).toBeGreaterThan(5);
  }, 60_000);
});
