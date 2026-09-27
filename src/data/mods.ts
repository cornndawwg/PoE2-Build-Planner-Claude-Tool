import type { BaseItem, Mod } from "./types.js";

/**
 * The spawn weight a mod has on an item with these tags.
 * The game walks the mod's spawn_weights in order and uses the first tag the item has.
 */
export function spawnWeight(mod: Pick<Mod, "spawn_weights">, itemTags: Iterable<string>): number {
  const tags = new Set(itemTags);
  tags.add("default");
  for (const { tag, weight } of mod.spawn_weights) {
    if (tags.has(tag)) return weight;
  }
  return 0;
}

/** Random prefix/suffix mods that can roll on a base (PoE2 weights only say can / can't). */
export function rollableMods(mods: Record<string, Mod>, base: Pick<BaseItem, "tags">, domains = ["item", "misc"]): Mod[] {
  return Object.values(mods).filter(
    (mod) =>
      (mod.generation_type === "prefix" || mod.generation_type === "suffix") &&
      domains.includes(mod.domain) &&
      !mod.is_essence_only &&
      spawnWeight(mod, base.tags) > 0,
  );
}
