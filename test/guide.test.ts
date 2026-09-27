import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { defaultCacheDir } from "../src/data/cache.js";
import { loadGameData } from "../src/data/gamedata.js";
import { ALL_SOURCES } from "../src/data/sources.js";
import { createGuide } from "../src/guide/guide.js";
import { renderGuide } from "../src/guide/render.js";
import { PassiveTree, withLevels } from "../src/tree/tree.js";

describe("renderGuide", () => {
  it("escapes player-provided text", () => {
    const html = renderGuide({
      name: "<script>alert(1)</script>",
      className: "Witch",
      leagueStart: true,
      summary: "Fire & <b>ice</b>",
      strengths: ['"quoted"'],
      weaknesses: [],
      phases: [{ name: "Act 1", levels: [1, 15], skills: [], keyPassives: [], pointsUsed: 0, pointsAvailable: 18, ascendancy: [], gear: [], checklist: [], checkWarnings: [], questRewards: [] }],
      notes: [],
      generatedAt: "2026-09-26",
      toolVersion: "test",
      tree: [],
      ascendancyTree: [],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Fire &amp; &lt;b&gt;ice&lt;/b&gt;");
    expect(html).not.toMatch(/https?:\/\//); // fully offline: no external requests
  });
});

const hasCache = Object.values(ALL_SOURCES).every((s) => existsSync(join(defaultCacheDir(), s.file)));

describe.skipIf(!hasCache)("createGuide against real data", () => {
  let dir: string;
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("writes a page and a Build Planner file per phase, with checks", async () => {
    dir = await mkdtemp(join(tmpdir(), "poe2bf-guide-"));
    process.env.POE2BF_GUIDES_DIR = dir;
    const data = await loadGameData();
    const tree = new PassiveTree(data.nodes);
    const witch = data.classes.find((c) => c.name === "Witch")!;
    const potent = [...tree.nodes].find(([, n]) => n.name === "Potent Incantation")![0];
    const plan = withLevels(tree.planMainTree(witch.startNode, [potent]), data.questPoints);
    const result = await createGuide(
      data,
      tree,
      (ref) => ref,
      {
        name: "Test Guide",
        cls: witch,
        leagueStart: true,
        summary: "Test",
        passivePlan: plan.map((n) => ({ id: n.key, level: n.level })),
        phases: [
          { name: "Act 1", levels: [1, 5], skills: [{ gemId: "Fireball" }] },
          { name: "Maps", levels: [65, 90], skills: [{ gemId: "Fireball", supports: [{ gemId: "Fiery Death" }] }] },
        ],
      },
      { open: false, toolVersion: "test" },
    );
    delete process.env.POE2BF_GUIDES_DIR;
    expect(result.buildFiles).toHaveLength(2);
    expect(result.warningsByPhase["Act 1"]!.join()).toMatch(/Fireball can't be used until level 6/);
    const html = readFileSync(result.path, "utf8");
    expect(html).toContain("Potent Incantation");
    expect(html).toContain("<svg");
  });
});
