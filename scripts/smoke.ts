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
  env: { ...(process.env as Record<string, string>), POE2BF_BUILDPLANNER_DIR: exportDir },
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
await call("compatible_supports", { gemId: fireball.gemId, limit: 6 });
const passives = JSON.parse(await call("find_passives", { terms: ["fire", "spell"], class: "Infernalist", limit: 8 }));
const main = passives.filter((p: { kind: string }) => p.kind === "notable").slice(0, 4).map((p: { key: string }) => p.key);
const asc = passives.filter((p: { kind: string }) => p.kind === "ascendancy-notable").slice(0, 2).map((p: { id: string }) => p.id);
const plan = JSON.parse(await call("plan_passive_tree", { class: "Witch", ascendancy: "Infernalist", passives: main, ascendancyPassives: asc }));
await call("stat_priorities", { terms: ["fire", "spell", "cast speed"], avoid: ["attack"], slots: ["Amulet", "Jewel"], perSlot: 3 });

await call("find_uniques", { terms: ["fire", "spell"], slots: ["Amulet", "Wand"], limit: 3 });
await call("export_build", {
  name: "Smoke Test Fireball",
  class: "Infernalist",
  passives: plan.passives.map((p: { id: string; takeAtLevel: number }) => ({ id: p.id, level: p.takeAtLevel })),
  ascendancyPassives: plan.ascendancyPlan.passives.map((p: { id: string }) => ({ id: p.id })),
  skills: [{ gemId: fireball.gemId, note: "Main skill" }],
  gear: [{ slot: "Amulet", title: "Any Amulet", priorities: ["+ Level of all Spell Skills", "Cast Speed"] }],
});
const files = readdirSync(exportDir);
console.log(`exported files: ${files.join(", ")}`);
if (files.length !== 1) process.exitCode = 1;
rmSync(exportDir, { recursive: true, force: true });

// Errors should come back as readable tool errors, not crashes.
const bad = await client.callTool({ name: "plan_passive_tree", arguments: { class: "Necromancer", passives: [] } });
console.log(`\n== bad class -> isError=${bad.isError}: ${(bad.content as { text: string }[])[0]?.text}`);
if (!bad.isError) process.exitCode = 1;

await client.close();
