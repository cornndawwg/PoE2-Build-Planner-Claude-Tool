// Jewels in calculations, Spirit/jewel/flask suggestions, and compare mode.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultCacheDir } from "../src/data/cache.js";
import { loadGameData, type GameData } from "../src/data/gamedata.js";
import { ALL_SOURCES } from "../src/data/sources.js";
import { compareBuilds } from "../src/engine/compare.js";
import { evaluateBuild } from "../src/engine/evaluate.js";
import { assumeJewel } from "../src/engine/gear.js";
import { findEngine, PobEngine } from "../src/engine/pob.js";
import { flaskSuggestions, jewelSuggestions, spiritSuggestions } from "../src/gear/extras.js";
import { findGem } from "../src/skills/skills.js";
import { PassiveTree } from "../src/tree/tree.js";

const hasCache = Object.values(ALL_SOURCES).every((s) => existsSync(join(defaultCacheDir(), s.file)));
const enginePaths = findEngine();

describe.skipIf(!hasCache)("suggestions", () => {
  let data: GameData;
  beforeAll(async () => {
    data = await loadGameData();
  });
  const query = () => ({
    level: 45,
    terms: ["fire", "spell", "ignite"],
    avoid: ["attack"],
    defence: ["energy shield" as const],
    mainSkill: findGem(data, "Fireball"),
  });

  it("suggests Spirit skills that fit the available Spirit", () => {
    const s = spiritSuggestions(data, query());
    expect(s.spiritAvailable).toBe(60); // Act 1 and Act 3 quests by level 45
    expect(s.options.length).toBeGreaterThan(0);
    expect(s.options.every((o) => o.spirit > 0)).toBe(true);
    const picked = s.options.filter((o) => s.suggestedPick.skills.includes(o.name));
    expect(picked.reduce((sum, o) => sum + o.spirit, 0)).toBeLessThanOrEqual(60);
    const more = spiritSuggestions(data, { ...query(), gearSpirit: 100 });
    expect(more.spiritAvailable).toBe(160);
  });

  it("suggests the jewel type for the main skill's attribute, with matching mods", () => {
    const j = jewelSuggestions(data, query());
    expect(j.recommendedType).toBe("Sapphire");
    const sapphire = j.byType.find((t) => t.jewel === "Sapphire")!;
    expect(sapphire.bestMods.length).toBeGreaterThan(2);
    expect(sapphire.bestMods.every((m) => m.matched.length > 0)).toBe(true);
  });

  it("suggests flasks a character can have by the level, and charms", () => {
    const f = flaskSuggestions(data, { ...query(), level: 12 });
    expect(f.lifeFlask?.base).toBe("Greater Life Flask"); // drops from level 10
    expect(f.charms.every((c) => (c.dropLevel ?? 1) <= 12)).toBe(true);
    expect(f.charms[0]!.trigger).toMatch(/Used when/);
  });

  it("builds a budget jewel with build mods and a defensive mod", () => {
    const jewel = assumeJewel(data, "Sapphire", { terms: ["fire", "spell"], defence: ["energy shield"] })!;
    expect(jewel.raw).toMatch(/^Rarity: RARE\nAssumed Jewel\nSapphire\n/);
    expect(jewel.mods.length).toBe(3);
    expect(jewel.mods.some((m) => /Energy Shield/i.test(m))).toBe(true);
  });
});

describe.skipIf(!hasCache || !enginePaths)("jewels and compare mode (engine)", () => {
  const engine = enginePaths ? new PobEngine(enginePaths) : undefined;
  afterAll(() => engine?.stop());

  it("puts budget jewels in allocated sockets, and chosen jewels first", async () => {
    const data = await loadGameData();
    const tree = new PassiveTree(data.nodes);
    const witch = data.classes.find((c) => c.name === "Witch")!;
    const dist = tree.distancesFrom(witch.startNode);
    const socket = [...tree.nodes].filter(([k, n]) => n.isJewelSocket && dist.has(k)).sort((a, b) => dist.get(a[0])! - dist.get(b[0])!)[0]![0];
    const base = {
      cls: witch,
      level: 40,
      passives: [socket],
      skills: [{ gem: findGem(data, "Fireball") }],
      gear: { kind: "budget" as const, terms: ["fire", "spell"], defence: ["energy shield" as const] },
      tree,
    };
    const assumed = await evaluateBuild(engine!, data, base);
    expect(assumed.assumedGear.some((g) => g.slot === "Jewel socket" && g.base === "Sapphire")).toBe(true);

    const chosen = await evaluateBuild(engine!, data, { ...base, items: [{ raw: "Rarity: RARE\nMy Jewel\nRuby\n+40 to maximum Life", slot: "Jewel" }] });
    expect(chosen.itemsUsed.some((i) => /jewel socket/.test(i))).toBe(true);
    expect(chosen.assumedGear.some((g) => g.slot.startsWith("Jewel"))).toBe(false);
  }, 60_000);

  it("compares variants and says which is best", async () => {
    const data = await loadGameData();
    const tree = new PassiveTree(data.nodes);
    const warrior = data.classes.find((c) => c.name === "Warrior")!;
    const common = { cls: warrior, ascendancyName: "Titan", ascendancyId: "Warrior1", level: 40, passives: [], skills: [{ gem: findGem(data, "Boneshatter") }], tree };
    const result = await compareBuilds(engine!, data, [
      { label: "two-handed", input: { ...common, gear: { kind: "budget", terms: ["physical"], defence: ["armour"], weapons: ["Two Hand Mace"] } } },
      { label: "shield", input: { ...common, gear: { kind: "budget", terms: ["physical"], defence: ["armour"], weapons: ["One Hand Mace", "Shield"] } } },
    ]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[1]!.vsFirst?.clearDps).toMatch(/%$/);
    expect(["two-handed", "shield"]).toContain(result.best.clearing);
  }, 60_000);
});
