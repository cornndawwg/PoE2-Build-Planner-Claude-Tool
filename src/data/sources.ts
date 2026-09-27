// Public game data the tool downloads on the player's machine.
// Nothing here is bundled or redistributed with the tool.

const REPOE = "https://repoe-fork.github.io/poe2/";

/**
 * Path of Building PoE2 git ref for data files. Should match the PoB checkout used
 * for calculations once that is pinned; "dev" tracks the latest game data until then.
 */
export const POB_REF = "dev";
const POB = `https://raw.githubusercontent.com/PathOfBuildingCommunity/PathOfBuilding-PoE2/${POB_REF}/src/Data/`;

export interface DataSource {
  url: string;
  /** File name inside the cache directory. */
  file: string;
  /** "text" files are downloaded as-is (validated by their own parser when loaded). */
  format: "json" | "lua" | "text";
  description: string;
}

export const SOURCES = {
  tree: {
    url: "https://raw.githubusercontent.com/grindinggear/poe2-skilltree-export/main/data.json",
    file: "tree.json",
    format: "json",
    description: "GGG passive tree export",
  },
  skillGems: {
    url: `${REPOE}skill_gems.min.json`,
    file: "skill_gems.json",
    format: "json",
    description: "RePoE skill and support gems",
  },
  skills: {
    url: `${REPOE}skills.min.json`,
    file: "skills.json",
    format: "json",
    description: "RePoE skill definitions",
  },
  baseItems: {
    url: `${REPOE}base_items.min.json`,
    file: "base_items.json",
    format: "json",
    description: "RePoE item bases",
  },
  mods: {
    url: `${REPOE}mods.min.json`,
    file: "mods.json",
    format: "json",
    description: "RePoE modifiers",
  },
  pobGems: {
    url: `${POB}Gems.lua`,
    file: "pob_gems.lua",
    format: "lua",
    description: "Path of Building gem list",
  },
  pobRunes: {
    url: `${POB}ModRunes.lua`,
    file: "pob_runes.lua",
    format: "lua",
    description: "Path of Building runes, soul cores and other socketables",
  },
  pobQueryMods: {
    url: `${POB}QueryMods.lua`,
    file: "pob_query_mods.lua",
    format: "lua",
    description: "Path of Building trade-site stat ids",
  },
  pobAmuletBases: {
    url: `${POB}Bases/amulet.lua`,
    file: "pob_bases_amulet.lua",
    format: "text",
    description: "Path of Building amulet bases (granted skills)",
  },
  pobQuestRewards: {
    url: `${POB}QuestRewards.lua`,
    file: "pob_quest_rewards.lua",
    format: "lua",
    description: "Path of Building quest rewards",
  },
} as const satisfies Record<string, DataSource>;

/** Path of Building's unique item files that hold wearable gear. */
export const UNIQUE_FILES = [
  "amulet", "belt", "body", "boots", "bow", "crossbow", "flask", "focus", "gloves", "helmet", "jewel",
  "mace", "quiver", "ring", "sceptre", "shield", "spear", "staff", "talisman", "wand",
] as const;

export const UNIQUE_SOURCES: Record<string, DataSource> = Object.fromEntries(
  UNIQUE_FILES.map((name) => [
    `uniques:${name}`,
    { url: `${POB}Uniques/${name}.lua`, file: `pob_uniques_${name}.lua`, format: "lua", description: `Path of Building uniques (${name})` },
  ]),
);

/** Everything the tool downloads, keyed by a short name. */
export const ALL_SOURCES: Record<string, DataSource> = { ...SOURCES, ...UNIQUE_SOURCES };

export const SOURCE_KEYS = Object.keys(ALL_SOURCES);
