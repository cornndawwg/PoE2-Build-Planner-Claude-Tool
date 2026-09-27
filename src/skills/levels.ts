import type { PlayerGem } from "../data/gamedata.js";

/**
 * Character level needed for each skill gem level (index 0 = gem level 1). The same table is used
 * by every active skill in Path of Building's skill data (levelRequirement), checked 2026-09-26.
 */
export const GEM_LEVEL_REQUIREMENT = [0, 3, 6, 10, 14, 18, 22, 26, 31, 36, 41, 46, 52, 58, 64, 66, 72, 78, 84, 90];

/** Highest skill gem level a character of this level can use. */
export function gemLevelForCharacter(characterLevel: number): number {
  let gemLevel = 1;
  GEM_LEVEL_REQUIREMENT.forEach((req, i) => {
    if (req <= characterLevel) gemLevel = i + 1;
  });
  return gemLevel;
}

/**
 * Earliest character level a skill can be used, for skills cut from uncut gems: a skill's tier is the
 * lowest uncut skill gem level that can become it. Undefined for item-granted skills and supports.
 */
export function availableFromLevel(gem: PlayerGem): number | undefined {
  if (gem.kind === "support" || gem.source !== "uncut-gem" || gem.tier < 1) return undefined;
  // Tier 1 gems need character level 0 in the table, i.e. usable from the start (level 1).
  return Math.max(1, GEM_LEVEL_REQUIREMENT[Math.min(gem.tier, GEM_LEVEL_REQUIREMENT.length) - 1]!);
}
