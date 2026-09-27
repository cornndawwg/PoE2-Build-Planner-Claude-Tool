// Anoints, instills, socketables, free-Spirit amulets, flasks, weapon swap, gear tiers and trade links.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultCacheDir } from "../src/data/cache.js";
import { loadGameData, type GameData } from "../src/data/gamedata.js";
import { ALL_SOURCES } from "../src/data/sources.js";
import { evaluateBuild, type EvaluateInput } from "../src/engine/evaluate.js";
import { applyItemExtras } from "../src/engine/itemExtras.js";
import { optimizeBuild } from "../src/engine/optimize.js";
import { findEngine, PobEngine } from "../src/engine/pob.js";
import { amuletSkillSuggestions, anointSuggestions, socketableSuggestions, uniqueFlaskSuggestions } from "../src/gear/extras.js";
import { rareSearchLink, uniqueSearchLink } from "../src/prices/trade.js";
import { findGem } from "../src/skills/skills.js";
import { PassiveTree } from "../src/tree/tree.js";

const hasCache = Object.values(ALL_SOURCES).every((s) => existsSync(join(defaultCacheDir(), s.file)));
const enginePaths = findEngine();

describe.skipIf(!hasCache)("extra item data", () => {
  let data: GameData;
  let tree: PassiveTree;
  beforeAll(async () => {
    data = await loadGameData();
    tree = new PassiveTree(data.nodes);
  });
  const query = () => ({ level: 70, terms: ["fire", "spell"], avoid: ["attack"], defence: ["energy shield" as const] });

  it("knows the free-Spirit amulets and socketables", () => {
    expect(data.skillAmuletBases.length).toBeGreaterThan(0);
    expect(data.skillAmuletBases.some((b) => b.skills.includes("Herald of Ash"))).toBe(true);
    expect(data.socketables.some((s) => s.name === "Desert Rune" && s.mods.armour?.some((m) => /Fire Resistance/.test(m)))).toBe(true);
  });

  it("suggests anoints, runes, amulet skills and unique flasks", () => {
    const anoints = anointSuggestions(data, query(), (name) => (/Liquid/.test(name) ? 2 : undefined));
    expect(anoints.amulet.length).toBeGreaterThan(0);
    expect(anoints.amulet[0]!.recipe).toHaveLength(3);
    expect(anoints.amulet[0]!.costExalted).toBe(6);
    const runes = socketableSuggestions(data, { ...query(), slots: ["Body Armour"] });
    expect(runes[0]!.options.length).toBeGreaterThan(0);
    expect(amuletSkillSuggestions(data, query()).some((a) => ["Lament Amulet", "Portent Amulet", "Absent Amulet"].includes(a.amulet))).toBe(true);
    expect(uniqueFlaskSuggestions(data, query()).length).toBeGreaterThan(0);
  });

  it("puts extras on the items", () => {
    const amulet = { raw: "Rarity: RARE\nAssumed Amulet\nGold Amulet\nImplicits: 0\n+20 to maximum Life\n+10% to Fire Resistance", slot: "Amulet" };
    const helmet = { raw: "Rarity: RARE\nAssumed Helmet\nIron Hat\n+20 to maximum Life", slot: "Helmet" };
    const notable = [...tree.nodes.values()].find((n) => n.isNotable && !n.ascendancyId && n.name)!.name!;
    const r = applyItemExtras(data, tree, 70, 15, [amulet, helmet], {
      anoint: notable,
      helmetInstill: notable,
      socketables: [{ slot: "Helmet", names: ["Desert Rune"] }],
      weaponSwap: { passives: ["123"], skills: [{ gem: findGem(data, "Fireball") }], active: true },
    }, undefined);
    const hat = r.items.find((i) => i.slot === "Helmet")!;
    expect(hat.specLines).toEqual(["Sockets: S S", "Rune: Desert Rune", "Rune: Raven-Touched Shard"]);
    expect(hat.extraLines).toEqual([`Allocates ${notable}`]);
    expect(r.items.find((i) => i.slot === "Amulet")!.extraLines).toEqual([`Allocates ${notable}`]);
    expect(r.weaponSets).toEqual({ "123": 2 });
    expect(r.swapSkillTexts[0]).toMatch(/^Weapon Set: Set 2\nFireball 15/);
    expect(r.useWeaponSet2).toBe(true);

    const bad = applyItemExtras(data, tree, 30, 10, [amulet], { anoint: "Not A Notable", socketables: [{ slot: "Gloves", names: ["Nope Rune"] }] }, undefined);
    expect(bad.notes.some((n) => /isn't a notable/.test(n))).toBe(true);
    expect(bad.notes.some((n) => /Unknown rune/.test(n))).toBe(true);
  });

  it("builds trade links", () => {
    const rare = rareSearchLink(data, { league: "Forbidden Rites", itemClass: "Helmet", mods: ["+80 to maximum Life", "+30% to Fire Resistance", "Makes you fly"], maxLevel: 60 });
    expect(rare.url).toMatch(/^https:\/\/www\.pathofexile\.com\/trade2\/search\/poe2\/Forbidden\+Rites\?q=/);
    const query = JSON.parse(decodeURIComponent(rare.url.split("?q=")[1]!));
    expect(query.query.filters.type_filters.filters.category.option).toBe("armour.helmet");
    expect(query.query.filters.req_filters.filters.lvl.max).toBe(60);
    expect(query.query.stats[0].filters[0].value.min).toBe(64);
    expect(rare.searchesFor).toHaveLength(2);
    expect(rare.leftOut).toEqual(["Makes you fly"]);
    const unique = uniqueSearchLink(data, { league: "Standard", name: "headhunter" });
    expect(JSON.parse(decodeURIComponent(unique.url.split("?q=")[1]!)).query.name).toBe("Headhunter");
  });
});

describe.skipIf(!hasCache || !enginePaths)("extras in calculations (engine)", () => {
  let engine: PobEngine | undefined;
  let data: GameData;
  let base: EvaluateInput;
  beforeAll(async () => {
    engine = new PobEngine(enginePaths!);
    data = await loadGameData();
    const witch = data.classes.find((c) => c.name === "Witch")!;
    base = {
      cls: witch,
      level: 65,
      passives: [],
      skills: [{ gem: findGem(data, "Fireball") }],
      gear: { kind: "budget", terms: ["fire", "spell"], avoid: ["attack"], defence: ["energy shield"] },
      tree: new PassiveTree(data.nodes),
    };
  });
  afterAll(() => engine?.stop());

  it("better gear tiers do more damage", async () => {
    const dps = [];
    for (const tier of ["budget", "high"] as const) {
      dps.push((await evaluateBuild(engine!, data, { ...base, gear: { ...(base.gear as object), tier } as EvaluateInput["gear"] })).clear.dps);
    }
    expect(dps[1]!).toBeGreaterThan(dps[0]!);
  }, 60_000);

  it("runes, a free-Spirit amulet skill and weapon swap", async () => {
    // Level 60: below 65 the assumed gear isn't topped up to cap resistances, so the runes show.
    const plain = await evaluateBuild(engine!, data, { ...base, level: 60 });
    const extras = await evaluateBuild(engine!, data, {
      ...base,
      level: 60,
      extras: {
        socketables: [{ slot: "Body Armour", names: ["Desert Rune", "Desert Rune"] }],
        amuletSkill: "Herald of Ash",
        weaponSwap: { weapons: ["Bow"], skills: [{ gem: findGem(data, "Lightning Arrow") }] },
      },
    });
    expect(extras.defence.resistances.fire!).toBeGreaterThan(plain.defence.resistances.fire!);
    expect(extras.resources.spiritUnreserved).toBe(extras.resources.spirit);
    expect(extras.itemsUsed.some((i) => /Swap/.test(i))).toBe(true);
  }, 60_000);
});

describe.skipIf(!hasCache || !enginePaths)("goals and resistances (engine)", () => {
  let engine: PobEngine | undefined;
  let data: GameData;
  beforeAll(async () => {
    engine = new PobEngine(enginePaths!);
    data = await loadGameData();
  });
  afterAll(() => engine?.stop());

  it("caps resistances on assumed end-game gear and checks the goal honestly", async () => {
    const warrior = data.classes.find((c) => c.name === "Warrior")!;
    const e = await evaluateBuild(engine!, data, {
      cls: warrior,
      level: 90,
      passives: [],
      skills: [{ gem: findGem(data, "Boneshatter") }],
      gear: { kind: "budget", terms: ["physical", "attack"], defence: ["armour"] },
      tree: new PassiveTree(data.nodes),
      goals: { purpose: "bossing", push: "pinnacle", buttons: "few", budget: "self-found" },
    });
    expect(Object.values(e.defence.missingResistance).every((m) => !m || m <= 0)).toBe(true);
    expect(e.notes.some((n) => /Added resistance mods/.test(n))).toBe(true);
    expect(e.verdicts.some((v) => v.content === "pinnacle bosses")).toBe(true);
    expect(e.goalCheck?.goal).toMatch(/killing bosses, pushing pinnacle bosses/);
    expect(["on track", "rough", "not realistic yet"]).toContain(e.goalCheck?.status);
    expect(e.goalCheck!.message.length).toBeGreaterThan(20);
    // One damage skill, no curse/warcry, no Spirit skill: the setup check says so.
    expect(e.setupGaps.some((g) => /second skill/.test(g))).toBe(true);
    expect(e.setupGaps.some((g) => /curse, mark, warcry or banner/.test(g))).toBe(true);
  }, 60_000);
});

describe.skipIf(!hasCache || !enginePaths)("optimizer (engine)", () => {
  let engine: PobEngine | undefined;
  afterAll(() => engine?.stop());

  it("finds measured damage gains that keep survivability", async () => {
    engine = new PobEngine(enginePaths!);
    const data = await loadGameData();
    const tree = new PassiveTree(data.nodes);
    const witch = data.classes.find((c) => c.name === "Witch")!;
    const result = await optimizeBuild(
      engine,
      data,
      tree,
      {
        cls: witch,
        level: 70,
        passives: [],
        skills: [{ gem: findGem(data, "Fireball") }],
        gear: { kind: "budget", terms: ["fire", "spell"], avoid: ["attack"], defence: ["energy shield"] },
        tree,
      },
      { objective: "balanced", terms: ["fire", "spell"], avoid: ["attack"], defence: ["energy shield"], maxEvaluations: 10, kinds: ["support", "passive"] },
    );
    expect(result.evaluations).toBeLessThanOrEqual(11);
    expect(result.damage.length).toBeGreaterThan(0);
    const best = result.damage[0]!;
    expect(best.score).toBeGreaterThan(0);
    expect(best.bossDps).toMatch(/^\+/);
    expect(result.baseline.pointsFree).toBeGreaterThan(0);
  }, 120_000);
});
