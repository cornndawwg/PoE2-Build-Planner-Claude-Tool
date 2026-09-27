// Checks against the real downloaded game data; skipped until the cache is populated.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { defaultCacheDir } from "../src/data/cache.js";
import { loadGameData, type GameData } from "../src/data/gamedata.js";
import { ALL_SOURCES } from "../src/data/sources.js";
import { statPriorities } from "../src/gear/priorities.js";

const hasCache = Object.values(ALL_SOURCES).every((s) => existsSync(join(defaultCacheDir(), s.file)));

describe.skipIf(!hasCache)("stat priorities against real data", () => {
  let data: GameData;
  beforeAll(async () => {
    data = await loadGameData();
  });

  const fireCaster = () =>
    statPriorities(data, {
      terms: ["fire", "spell", "cast speed", "critical"],
      avoid: ["attack"],
      slots: ["Amulet", "Ring", "Wand", "Jewel"],
    });
  const texts = (r: ReturnType<typeof fireCaster>, slot: string) =>
    r.offence.find((s) => s.slot === slot)!.mods.map((m) => m.bestTier);

  it("puts spell levels and spell damage on an amulet for a fire caster", () => {
    const amulet = texts(fireCaster(), "Amulet");
    expect(amulet.some((t) => /Level of all Spell Skills/.test(t))).toBe(true);
    expect(amulet.some((t) => /Spell Damage/.test(t))).toBe(true);
  });

  it("keeps resistances out of offence but keeps penetration", () => {
    const r = fireCaster();
    for (const slot of r.offence) expect(slot.mods.some((m) => /to Fire Resistance/.test(m.bestTier))).toBe(false);
    expect(texts(r, "Jewel").some((t) => /Penetrates/.test(t))).toBe(true);
  });

  it("drops other elements and avoided words", () => {
    const wand = texts(fireCaster(), "Wand");
    expect(wand.some((t) => /Chaos Spell|Physical Spell/.test(t))).toBe(false);
    expect(wand.some((t) => /Attacks/.test(t))).toBe(false);
    expect(wand[0]).toMatch(/Fire Spell Skills/);
  });

  it("reports a defence baseline per slot", () => {
    const r = fireCaster();
    expect(r.defence.find((s) => s.slot === "Ring")!.mods.length).toBeGreaterThan(0);
  });
});
