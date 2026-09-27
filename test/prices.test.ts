// Currency Exchange prices and small parsers, without the network.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseSkillAmuletBases, tradeTemplate } from "../src/data/pobextra.js";
import { buildPrices, DIVINE, EXALTED, formatPrice, getPrices, mainLeague } from "../src/prices/exchange.js";

const RUNE = "Metadata/Items/SoulCores/DesertRune";
const OMEN = "Metadata/Items/Currency/SomeOmen";
const market = (league: string, a: string, b: string, va: number, vb: number) => ({ league, market_pair: [a, b] as [string, string], volume_traded: { [a]: va, [b]: vb } });
const markets = [
  market("Rites", DIVINE, EXALTED, 10, 5000), // 1 div = 500 ex
  market("Rites", RUNE, EXALTED, 100, 1200), // 12 ex
  market("Rites", OMEN, DIVINE, 50, 300), // 6 div = 3000 ex, only through Divine
  market("Standard", RUNE, EXALTED, 1, 1),
  market("Rites", DIVINE, RUNE, 1, 40),
];

describe("prices", () => {
  it("values items in Exalted Orbs, directly or through Divine", () => {
    const { exalted, volume } = buildPrices(markets, "Rites");
    expect(exalted[EXALTED]).toBe(1);
    expect(exalted[DIVINE]).toBe(500);
    expect(exalted[RUNE]).toBe(12);
    expect(exalted[OMEN]).toBe(3000);
    expect(volume[RUNE]).toBe(140);
  });

  it("picks the busiest league that isn't Standard or Hardcore", () => {
    expect(mainLeague(markets)).toBe("Rites");
    expect(mainLeague([market("Standard", RUNE, EXALTED, 1, 1), market("HC Rites", RUNE, EXALTED, 1, 1), market("HC Rites", OMEN, EXALTED, 1, 1)])).toBeUndefined();
  });

  it("formats prices in ex or div", () => {
    expect(formatPrice(12.34)).toBe("12 ex");
    expect(formatPrice(0.25)).toBe("0.25 ex");
    expect(formatPrice(3000, 500)).toBe("6.0 div");
    expect(formatPrice(undefined)).toBeUndefined();
  });

  const dirs: string[] = [];
  afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

  it("fetches the last full hour, skips empty hours, and caches", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "prices-"));
    dirs.push(cacheDir);
    const urls: string[] = [];
    const now = () => new Date("2026-09-27T12:30:00Z");
    const fetchImpl = async (url: string) => {
      urls.push(url);
      const hour = Number(url.split("/").pop());
      const body = { markets: hour === Date.parse("2026-09-27T11:00:00Z") / 1000 ? [] : markets };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const table = await getPrices({ cacheDir, fetchImpl, now });
    expect(table.league).toBe("Rites");
    expect(table.hour).toBe(Date.parse("2026-09-27T10:00:00Z") / 1000);
    expect(table.exalted[RUNE]).toBe(12);
    expect(urls).toHaveLength(2);
    await getPrices({ cacheDir, fetchImpl, now });
    expect(urls).toHaveLength(2); // from cache
  });

  it("reports HTTP errors", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "prices-"));
    dirs.push(cacheDir);
    await expect(getPrices({ cacheDir, fetchImpl: async () => new Response("", { status: 503 }) })).rejects.toThrow(/503/);
  });
});

describe("parsers", () => {
  it("makes trade stat templates", () => {
    expect(tradeTemplate("+23% to Fire Resistance")).toBe("#% to fire resistance");
    expect(tradeTemplate("Adds 4 to 9 Fire Damage")).toBe("adds # to # fire damage");
  });

  it("reads amulet bases whose skills cost no Spirit", () => {
    const text = [
      "local itemBases = ...",
      'itemBases["Lament Amulet"] = {\n\ttype = "Amulet",\n\timplicit = "-1 Prefix Modifier allowed\\nGrants Skill: {variant} Level 10",\n\tvariantList = { "Herald of Ash", "Herald of Ice", },\n\tgrantedSkillsHaveNoReservation = true,\n\treq = { level = 40, },\n}',
      'itemBases["Gold Amulet"] = {\n\ttype = "Amulet",\n\treq = { level = 8, },\n}',
    ].join("\n");
    expect(parseSkillAmuletBases(text)).toEqual([{ name: "Lament Amulet", level: 40, cost: ["-1 Prefix Modifier allowed"], skills: ["Herald of Ash", "Herald of Ice"] }]);
  });
});
