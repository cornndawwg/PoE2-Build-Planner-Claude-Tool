// Checks against the real downloaded game data; skipped until the cache is populated.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { defaultCacheDir } from "../src/data/cache.js";
import { loadGameData, type GameData } from "../src/data/gamedata.js";
import { ALL_SOURCES } from "../src/data/sources.js";
import { findUniques } from "../src/gear/uniques.js";

const hasCache = Object.values(ALL_SOURCES).every((s) => existsSync(join(defaultCacheDir(), s.file)));

describe.skipIf(!hasCache)("uniques against real data", () => {
  let data: GameData;
  beforeAll(async () => {
    data = await loadGameData();
  });

  it("loads hundreds of uniques, each with a known item class", () => {
    expect(data.uniques.length).toBeGreaterThan(300);
    expect(data.uniques.every((u) => u.itemClass)).toBe(true);
  });

  it("finds fire uniques for a slot and respects level and avoid", () => {
    const amulets = findUniques(data, { terms: ["fire"], slots: ["Amulet"] });
    expect(amulets.length).toBeGreaterThan(0);
    expect(amulets.every((u) => u.itemClass === "Amulet")).toBe(true);
    const low = findUniques(data, { terms: ["fire"], maxRequiredLevel: 20, limit: 100 });
    expect(low.every((u) => (u.requiredLevel ?? 0) <= 20)).toBe(true);
    const noAttack = findUniques(data, { terms: ["fire"], avoid: ["attack"], limit: 100 });
    expect(noAttack.some((u) => /\battacks?\b/i.test([...u.implicits, ...u.mods].join(" ")))).toBe(false);
  });

  it("rejects unknown slots clearly", () => {
    expect(() => findUniques(data, { terms: ["fire"], slots: ["Hat"] })).toThrow(/Unknown slot/);
  });
});
