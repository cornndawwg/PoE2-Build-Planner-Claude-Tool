// Checks against the real downloaded game data. Skipped when the cache hasn't been
// populated yet (run `npm run data:summary` once to download it).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { defaultCacheDir } from "../src/data/cache.js";
import { SOURCES } from "../src/data/sources.js";
import { loadGameData, type GameData } from "../src/data/gamedata.js";
import { canSupport, compatibleSupports, searchSkills, skillOf } from "../src/skills/skills.js";

const hasCache = Object.values(SOURCES).every((s) => existsSync(join(defaultCacheDir(), s.file)));

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
