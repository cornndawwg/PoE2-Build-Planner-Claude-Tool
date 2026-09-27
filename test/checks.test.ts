import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  availableFromLevel,
  checkBuild,
  gemAttributeRequirement,
  gemLevelForCharacter,
  nodeAttributes,
  nodeSpirit,
} from "../src/build/checks.js";
import { defaultCacheDir } from "../src/data/cache.js";
import { loadGameData } from "../src/data/gamedata.js";
import { ALL_SOURCES } from "../src/data/sources.js";
import { findGem } from "../src/skills/skills.js";
import { PassiveTree } from "../src/tree/tree.js";

describe("gem levels", () => {
  it("maps character level to the highest usable gem level", () => {
    expect(gemLevelForCharacter(1)).toBe(1);
    expect(gemLevelForCharacter(6)).toBe(3);
    expect(gemLevelForCharacter(35)).toBe(9);
    expect(gemLevelForCharacter(90)).toBe(20);
    expect(gemLevelForCharacter(100)).toBe(20);
  });

  it("matches Path of Building's attribute requirement formula", () => {
    expect(gemAttributeRequirement(1, 100)).toBe(0); // under 8 rounds to no requirement
    expect(gemAttributeRequirement(20, 100)).toBe(Math.round(5 + 17 * 1.7) + 4);
    expect(gemAttributeRequirement(20, 0)).toBe(0);
    expect(gemAttributeRequirement(20, 50)).toBeLessThan(gemAttributeRequirement(20, 100));
  });
});

describe("passive stats", () => {
  it("reads flat attributes and spirit from stat text", () => {
    expect(nodeAttributes({ stats: ["+10 to [Strength|Strength]"] })).toEqual({ str: 10, dex: 0, int: 0 });
    expect(nodeAttributes({ stats: ["+5 to all Attributes"] })).toEqual({ str: 5, dex: 5, int: 5 });
    expect(nodeAttributes({ stats: ["+8 to Strength and Intelligence"] })).toEqual({ str: 8, dex: 0, int: 8 });
    expect(nodeAttributes({ stats: ["10% increased Strength"] })).toEqual({ str: 0, dex: 0, int: 0 });
    expect(nodeSpirit({ stats: ["+30 to [Spirit|Spirit]"] })).toBe(30);
  });
});

const hasCache = Object.values(ALL_SOURCES).every((s) => existsSync(join(defaultCacheDir(), s.file)));

describe.skipIf(!hasCache)("checkBuild against real data", () => {
  it("reports availability, attributes, spirit and budget", async () => {
    const data = await loadGameData();
    const tree = new PassiveTree(data.nodes);
    const witch = data.classes.find((c) => c.name === "Witch")!;
    const fireball = findGem(data, "Fireball");
    const herald = findGem(data, "Herald of Ash");
    expect(availableFromLevel(fireball)).toBe(6); // tier 3 = gem level 3 = character level 6
    expect(data.questSpirit.reduce((s, q) => s + q.spirit, 0)).toBeGreaterThanOrEqual(100);

    const early = checkBuild(data, data.nodes, { cls: witch, passives: [], skills: [{ gem: fireball }, { gem: herald }], characterLevel: 4 });
    expect(early.skills[0]!.usableNow).toBe(false);
    expect(early.warnings.join()).toMatch(/Fireball can't be used until level 6/);
    expect(early.spirit.reserved).toBe(30);
    expect(early.spirit.shortfall).toBe(30); // no Spirit from quests yet

    const potent = [...tree.nodes].find(([, n]) => n.name === "Potent Incantation")![0];
    const plan = tree.planMainTree(witch.startNode, [potent]);
    const late = checkBuild(data, data.nodes, {
      cls: witch,
      passives: plan.nodes.map((n) => n.key),
      skills: [{ gem: fireball }],
      characterLevel: 90,
    });
    expect(late.points.overBudget).toBe(false);
    expect(late.attributes.required.int).toBeGreaterThan(late.attributes.fromClass.int);

    const tooMany = checkBuild(data, data.nodes, { cls: witch, passives: new Array(200).fill(potent), skills: [], characterLevel: 90 });
    expect(tooMany.points.overBudget).toBe(true);
  });
});

describe.skipIf(!hasCache)("leveling phases", () => {
  it("covers levels 1-90 in order with growing budgets", async () => {
    const { levelingPhases } = await import("../src/build/phases.js");
    const phases = levelingPhases(await loadGameData());
    expect(phases[0]!.name).toBe("Act 1");
    expect(phases[0]!.levels[0]).toBe(1);
    expect(phases.at(-1)!.levels[1]).toBe(90);
    for (let i = 1; i < phases.length; i++) {
      expect(phases[i]!.levels[0]).toBe(phases[i - 1]!.levels[1] + 1);
      expect(phases[i]!.passivePoints).toBeGreaterThanOrEqual(phases[i - 1]!.passivePoints);
    }
    expect(phases[0]!.questRewards.some((r) => r.reward === "+30 to Spirit")).toBe(true);
  });
});
