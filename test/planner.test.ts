// Route planning: priority order, tie-breaking by terms, gated passives; trials; build file housekeeping.
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { trialForAscendancyPoint } from "../src/build/trials.js";
import type { TreeNode } from "../src/data/types.js";
import { AUTHOR, archiveEntries, listBuildFiles } from "../src/export/buildFile.js";
import { PassiveTree } from "../src/tree/tree.js";

/*
 *            A1(regen) - A2(regen)
 *          /                      \
 *   start                           N (notable)
 *          \                      /
 *            B1(spell) - B2(spell)
 *
 *   start - F (far notable, 1 away) ; N - G (gated: needs U, an ascendancy node)
 */
const node = (name: string, stats: string[] = [], extra: Partial<TreeNode> = {}): TreeNode => ({ id: name, name, stats, ...extra });
const nodes = new Map<string, TreeNode>([
  ["start", node("start", [], { out: ["A1", "B1", "F"] })],
  ["A1", node("Life Regeneration", ["1 Life Regeneration per second"], { out: ["A2"] })],
  ["A2", node("Life Regeneration", ["1 Life Regeneration per second"], { out: ["N"] })],
  ["B1", node("Spell Damage", ["10% increased Spell Damage"], { out: ["B2"] })],
  ["B2", node("Spell Damage", ["10% increased Spell Damage"], { out: ["N"] })],
  ["N", node("Big Notable", ["30% increased Damage"], { isNotable: true, out: ["G"] })],
  ["F", node("Far Notable", ["5% increased Damage"], { isNotable: true })],
  ["G", node("Gated", ["12% of Damage as extra Chaos"], { isNotable: true, unlockConstraint: { nodes: [7] } as TreeNode["unlockConstraint"] })],
  ["U", node("Unlocker", [], { ascendancyId: "Asc1" })],
]);
// Unlock constraints use numeric keys; give the unlocker one.
nodes.set("7", nodes.get("U")!);
const tree = new PassiveTree(nodes);
const keys = (plan: { nodes: { key: string }[] }) => plan.nodes.map((n) => n.key);

describe("route planning", () => {
  it("takes the nearest target first by default, the given order with priority", () => {
    expect(keys(tree.planMainTree("start", ["N", "F"]))[0]).toBe("F");
    expect(keys(tree.planMainTree("start", ["N", "F"], undefined, { order: "priority" })).at(-1)).toBe("F");
  });

  it("breaks ties between equally short routes with the weight, never lengthening them", () => {
    const spell = (k: string) => ((nodes.get(k)?.stats ?? []).join(" ").match(/Spell/) ? 1 : 0);
    expect(keys(tree.planMainTree("start", ["N"], undefined, { weight: spell }))).toEqual(["B1", "B2", "N"]);
    const regen = (k: string) => ((nodes.get(k)?.stats ?? []).join(" ").match(/Regeneration/) ? 1 : 0);
    expect(keys(tree.planMainTree("start", ["N"], undefined, { weight: regen }))).toEqual(["A1", "A2", "N"]);
  });

  it("only uses gated passives once their unlocking node is taken", () => {
    expect(tree.unlockedBy("G")).toEqual(["7"]);
    const locked = tree.planMainTree("start", ["G"], undefined, { unlocked: [] });
    expect(locked.unreachable).toEqual(["G"]);
    const open = tree.planMainTree("start", ["G"], undefined, { unlocked: ["7"] });
    expect(keys(open).at(-1)).toBe("G");
    // Without the option, constraints are ignored (older callers).
    expect(tree.planMainTree("start", ["G"]).unreachable).toEqual([]);
  });
});

describe("trials", () => {
  it("maps ascendancy points to trials, two per trial", () => {
    expect(trialForAscendancyPoint(1)?.trial).toBe(1);
    expect(trialForAscendancyPoint(2)?.trial).toBe(1);
    expect(trialForAscendancyPoint(3)?.trial).toBe(2);
    expect(trialForAscendancyPoint(8)?.trial).toBe(4);
    expect(trialForAscendancyPoint(9)).toBeUndefined();
  });
});

describe("build file housekeeping", () => {
  const dirs: string[] = [];
  afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

  it("lists build files, tells ours apart, and moves them without deleting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bp-"));
    const archive = join(await mkdtemp(join(tmpdir(), "bp-archive-")), "removed");
    dirs.push(dir, archive);
    await writeFile(join(dir, "Ours.build"), JSON.stringify({ name: "Ours", author: AUTHOR }));
    await writeFile(join(dir, "Theirs.build"), JSON.stringify({ name: "Theirs", author: "someone" }));
    await writeFile(join(dir, "notes.txt"), "x");
    const list = await listBuildFiles(dir);
    expect(list.map((b) => [b.file, b.madeByThisTool]).sort()).toEqual([["Ours.build", true], ["Theirs.build", false]]);

    const { moved } = await archiveEntries(dir, ["Ours.build", "../escape.build", "missing.build"], archive);
    expect(moved).toEqual(["Ours.build"]);
    expect(existsSync(join(dir, "Ours.build"))).toBe(false);
    expect(await readdir(archive)).toEqual(["Ours.build"]);
  });
});
