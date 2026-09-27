// Public game data the tool downloads on the player's machine.
// Nothing here is bundled or redistributed with the tool.

const REPOE = "https://repoe-fork.github.io/poe2/";

export interface DataSource {
  url: string;
  /** File name inside the cache directory. */
  file: string;
  description: string;
}

export const SOURCES = {
  tree: {
    url: "https://raw.githubusercontent.com/grindinggear/poe2-skilltree-export/main/data.json",
    file: "tree.json",
    description: "GGG passive tree export",
  },
  skillGems: {
    url: `${REPOE}skill_gems.min.json`,
    file: "skill_gems.json",
    description: "RePoE skill and support gems",
  },
  skills: {
    url: `${REPOE}skills.min.json`,
    file: "skills.json",
    description: "RePoE skill definitions",
  },
  baseItems: {
    url: `${REPOE}base_items.min.json`,
    file: "base_items.json",
    description: "RePoE item bases",
  },
  mods: {
    url: `${REPOE}mods.min.json`,
    file: "mods.json",
    description: "RePoE modifiers",
  },
} as const satisfies Record<string, DataSource>;

export type SourceKey = keyof typeof SOURCES;

export const SOURCE_KEYS = Object.keys(SOURCES) as SourceKey[];
