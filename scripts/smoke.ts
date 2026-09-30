// End-to-end check: start the MCP server over stdio like Claude Desktop does, then call each tool.
// Usage: npm run smoke   (or SMOKE_SERVER=dist/server.js npm run smoke after npm run build)

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Exports go to a temp folder, never the player's real BuildPlanner folder.
const exportDir = mkdtempSync(join(tmpdir(), "poe2bf-smoke-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  // SMOKE_SERVER=<path to server.js> tests a compiled build (dist/ or an unpacked .mcpb).
  args: process.env.SMOKE_SERVER ? [process.env.SMOKE_SERVER] : ["--import", "tsx", "src/server.ts"],
  stderr: "inherit",
  env: { ...(process.env as Record<string, string>), POE2BF_BUILDPLANNER_DIR: exportDir, POE2BF_GUIDES_DIR: exportDir, POE2BF_NO_OPEN: "1" },
});
const client = new Client({ name: "smoke-test", version: "0.0.1" });
await client.connect(transport);

const tools = await client.listTools();
console.log(`tools: ${tools.tools.map((t) => t.name).join(", ")}`);

async function call(name: string, args: Record<string, unknown> = {}) {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
  const status = result.isError ? "ERROR" : "ok";
  console.log(`\n== ${name} (${status}, ${Date.now() - started} ms)\n${text.slice(0, 700)}${text.length > 700 ? "\n…" : ""}`);
  if (result.isError && !name.startsWith("expect-error:")) process.exitCode = 1;
  return text;
}

await call("data_status");
await call("list_classes");
const skills = JSON.parse(await call("search_skills", { require: ["fire", "spell"], prefer: ["projectile"], limit: 5 }));
const fireball = skills.find((s: { name: string }) => s.name === "Fireball");
await call("compatible_supports", { gemId: "Fireball", limit: 6 });
await call("gem_details", { gem: "Herald of Ash" });
await call("find_passives", { class: "Titan", listAscendancy: true });
const passives = JSON.parse(await call("find_passives", { terms: ["fire", "spell"], class: "Infernalist", limit: 8 }));
const main = passives.filter((p: { kind: string }) => p.kind === "notable").slice(0, 4).map((p: { key: string }) => p.key);
const asc = passives.filter((p: { kind: string }) => p.kind === "ascendancy-notable").slice(0, 2).map((p: { id: string }) => p.id);
const plan = JSON.parse(await call("plan_passive_tree", { class: "Witch", ascendancy: "Infernalist", passives: main, ascendancyPassives: asc }));
await call("stat_priorities", { terms: ["fire", "spell", "cast speed"], avoid: ["attack"], slots: ["Amulet", "Helmet", "Jewel"], perSlot: 3, defence: ["energy shield"], itemLevel: 30 });

await call("leveling_phases");
await call("check_build", {
  class: "Titan",
  characterLevel: 60,
  passives: ["Giant's Blood"],
  skills: [{ gemId: "Sunder", supports: ["Corrosion"] }],
  weapons: ["Two Hand Mace"],
});
await call("check_build", {
  class: "Infernalist",
  characterLevel: 28,
  passives: plan.passives.map((p: { id: string }) => p.id),
  skills: [{ gemId: "Fireball", supports: ["Fiery Death"] }, { gemId: "Herald of Ash" }],
});
const evaluation = JSON.parse(
  await call("evaluate_build", {
    class: "Infernalist",
    level: 45,
    passives: plan.passives.map((p: { id: string }) => p.id),
    skills: [{ gemId: "Fireball", supports: ["Fiery Death"] }],
    terms: ["fire", "spell", "cast speed"],
    avoid: ["attack"],
    defence: ["energy shield"],
  }),
);
if (evaluation.available && !(evaluation.clear?.dps > 0)) process.exitCode = 1;
await call("suggest_extras", { level: 45, terms: ["fire", "spell", "ignite"], avoid: ["attack"], defence: ["energy shield"], mainSkill: "Fireball" });
await call("evaluate_build", {
  class: "Infernalist",
  level: 65,
  passives: [],
  skills: [{ gemId: "Fireball" }],
  terms: ["fire", "spell"],
  gearTier: "mid",
  anoint: "Potent Incantation",
  socketables: [{ slot: "Body Armour", names: ["Desert Rune"] }],
  amuletSkill: "Herald of Ash",
  weaponSwap: { weapons: ["Bow"], skills: [{ gemId: "Lightning Arrow" }] },
});
// Druid / Oracle: class-specific passives, term-preferred routes, gated Oracle-only passives.
const druidPlan = JSON.parse(
  await call("plan_passive_tree", {
    class: "Oracle",
    passives: ["Guardian of the Wilds", "Night's Bite"],
    ascendancyPassives: ["The Unseen Path"],
    terms: ["spell"],
    targetLevel: 30,
  }),
);
const gated = druidPlan.passives?.find((n: { name: string }) => n.name === "Night's Bite");
if (!gated?.requires || !druidPlan.passives?.some((n: { name: string }) => n.name === "Guardian of the Wilds")) process.exitCode = 1;
const lockedPlan = JSON.parse(await call("plan_passive_tree", { class: "Oracle", passives: ["Night's Bite"] }));
if (!lockedPlan.unreachable?.[0]?.includes("The Unseen Path")) process.exitCode = 1;
const smalls = JSON.parse(await call("find_passives", { class: "Druid", near: "Guardian of the Wilds", within: 3, kinds: ["small"] }));
if (!smalls.length || !smalls.every((n: { kind: string }) => n.kind === "small")) process.exitCode = 1;
const gatedCheck = JSON.parse(await call("check_build", { class: "Oracle", characterLevel: 30, passives: ["Night's Bite"], skills: [{ gemId: "Spark" }] }));
if (!gatedCheck.warnings?.some((w: string) => /needs The Unseen Path first/.test(w))) process.exitCode = 1;
await call("list_builds");
await call("build_intake");
const goalEval = JSON.parse(
  await call("evaluate_build", {
    class: "Infernalist",
    level: 90,
    passives: [],
    skills: [{ gemId: "Fireball" }],
    terms: ["fire", "spell"],
    goals: { purpose: "bossing", push: "pinnacle", buttons: "few", budget: "modest" },
  }),
);
if (goalEval.available && !goalEval.goalCheck?.status) process.exitCode = 1;
const optimized = JSON.parse(
  await call("optimize_build", {
    class: "Infernalist",
    level: 70,
    passives: [],
    skills: [{ gemId: "Fireball" }],
    terms: ["fire", "spell"],
    goals: { purpose: "mapping", push: "T15" },
    maxEvaluations: 8,
  }),
);
if (optimized.available && optimized.objective !== "clear") process.exitCode = 1;
await call("item_prices", { names: ["Divine Orb", "Desert Rune", "Raven-Touched Shard"] });
await call("trade_links", { rares: [{ slot: "Helmet", mods: ["+80 to maximum Life", "+30% to Fire Resistance"], maxLevel: 65 }], uniques: ["Mageblood"] });
const comparison = JSON.parse(
  await call("compare_builds", {
    variants: [
      { label: "Fireball", class: "Infernalist", level: 30, passives: [], skills: [{ gemId: "Fireball" }], terms: ["fire", "spell"] },
      { label: "Firebolt wand", class: "Infernalist", level: 30, passives: [], skills: [{ gemId: "Fireball", supports: ["Fiery Death"] }], terms: ["fire", "spell"] },
    ],
  }),
);
if (comparison.available && comparison.rows?.length !== 2) process.exitCode = 1;
await call("find_uniques", { terms: ["fire", "spell"], slots: ["Amulet", "Wand"], limit: 3 });
await call("export_build", {
  name: "Smoke Test Fireball",
  class: "Infernalist",
  passives: plan.passives.map((p: { id: string; takeAtLevel: number }) => ({ id: p.id, level: p.takeAtLevel })),
  ascendancyPassives: plan.ascendancyPlan.passives.map((p: { id: string }) => ({ id: p.id })),
  skills: [{ gemId: fireball.gemId, note: "Main skill" }],
  gear: [{ slot: "Amulet", title: "Any Amulet", priorities: ["+ Level of all Spell Skills", "Cast Speed"] }],
});
await call("create_build_guide", {
  name: "Smoke Guide",
  class: "Infernalist",
  leagueStart: true,
  summary: "Smoke test guide",
  passivePlan: plan.passives.map((p: { id: string; takeAtLevel: number }) => ({ id: p.id, level: p.takeAtLevel })),
  phases: [
    { name: "Act 1", levels: [1, 15], skills: [{ gemId: "Fireball" }] },
    { name: "Maps", levels: [65, 90], skills: [{ gemId: "Fireball", supports: [{ gemId: "Fiery Death" }] }, { gemId: "Herald of Ash" }] },
  ],
  goals: { purpose: "bossing", push: "pinnacle", buttons: "few", budget: "modest" },
  open: false,
});
const files = readdirSync(exportDir);
console.log(`exported files: ${files.join(", ")}`);
if (!files.includes("Smoke Test Fireball.build") || !files.includes("Smoke Guide")) process.exitCode = 1;
rmSync(exportDir, { recursive: true, force: true });

// Errors should come back as readable tool errors, not crashes.
const bad = await client.callTool({ name: "plan_passive_tree", arguments: { class: "Necromancer", passives: [] } });
console.log(`\n== bad class -> isError=${bad.isError}: ${(bad.content as { text: string }[])[0]?.text}`);
if (!bad.isError) process.exitCode = 1;

await client.close();
