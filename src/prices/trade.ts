// Pre-filled trade site searches the player opens themselves. The tool never calls the trade site;
// it only builds a link (https://www.pathofexile.com/trade2/search/poe2/<league>?q=<query>), the
// same way Path of Building opens searches in the browser.

import type { GameData } from "../data/gamedata.js";
import { tradeTemplate } from "../data/pobextra.js";

/** Item class (RePoE) → trade site category, as Path of Building maps them. */
const CATEGORY: Record<string, string> = {
  Helmet: "armour.helmet",
  "Body Armour": "armour.chest",
  Gloves: "armour.gloves",
  Boots: "armour.boots",
  Amulet: "accessory.amulet",
  Ring: "accessory.ring",
  Belt: "accessory.belt",
  Shield: "armour.shield",
  Buckler: "armour.buckler",
  Focus: "armour.focus",
  Quiver: "armour.quiver",
  Wand: "weapon.wand",
  Staff: "weapon.staff",
  Sceptre: "weapon.sceptre",
  Bow: "weapon.bow",
  Crossbow: "weapon.crossbow",
  "One Hand Mace": "weapon.onemace",
  "Two Hand Mace": "weapon.twomace",
  Spear: "weapon.spear",
  Warstaff: "weapon.warstaff",
  Quarterstaff: "weapon.warstaff",
  Talisman: "weapon.talisman",
  Jewel: "jewel",
  LifeFlask: "flask.life",
  ManaFlask: "flask.mana",
};

export interface TradeLink {
  url: string;
  /** Stats included in the search. */
  searchesFor: string[];
  /** Stats the trade site's stat list didn't match (left out of the search). */
  leftOut: string[];
}

const encodeLeague = (league: string) => encodeURIComponent(league).replace(/%20/g, "+");
const baseUrl = (league: string) => `https://www.pathofexile.com/trade2/search/poe2/${encodeLeague(league)}`;

/** Average of the numbers in a mod line ("Adds 4 to 9 Fire Damage" → 6.5, "+23% to …" → 23). */
function modValue(text: string): number | undefined {
  const numbers = [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  return numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : undefined;
}

/**
 * A search for a rare item: the slot's category, the level the character can wear, and each mod at
 * `strictness` (default 80%) of its value or better, cheapest first.
 */
export function rareSearchLink(
  data: GameData,
  opts: { league: string; itemClass: string; mods: string[]; maxLevel?: number; strictness?: number },
): TradeLink {
  const strictness = opts.strictness ?? 0.8;
  const filters: { id: string; value?: { min: number } }[] = [];
  const searchesFor: string[] = [];
  const leftOut: string[] = [];
  for (const mod of opts.mods) {
    const id = data.tradeStats.get(tradeTemplate(mod));
    if (!id) {
      leftOut.push(mod);
      continue;
    }
    const value = modValue(mod);
    filters.push(value === undefined ? { id } : { id, value: { min: Math.floor(value * strictness) } });
    searchesFor.push(mod);
  }
  const category = CATEGORY[opts.itemClass];
  const query = {
    query: {
      status: { option: "online" },
      filters: {
        type_filters: { filters: { ...(category ? { category: { option: category } } : {}), rarity: { option: "nonunique" } } },
        ...(opts.maxLevel ? { req_filters: { filters: { lvl: { max: opts.maxLevel } } } } : {}),
      },
      stats: [{ type: "and", filters }],
    },
    sort: { price: "asc" },
  };
  return { url: `${baseUrl(opts.league)}?q=${encodeURIComponent(JSON.stringify(query))}`, searchesFor, leftOut };
}

/** A search for a unique by name. */
export function uniqueSearchLink(data: GameData, opts: { league: string; name: string }): TradeLink {
  const unique = data.uniques.find((u) => u.name.toLowerCase() === opts.name.toLowerCase());
  const query = {
    query: { status: { option: "online" }, name: unique?.name ?? opts.name, ...(unique ? { type: unique.baseType } : {}) },
    sort: { price: "asc" },
  };
  return { url: `${baseUrl(opts.league)}?q=${encodeURIComponent(JSON.stringify(query))}`, searchesFor: [unique?.name ?? opts.name], leftOut: [] };
}

/** Item class of a base type name. */
export function itemClassOfBase(data: GameData, baseName: string): string | undefined {
  return Object.values(data.baseItems).find((b) => b.name === baseName)?.item_class;
}
