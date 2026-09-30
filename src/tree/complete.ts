import type { PassiveTree } from "./tree.js";

export interface CompletedPassives {
  /** Main-tree passives including any connecting nodes that were missing. */
  main: string[];
  /** Ascendancy passives including connecting nodes. */
  ascendancy: string[];
  /** Names of connecting passives that were added. */
  added: string[];
  /** Passives that can't be reached from this class (or belong to another ascendancy). */
  unreachable: string[];
}

/**
 * Make a passive list a connected tree: keep what was given, add the cheapest connecting nodes,
 * and split main-tree from ascendancy nodes. Lists that are already connected come back unchanged.
 */
export function completePassives(tree: PassiveTree, startKey: string, keys: string[], ascendancyId?: string): CompletedPassives {
  const unique = [...new Set(keys)];
  const mainGiven = unique.filter((k) => !tree.nodes.get(k)?.ascendancyId);
  const ascGiven = unique.filter((k) => tree.nodes.get(k)?.ascendancyId);
  const wrongAscendancy = ascGiven.filter((k) => tree.nodes.get(k)!.ascendancyId !== ascendancyId);

  // Planning to every given node (they're all targets) returns them plus the missing connectors.
  // Gated passives (e.g. Oracle-only ones) count only if their unlocking ascendancy node is taken.
  const ascTargets = ascGiven.filter((k) => !wrongAscendancy.includes(k));
  const ascPlan = ascendancyId && ascTargets.length ? tree.planAscendancy(ascendancyId, ascTargets) : { nodes: [], unreachable: [] };
  const mainPlan = tree.planMainTree(startKey, mainGiven, ascendancyId, { unlocked: ascPlan.nodes.map((n) => n.key) });

  const given = new Set(unique);
  const main = mainPlan.nodes.map((n) => n.key);
  const ascendancy = ascPlan.nodes.map((n) => n.key);
  const added = [...mainPlan.nodes, ...ascPlan.nodes].filter((n) => !given.has(n.key)).map((n) => n.name || n.id);
  const name = (k: string) => tree.nodes.get(k)?.name ?? k;
  return {
    main,
    ascendancy,
    added,
    unreachable: [...mainPlan.unreachable, ...ascPlan.unreachable, ...wrongAscendancy].map(name),
  };
}
