import type { TreeNode } from "../data/types.js";
import { stripMarkup } from "../text.js";

export const ASCENDANCY_POINTS = 8;
/** Passive points from character levels (levels 2–100). Quest points come on top. */
export const LEVEL_POINTS = 99;

export type NodeKind = "keystone" | "notable" | "jewel-socket" | "attribute" | "small" | "ascendancy-notable" | "ascendancy-small" | "choice";

export interface AllocatedNode {
  /** Tree export key (numeric skill hash as a string). */
  key: string;
  /** String id used by GGG's .build files. */
  id: string;
  name: string;
  kind: NodeKind;
  stats: string[];
  /** The target this node was taken to reach. */
  forTarget: string;
}

export interface PathPlan {
  /** Nodes in the order to take them (start node excluded). */
  nodes: AllocatedNode[];
  /** Targets that couldn't be reached (wrong ascendancy, locked, or not on this tree). */
  unreachable: string[];
}

export function nodeKind(node: TreeNode): NodeKind {
  if (node.ascendancyId) return node.isNotable ? "ascendancy-notable" : "ascendancy-small";
  if (node.isKeystone) return "keystone";
  if (node.isNotable) return "notable";
  if (node.isJewelSocket) return "jewel-socket";
  if (node.isGenericAttribute) return "attribute";
  if (node.isMultipleChoiceOption) return "choice";
  return "small";
}

export class PassiveTree {
  private readonly adjacency = new Map<string, string[]>();

  constructor(readonly nodes: ReadonlyMap<string, TreeNode>) {
    for (const [key, node] of nodes) {
      if (key === "root") continue;
      for (const other of [...(node.out ?? []), ...(node.in ?? [])]) {
        if (other === "root" || !nodes.has(other)) continue;
        this.link(key, other);
      }
    }
  }

  private link(a: string, b: string) {
    for (const [from, to] of [[a, b], [b, a]] as const) {
      const list = this.adjacency.get(from) ?? [];
      if (!list.includes(to)) list.push(to);
      this.adjacency.set(from, list);
    }
  }

  neighbors(key: string): readonly string[] {
    return this.adjacency.get(key) ?? [];
  }

  /** Can this node be allocated with main-tree points by a character with this ascendancy? */
  isMainTreeNode(key: string, ascendancyId?: string): boolean {
    const node = this.nodes.get(key);
    if (!node || key === "root" || node.ascendancyId || node.isMastery || node.classStartIndex) return false;
    const required = node.unlockConstraint?.ascendancy;
    return !required || required === ascendancyId;
  }

  /** Multiple-choice options are picked at the end of a path, never walked through. */
  private canPassThrough(key: string, ascendancyId?: string): boolean {
    return this.isMainTreeNode(key, ascendancyId) && !this.nodes.get(key)?.isMultipleChoiceOption;
  }

  /**
   * Breadth-first search from every allocated node at once. Returns each reachable node's
   * distance (points needed) and the node it was reached from.
   */
  private searchFrom(
    allocated: ReadonlySet<string>,
    passable: (key: string) => boolean,
    endpoint: (key: string) => boolean,
  ): Map<string, { dist: number; prev: string | undefined }> {
    const seen = new Map<string, { dist: number; prev: string | undefined }>();
    const queue: string[] = [];
    for (const key of allocated) {
      seen.set(key, { dist: 0, prev: undefined });
      queue.push(key);
    }
    for (let i = 0; i < queue.length; i++) {
      const key = queue[i]!;
      const { dist } = seen.get(key)!;
      // Only allocated nodes and pass-through nodes can extend a path.
      if (!allocated.has(key) && !passable(key)) continue;
      for (const next of this.neighbors(key)) {
        if (seen.has(next) || !(passable(next) || endpoint(next))) continue;
        seen.set(next, { dist: dist + 1, prev: key });
        queue.push(next);
      }
    }
    return seen;
  }

  /** Points needed to reach each main-tree node from the class start. */
  distancesFrom(startKey: string, ascendancyId?: string): Map<string, number> {
    const found = this.searchFrom(
      new Set([startKey]),
      (k) => this.canPassThrough(k, ascendancyId),
      (k) => this.isMainTreeNode(k, ascendancyId),
    );
    return new Map([...found].map(([k, v]) => [k, v.dist]));
  }

  /**
   * Connect the start to every target, always taking the cheapest remaining target next
   * (a greedy Steiner-tree approximation). The order doubles as a leveling order.
   */
  planMainTree(startKey: string, targets: string[], ascendancyId?: string): PathPlan {
    return this.plan(
      new Set([startKey]),
      targets,
      (k) => this.canPassThrough(k, ascendancyId),
      (k) => this.isMainTreeNode(k, ascendancyId),
    );
  }

  /** Path from the ascendancy's start node to the chosen ascendancy nodes. */
  planAscendancy(ascendancyId: string, targets: string[]): PathPlan {
    const start = [...this.nodes].find(([, n]) => n.isAscendancyStart && n.ascendancyId === ascendancyId)?.[0];
    if (!start) return { nodes: [], unreachable: targets };
    const inAscendancy = (k: string) => this.nodes.get(k)?.ascendancyId === ascendancyId;
    return this.plan(new Set([start]), targets, inAscendancy, inAscendancy);
  }

  private plan(
    start: Set<string>,
    targets: string[],
    passable: (key: string) => boolean,
    endpoint: (key: string) => boolean,
  ): PathPlan {
    const allocated = new Set(start);
    const remaining = new Set(targets.filter((t) => !allocated.has(t)));
    const order: AllocatedNode[] = [];
    const unreachable: string[] = [];

    while (remaining.size > 0) {
      const found = this.searchFrom(allocated, passable, endpoint);
      let best: string | undefined;
      for (const target of remaining) {
        const hit = found.get(target);
        if (!hit) continue;
        if (best === undefined || hit.dist < found.get(best)!.dist) best = target;
      }
      if (best === undefined) {
        unreachable.push(...remaining);
        break;
      }
      const path: string[] = [];
      for (let k: string | undefined = best; k !== undefined && !allocated.has(k); k = found.get(k)?.prev) path.unshift(k);
      for (const key of path) {
        allocated.add(key);
        remaining.delete(key);
        order.push(this.describe(key, best));
      }
    }
    return { nodes: order, unreachable };
  }

  describe(key: string, forTarget = key): AllocatedNode {
    const node = this.nodes.get(key)!;
    return {
      key,
      id: node.id ?? key,
      name: node.name ?? "",
      kind: nodeKind(node),
      stats: (node.stats ?? []).map(stripMarkup),
      forTarget,
    };
  }
}

/** Passive points available at a character level: one per level after 1, plus quest points earned by then. */
export function pointsAtLevel(level: number, quests: readonly { areaLevel: number; points: number }[]): number {
  const questPoints = quests.filter((q) => q.areaLevel <= level).reduce((sum, q) => sum + q.points, 0);
  return Math.min(level, 100) - 1 + questPoints;
}

export interface LeveledNode extends AllocatedNode {
  /** Character level at which this node's point is available, if taken in plan order. */
  level: number | undefined;
}

/** Attach the level each node can be taken at, allocating in plan order. */
export function withLevels(
  plan: PathPlan,
  quests: readonly { areaLevel: number; points: number }[],
  alreadySpent = 0,
): LeveledNode[] {
  return plan.nodes.map((node, i) => ({ ...node, level: levelForPoint(alreadySpent + i + 1, quests) }));
}

/** The character level at which the nth passive point becomes available (undefined if never). */
export function levelForPoint(n: number, quests: readonly { areaLevel: number; points: number }[]): number | undefined {
  for (let level = 1; level <= 100; level++) if (pointsAtLevel(level, quests) >= n) return level;
  return undefined;
}

const classTrees = new WeakMap<PassiveTree, Map<string, PassiveTree>>();

/**
 * The tree as a class (and ascendancy) sees it: some passives near the shared starting areas are
 * different for Druid, Witch, Huntress or an ascendancy (e.g. Druid's "Guardian of the Wilds" in
 * place of "Relentless Vindicator"). An ascendancy's version wins over the class's.
 */
export function treeForClass(
  base: PassiveTree,
  variants: ReadonlyMap<string, Record<string, { name: string; stats: string[] }>>,
  className?: string,
  ascendancyName?: string,
): PassiveTree {
  if (!variants.size || (!className && !ascendancyName)) return base;
  const cacheKey = `${className ?? ""}|${ascendancyName ?? ""}`;
  const cache = classTrees.get(base) ?? new Map<string, PassiveTree>();
  classTrees.set(base, cache);
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  let changed = false;
  const nodes = new Map(base.nodes);
  for (const [key, options] of variants) {
    const variant = (ascendancyName && options[ascendancyName]) || (className && options[className]);
    const node = nodes.get(key);
    if (!variant || !node) continue;
    nodes.set(key, { ...node, name: variant.name, stats: variant.stats });
    changed = true;
  }
  const tree = changed ? new PassiveTree(nodes) : base;
  cache.set(cacheKey, tree);
  return tree;
}
