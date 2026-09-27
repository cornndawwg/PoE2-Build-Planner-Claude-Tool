import { describe, expect, it } from "vitest";
import { rollableMods, spawnWeight } from "../src/data/mods.js";
import type { Mod } from "../src/data/types.js";

function mod(partial: Partial<Mod> & Pick<Mod, "spawn_weights">): Mod {
  return {
    name: "",
    domain: "misc",
    generation_type: "prefix",
    type: "T",
    groups: [],
    required_level: 1,
    stats: [],
    ...partial,
  };
}

describe("spawnWeight", () => {
  it("uses the first tag the item has, in the mod's order", () => {
    const m = mod({ spawn_weights: [{ tag: "two_hand_weapon", weight: 0 }, { tag: "mace", weight: 1 }, { tag: "default", weight: 0 }] });
    expect(spawnWeight(m, ["mace", "two_hand_weapon"])).toBe(0);
    expect(spawnWeight(m, ["mace", "one_hand_weapon"])).toBe(1);
    expect(spawnWeight(m, ["sword"])).toBe(0);
  });

  it("treats every item as having the default tag", () => {
    const m = mod({ spawn_weights: [{ tag: "default", weight: 1 }] });
    expect(spawnWeight(m, [])).toBe(1);
  });
});

describe("rollableMods", () => {
  const mods: Record<string, Mod> = {
    a: mod({ spawn_weights: [{ tag: "jewel", weight: 1 }] }),
    b: mod({ spawn_weights: [{ tag: "strjewel", weight: 1 }, { tag: "default", weight: 0 }] }),
    c: mod({ spawn_weights: [{ tag: "jewel", weight: 1 }], generation_type: "unique" }),
    d: mod({ spawn_weights: [{ tag: "jewel", weight: 1 }], is_essence_only: true }),
    e: mod({ spawn_weights: [{ tag: "jewel", weight: 1 }], domain: "monster" }),
  };

  it("keeps rollable prefixes/suffixes in item domains only", () => {
    expect(rollableMods(mods, { tags: ["jewel", "strjewel"] }).length).toBe(2);
    expect(rollableMods(mods, { tags: ["jewel", "intjewel"] }).length).toBe(1);
  });
});
