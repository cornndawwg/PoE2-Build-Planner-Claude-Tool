import { describe, expect, it } from "vitest";
import { parseLuaData } from "../src/data/lua.js";
import { parseUnique, parseUniqueFile } from "../src/data/uniques.js";

const carnageHeart = `
Carnage Heart
Amber Amulet
Variant: Pre 0.4.0
Variant: Pre 0.5.0
Variant: Current
Implicits: 1
{tags:attribute}+(10-15) to Strength
{tags:life}20% reduced maximum Life
{tags:fire,cold,lightning}+(10-20)% to all Elemental Resistances
{variant:1}{tags:life}100% increased amount of Life Leeched
{variant:2,3}{tags:life}(100-200)% increased amount of Life Leeched
{variant:3}(25-50)% increased Damage while Leeching
`;

describe("parseUnique", () => {
  it("keeps only the current variant's lines", () => {
    const item = parseUnique(carnageHeart)!;
    expect(item.name).toBe("Carnage Heart");
    expect(item.baseType).toBe("Amber Amulet");
    expect(item.implicits).toEqual(["+(10-15) to Strength"]);
    expect(item.mods).toEqual([
      "20% reduced maximum Life",
      "+(10-20)% to all Elemental Resistances",
      "(100-200)% increased amount of Life Leeched",
      "(25-50)% increased Damage while Leeching",
    ]);
    expect(item.tags.sort()).toEqual(["attribute", "cold", "fire", "life", "lightning"]);
  });

  it("reads level requirement and source, and handles no variants", () => {
    const item = parseUnique(`Choir of the Storm
Jade Amulet
Source: Drops from unique{Xesht, We That Are One} in normal{Twisted Domain}
Requires Level 55
Implicits: 0
Critical Hits [Shock|Shock] enemies`)!;
    expect(item.requiredLevel).toBe(55);
    expect(item.source).toBe("Drops from Xesht, We That Are One in Twisted Domain");
    expect(item.mods).toEqual(["Critical Hits Shock enemies"]);
  });

  it("picks the current variant's base, even when bases come after headers", () => {
    const bases = new Set(["Furtive Wraps", "Spiral Wraps"]);
    const item = parseUnique(
      `Hand of Wisdom and Action
Variant: Pre 0.2.0
Variant: Current
Source: Drops from unique{Xesht}
{variant:1}Furtive Wraps
{variant:2}Spiral Wraps
+(15-25) to Dexterity
{variant:1}3% increased Attack Speed per 20 Dexterity
{variant:2}1% increased Attack Speed per 20 Dexterity`,
      (n) => bases.has(n),
    )!;
    expect(item.baseType).toBe("Spiral Wraps");
    expect(item.implicits).toEqual([]);
    expect(item.mods).toEqual(["+(15-25) to Dexterity", "1% increased Attack Speed per 20 Dexterity"]);
  });

  it("filters by version as well as variant", () => {
    const item = parseUnique(`Idol of Uldurn
Crimson Amulet
Version: Pre 0.5.0
Version: Current
Implicits: 1
(2-4) Life Regeneration per second
{version:2}(10-15)% increased Spirit
{version:1}Old line`)!;
    expect(item.mods).toEqual(["(10-15)% increased Spirit"]);
  });

  it("parses a PoB file of long strings", () => {
    const file = parseLuaData(`-- Item data (c) Grinding Gear Games
return {
-- Amulet
[[${carnageHeart}]],[[
Beacon of Azis
Solar Amulet
Implicits: 1
+(10-15) to Spirit
+30 to Spirit
]],
}`);
    expect(parseUniqueFile(file).map((u) => u.name)).toEqual(["Carnage Heart", "Beacon of Azis"]);
  });
});
