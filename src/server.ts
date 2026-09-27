#!/usr/bin/env node
// MCP server: exposes the build-planning tools to the player's Claude over stdio.
// stdout carries the protocol, so all logging goes to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { defaultCacheDir, ensureData, readCachedManifest } from "./data/cache.js";
import { loadGameData, type GameData, type PlayableClass } from "./data/gamedata.js";
import { buildFileName, findBuildPlannerDir, INVENTORY_IDS, toBuildFile, writeBuildFile } from "./export/buildFile.js";
import { DEFENCE_STYLES, SLOT_CLASSES, statPriorities } from "./gear/priorities.js";
import { findUniques } from "./gear/uniques.js";
import { checkBuild } from "./build/checks.js";
import { levelingPhases } from "./build/phases.js";
import { evaluateBuild } from "./engine/evaluate.js";
import { findEngine, PobEngine } from "./engine/pob.js";
import { createGuide } from "./guide/guide.js";
import { compatibleSupports, findGem, searchSkills } from "./skills/skills.js";
import { findScaling } from "./tree/scaling.js";
import { ASCENDANCY_POINTS, PassiveTree, pointsAtLevel, withLevels } from "./tree/tree.js";

const VERSION = "0.1.0";
const log = (message: string) => process.stderr.write(`[poe2-build-planner] ${message}\n`);

const INSTRUCTIONS = `Tools for planning Path of Exile 2 builds (game version 0.5) for casual players.

How to help the player:
- Start from their play fantasy, not from what's strongest. Stay true to it; if part of it isn't viable, say so plainly and offer the closest version that is.
- Assume a modest budget and self-found gear unless they say otherwise.
- Explain every choice briefly in plain language — players may be new to the game.
- Tools return candidates, not decisions: read the stat text and pick what actually fits. Keystones are build-defining and often have big drawbacks; check the "drawbacks" field.
- Defences are a baseline every build needs; keep that advice short and focus on what makes their idea work.
- Verdicts and numbers are estimates, not guarantees.

First ask: is this a league start (new character from level 1) or an existing character? For an existing character, ask their level and roughly what gear they have, and plan from there.

League start: call leveling_phases and plan every phase, not just the end-game build. For each phase pick skills the character can use by then (search_skills with availableBy), supports, the passives to take during it, and gear to look for (stat_priorities with itemLevel ≈ the phase's levels). Run check_build at each phase's checkpointLevel and fix what it flags before moving on. If the final build is weak early, use a different leveling skill or setup and say when to switch. Mention useful quest rewards in each phase.

Typical flow: list_classes → search_skills → compatible_supports → find_passives (with the class and ascendancy) → plan_passive_tree with the notables you chose → check_build → evaluate_build (real numbers and a verdict per phase) → stat_priorities → find_uniques → export_build (ask the player first) → create_build_guide to lay it all out as a web page (ask first; it opens in their browser). For a league start, export one Build Planner file per phase whose setup differs (e.g. "Name - 1 Acts 1-2", "Name - 2 Acts 3-4", "Name - 3 Maps"), so the player can switch plans in game.

This tool isn't affiliated with or endorsed by Grinding Gear Games in any way.`;

let engine: PobEngine | null | undefined;

/** The Path of Building engine, started on first use; null if it isn't installed. */
function getEngine(): PobEngine | null {
  if (engine !== undefined) return engine;
  const paths = findEngine();
  engine = paths ? new PobEngine(paths, log) : null;
  return engine;
}

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
      availableBy: z.number().int().min(1).max(100).optional().describe("Only skills usable by this character level (for leveling)"),
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
      gemId: z.string().describe("gemId from search_skills, or the skill's exact name"),
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
      warning:
        plan.nodes.length > budget
          ? `Over budget: needs ${plan.nodes.length} points but a level ${level} character has ${budget}. Drop or swap some targets.`
          : undefined,
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
  "evaluate_build",
  {
    title: "Calculate a build with Path of Building",
    description:
      "Real numbers from Path of Building's calculation engine for a planned build at a character level: damage against normal " +
      "monsters and against a boss, seconds to kill a normal/rare monster and a boss, hits you survive from monsters and bosses, " +
      "life, energy shield, resistances (with the campaign's resistance penalty and only the quest rewards earned by that level), " +
      "Spirit and attributes, plus a verdict band (Comfortable / Workable / Borderline / Not yet) with the weak point and what to fix " +
      "first. Level 65+ is judged for early maps, T15 and juiced T16. By default it assumes budget rare gear for that level (a few " +
      "mid-roll mods per slot, based on `terms` and `defence`); pass `gear: \"none\"` for no gear. Use it at each phase's checkpoint. " +
      "Numbers are estimates: assumed gear and heuristic bands, not guarantees. Windows only for now.",
    inputSchema: {
      class: z.string().describe("Class or ascendancy name"),
      ascendancy: z.string().optional(),
      level: z.number().int().min(1).max(100),
      passives: z.array(z.string()).describe("Main-tree passives taken by this level (key, id or exact name)"),
      ascendancyPassives: z.array(z.string()).optional(),
      skills: z.array(z.object({ gemId: z.string().describe("gemId or exact name"), supports: z.array(z.string()).optional() })).min(1),
      mainSkill: z.number().int().min(0).optional().describe("0-based index of the main damage skill (default 0)"),
      terms: z.array(z.string()).optional().describe("What the build scales, for the assumed gear (as for stat_priorities)"),
      avoid: z.array(z.string()).optional(),
      defence: z.array(z.enum(DEFENCE_STYLES)).optional().describe("Defence layers for the assumed gear (default: life)"),
      weapons: z.array(z.string()).optional().describe("Weapon item classes to assume, e.g. [\"Staff\"] or [\"Wand\", \"Focus\"]"),
      gear: z.enum(["budget", "none"]).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) =>
    run(async () => {
      const { data, tree } = await gameData();
      const engine = getEngine();
      if (!engine) {
        return json({
          available: false,
          reason:
            process.platform === "win32"
              ? "The Path of Building engine files aren't installed with this copy of the tool."
              : "The Path of Building engine currently ships for Windows only.",
          hint: "Use check_build for rule-based checks instead.",
        });
      }
      const { cls, asc } = findClass(data, args.class, args.ascendancy);
      const skills = args.skills.map((s) => ({ gem: findGem(data, s.gemId), supports: s.supports?.map((id) => findGem(data, id)) }));
      const terms = args.terms?.length ? args.terms : skills[args.mainSkill ?? 0]!.gem.tags.filter((t) => !["intelligence", "strength", "dexterity", "repeatable"].includes(t));
      const evaluation = await evaluateBuild(engine, data, {
        cls,
        ascendancyName: asc?.name,
        level: args.level,
        passives: [...args.passives, ...(args.ascendancyPassives ?? [])].map((p) => resolveNode(tree, p)),
        skills,
        mainSkill: args.mainSkill,
        gear:
          args.gear === "none"
            ? { kind: "none" }
            : { kind: "budget", terms, avoid: args.avoid, defence: args.defence?.length ? args.defence : ["life"], weapons: args.weapons },
      });
      return json({ available: true, ...evaluation });
    }),
);

server.registerTool(
  "stat_priorities",
  {
    title: "Gear and jewel stat priorities",
    description:
      "For each gear slot (and jewels), the random modifiers that match what the build scales, best first, plus a defence " +
      "baseline for the build's defence style. Terms are words from mod text (e.g. fire, spell, cast speed, critical, minion, " +
      "projectile, area of effect, attack speed). Use `avoid` to rule out mods, e.g. [\"attack\"] for a caster. " +
      "Give `itemLevel` for leveling advice: each mod then shows the best tier that can roll at that level, plus the end-game tier. " +
      "Slots: " + Object.keys(SLOT_CLASSES).join(", ") + ".",
    inputSchema: {
      terms: z.array(z.string()).min(1),
      avoid: z.array(z.string()).optional(),
      slots: z.array(z.string()).optional().describe("Default: armour, jewellery and jewels"),
      perSlot: z.number().int().min(1).max(20).optional(),
      defence: z
        .array(z.enum(DEFENCE_STYLES))
        .optional()
        .describe("Defence layers the build uses, e.g. [\"energy shield\"] or [\"life\", \"armour\"]. Resistances are always included. Default: all"),
      itemLevel: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Item level to plan for: roughly the area level; during the campaign about the character level"),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) =>
    run(async () => {
      const { data } = await gameData();
      const { offence, defence } = statPriorities(data, args);
      return json({ itemLevel: args.itemLevel ?? "end-game", offence, defenceBaseline: defence });
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

server.registerTool(
  "leveling_phases",
  {
    title: "Leveling phases",
    description:
      "Campaign and end-game phases for a league-start character (Act 1 … Interludes, early maps, end-game), with approximate " +
      "level ranges, a checkpoint level to run check_build at, passive points and quest Spirit by then, the highest gem level " +
      "usable, and the quest rewards in each phase (resistances, Spirit, life, and choices). Level ranges come from quest area levels.",
    annotations: { readOnlyHint: true },
  },
  async () =>
    run(async () => {
      const { data } = await gameData();
      return json(levelingPhases(data));
    }),
);

server.registerTool(
  "check_build",
  {
    title: "Check a build at a character level",
    description:
      "Rule-based checks for a planned build at a given character level: which skills are usable yet (and from what level), " +
      "gem attribute requirements vs Strength/Dexterity/Intelligence from the class, passives and gear (and how to spend " +
      "\"+5 to any Attribute\" passives), Spirit for persistent skills vs Spirit from quests, passives and gear, and the passive " +
      "point budget. Run it for each leveling phase (e.g. levels 12, 28, 45, 65, 90). No damage numbers yet.",
    inputSchema: {
      class: z.string().describe("Class or ascendancy name"),
      ascendancy: z.string().optional(),
      characterLevel: z.number().int().min(1).max(100),
      passives: z.array(z.string()).describe("Main-tree passives taken by this level (key, id or exact name)"),
      ascendancyPassives: z.array(z.string()).optional(),
      skills: z.array(z.object({ gemId: z.string().describe("gemId or exact name"), supports: z.array(z.string()).optional() })),
      gearAttributes: z
        .object({ str: z.number().optional(), dex: z.number().optional(), int: z.number().optional() })
        .optional()
        .describe("Attributes expected from gear, if known"),
      gearSpirit: z.number().int().min(0).optional().describe("Spirit from gear, if known (e.g. a sceptre)"),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) =>
    run(async () => {
      const { data, tree } = await gameData();
      const { cls } = findClass(data, args.class, args.ascendancy);
      return json(
        checkBuild(data, data.nodes, {
          cls,
          characterLevel: args.characterLevel,
          passives: args.passives.map((p) => resolveNode(tree, p)),
          ascendancyPassives: args.ascendancyPassives?.map((p) => resolveNode(tree, p)),
          skills: args.skills.map((s) => ({ gem: findGem(data, s.gemId), supports: s.supports?.map((id) => findGem(data, id)) })),
          gearAttributes: args.gearAttributes,
          gearSpirit: args.gearSpirit,
        }),
      );
    }),
);

const guidePassive = z.object({
  id: z.string().describe("Passive id, key or exact name"),
  level: z.number().int().min(1).max(100).optional().describe("Level to take it (takeAtLevel)"),
});

server.registerTool(
  "create_build_guide",
  {
    title: "Create a build guide page",
    description:
      "Write a full build guide as a local web page and open it in the player's browser (like a Maxroll or Mobalytics guide): " +
      "overview, strengths and weaknesses, a tab per phase (skills and supports, key passives with levels, ascendancy, gear to look " +
      "for, quest rewards, a checklist before moving on, when to switch setups), automatic checks per phase, a zoomable passive tree " +
      "highlighting each phase, and a downloadable Build Planner file per phase. When the Path of Building engine is available, each " +
      "phase also gets real numbers and a verdict band at its last level. Use after planning; ask the player first. " +
      "passivePlan is the plan_passive_tree output (id + takeAtLevel); phases split it by level. Give a phase its own passives only " +
      "when it respecs. Gear slots use stat_priorities names (Ring, Wand, Focus…).",
    inputSchema: {
      name: z.string().min(1).max(80),
      class: z.string().describe("Class or ascendancy name"),
      ascendancy: z.string().optional(),
      leagueStart: z.boolean(),
      summary: z.string().describe("The play fantasy and how the build delivers it, in plain language"),
      playstyle: z.string().optional(),
      strengths: z.array(z.string()).optional(),
      weaknesses: z.array(z.string()).optional(),
      notes: z.array(z.string()).optional(),
      terms: z.array(z.string()).optional().describe("What the build scales, for the assumed gear in Path of Building numbers"),
      avoid: z.array(z.string()).optional(),
      defence: z.array(z.enum(DEFENCE_STYLES)).optional().describe("Defence layers for the assumed gear (default: life)"),
      weapons: z.array(z.string()).optional(),
      passivePlan: z.array(guidePassive),
      ascendancyPassives: z
        .array(z.object({ id: z.string(), phase: z.number().int().min(0).optional().describe("0-based phase index it's taken in") }))
        .optional(),
      phases: z
        .array(
          z.object({
            name: z.string(),
            levels: z.tuple([z.number().int().min(1).max(100), z.number().int().min(1).max(100)]),
            summary: z.string().optional(),
            assessment: z.string().optional().describe("Plain-language viability read for this phase"),
            skills: z.array(
              z.object({
                gemId: z.string().describe("gemId or exact name"),
                note: z.string().optional(),
                supports: z.array(z.object({ gemId: z.string(), note: z.string().optional() })).optional(),
              }),
            ),
            gear: z.array(z.object({ slot: z.string(), priorities: z.array(z.string()), note: z.string().optional() })).optional(),
            checklist: z.array(z.string()).optional(),
            switchNote: z.string().optional(),
            passives: z.array(guidePassive).optional().describe("Only when this phase uses a different tree (respec)"),
            gearAttributes: z.object({ str: z.number().optional(), dex: z.number().optional(), int: z.number().optional() }).optional(),
            gearSpirit: z.number().int().min(0).optional(),
          }),
        )
        .min(1),
      open: z.boolean().optional().describe("Open in the browser (default true)"),
    },
  },
  async (args) =>
    run(async () => {
      const { data, tree } = await gameData();
      const { cls, asc } = findClass(data, args.class, args.ascendancy);
      const result = await createGuide(
        data,
        tree,
        (ref) => resolveNode(tree, ref),
        {
          name: args.name,
          cls,
          ascendancyId: asc?.id,
          ascendancyName: asc?.name,
          leagueStart: args.leagueStart,
          summary: args.summary,
          playstyle: args.playstyle,
          strengths: args.strengths,
          weaknesses: args.weaknesses,
          notes: args.notes,
          passivePlan: args.passivePlan,
          ascendancyPassives: args.ascendancyPassives,
          phases: args.phases,
          terms: args.terms,
          avoid: args.avoid,
          defence: args.defence,
          weapons: args.weapons,
        },
        { open: args.open, toolVersion: VERSION, engine: getEngine() },
      );
      return json({
        opened: args.open !== false,
        path: result.path,
        buildFiles: result.buildFiles,
        warningsByPhase: result.warningsByPhase,
        tip: "The page is a local file; the player can bookmark it or re-run this tool to update it. Build files are also in that folder.",
      });
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
          gemId: z.string().describe("gemId or exact gem name"),
          fromLevel: z.number().int().min(0).max(100).optional(),
          toLevel: z.number().int().min(0).max(100).optional().describe("For leveling skills you swap out later"),
          note: z.string().optional(),
          supports: z
            .array(z.object({ gemId: z.string().describe("gemId or exact support name"), fromLevel: z.number().int().min(0).max(100).optional(), note: z.string().optional() }))
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

// Don't leave Path of Building running after Claude closes the extension.
const shutdown = () => {
  if (engine) engine.stop();
};
process.on("exit", shutdown);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));
process.stdin.on("end", () => process.exit(0));
server.server.onclose = shutdown;

await server.connect(new StdioServerTransport());
log(`v${VERSION} ready`);
// Start loading data in the background so the first tool call is fast.
gameData().catch((error: unknown) => log(`data load failed: ${String(error)}`));
