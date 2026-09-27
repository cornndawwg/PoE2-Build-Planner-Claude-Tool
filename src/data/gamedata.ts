import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultCacheDir } from "./cache.js";
import { SOURCES } from "./sources.js";
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

export interface GameData {
  /** Keyed by skill hash (string), as in the tree export. */
  nodes: Map<string, TreeNode>;
  classes: PlayableClass[];
  /** Released gems, keyed by metadata id. */
  gems: Map<string, SkillGem>;
  skills: Record<string, Skill>;
  baseItems: Record<string, BaseItem>;
  mods: Record<string, Mod>;
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

export async function loadGameData(cacheDir: string = defaultCacheDir()): Promise<GameData> {
  const [tree, gems, skills, baseItems, mods] = await Promise.all([
    readJson<TreeExport>(cacheDir, SOURCES.tree.file),
    readJson<Record<string, SkillGem>>(cacheDir, SOURCES.skillGems.file),
    readJson<Record<string, Skill>>(cacheDir, SOURCES.skills.file),
    readJson<Record<string, BaseItem>>(cacheDir, SOURCES.baseItems.file),
    readJson<Record<string, Mod>>(cacheDir, SOURCES.mods.file),
  ]);

  const releasedGems = new Map(
    Object.entries(gems).filter(([, gem]) => gem.base_item.release_state === "released"),
  );

  return {
    nodes: new Map(Object.entries(tree.nodes)),
    classes: playableClasses(tree),
    gems: releasedGems,
    skills,
    baseItems,
    mods,
  };
}
