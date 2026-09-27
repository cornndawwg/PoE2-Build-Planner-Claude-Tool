// Checks against the real downloaded game data; skipped until the cache is populated.
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defaultCacheDir } from "../src/data/cache.js";
import { loadGameData, type GameData } from "../src/data/gamedata.js";
import { ALL_SOURCES } from "../src/data/sources.js";
import { AUTHOR, buildFileName, toBuildFile, writeBuildFile, type BuildPlan } from "../src/export/buildFile.js";
import { canSupport, skillOf } from "../src/skills/skills.js";
import { PassiveTree } from "../src/tree/tree.js";

const hasCache = Object.values(ALL_SOURCES).every((s) => existsSync(join(defaultCacheDir(), s.file)));

describe.skipIf(!hasCache)(".build export against real data", () => {
  let data: GameData;
  let plan: BuildPlan;
  beforeAll(async () => {
    data = await loadGameData();
    const tree = new PassiveTree(data.nodes);
    const witch = data.classes.find((c) => c.name === "Witch")!;
    const infernalist = witch.ascendancies.find((a) => a.name === "Infernalist")!;
    const notable = [...tree.nodes].find(([, n]) => n.name === "Potent Incantation")![0];
    const path = tree.planMainTree(witch.startNode, [notable], infernalist.id);
    const gem = (name: string) => [...data.playerGems.values()].find((g) => g.name === name && g.source === "uncut-gem")!.gameId;
    plan = {
      name: "Fireball Infernalist {test}",
      ascendancyId: infernalist.id,
      passives: path.nodes.map((n, i) => ({ id: n.id, level: i + 2 })),
      skills: [{ gemId: gem("Fireball"), note: "Main skill {use this}", supports: [{ gemId: gem("Fire Mastery") }] }],
      slots: [{ slot: "Amulet", title: "Any Amulet", priorities: ["+ Level of all Spell Skills", "Cast Speed"] }],
    };
  });

  it("produces a build in GGG's format", () => {
    const { build, warnings } = toBuildFile(data, plan);
    expect(warnings).toEqual([]);
    expect(build.author).toBe(AUTHOR);
    expect(build.ascendancy).toBe("Witch1");
    expect(build.passives!.length).toBe(plan.passives.length);
    expect(build.passives![0]).toMatchObject({ level_interval: [2, 100] });
    const skill = build.skills![0] as { id: string; support_skills: string[]; additional_text: string };
    expect(skill.id).toBe("Metadata/Items/Gem/SkillGemFireball");
    expect(skill.support_skills).toHaveLength(1);
    expect(skill.additional_text).toBe("Main skill use this"); // braces would break markup
    expect(build.inventory_slots![0]).toMatchObject({ inventory_id: "Amulet1" });
    expect(build.inventory_slots![0]!.additional_text).toContain("1. + Level of all Spell Skills");
  });

  it("rejects unknown ids and passives from another ascendancy", () => {
    expect(() => toBuildFile(data, { ...plan, passives: [{ id: "not_a_node" }] })).toThrow(/Unknown passive/);
    const titanNode = [...data.nodes.values()].find((n) => n.ascendancyId === "Warrior1" && n.id)!;
    expect(() => toBuildFile(data, { ...plan, passives: [{ id: titanNode.id! }] })).toThrow(/belongs to ascendancy/);
    expect(() => toBuildFile(data, { ...plan, slots: [{ slot: "Hat" }] })).toThrow(/Unknown slot/);
  });

  it("refuses supports that can't support the skill, before writing anything", () => {
    const fireball = skillOf(data, data.playerGems.get(plan.skills[0]!.gemId)!)!;
    const incompatible = [...data.playerGems.values()].find(
      (g) => g.kind === "support" && g.source === "uncut-gem" && !canSupport(skillOf(data, g)!, fireball).ok,
    )!;
    expect(() => toBuildFile(data, { ...plan, skills: [{ ...plan.skills[0]!, supports: [{ gemId: incompatible.gameId }] }] })).toThrow(
      /can't support/,
    );
  });

  describe("writing", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "poe2bf-build-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("writes a safe file name and can replace its own file", async () => {
      const { build } = toBuildFile(data, plan);
      const path = await writeBuildFile(build, dir);
      expect(path.endsWith(buildFileName(build.name))).toBe(true);
      expect(JSON.parse(await readFile(path, "utf8")).name).toBe(build.name);
      await expect(writeBuildFile(build, dir)).resolves.toBe(path);
    });

    it("won't replace a file it didn't write", async () => {
      const { build } = toBuildFile(data, plan);
      await writeFile(join(dir, buildFileName(build.name)), JSON.stringify({ name: "mine", author: "Someone" }));
      await expect(writeBuildFile(build, dir)).rejects.toThrow(/wasn't made by this tool/);
      await expect(writeBuildFile(build, dir, true)).resolves.toContain(dir);
    });
  });
});

describe.skipIf(!hasCache)("support family warning", () => {
  it("refuses two supports from one family on a skill", async () => {
    const data = await loadGameData();
    const byName = (n: string) => [...data.playerGems.values()].find((g) => g.name === n)!.gameId;
    expect(() =>
      toBuildFile(data, {
        name: "x",
        passives: [],
        skills: [{ gemId: byName("Fireball"), supports: [{ gemId: byName("Ignite I") }, { gemId: byName("Ignite II") }] }],
      }),
    ).toThrow(/same support family/);
  });
});

describe.skipIf(!hasCache)("export accepts gem names", () => {
  it("resolves skill and support names to the game's ids", async () => {
    const data = await loadGameData();
    const { build } = toBuildFile(data, { name: "x", passives: [], skills: [{ gemId: "Fireball", supports: [{ gemId: "Fiery Death" }] }] });
    const skill = build.skills![0] as { id: string; support_skills: string[] };
    expect(skill.id).toBe("Metadata/Items/Gem/SkillGemFireball");
    expect(skill.support_skills[0]).toMatch(/SupportGemFieryDeath$/);
  });
});
