// Class-specific passives (from Path of Building's tree) and following PoB's latest tree version.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultCacheDir } from "../src/data/cache.js";
import { loadGameData } from "../src/data/gamedata.js";
import { parseLuaData } from "../src/data/lua.js";
import { parseNodeVariants } from "../src/data/pobextra.js";
import { ALL_SOURCES, latestTreeVersion } from "../src/data/sources.js";
import type { TreeNode } from "../src/data/types.js";
import { PassiveTree, treeForClass } from "../src/tree/tree.js";

describe("tree versions", () => {
  it("follows the last entry of PoB's tree version list", () => {
    expect(latestTreeVersion('treeVersionList = { "0_1", "0_2", "0_5" }\nlatestTreeVersion = x')).toBe("0_5");
    expect(latestTreeVersion('treeVersionList = { "0_5", "0_6" }')).toBe("0_6");
    expect(latestTreeVersion("nothing here")).toBeUndefined();
  });

  it("reads Lua files that start with a byte-order mark", () => {
    expect(parseLuaData("﻿return { a = 1 }")).toEqual({ a: 1 });
  });
});

describe("class-specific passives", () => {
  const lua = `return { nodes = {
    [6898] = { name = "Relentless Vindicator", options = {
      Druid = { name = "Guardian of the Wilds", stats = { [1] = "10% increased Damage", [2] = "Gain 5% of Damage as Extra Damage of a random Element" } },
      ["Abyssal Lich"] = { name = "Lich Thing", stats = { [1] = "Something" } },
    } },
    [100] = { name = "+5 to any Attribute", options = { [1] = { name = "Strength", stats = { [1] = "+5 to Strength" } } } },
    [200] = { name = "Plain" },
  } }`;
  const variants = parseNodeVariants(parseLuaData(lua));

  it("keeps class and ascendancy options, not attribute choices", () => {
    expect([...variants.keys()]).toEqual(["6898"]);
    expect(variants.get("6898")!.Druid!.name).toBe("Guardian of the Wilds");
    expect(variants.get("6898")!["Abyssal Lich"]!.stats).toEqual(["Something"]);
  });

  const nodes = new Map<string, TreeNode>([
    ["6898", { id: "templar_druid_notable1", name: "Relentless Vindicator", stats: ["10% increased Critical Hit Chance"], out: ["200"] }],
    ["200", { id: "plain", name: "Plain", stats: [] }],
  ]);
  const base = new PassiveTree(nodes);

  it("shows each class its own version", () => {
    expect(treeForClass(base, variants, "Druid").describe("6898").name).toBe("Guardian of the Wilds");
    expect(treeForClass(base, variants, "Warrior")).toBe(base);
    expect(treeForClass(base, variants, "Witch", "Abyssal Lich").describe("6898").name).toBe("Lich Thing");
    expect(treeForClass(base, variants, "Druid")).toBe(treeForClass(base, variants, "Druid")); // cached
  });

  it("keeps ids and connections", () => {
    const druid = treeForClass(base, variants, "Druid");
    expect(druid.describe("6898").id).toBe("templar_druid_notable1");
    expect(druid.neighbors("6898")).toEqual(["200"]);
  });
});

const hasCache = Object.values(ALL_SOURCES).every((s) => existsSync(join(defaultCacheDir(), s.file)));

describe.skipIf(!hasCache)("class-specific passives (real data)", () => {
  it("a Druid sees Guardian of the Wilds where others see Relentless Vindicator", async () => {
    const data = await loadGameData();
    const base = new PassiveTree(data.nodes);
    const key = [...data.nodes].find(([, n]) => n.name === "Relentless Vindicator")![0];
    expect(treeForClass(base, data.nodeVariants, "Druid").describe(key).name).toBe("Guardian of the Wilds");
    expect(treeForClass(base, data.nodeVariants, "Warrior").describe(key).name).toBe("Relentless Vindicator");
  });
});
