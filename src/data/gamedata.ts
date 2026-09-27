import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultCacheDir } from "./cache.js";
import { parseLuaData } from "./lua.js";
import { parseUniqueFile, type UniqueItem } from "./uniques.js";
import { SOURCES, UNIQUE_SOURCES } from "./sources.js";
import type { BaseItem, Mod, Skill, SkillGem, TreeExport, TreeNode } from "./types.js";

export interface PlayableAscendancy {
  /** Id used in .build files and on tree nodes, e.g. "Witch1". */
  id: string;
  name: string;
}

export interface PlayableClass {
  /** Index into the tree export's class list (used by classStartIndex). */
  index: number;
  name: string;
  baseStr: number;
  baseDex: number;
  baseInt: number;
  /** Tree node key (skill hash) where this class starts. */
  startNode: string;
  ascendancies: PlayableAscendancy[];
}

/** How a player gets a skill or support. */
export type GemSource =
  | "uncut-gem" // cut from an uncut skill/support/spirit gem
  | "item" // granted by an item (weapon/shield/sceptre base or a unique)
  | "lineage" // lineage support: rare drop
  | "special"; // other supports that don't come from uncut gems

/** A gem a player can use, from Path of Building's curated list joined with RePoE. */
export interface PlayerGem {
  /** The game's metadata id (exact Gem/ vs Gems/ spelling), as used in .build files. */
  gameId: string;
  name: string;
  kind: "active" | "support" | "spirit";
  source: GemSource;
  /** PoB "Tier": 0 for non-uncut gems; higher tiers unlock later. */
  tier: number;
  /** Weapon types the skill needs, e.g. ["One Hand Mace", "Two Hand Mace"]. Empty = no requirement. */
  weaponRequirements: string[];
  tags: string[];
  grantedEffectId: string;
  /** Supports in the same family (e.g. all Ignite tiers) can't go on the same skill together. */
  family?: string;
  gem: SkillGem;
}

export interface GameData {
  /** Keyed by skill hash (string), as in the tree export. */
  nodes: Map<string, TreeNode>;
  classes: PlayableClass[];
  /** All released gems from RePoE, keyed by metadata id. Includes test and internal entries. */
  gems: Map<string, SkillGem>;
  /** Gems players can actually use, keyed by gameId. Use this for anything player-facing. */
  playerGems: Map<string, PlayerGem>;
  skills: Record<string, Skill>;
  baseItems: Record<string, BaseItem>;
  mods: Record<string, Mod>;
  /** Unique items (current version), with the item class of their base. */
  uniques: (UniqueItem & { itemClass?: string })[];
  /** Quests that grant passive points, with the area level they're done at. */
  questPoints: { areaLevel: number; points: number; quest: string }[];
}

interface PobQuestReward {
  Act: number;
  Area?: string;
  Info?: string;
  AreaLevel: number;
  questPoints?: number;
}

async function readJson<T>(dir: string, file: string): Promise<T> {
  return JSON.parse(await readFile(join(dir, file), "utf8")) as T;
}

/**
 * Classes a player can pick: the PoE1-era classes still present in the export
 * have no ascendancies, and unreleased ascendancies have a null name.
 */
export function playableClasses(tree: Pick<TreeExport, "classes" | "nodes">): PlayableClass[] {
  const startByIndex = new Map<number, string>();
  for (const [key, node] of Object.entries(tree.nodes)) {
    for (const index of node.classStartIndex ?? []) startByIndex.set(index, key);
  }

  return tree.classes.flatMap((cls, index) => {
    const ascendancies = cls.ascendancies
      .filter((a): a is PlayableAscendancy => typeof a.name === "string" && a.name.length > 0)
      .map(({ id, name }) => ({ id, name }));
    const startNode = startByIndex.get(index);
    if (ascendancies.length === 0 || startNode === undefined) return [];
    return [
      {
        index,
        name: cls.name,
        baseStr: cls.base_str,
        baseDex: cls.base_dex,
        baseInt: cls.base_int,
        startNode,
        ascendancies,
      },
    ];
  });
}

interface PobGemEntry {
  name: string;
  gameId: string;
  grantedEffectId: string;
  Tier: number;
  weaponRequirements?: string;
  tags?: Record<string, boolean>;
  gemFamily?: string;
}

/**
 * Join Path of Building's gem list (which leaves out test, placeholder and weapon-default
 * entries) with RePoE's gem data. Entries without a RePoE match or a skill are dropped.
 */
export function buildPlayerGems(
  pobGems: Record<string, PobGemEntry>,
  gems: Map<string, SkillGem>,
  skills: Record<string, Skill>,
): Map<string, PlayerGem> {
  const result = new Map<string, PlayerGem>();
  for (const entry of Object.values(pobGems)) {
    const gem = gems.get(entry.gameId);
    if (!gem || !skills[entry.grantedEffectId]) continue;
    const kind = gem.gem_type === "support" ? "support" : gem.gem_type === "spirit" ? "spirit" : "active";
    const source: GemSource =
      entry.Tier > 0 ? "uncut-gem" : kind !== "support" ? "item" : gem.is_lineage ? "lineage" : "special";
    result.set(entry.gameId, {
      gameId: entry.gameId,
      name: entry.name,
      kind,
      source,
      tier: entry.Tier,
      weaponRequirements: (entry.weaponRequirements ?? "").split(",").map((w) => w.trim()).filter(Boolean),
      tags: Object.keys(entry.tags ?? {}).filter((t) => t !== "grants_active_skill"),
      grantedEffectId: entry.grantedEffectId,
      family: entry.gemFamily,
      gem,
    });
  }
  return result;
}

export async function loadGameData(cacheDir: string = defaultCacheDir()): Promise<GameData> {
  const [tree, gems, skills, baseItems, mods, pobGemsSrc, questSrc] = await Promise.all([
    readJson<TreeExport>(cacheDir, SOURCES.tree.file),
    readJson<Record<string, SkillGem>>(cacheDir, SOURCES.skillGems.file),
    readJson<Record<string, Skill>>(cacheDir, SOURCES.skills.file),
    readJson<Record<string, BaseItem>>(cacheDir, SOURCES.baseItems.file),
    readJson<Record<string, Mod>>(cacheDir, SOURCES.mods.file),
    readFile(join(cacheDir, SOURCES.pobGems.file), "utf8"),
    readFile(join(cacheDir, SOURCES.pobQuestRewards.file), "utf8"),
  ]);
  const quests = parseLuaData(questSrc) as unknown as PobQuestReward[];
  const classOfBase = new Map(Object.values(baseItems).map((b) => [b.name, b.item_class]));
  const isBase = (name: string) => classOfBase.has(name);
  const uniqueFiles = await Promise.all(
    Object.values(UNIQUE_SOURCES).map(async (src) =>
      parseUniqueFile(parseLuaData(await readFile(join(cacheDir, src.file), "utf8")), isBase),
    ),
  );

  const releasedGems = new Map(
    Object.entries(gems).filter(([, gem]) => gem.base_item.release_state === "released"),
  );
  const pobGems = parseLuaData(pobGemsSrc) as unknown as Record<string, PobGemEntry>;

  return {
    nodes: new Map(Object.entries(tree.nodes)),
    classes: playableClasses(tree),
    gems: releasedGems,
    playerGems: buildPlayerGems(pobGems, releasedGems, skills),
    skills,
    baseItems,
    mods,
    uniques: uniqueFiles.flat().map((u) => ({ ...u, itemClass: classOfBase.get(u.baseType) })),
    questPoints: quests
      .filter((q) => (q.questPoints ?? 0) > 0)
      .map((q) => ({ areaLevel: q.AreaLevel, points: q.questPoints!, quest: `Act ${q.Act}: ${q.Info ?? q.Area ?? ""}` }))
      .sort((a, b) => a.areaLevel - b.areaLevel),
  };
}
