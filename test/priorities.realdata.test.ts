// Checks against the real downloaded game data; skipped until the cache is populated.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { defaultCacheDir } from "../src/data/cache.js";
import { loadGameData, type GameData } from "../src/data/gamedata.js";
import { ALL_SOURCES } from "../src/data/sources.js";
import { statPriorities, type DefenceStyle } from "../src/gear/priorities.js";

const hasCache = Object.values(ALL_SOURCES).every((s) => existsSync(join(defaultCacheDir(), s.file)));

describe.skipIf(!hasCache)("stat priorities against real data", () => {
  let data: GameData;
  beforeAll(async () => {
    data = await loadGameData();
  });

  const fireCaster = (extra: { defence?: DefenceStyle[]; itemLevel?: number } = {}) =>
    statPriorities(data, {
      terms: ["fire", "spell", "cast speed", "critical"],
      avoid: ["attack"],
      slots: ["Amulet", "Ring", "Wand", "Helmet", "Jewel"],
      ...extra,
    });
  type Result = ReturnType<typeof fireCaster>;
  const texts = (r: Result, slot: string, part: "offence" | "defence" = "offence") =>
    r[part].find((s) => s.slot === slot)!.mods.map((m) => m.tier);

  it("puts spell levels and spell damage on an amulet for a fire caster", () => {
    const amulet = texts(fireCaster(), "Amulet");
    expect(amulet.some((t) => /Level of all Spell Skills/.test(t))).toBe(true);
    expect(amulet.some((t) => /Spell Damage/.test(t))).toBe(true);
  });

  it("keeps resistances out of offence but keeps penetration", () => {
    const r = fireCaster();
    for (const slot of r.offence) expect(slot.mods.some((m) => /to Fire Resistance/.test(m.tier))).toBe(false);
    expect(texts(r, "Jewel").some((t) => /Penetrates/.test(t))).toBe(true);
  });

  it("drops other elements and avoided words", () => {
    const wand = texts(fireCaster(), "Wand");
    expect(wand.some((t) => /Chaos Spell|Physical Spell/.test(t))).toBe(false);
    expect(wand.some((t) => /Attacks/.test(t))).toBe(false);
    expect(wand[0]).toMatch(/Fire Spell Skills/);
  });

  it("reports a defence baseline per slot, without armour break or shield-only mods", () => {
    const r = fireCaster();
    expect(texts(r, "Ring", "defence").length).toBeGreaterThan(0);
    for (const slot of r.defence) expect(slot.mods.some((m) => /break|equipped shield/i.test(m.tier))).toBe(false);
  });

  it("matches the defence baseline to the build's defence style", () => {
    const es = fireCaster({ defence: ["energy shield"] });
    const helmet = texts(es, "Helmet", "defence");
    expect(helmet.length).toBeGreaterThan(0);
    expect(helmet.some((t) => /Evasion|Armour/.test(t))).toBe(false);
    expect(helmet.some((t) => /Energy Shield|Resistance/.test(t))).toBe(true);
  });

  it("shows the best tier that can roll at an item level, and the end-game tier", () => {
    const early = fireCaster({ itemLevel: 20 });
    const all = [...early.offence, ...early.defence].flatMap((s) => s.mods);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((m) => m.tierItemLevel <= 20)).toBe(true);
    expect(all.some((m) => m.bestTier && (m.bestTierItemLevel ?? 0) > 20)).toBe(true);
    // "+5 to Level of all Fire Spell Skills" needs a high item level, so it shouldn't show at 20.
    expect(texts(early, "Wand").some((t) => /\+5 to Level/.test(t))).toBe(false);
  });
});
