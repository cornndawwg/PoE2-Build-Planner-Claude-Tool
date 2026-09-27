#!/usr/bin/env node
// MCP server: exposes the build-planning tools to the player's Claude over stdio.
// stdout carries the protocol, so all logging goes to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { defaultCacheDir, ensureData, readCachedManifest } from "./data/cache.js";
import { loadGameData, type GameData, type PlayableClass } from "./data/gamedata.js";
import { buildFileName, findBuildPlannerDir, INVENTORY_IDS, toBuildFile, writeBuildFile } from "./export/buildFile.js";
import { SLOT_CLASSES, statPriorities } from "./gear/priorities.js";
import { findUniques } from "./gear/uniques.js";
import { compatibleSupports, searchSkills } from "./skills/skills.js";
import { findScaling } from "./tree/scaling.js";
import { ASCENDANCY_POINTS, PassiveTree, pointsAtLevel, withLevels } from "./tree/tree.js";

const VERSION = "0.0.1";
const log = (message: string) => process.stderr.write(`[poe2-build-planner] ${message}\n`);

const INSTRUCTIONS = `Tools for planning Path of Exile 2 builds (game version 0.5) for casual players.

How to help the player:
- Start from their play fantasy, not from what's strongest. Stay true to it; if part of it isn't viable, say so plainly and offer the closest version that is.
- Assume a modest budget and self-found gear unless they say otherwise.
- Explain every choice briefly in plain language — players may be new to the game.
- Tools return candidates, not decisions: read the stat text and pick what actually fits. Keystones are build-defining and often have big drawbacks; check the "drawbacks" field.
- Defences are a baseline every build needs; keep that advice short and focus on what makes their idea work.
- Verdicts and numbers are estimates, not guarantees.

Typical flow: list_classes → search_skills → compatible_supports → find_passives (with the class and ascendancy) → plan_passive_tree with the notables you chose → stat_priorities → find_uniques → export_build (ask the player first).

This tool isn't affiliated with or endorsed by Grinding Gear Games in any way.`;

let dataPromise: Promise<{ data: GameData; tree: PassiveTree }> | undefined;

function gameData() {
  dataPromise ??= (async () => {
    await ensureData({ log });
    const data = await loadGameData();
    return { data, tree: new PassiveTree(data.nodes) };
  })().catch((error: unknown) => {
    dataPromise = undefined; // allow a retry, e.g. after the network comes back
    throw error;
  });
  return dataPromise;
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

/** Run a tool body, reporting errors to Claude as readable messages rather than protocol errors. */
async function run(body: () => Promise<ReturnType<typeof json>>) {
  try {
    return await body();
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

function findClass(data: GameData, name: string, ascendancy?: string) {
  const norm = (s: string) => s.trim().toLowerCase();
  const cls = data.classes.find((c) => norm(c.name) === norm(name) || c.ascendancies.some((a) => norm(a.name) === norm(name)));
  if (!cls) throw new Error(`Unknown class "${name}". Classes: ${data.classes.map((c) => c.name).join(", ")}`);
  const ascName = ascendancy ?? cls.ascendancies.find((a) => norm(a.name) === norm(name))?.name;
  const asc = ascName ? cls.ascendancies.find((a) => norm(a.name) === norm(ascName)) : undefined;
  if (ascName && !asc) {
    throw new Error(`${cls.name} has no ascendancy "${ascName}". Options: ${cls.ascendancies.map((a) => a.name).join(", ")}`);
  }
  return { cls, asc };
}

/** Accept a node's tree key, its .build id, or its exact name (if unique). */
function resolveNode(tree: PassiveTree, ref: string): string {
  if (tree.nodes.has(ref)) return ref;
  for (const [key, node] of tree.nodes) if (node.id === ref) return key;
  const byName = [...tree.nodes].filter(([, n]) => n.name?.toLowerCase() === ref.toLowerCase());
  if (byName.length === 1) return byName[0]![0];
  if (byName.length > 1) throw new Error(`"${ref}" matches ${byName.length} nodes; use the key or id from find_passives`);
  throw new Error(`Unknown passive "${ref}"`);
}

function summariseClass(c: PlayableClass) {
  return {
    class: c.name,
    ascendancies: c.ascendancies.map((a) => a.name),
    baseAttributes: { str: c.baseStr, dex: c.baseDex, int: c.baseInt },
  };
}

const server = new McpServer({ name: "poe2-build-planner", version: VERSION }, { instructions: INSTRUCTIONS });

server.registerTool(
  "data_status",
  {
    title: "Game data status",
    description: "Where the game data is cached, when each file was last checked, and whether it loaded.",
    annotations: { readOnlyHint: true },
  },
  async () =>
    run(async () => {
    const { data } = await gameData();
    const manifest = await readCachedManifest();
    return json({
      cacheDir: defaultCacheDir(),
      files: Object.fromEntries(Object.entries(manifest).map(([k, v]) => [k, { checkedAt: v?.checkedAt, lastModified: v?.lastModified }])),
      counts: { classes: data.classes.length, playerGems: data.playerGems.size, passives: data.nodes.size },
    });
  }),
);

server.registerTool(
  "list_classes",
  {
    title: "List classes",
    description: "Playable classes with their released ascendancies and starting attributes.",
    annotations: { readOnlyHint: true },
  },
  async () =>
    run(async () => {
    const { data } = await gameData();
    return json(data.classes.map(summariseClass));
  }),
);

server.registerTool(
  "search_skills",
  {
    title: "Search skills",
    description:
      "Find active and spirit skills by gem tags, skill types or name words. `require` terms must all match; `prefer` terms rank results. " +
      "Useful terms: fire, cold, lightning, chaos, physical, spell, attack, projectile, area, melee, minion, bow, crossbow, mace, spear, quarterstaff, totem, curse, aura, herald, channelling, duration. " +
      "Results include weapon requirements and where the skill comes from (uncut-gem or item).",
    inputSchema: {
      require: z.array(z.string()).optional().describe("All must match, e.g. [\"fire\", \"spell\"]"),
      prefer: z.array(z.string()).optional().describe("Raise ranking, e.g. [\"projectile\", \"area\"]"),
      weapon: z.string().optional().describe("Only skills usable with this weapon, e.g. \"bow\", \"mace\""),
      includeItemSkills: z.boolean().optional().describe("Also include skills granted by items (weapon bases, uniques)"),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) =>
    run(async () => {
    const { data } = await gameData();
    const results = searchSkills(data, args).map(({ gameId, score, ...rest }) => ({ gemId: gameId, ...rest }));
    return json(results);
  }),
);

server.registerTool(
  "compatible_supports",
  {
    title: "Compatible supports",
    description:
      "Support gems that can support a skill, ranked: the game's own recommendations first, then tag matches. " +
      "Each result explains why. Lineage supports are rare drops (expensive for a budget build).",
    inputSchema: {
      gemId: z.string().describe("gemId from search_skills"),
      prefer: z.array(z.string()).optional().describe("Extra tags to favour, e.g. [\"ignite\"]"),
      includeLineage: z.boolean().optional().describe("Include lineage supports (default true)"),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ gemId, ...options }) =>
    run(async () => {
    const { data } = await gameData();
    const results = compatibleSupports(data, gemId, options).map(({ gameId, score, ...rest }) => ({ gemId: gameId, ...rest }));
    return json(results);
  }),
);

server.registerTool(
  "find_passives",
  {
    title: "Find scaling passives",
    description:
      "Notables, keystones and ascendancy notables whose text matches what the build scales. Give the class (and ascendancy) " +
      "to get distances from the class start and that ascendancy's nodes. Terms are words from passive text, e.g. " +
      "fire, spell, cast speed, critical, ignite, minion, projectile, area of effect, energy shield, life.",
    inputSchema: {
      terms: z.array(z.string()).min(1),
      class: z.string().optional().describe("Class or ascendancy name"),
      ascendancy: z.string().optional(),
      includeJewelSockets: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ terms, class: className, ascendancy, includeJewelSockets, limit }) =>
    run(async () => {
    const { data, tree } = await gameData();
    const found = className ? findClass(data, className, ascendancy) : undefined;
    const kinds = ["keystone", "notable", "ascendancy-notable"] as const;
    const results = findScaling(tree, {
      terms,
      startKey: found?.cls.startNode,
      ascendancyId: found?.asc?.id,
      kinds: includeJewelSockets ? [...kinds, "jewel-socket"] : [...kinds],
      limit,
    });
    return json(results.map(({ ascendancyId, ...rest }) => rest));
  }),
);

server.registerTool(
  "plan_passive_tree",
  {
    title: "Plan passive tree",
    description:
      "Connect the class start to the chosen passives using as few points as possible, in a sensible order, and say the " +
      "character level each point can be taken at. Also paths the ascendancy nodes (8 points). Pass passives by key, id or exact name.",
    inputSchema: {
      class: z.string().describe("Class or ascendancy name"),
      ascendancy: z.string().optional(),
      passives: z.array(z.string()).describe("Main-tree targets in priority order"),
      ascendancyPassives: z.array(z.string()).optional(),
      targetLevel: z.number().int().min(1).max(100).optional().describe("Level to budget for (default 90)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ class: className, ascendancy, passives, ascendancyPassives, targetLevel }) =>
    run(async () => {
    const { data, tree } = await gameData();
    const { cls, asc } = findClass(data, className, ascendancy);
    const level = targetLevel ?? 90;
    const plan = tree.planMainTree(cls.startNode, passives.map((p) => resolveNode(tree, p)), asc?.id);
    const budget = pointsAtLevel(level, data.questPoints);
    const ascPlan = asc && ascendancyPassives?.length ? tree.planAscendancy(asc.id, ascendancyPassives.map((p) => resolveNode(tree, p))) : undefined;
    return json({
      class: cls.name,
      ascendancy: asc?.name,
      pointsUsed: plan.nodes.length,
      pointsAvailableAtTargetLevel: budget,
      spareForDefenceAndAttributes: budget - plan.nodes.length,
      unreachable: plan.unreachable.map((k) => tree.describe(k).name || k),
      passives: withLevels(plan, data.questPoints).map(({ key, id, name, kind, stats, level: at, forTarget }) => ({
        takeAtLevel: at,
        name,
        kind,
        id,
        key,
        stats: kind === "small" || kind === "attribute" ? undefined : stats,
        towards: tree.describe(forTarget).name,
      })),
      ascendancyPlan: ascPlan && {
        pointsUsed: ascPlan.nodes.length,
        pointsAvailable: ASCENDANCY_POINTS,
        unreachable: ascPlan.unreachable.map((k) => tree.describe(k).name || k),
        passives: ascPlan.nodes.map(({ id, name, kind, stats }) => ({ name, kind, id, stats })),
      },
    });
  }),
);

server.registerTool(
  "stat_priorities",
  {
    title: "Gear and jewel stat priorities",
    description:
      "For each gear slot (and jewels), the random modifiers that match what the build scales, best first, plus a short defensive " +
      "baseline. Terms are words from mod text (e.g. fire, spell, cast speed, critical, minion, projectile, attack speed). " +
      "Use `avoid` to rule out mods, e.g. [\"attack\"] for a caster. Slots: " + Object.keys(SLOT_CLASSES).join(", ") + ".",
    inputSchema: {
      terms: z.array(z.string()).min(1),
      avoid: z.array(z.string()).optional(),
      slots: z.array(z.string()).optional().describe("Default: armour, jewellery and jewels"),
      perSlot: z.number().int().min(1).max(20).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) =>
    run(async () => {
    const { data } = await gameData();
    const { offence, defence } = statPriorities(data, args);
    const brief = (s: { slot: string; mods: { side: string; bestTier: string; bestTierLevel: number; matched?: string[] }[] }) => ({
      slot: s.slot,
      mods: s.mods.map((m) => ({ side: m.side, best: m.bestTier, itemLevelForBest: m.bestTierLevel })),
    });
    return json({ offence: offence.map(brief), defenceBaseline: defence.map(brief) });
  }),
);

server.registerTool(
  "find_uniques",
  {
    title: "Find unique items",
    description:
      "Unique items whose mods match what the build scales, with their full current mods, level requirement and where they drop. " +
      "No prices are available: treat boss-only drops (bossDrop: true) as likely expensive and prefer common uniques for budget builds. " +
      "Slots: " + Object.keys(SLOT_CLASSES).join(", ") + ".",
    inputSchema: {
      terms: z.array(z.string()).min(1).describe("Words from mod text, e.g. [\"fire\", \"spell\"]"),
      avoid: z.array(z.string()).optional(),
      slots: z.array(z.string()).optional(),
      maxRequiredLevel: z.number().int().min(1).max(100).optional().describe("e.g. the player's level, for leveling uniques"),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) =>
    run(async () => {
      const { data } = await gameData();
      return json(findUniques(data, args));
    }),
);

const passiveEntry = z.object({
  id: z.string().describe("Passive id, key or exact name (from plan_passive_tree)"),
  level: z.number().int().min(1).max(100).optional().describe("Level to take it at (takeAtLevel)"),
  note: z.string().optional().describe("Shown when hovering the passive in game"),
});

server.registerTool(
  "export_build",
  {
    title: "Export to the in-game Build Planner",
    description:
      "Write the finished build as a .build file into Path of Exile 2's BuildPlanner folder, where the game picks it up " +
      "(passives with the level to take them, skills and supports with level ranges, and gear stat priorities per slot). " +
      "Ask the player before writing. If the game folder isn't found, the file contents are returned to save manually. " +
      "Gear slots: " + Object.keys(INVENTORY_IDS).join(", ") + ".",
    inputSchema: {
      name: z.string().min(1).max(80),
      description: z.string().optional(),
      class: z.string().describe("Class or ascendancy name"),
      ascendancy: z.string().optional(),
      passives: z.array(passiveEntry),
      ascendancyPassives: z.array(passiveEntry).optional(),
      skills: z.array(
        z.object({
          gemId: z.string(),
          fromLevel: z.number().int().min(0).max(100).optional(),
          toLevel: z.number().int().min(0).max(100).optional().describe("For leveling skills you swap out later"),
          note: z.string().optional(),
          supports: z
            .array(z.object({ gemId: z.string(), fromLevel: z.number().int().min(0).max(100).optional(), note: z.string().optional() }))
            .optional(),
        }),
      ),
      gear: z
        .array(
          z.object({
            slot: z.string(),
            title: z.string().optional().describe("e.g. \"Energy Shield base (Int)\""),
            priorities: z.array(z.string()).optional().describe("Stats to look for, most important first"),
            uniqueName: z.string().optional(),
            note: z.string().optional(),
          }),
        )
        .optional(),
      write: z.boolean().optional().describe("Write the file (default true). false = just return it"),
      overwrite: z.boolean().optional().describe("Replace an existing file with the same name that this tool didn't write"),
    },
  },
  async (args) =>
    run(async () => {
      const { data, tree } = await gameData();
      const { asc } = findClass(data, args.class, args.ascendancy);
      const toPassive = (p: z.infer<typeof passiveEntry>) => ({
        id: tree.describe(resolveNode(tree, p.id)).id,
        level: p.level,
        note: p.note,
      });
      const { build, warnings } = toBuildFile(data, {
        name: args.name,
        description: args.description,
        ascendancyId: asc?.id,
        passives: [...args.passives, ...(args.ascendancyPassives ?? [])].map(toPassive),
        skills: args.skills,
        slots: args.gear,
      });
      const dir = findBuildPlannerDir();
      if (args.write === false || !dir) {
        return json({
          written: false,
          reason: dir ? "write was false" : "Path of Exile 2's Documents folder wasn't found",
          saveAs: dir ? undefined : `Documents/My Games/Path of Exile 2/BuildPlanner/${buildFileName(build.name)}`,
          warnings,
          build,
        });
      }
      const path = await writeBuildFile(build, dir, args.overwrite ?? false);
      return json({
        written: true,
        path,
        warnings,
        nextStep: "Open the Build Planner in game (or restart the game if it was open) to see the build.",
        counts: { passives: build.passives?.length ?? 0, skills: build.skills?.length ?? 0, gearHints: build.inventory_slots?.length ?? 0 },
      });
    }),
);

await server.connect(new StdioServerTransport());
log(`v${VERSION} ready`);
// Start loading data in the background so the first tool call is fast.
gameData().catch((error: unknown) => log(`data load failed: ${String(error)}`));
