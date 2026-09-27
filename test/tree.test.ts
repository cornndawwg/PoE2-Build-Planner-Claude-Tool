import { describe, expect, it } from "vitest";
import type { TreeNode } from "../src/data/types.js";
import { findScaling } from "../src/tree/scaling.js";
import { levelForPoint, PassiveTree, pointsAtLevel, withLevels } from "../src/tree/tree.js";

// A small tree:
//
//   S ─ a ─ b ─ N1 (fire notable)
//   │   │
//   │   c ─ d ─ N2 (cold notable)
//   │       │
//   │       M (mastery, not pathable) ─ N3
//   ├─ K (keystone, locked to Asc1)
//   └─ AS (ascendancy start) ─ A1 (ascendancy notable)
//   Choice parent P ─ option O1, reached from b
function node(id: string, extra: Partial<TreeNode> = {}): TreeNode {
  return { id, name: id, stats: [], ...extra };
}
const edges: [string, string][] = [
  ["S", "a"], ["a", "b"], ["b", "N1"], ["a", "c"], ["c", "d"], ["d", "N2"], ["d", "M"], ["M", "N3"],
  ["S", "K"], ["S", "AS"], ["AS", "A1"], ["b", "P"], ["P", "O1"], ["O1", "x"],
];
const nodes = new Map<string, TreeNode>([
  ["S", node("S", { classStartIndex: [0] })],
  ["a", node("a")], ["b", node("b")], ["c", node("c")], ["d", node("d")], ["x", node("x")],
  ["N1", node("N1", { isNotable: true, name: "Burning", stats: ["20% increased [Fire|Fire] Damage"] })],
  ["N2", node("N2", { isNotable: true, name: "Frost", stats: ["20% increased Cold Damage"] })],
  ["N3", node("N3", { isNotable: true, name: "Hidden", stats: ["Fire things"] })],
  ["M", node("M", { isMastery: true })],
  ["K", node("K", { isKeystone: true, name: "Locked", stats: ["Fire keystone"], unlockConstraint: { ascendancy: "Asc1" } })],
  ["AS", node("AS", { isAscendancyStart: true, ascendancyId: "Asc1" })],
  ["A1", node("A1", { isNotable: true, ascendancyId: "Asc1", stats: ["Fire ascendancy"] })],
  ["P", node("P", { isMultipleChoice: true })],
  ["O1", node("O1", { isMultipleChoiceOption: true })],
]);
for (const [from, to] of edges) nodes.get(from)!.out = [...(nodes.get(from)!.out ?? []), to];
const tree = new PassiveTree(nodes);

describe("PassiveTree", () => {
  it("paths to targets cheapest-first and lists nodes in order", () => {
    const plan = tree.planMainTree("S", ["N2", "N1"]);
    expect(plan.nodes.map((n) => n.key)).toEqual(["a", "b", "N1", "c", "d", "N2"]);
    expect(plan.nodes.find((n) => n.key === "c")?.forTarget).toBe("N2");
    expect(plan.unreachable).toEqual([]);
  });

  it("never walks through masteries or into ascendancy nodes", () => {
    expect(tree.planMainTree("S", ["N3"]).unreachable).toEqual(["N3"]);
    expect(tree.planMainTree("S", ["A1"]).unreachable).toEqual(["A1"]);
  });

  it("respects ascendancy-locked nodes", () => {
    expect(tree.planMainTree("S", ["K"]).unreachable).toEqual(["K"]);
    expect(tree.planMainTree("S", ["K"], "Asc1").nodes.map((n) => n.key)).toEqual(["K"]);
  });

  it("treats multiple-choice options as endpoints only", () => {
    expect(tree.planMainTree("S", ["O1"]).nodes.map((n) => n.key)).toEqual(["a", "b", "P", "O1"]);
    expect(tree.planMainTree("S", ["x"]).unreachable).toEqual(["x"]);
  });

  it("plans ascendancy nodes from the ascendancy start", () => {
    expect(tree.planAscendancy("Asc1", ["A1"]).nodes.map((n) => n.key)).toEqual(["A1"]);
  });

  it("measures distance from the class start", () => {
    const dist = tree.distancesFrom("S");
    expect(dist.get("N1")).toBe(3);
    expect(dist.has("N3")).toBe(false);
  });
});

describe("findScaling", () => {
  it("finds notables by whole-word stat text and ranks closer ones first", () => {
    const found = findScaling(tree, { terms: ["fire"], startKey: "S" });
    expect(found.map((n) => n.key)).toEqual(["N1"]); // N3 unreachable, K locked
    expect(found[0]?.stats).toEqual(["20% increased Fire Damage"]);
  });

  it("includes the chosen ascendancy's nodes", () => {
    const found = findScaling(tree, { terms: ["fire"], startKey: "S", ascendancyId: "Asc1", kinds: ["notable", "keystone", "ascendancy-notable"] });
    expect(found.map((n) => n.key).sort()).toEqual(["A1", "K", "N1"]);
  });
});

describe("drawbacks", () => {
  it("flags stat lines that look like downsides", () => {
    const withDownside = new Map(nodes);
    withDownside.set("N1", { ...nodes.get("N1")!, stats: ["30% increased Fire Damage", "10% reduced Cast Speed"] });
    const found = findScaling(new PassiveTree(withDownside), { terms: ["fire"], startKey: "S" });
    expect(found[0]?.drawbacks).toEqual(["10% reduced Cast Speed"]);
  });
});

describe("point budget", () => {
  const quests = [
    { areaLevel: 10, points: 2 },
    { areaLevel: 25, points: 2 },
  ];
  it("counts level points plus quest points earned", () => {
    expect(pointsAtLevel(1, quests)).toBe(0);
    expect(pointsAtLevel(10, quests)).toBe(11);
    expect(pointsAtLevel(100, quests)).toBe(103);
  });
  it("finds the level a point becomes available", () => {
    expect(levelForPoint(11, quests)).toBe(10);
    expect(levelForPoint(12, quests)).toBe(11);
    expect(levelForPoint(200, quests)).toBeUndefined();
  });
  it("attaches levels to a plan in order", () => {
    const plan = tree.planMainTree("S", ["N1"]);
    expect(withLevels(plan, quests).map((n) => n.level)).toEqual([2, 3, 4]);
    // Points 11, 12, 13: level 10 gives 9 level points + 2 quest points.
    expect(withLevels(plan, quests, 10).map((n) => n.level)).toEqual([10, 11, 12]);
  });
});
