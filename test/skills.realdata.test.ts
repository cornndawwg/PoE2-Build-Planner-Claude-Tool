// Checks against the real downloaded game data. Skipped when the cache hasn't been
// populated yet (run `npm run data:summary` once to download it).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { defaultCacheDir } from "../src/data/cache.js";
import { ALL_SOURCES } from "../src/data/sources.js";
import { loadGameData, type GameData } from "../src/data/gamedata.js";
import { canSupport, compatibleSupports, searchSkills, skillOf } from "../src/skills/skills.js";

const hasCache = Object.values(ALL_SOURCES).every((s) => existsSync(join(defaultCacheDir(), s.file)));

describe.skipIf(!hasCache)("skills against real data", () => {
  let data: GameData;
  beforeAll(async () => {
    data = await loadGameData();
  });

  const gem = (name: string) => {
    const found = [...data.playerGems.values()].find((g) => g.name === name && g.source !== "item");
    if (!found) throw new Error(`no gem ${name}`);
    return found;
  };

  it("has no test or placeholder gems", () => {
    const names = [...data.playerGems.values()].map((g) => g.name);
    expect(names.some((n) => /^\[DNT|^Playtest|^Coming Soon$/.test(n))).toBe(false);
  });

  it("labels weapon default attacks as item skills and leaves them out of searches by default", () => {
    const defaults = [...data.playerGems.values()].filter((g) => g.gameId.includes("PlayerDefault"));
    expect(defaults.length).toBeGreaterThan(0);
    expect(defaults.every((g) => g.source === "item")).toBe(true);
    expect(searchSkills(data, { require: ["bow"], limit: 500 }).map((r) => r.name)).not.toContain("Bow Shot");
  });

  it("keeps the game's exact id spelling", () => {
    expect(gem("Fireball").gameId).toBe("Metadata/Items/Gem/SkillGemFireball");
  });

  it("finds Fireball for a fire spell projectile search, once", () => {
    const results = searchSkills(data, { require: ["fire", "spell"], prefer: ["projectile"] });
    expect(results.filter((r) => r.name === "Fireball")).toHaveLength(1);
    expect(results.every((r) => r.tags.includes("fire"))).toBe(true);
  });

  it("filters by weapon", () => {
    expect(gem("Boneshatter").weaponRequirements.some((w) => w.includes("Mace"))).toBe(true);
    const bow = searchSkills(data, { weapon: "bow", require: ["attack"], limit: 500 });
    expect(bow.map((r) => r.name)).toContain("Lightning Arrow");
    expect(bow.map((r) => r.name)).not.toContain("Boneshatter");
  });

  it("recommends the game's own suggested supports first for Fireball", () => {
    const fireball = gem("Fireball");
    const supports = compatibleSupports(data, fireball.gameId);
    expect(supports.length).toBeGreaterThan(10);
    expect(new Set(fireball.gem.recommended_supports).has(supports[0]!.gameId)).toBe(true);
  });

  it("never offers a support that can't support the skill", () => {
    for (const name of ["Fireball", "Lightning Arrow", "Boneshatter"]) {
      const g = gem(name);
      const active = skillOf(data, g)!;
      for (const s of compatibleSupports(data, g.gameId, { limit: 1000 })) {
        expect(canSupport(skillOf(data, data.playerGems.get(s.gameId)!)!, active).ok).toBe(true);
      }
    }
  });
});

describe.skipIf(!hasCache)("support families", () => {
  it("offers one support per family and lists the rest as alternatives", async () => {
    const data = await loadGameData();
    const fireball = [...data.playerGems.values()].find((g) => g.name === "Fireball")!;
    const supports = compatibleSupports(data, fireball.gameId, { limit: 1000 });
    const families = supports.map((s) => data.playerGems.get(s.gameId)!.family).filter(Boolean);
    expect(new Set(families).size).toBe(families.length);
    const ignite = supports.find((s) => data.playerGems.get(s.gameId)!.family === "Ignite");
    expect(ignite?.alternatives.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasCache)("gem lookup", () => {
  it("accepts the exact id, the other Gem/Gems spelling, or the name", async () => {
    const data = await loadGameData();
    const { findGem } = await import("../src/skills/skills.js");
    const id = "Metadata/Items/Gem/SkillGemFireball";
    expect(findGem(data, id).gameId).toBe(id);
    expect(findGem(data, "Metadata/Items/Gems/SkillGemFireball").gameId).toBe(id);
    expect(findGem(data, "fireball").gameId).toBe(id);
    expect(findGem(data, "Ignite II").kind).toBe("support");
    expect(() => findGem(data, "Not A Gem")).toThrow(/Unknown gem/);
  });

  it("finds every cuttable gem by name, and asks for an id when names are ambiguous", async () => {
    const data = await loadGameData();
    const { findGem } = await import("../src/skills/skills.js");
    for (const gem of data.playerGems.values()) {
      if (gem.source !== "item") expect(findGem(data, gem.name).gameId).toBe(gem.gameId);
    }
    // Two item-granted skills share this name.
    expect(() => findGem(data, "Lightning Bolt")).toThrow(/matches several gems/);
  });
});
