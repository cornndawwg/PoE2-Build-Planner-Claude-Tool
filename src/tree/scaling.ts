import { stripMarkup } from "../text.js";
import { nodeKind, type NodeKind, type PassiveTree } from "./tree.js";

export interface ScalingNode {
  key: string;
  id: string;
  name: string;
  kind: NodeKind;
  stats: string[];
  /** Requested terms found in the node's name or stats. */
  matched: string[];
  /** Stat lines that look like downsides ("reduced", "less", "cannot", …). A keyword heuristic. */
  drawbacks: string[];
  /** Ascendancy node that must be taken first (e.g. "The Unseen Path" for Oracle-only passives). */
  requires?: string;
  /** Points from the class start (main tree only; undefined if no class given or unreachable). */
  distance?: number;
  ascendancyId?: string;
}

export interface ScalingQuery {
  /** Terms describing what the build scales, e.g. ["fire", "spell", "cast speed"]. */
  terms: string[];
  /** Class start node key: adds distance and ranks closer nodes higher. */
  startKey?: string;
  /** Include this ascendancy's notables and nodes locked to it. */
  ascendancyId?: string;
  kinds?: NodeKind[];
  limit?: number;
  /** Only nodes in this set (e.g. within a few points of a given node). */
  within?: ReadonlySet<string>;
}

const DRAWBACK = /\b(reduced|less|cannot|can't|lose|loses|no longer|converts?)\b/i;

const escape =(s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word, case-insensitive, allowing a plural "s". */
export function termPattern(term: string): RegExp {
  return new RegExp(`\\b${escape(term.trim())}s?\\b`, "i");
}

export function findScaling(tree: PassiveTree, query: ScalingQuery): ScalingNode[] {
  const kinds = new Set<NodeKind>(query.kinds ?? ["keystone", "notable", "ascendancy-notable"]);
  const patterns = query.terms.map((t) => [t, termPattern(t)] as const);
  const distances = query.startKey ? tree.distancesFrom(query.startKey, query.ascendancyId) : undefined;

  const results: ScalingNode[] = [];
  for (const [key, node] of tree.nodes) {
    const kind = nodeKind(node);
    if (!kinds.has(kind)) continue;
    if (node.ascendancyId) {
      if (node.ascendancyId !== query.ascendancyId) continue;
    } else if (!tree.isMainTreeNode(key, query.ascendancyId)) {
      continue;
    }
    const stats = (node.stats ?? []).map(stripMarkup);
    const haystack = [node.name ?? "", ...stats].join("\n");
    const matched = patterns.filter(([, re]) => re.test(haystack)).map(([t]) => t);
    // With no terms (e.g. listing what's near a node), everything of the right kind matches.
    if (patterns.length > 0 && matched.length === 0) continue;
    if (query.within && !query.within.has(key)) continue;
    const distance = node.ascendancyId ? undefined : distances?.get(key);
    if (distances && !node.ascendancyId && distance === undefined) continue;
    results.push({
      key,
      id: node.id ?? key,
      name: node.name ?? "",
      kind,
      stats,
      matched,
      drawbacks: stats.filter((line) => DRAWBACK.test(line)),
      distance,
      requires: tree.unlockedBy(key).map((k) => tree.nodes.get(k)?.name ?? k).join(" or ") || undefined,
      ascendancyId: node.ascendancyId,
    });
  }

  return results
    .sort(
      (a, b) =>
        b.matched.length - a.matched.length ||
        (a.distance ?? 0) - (b.distance ?? 0) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, query.limit ?? 40);
}
