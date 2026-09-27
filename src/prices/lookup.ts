// Item names → Currency Exchange prices.

import type { GameData } from "../data/gamedata.js";
import type { PriceLookup } from "../gear/extras.js";
import { DIVINE, formatPrice, type PriceTable } from "./exchange.js";

/** Lower-cased item name → metadata id, for every base item. */
export function idsByName(data: GameData): Map<string, string> {
  const ids = new Map<string, string>();
  for (const [id, base] of Object.entries(data.baseItems)) {
    const key = base.name?.toLowerCase();
    if (key && !ids.has(key)) ids.set(key, id);
  }
  return ids;
}

export function priceLookup(data: GameData, table: PriceTable): PriceLookup {
  const ids = idsByName(data);
  return (name) => {
    const id = ids.get(name.toLowerCase());
    return id ? table.exalted[id] : undefined;
  };
}

export interface ItemPrice {
  name: string;
  exalted?: number;
  price?: string;
  /** Units traded in the hour; low volume means a rough price. */
  tradedLastHour?: number;
  note?: string;
}

export function itemPrices(data: GameData, table: PriceTable, names: string[]): ItemPrice[] {
  const ids = idsByName(data);
  const divine = table.exalted[DIVINE];
  return names.map((name) => {
    const id = ids.get(name.toLowerCase());
    if (!id) return { name, note: "Not a known item name." };
    const exalted = table.exalted[id];
    if (exalted === undefined) return { name, note: "Not traded on the Currency Exchange this hour (uniques and rares aren't; use trade_links)." };
    return {
      name: data.baseItems[id]?.name ?? name,
      exalted: Math.round(exalted * 100) / 100,
      price: formatPrice(exalted, divine),
      tradedLastHour: table.volume[id],
    };
  });
}
