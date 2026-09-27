// Regression tests for bugs reported from real chats (2026-09-27). Skipped without game data;
// engine tests also need the Path of Building engine in vendor/.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkBuild } from "../src/build/checks.js";
import { validateSkills } from "../src/build/validate.js";
import { defaultCacheDir } from "../src/data/cache.js";
import { loadGameData, type GameData } from "../src/data/gamedata.js";
import { ALL_SOURCES } from "../src/data/sources.js";
import { evaluateBuild } from "../src/engine/evaluate.js";
import { findEngine, PobEngine } from "../src/engine/pob.js";
import { toBuildFile } from "../src/export/buildFile.js";
import { guidesDir } from "../src/guide/guide.js";
import { findGem, searchSkills } from "../src/skills/skills.js";
import { completePassives } from "../src/tree/complete.js";
import { PassiveTree } from "../src/tree/tree.js";

const hasCache = Object.values(ALL_SOURCES).every((s) => existsSync(join(defaultCacheDir(), s.file)));
const enginePaths = findEngine();

describe("guides are written where they can be found", () => {
  it("uses Documents, not AppData (which the Store app redirects)", () => {
    const saved = process.env.POE2BF_GUIDES_DIR;
    delete process.env.POE2BF_GUIDES_DIR;
    const dir = guidesDir();
    if (saved !== undefined) process.env.POE2BF_GUIDES_DIR = saved;
    expect(dir).toMatch(/PoE2 Build Planner[\\/]guides$/);
    expect(dir).not.toMatch(/AppData/i);
  });
});

describe.skipIf(!hasCache)("rule and path fixes", () => {
  let data: GameData;
  let tree: PassiveTree;
  beforeAll(async () => {
    data = await loadGameData();
    tree = new PassiveTree(data.nodes);
  });

  const warrior = () => data.classes.find((c) => c.name === "Warrior")!;
  const notable = (name: string) => [...tree.nodes].find(([, n]) => n.name === name && !n.ascendancyId)![0];

  it("check_build and export_build agree: Corrosion can't support Sunder", () => {
    const skills = [{ gem: findGem(data, "Sunder"), supports: [findGem(data, "Corrosion")] }];
    const check = checkBuild(data, data.nodes, { cls: warrior(), passives: [], skills, characterLevel: 44 });
    expect(check.skillIssues.some((i) => i.severity === "error" && /Corrosion can't support Sunder/.test(i.message))).toBe(true);
    expect(() => toBuildFile(data, { name: "x", passives: [], skills: [{ gemId: "Sunder", supports: [{ gemId: "Corrosion" }] }] })).toThrow(
      /Corrosion can't support Sunder/,
    );
  });

  it("warns when a support turns off crits and the tree invests in crit", () => {
    const critNode = [...data.nodes.values()].find((n) => n.isNotable && (n.stats ?? []).some((s) => /critical/i.test(s)))!;
    const issues = validateSkills(data, [{ gem: findGem(data, "Fireball"), supports: [findGem(data, "Controlled Destruction")] }], [critNode]);
    expect(issues.some((i) => i.severity === "warning" && /critical hits/i.test(i.message))).toBe(true);
  });

  it("fills in connecting passives when only notables are given", () => {
    const target = notable("Potent Incantation");
    const witch = data.classes.find((c) => c.name === "Witch")!;
    const completed = completePassives(tree, witch.startNode, [target]);
    expect(completed.main).toContain(target);
    expect(completed.added.length).toBeGreaterThan(0);
    const full = tree.planMainTree(witch.startNode, [target]).nodes.map((n) => n.key);
    expect(completePassives(tree, witch.startNode, full).added).toEqual([]); // already connected: unchanged
  });

  it("counts weapon requirements, tripled by Giant's Blood", () => {
    const giantsBlood = [...tree.nodes].find(([, n]) => n.name === "Giant's Blood")![0];
    const path = tree.planMainTree(warrior().startNode, [giantsBlood]).nodes.map((n) => n.key);
    const skills = [{ gem: findGem(data, "Boneshatter") }];
    const plain = checkBuild(data, data.nodes, { cls: warrior(), passives: [], skills, characterLevel: 80, weapons: ["Two Hand Mace"] });
    const tripled = checkBuild(data, data.nodes, { cls: warrior(), passives: path, skills, characterLevel: 80, weapons: ["Two Hand Mace"] });
    expect(plain.weapons[0]!.requirement.str).toBeGreaterThan(100);
    expect(tripled.weapons[0]!.multiplier).toBe(3);
    expect(tripled.attributes.required.str).toBe(plain.weapons[0]!.requirement.str * 3);
  });

  it("finds skills by words in their description", () => {
    const poison = searchSkills(data, { text: ["poison"], limit: 50 });
    expect(poison.length).toBeGreaterThan(3);
    expect(poison.every((s) => /poison/i.test(s.description))).toBe(true);
  });
});

describe.skipIf(!hasCache || !enginePaths)("evaluate_build fixes (engine)", () => {
  const engine = enginePaths ? new PobEngine(enginePaths) : undefined;
  afterAll(() => engine?.stop());

  it("connects floating notables, spends attribute nodes, and uses chosen uniques", async () => {
    const data = await loadGameData();
    const tree = new PassiveTree(data.nodes);
    const merc = data.classes.find((c) => c.name === "Mercenary")!;
    const dist = tree.distancesFrom(merc.startNode);
    const attributeNodes = [...tree.nodes].filter(([k, n]) => n.isGenericAttribute && dist.has(k)).sort((a, b) => dist.get(a[0])! - dist.get(b[0])!).slice(0, 3).map(([k]) => k);
    const result = await evaluateBuild(engine!, data, {
      cls: merc,
      ascendancyName: "Witchhunter",
      ascendancyId: "Mercenary2",
      level: 40,
      passives: attributeNodes, // floating: no path given
      skills: [{ gem: findGem(data, "Crossbow Shot") }],
      items: [{ unique: "Plaguefinger" }],
      gear: { kind: "budget", terms: ["poison", "projectile"], defence: ["evasion"] },
      tree,
    });
    expect(result.passives.addedToConnect.length).toBeGreaterThan(0);
    const spent = result.attributes.flexibleNodes;
    expect(spent.str + spent.dex + spent.int).toBe(3);
    expect(result.itemsUsed.some((i) => /Plaguefinger \(Gloves\)/.test(i))).toBe(true);
    expect(result.assumedGear.some((g) => g.slot === "Gloves")).toBe(false);
    expect(result.clear.breakdown.poison ?? 0).toBeGreaterThan(0);
  }, 60_000);
});
