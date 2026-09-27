#!/usr/bin/env node
// MCP server: exposes the build-planning tools to the player's Claude over stdio.
// stdout carries the protocol, so all logging goes to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { defaultCacheDir, ensureData, readCachedManifest } from "./data/cache.js";
import { loadGameData, type GameData, type PlayableClass } from "./data/gamedata.js";
import { buildFileName, findBuildPlannerDir, INVENTORY_IDS, toBuildFile, writeBuildFile } from "./export/buildFile.js";
import {
  amuletSkillSuggestions,
  anointSuggestions,
  flaskSuggestions,
  jewelSuggestions,
  socketableSuggestions,
  spiritSuggestions,
  uniqueFlaskSuggestions,
  type PriceLookup,
} from "./gear/extras.js";
import { DIVINE, formatPrice, getPrices, type PriceTable } from "./prices/exchange.js";
import { itemPrices, priceLookup } from "./prices/lookup.js";
import { itemClassOfBase, rareSearchLink, uniqueSearchLink } from "./prices/trade.js";
import { DEFENCE_STYLES, SLOT_CLASSES, statPriorities, type DefenceStyle } from "./gear/priorities.js";
import { findUniques } from "./gear/uniques.js";
import { checkBuild } from "./build/checks.js";
import { validateSkills } from "./build/validate.js";
import { levelingPhases } from "./build/phases.js";
import { compareBuilds } from "./engine/compare.js";
import { evaluateBuild, type EvaluateInput } from "./engine/evaluate.js";
import { findEngine, PobEngine } from "./engine/pob.js";
import { createGuide } from "./guide/guide.js";
import type { Skill } from "./data/types.js";
import { availableFromLevel } from "./skills/levels.js";
import { compatibleSupports, findGem, searchSkills } from "./skills/skills.js";
import { stripMarkup } from "./text.js";
import { completePassives } from "./tree/complete.js";
import { findScaling } from "./tree/scaling.js";
import { ASCENDANCY_POINTS, PassiveTree, pointsAtLevel, withLevels } from "./tree/tree.js";

const VERSION = "0.4.0";
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

To weigh two options (weapon choice, ascendancy, a key unique), use compare_builds instead of guessing.

Chase uniques (Mageblood, Headhunter and similar): only suggest them if the player has the budget or asks. Show what they add with compare_builds, with and without the unique in items (flasks are assumed, so Mageblood's effect counts; set flasksActive). Headhunter's stolen rare-monster mods can't be calculated, so describe them instead. Timeless jewels (Heroic Tragedy, Undying Hate) aren't calculated yet either: describe what they do and say the numbers leave them out. Give a trade_links search so the player can see the current price.

Costs: item_prices has live prices for currency, runes, soul cores, Liquid Emotions, omens and other stackables. Uniques and rares aren't priced; give trade_links searches the player opens themselves. Budget/mid/high gear: evaluate_build's gearTier.

Typical flow: list_classes → search_skills → compatible_supports → find_passives (with the class and ascendancy) → plan_passive_tree with the notables you chose → check_build → evaluate_build (real numbers and a verdict per phase) → stat_priorities → suggest_extras (Spirit skills, free-Spirit amulets, jewels, flasks and charms, anoints, runes and soul cores) → find_uniques → export_build (ask the player first) → create_build_guide to lay it all out as a web page (ask first; it opens in their browser). For a league start, export one Build Planner file per phase whose setup differs (e.g. "Name - 1 Acts 1-2", "Name - 2 Acts 3-4", "Name - 3 Maps"), so the player can switch plans in game.

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

/** Currency Exchange prices, or why they aren't available (offline, no data this hour). */
async function prices(data: GameData, league?: string): Promise<{ table?: PriceTable; lookup?: PriceLookup; error?: string }> {
  try {
    const table = await getPrices({ league });
    return { table, lookup: priceLookup(data, table) };
  } catch (error) {
    return { error: `Prices unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
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
      "Find active and spirit skill gems by gem tags, skill types, name words or description text. `require` terms must all match " +
      "tags/types/name; `text` words must all appear in the skill's description (e.g. [\"poison\"], [\"slam\"]); `prefer` terms rank results. " +
      "Useful terms: fire, cold, lightning, chaos, physical, spell, attack, projectile, area, melee, slam, strike, minion, bow, crossbow, " +
      "mace, spear, quarterstaff, totem, curse, aura, herald, channelling, duration, persistent, buff. Each result has the gemId, tags, " +
      "skill types, description, weapon requirements, earliest level and where it comes from (uncut-gem or item). Use gem_details for " +
      "one gem's full details and compatible_supports for its supports.",
    inputSchema: {
      require: z.array(z.string()).optional().describe("All must match tags/types/name, e.g. [\"fire\", \"spell\"]"),
      text: z.array(z.string()).optional().describe("Words that must all appear in the description, e.g. [\"poison\"]"),
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
      gemId: z.string().describe("The skill's exact name (e.g. \"Fireball\") or its gemId from the search_skills tool"),
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
  "gem_details",
  {
    title: "Gem details",
    description:
      "Everything about one skill, spirit or support gem: tags, skill types (what supports and passives key off), description, " +
      "what it does at gem levels 1 and 20, Spirit cost, attribute weighting, weapon requirements, earliest character level, " +
      "support family, and the supports the game recommends for it. Pass the exact name or gemId.",
    inputSchema: { gem: z.string().describe("Exact gem name, e.g. \"Herald of Ash\", or gemId") },
    annotations: { readOnlyHint: true },
  },
  async ({ gem: ref }) =>
    run(async () => {
      const { data } = await gameData();
      const gem = findGem(data, ref);
      const skill = data.skills[gem.grantedEffectId] as
        | (Skill & { stat_sets?: { per_level?: Record<string, { stat_text?: Record<string, string> }> }[] })
        | undefined;
      const statText = (level: string) =>
        Object.values(skill?.stat_sets?.[0]?.per_level?.[level]?.stat_text ?? {}).map(stripMarkup);
      const recommended = (gem.gem.recommended_supports ?? []).flatMap((id) => {
        try {
          return [findGem(data, id).name];
        } catch {
          return [];
        }
      });
      return json({
        name: gem.name,
        gemId: gem.gameId,
        kind: gem.kind,
        source: gem.source,
        availableFromLevel: availableFromLevel(gem),
        tags: gem.tags,
        skillTypes: skill?.active_skill?.types ?? [],
        description: stripMarkup(skill?.active_skill?.description ?? ""),
        supportText: gem.kind === "support" ? stripMarkup(gem.gem.support_text ?? "") : undefined,
        atLevel1: statText("1"),
        atLevel20: statText("20"),
        spiritCost: skill?.static?.reservations?.spirit,
        attributeWeights: gem.gem.requirement_weights,
        weaponRequirements: gem.weaponRequirements,
        supportFamily: gem.family,
        recommendedSupports: recommended,
      });
    }),
);

server.registerTool(
  "find_passives",
  {
    title: "Find scaling passives",
    description:
      "Notables, keystones and ascendancy notables whose text matches what the build scales. Give the class (and ascendancy) " +
      "to get distances from the class start and that ascendancy's nodes. Terms are words from passive text, e.g. " +
      "fire, spell, cast speed, critical, ignite, minion, projectile, area of effect, energy shield, life. " +
      "Set listAscendancy to get every node of the ascendancy (no terms needed), to see all 8-point options.",
    inputSchema: {
      terms: z.array(z.string()).optional().describe("Required unless listAscendancy is set"),
      class: z.string().optional().describe("Class or ascendancy name"),
      ascendancy: z.string().optional(),
      listAscendancy: z.boolean().optional().describe("List every node of the ascendancy, with stats"),
      includeJewelSockets: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ terms = [], class: className, ascendancy, listAscendancy, includeJewelSockets, limit }) =>
    run(async () => {
    const { data, tree } = await gameData();
    const found = className ? findClass(data, className, ascendancy) : undefined;
    if (listAscendancy) {
      if (!found?.asc) throw new Error("listAscendancy needs the ascendancy (e.g. class \"Titan\").");
      const nodes = [...tree.nodes].filter(([, n]) => n.ascendancyId === found.asc!.id && !n.isAscendancyStart);
      return json({
        ascendancy: found.asc.name,
        points: ASCENDANCY_POINTS,
        nodes: nodes.map(([key]) => {
          const d = tree.describe(key);
          return { key, id: d.id, name: d.name, kind: d.kind, stats: d.stats, connectsTo: tree.neighbors(key).filter((k) => tree.nodes.get(k)?.ascendancyId === found.asc!.id).map((k) => tree.describe(k).name) };
        }),
      });
    }
    if (terms.length === 0) throw new Error("Give some terms, or set listAscendancy.");
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

/** One build to calculate; shared by evaluate_build and compare_builds. */
const buildSpec = {
  class: z.string().describe("Class or ascendancy name"),
  ascendancy: z.string().optional(),
  level: z.number().int().min(1).max(100),
  passives: z.array(z.string()).describe("Main-tree passives taken by this level (key, id or exact name); missing connectors are added"),
  ascendancyPassives: z.array(z.string()).optional(),
  skills: z.array(z.object({ gemId: z.string().describe("gemId or exact name"), supports: z.array(z.string()).optional() })).min(1),
  mainSkill: z.number().int().min(0).optional().describe("0-based index of the main damage skill (default 0)"),
  terms: z.array(z.string()).optional().describe("What the build scales, for the assumed gear (as for stat_priorities)"),
  avoid: z.array(z.string()).optional(),
  defence: z.array(z.enum(DEFENCE_STYLES)).optional().describe("Defence layers for the assumed gear (default: life)"),
  weapons: z.array(z.string()).optional().describe("Weapon item classes to assume, e.g. [\"Staff\"], [\"Wand\", \"Focus\"], [\"One Hand Mace\", \"Shield\"]"),
  items: z
    .array(
      z.object({
        unique: z.string().optional().describe("Exact unique name, e.g. \"Plaguefinger\""),
        raw: z.string().optional().describe("Item text copied from the game (Ctrl+C)"),
        slot: z
          .string()
          .optional()
          .describe("Weapon 1, Weapon 2, Helmet, Body Armour, Gloves, Boots, Amulet, Ring 1, Ring 2, Belt or Jewel (usually worked out automatically)"),
      }),
    )
    .optional()
    .describe("Specific items; each replaces the assumed item in its slot. Jewels go in the tree's allocated jewel sockets."),
  gear: z.enum(["budget", "none"]).optional(),
  gearTier: z
    .enum(["budget", "mid", "high"])
    .optional()
    .describe("Quality of the assumed rares: budget (default, mid rolls), mid (good rolls, more mods), high (perfect rolls, full mods)"),
  anoint: z.string().optional().describe("Notable to anoint on the amulet (Liquid Emotions), e.g. \"Potent Incantation\""),
  helmetInstill: z.string().optional().describe("Notable to instill on the helmet via a Raven-Touched Shard (level 60+, expensive)"),
  socketables: z
    .array(z.object({ slot: z.string().describe("Helmet, Body Armour, Gloves, Boots, Weapon 1, Weapon 2…"), names: z.array(z.string()) }))
    .optional()
    .describe("Runes, soul cores and idols to socket, by slot"),
  amuletSkill: z
    .string()
    .optional()
    .describe("A skill granted with no Spirit cost by a Lament, Portent or Absent Amulet (replaces the amulet), e.g. \"Herald of Ash\""),
  flasks: z
    .array(z.object({ unique: z.string().optional(), raw: z.string().optional(), slot: z.string().optional() }))
    .optional()
    .describe("Unique flasks and charms by name (or item text); plain life/mana flasks are assumed otherwise"),
  flasksActive: z.boolean().optional().describe("Calculate with flasks active"),
  weaponSwap: z
    .object({
      weapons: z.array(z.string()).optional().describe("Item classes for weapon set 2, e.g. [\"Bow\"]"),
      items: z.array(z.object({ unique: z.string().optional(), raw: z.string().optional(), slot: z.string().optional() })).optional(),
      passives: z.array(z.string()).optional().describe("Passives that only apply with weapon set 2"),
      skills: z.array(z.object({ gemId: z.string(), supports: z.array(z.string()).optional() })).optional().describe("Skills used with weapon set 2"),
      active: z.boolean().optional().describe("Calculate with weapon set 2 active"),
    })
    .optional()
    .describe("Weapon swap: a second weapon set with its own passives and skills"),
};
type BuildSpec = z.infer<z.ZodObject<typeof buildSpec>>;

function toEvaluateInput(data: GameData, tree: PassiveTree, spec: BuildSpec) {
  const { cls, asc } = findClass(data, spec.class, spec.ascendancy);
  const skills = spec.skills.map((s) => ({ gem: findGem(data, s.gemId), supports: s.supports?.map((id) => findGem(data, id)) }));
  const terms = spec.terms?.length
    ? spec.terms
    : skills[spec.mainSkill ?? 0]!.gem.tags.filter((t) => !["intelligence", "strength", "dexterity", "repeatable"].includes(t));
  const passiveKeys = [...spec.passives, ...(spec.ascendancyPassives ?? [])].map((p) => resolveNode(tree, p));
  const skillIssues = validateSkills(data, skills, passiveKeys.flatMap((k) => tree.nodes.get(k) ?? []));
  const input: EvaluateInput = {
    cls,
    ascendancyName: asc?.name,
    ascendancyId: asc?.id,
    level: spec.level,
    passives: passiveKeys,
    skills,
    mainSkill: spec.mainSkill,
    items: spec.items,
    tree,
    gear:
      spec.gear === "none"
        ? { kind: "none" }
        : {
            kind: "budget",
            terms,
            avoid: spec.avoid,
            defence: spec.defence?.length ? spec.defence : ["life"],
            weapons: spec.weapons,
            tier: spec.gearTier,
          },
    extras: {
      anoint: spec.anoint,
      helmetInstill: spec.helmetInstill,
      socketables: spec.socketables,
      amuletSkill: spec.amuletSkill,
      flasks: spec.flasks,
      flasksActive: spec.flasksActive,
      weaponSwap: spec.weaponSwap && {
        weapons: spec.weaponSwap.weapons,
        items: spec.weaponSwap.items,
        passives: spec.weaponSwap.passives?.map((p) => resolveNode(tree, p)),
        skills: spec.weaponSwap.skills?.map((s) => ({ gem: findGem(data, s.gemId), supports: s.supports?.map((id) => findGem(data, id)) })),
        active: spec.weaponSwap.active,
      },
    },
  };
  return { input, skillIssues };
}

const engineUnavailable = () =>
  json({
    available: false,
    reason:
      process.platform === "win32"
        ? "The Path of Building engine files aren't installed with this copy of the tool."
        : "The Path of Building engine currently ships for Windows only.",
    hint: "Use check_build for rule-based checks instead.",
  });

server.registerTool(
  "evaluate_build",
  {
    title: "Calculate a build with Path of Building",
    description:
      "Real numbers from Path of Building's calculation engine for a planned build at a character level: damage against normal " +
      "monsters and against a boss, seconds to kill a normal/rare monster and a boss, hits you survive from monsters and bosses, " +
      "life, energy shield, resistances (with the campaign's resistance penalty and only the quest rewards earned by that level), " +
      "Spirit and attributes, plus a verdict band (Comfortable / Workable / Borderline / Not yet) with the weak point and what to fix " +
      "first. Level 65+ is judged for early maps, T15 and juiced T16. Damage is broken down into hits, ignite, poison, bleed and " +
      "minions. By default it assumes budget rare gear for that level (a few mid-roll mods per slot, based on `terms` and `defence`), " +
      "including a budget jewel in each allocated jewel socket; pass `items` to use specific uniques (by name) or pasted item text " +
      "in their slots (jewels too), or `gear: \"none\"` for no gear. Missing connecting passives are filled in (and listed), and " +
      "\"+5 to any Attribute\" passives are spent where the gems and weapon need them. `gearTier` sets how good the assumed rares are " +
      "(budget, mid or high). Extras: an amulet `anoint` and a helmet instill (`helmetInstill`, via a Raven-Touched Shard), runes, soul " +
      "cores and idols (`socketables`), a skill from a Lament/Portent/Absent Amulet with no Spirit cost (`amuletSkill`), unique flasks and " +
      "charms (`flasks`, with `flasksActive`), and a `weaponSwap` set with its own weapons, passives and skills. " +
      "Timeless jewels (Heroic Tragedy, Undying Hate) aren't calculated by Path of Building for PoE2 yet. To compare options side by side, use " +
      "compare_builds. Numbers are estimates: assumed gear and heuristic bands, not guarantees. Windows only for now.",
    inputSchema: buildSpec,
    annotations: { readOnlyHint: true },
  },
  async (args) =>
    run(async () => {
      const { data, tree } = await gameData();
      const engine = getEngine();
      if (!engine) return engineUnavailable();
      const { input, skillIssues } = toEvaluateInput(data, tree, args);
      const evaluation = await evaluateBuild(engine, data, input);
      return json({ available: true, skillIssues, ...evaluation });
    }),
);

server.registerTool(
  "compare_builds",
  {
    title: "Compare build options side by side",
    description:
      "Calculate 2–4 variants of a build the same way and compare them: e.g. two-handed vs one-handed + shield Titan, two " +
      "ascendancies for the same theme, or a build with and without a key unique. Each variant is a full build (same fields as " +
      "evaluate_build) with a label; usually they share most fields and differ in weapons, items, passives, skills or ascendancy. " +
      "Returns damage, kill times, survival, life/ES, resistances, attribute shortfalls and verdicts per variant, the change " +
      "against the first variant, and which is best for clearing, bossing and survival. Windows only for now.",
    inputSchema: {
      variants: z.array(z.object({ label: z.string(), ...buildSpec })).min(2).max(4),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ variants }) =>
    run(async () => {
      const { data, tree } = await gameData();
      const engine = getEngine();
      if (!engine) return engineUnavailable();
      const prepared = variants.map((v) => ({ label: v.label, ...toEvaluateInput(data, tree, v) }));
      const comparison = await compareBuilds(engine, data, prepared.map(({ label, input }) => ({ label, input })));
      return json({
        available: true,
        ...comparison,
        skillIssues: Object.fromEntries(prepared.filter((p) => p.skillIssues.length).map((p) => [p.label, p.skillIssues])),
      });
    }),
);

server.registerTool(
  "suggest_extras",
  {
    title: "Suggest Spirit skills, jewels, flasks, anoints, runes and more",
    description:
      "Suggestions beyond the main skill at a character level: persistent skills (auras, heralds, buffs) that fit the build and " +
      "what they cost against the Spirit available by then (quests plus any gear Spirit you give), with a pick that fits — and " +
      "which ones a Lament, Portent or Absent Amulet grants with no Spirit cost (freeWithAmulet, and the amuletSkills section); the best " +
      "jewel type and its mods, plus fitting unique jewels; the best life and mana flask for the level, useful flask mods, charms, and " +
      "fitting unique flasks and charms; amulet anoints (notables and their Liquid Emotions recipe, with cost) and the helmet instill " +
      "(a Raven-Touched Shard in the helmet allows a second notable); and runes, soul cores and idols per gear slot. Costs are in " +
      "Exalted Orbs from the official Currency Exchange (last full hour) when it can be reached. Try any of these in evaluate_build " +
      "(anoint, helmetInstill, socketables, amuletSkill, flasks).",
    inputSchema: {
      level: z.number().int().min(1).max(100),
      terms: z.array(z.string()).min(1).describe("What the build scales, e.g. [\"fire\", \"spell\", \"ignite\"]"),
      avoid: z.array(z.string()).optional(),
      defence: z.array(z.enum(DEFENCE_STYLES)).optional().describe("Default: life"),
      mainSkill: z.string().optional().describe("Main skill name (for the jewel type)"),
      gearSpirit: z.number().int().min(0).optional().describe("Spirit from gear, if any"),
      alreadyUsing: z.array(z.string()).optional().describe("Spirit skills already in the build"),
      allocated: z.array(z.string()).optional().describe("Passives already in the tree (keys, ids or names), left out of anoints"),
      socketSlots: z.array(z.string()).optional().describe("Slots for rune suggestions, e.g. [\"Body Armour\", \"Staff\"]. Default: armour slots"),
      league: z.string().optional().describe("Trade league for prices. Default: the main league"),
      only: z
        .array(z.enum(["spirit", "jewels", "flasks", "anoints", "socketables", "amuletSkills"]))
        .optional()
        .describe("Default: all"),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) =>
    run(async () => {
      const { data, tree } = await gameData();
      const query = {
        level: args.level,
        terms: args.terms,
        avoid: args.avoid,
        defence: args.defence?.length ? args.defence : (["life"] as DefenceStyle[]),
        mainSkill: args.mainSkill ? findGem(data, args.mainSkill) : undefined,
        gearSpirit: args.gearSpirit,
        alreadyUsing: args.alreadyUsing,
      };
      const want = new Set<string>(args.only?.length ? args.only : ["spirit", "jewels", "flasks", "anoints", "socketables", "amuletSkills"]);
      const priced = want.has("anoints") || want.has("socketables") ? await prices(data, args.league) : {};
      return json({
        spirit: want.has("spirit") ? spiritSuggestions(data, query) : undefined,
        amuletSkills: want.has("amuletSkills") ? amuletSkillSuggestions(data, query) : undefined,
        jewels: want.has("jewels") ? jewelSuggestions(data, query) : undefined,
        flasksAndCharms: want.has("flasks") ? { ...flaskSuggestions(data, query), uniques: uniqueFlaskSuggestions(data, query).slice(0, 8) } : undefined,
        anoints: want.has("anoints")
          ? anointSuggestions(data, { ...query, allocated: args.allocated?.map((p) => resolveNode(tree, p)) }, priced.lookup)
          : undefined,
        socketables: want.has("socketables") ? socketableSuggestions(data, { ...query, slots: args.socketSlots }, priced.lookup) : undefined,
        prices: priced.table ? { league: priced.table.league, hour: new Date(priced.table.hour * 1000).toISOString() } : priced.error,
      });
    }),
);

server.registerTool(
  "item_prices",
  {
    title: "Prices of currency and stackable items",
    description:
      "Current prices from the official Currency Exchange (the last full hour) for stackable items: currency orbs, runes, soul cores, " +
      "idols, Liquid Emotions, omens, catalysts, essences, the Raven-Touched Shard and so on. Prices are in Exalted Orbs (and Divine " +
      "Orbs for expensive items), estimated from what actually traded. Uniques and rares aren't on the exchange: use trade_links.",
    inputSchema: {
      names: z.array(z.string()).min(1).max(50).describe("Item names, e.g. [\"Divine Orb\", \"Desert Rune\"]"),
      league: z.string().optional().describe("Default: the main trade league"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) =>
    run(async () => {
      const { data } = await gameData();
      const table = await getPrices({ league: args.league });
      return json({
        league: table.league,
        hour: new Date(table.hour * 1000).toISOString(),
        divineOrb: formatPrice(table.exalted[DIVINE]),
        prices: itemPrices(data, table, args.names),
        otherLeagues: table.leagues.filter((l) => l !== table.league),
      });
    }),
);

server.registerTool(
  "trade_links",
  {
    title: "Trade site search links",
    description:
      "Links to pre-filled searches on the official trade site that the player opens in their own browser (this tool never " +
      "contacts the trade site). Rare items: give the slot or item class and the mods to look for (e.g. the assumed gear from " +
      "evaluate_build or stat_priorities picks); each mod is searched at 80% of its value or better (`strictness`), cheapest first. " +
      "Uniques: give names (e.g. Mageblood, Headhunter). Mods the trade site's stat list doesn't recognise are listed in leftOut. " +
      "Share the links with the player; prices change constantly.",
    inputSchema: {
      league: z.string().optional().describe("Default: the main trade league (from the Currency Exchange; \"Standard\" if unreachable)"),
      rares: z
        .array(
          z.object({
            slot: z.string().describe("Slot or item class, e.g. Helmet, Ring, Staff, or a base type like \"Expert Hubris Circlet\""),
            mods: z.array(z.string()).describe("Mod lines, e.g. \"+80 to maximum Life\", \"+30% to Fire Resistance\""),
            maxLevel: z.number().int().min(1).max(100).optional().describe("Highest level requirement (the character's level)"),
            strictness: z.number().min(0.1).max(1).optional(),
          }),
        )
        .optional(),
      uniques: z.array(z.string()).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) =>
    run(async () => {
      const { data } = await gameData();
      const league = args.league ?? (await prices(data)).table?.league ?? "Standard";
      return json({
        league,
        rares: (args.rares ?? []).map((r) => {
          const itemClass = SLOT_CLASSES[r.slot]?.[0] ?? itemClassOfBase(data, r.slot) ?? r.slot;
          return { slot: r.slot, ...rareSearchLink(data, { league, itemClass, mods: r.mods, maxLevel: r.maxLevel, strictness: r.strictness }) };
        }),
        uniques: (args.uniques ?? []).map((name) => ({ name, ...uniqueSearchLink(data, { league, name }) })),
      });
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
      return json({
        phases: levelingPhases(data),
        notes: [
          "passivePoints already includes the quest rewards' \"+2 Weapon Set Passive Skill Points\" (24 in total), counted the way Path of Building counts them — spend them like normal points in the plan.",
          "Ascendancy points come from the Trials in the campaign (8 in total, 2 per trial). When each trial is done isn't in the game data; ask the player or give a rough estimate and say it's an estimate.",
          "Level ranges are approximate: they come from the area levels of the campaign's reward quests.",
        ],
      });
    }),
);

server.registerTool(
  "check_build",
  {
    title: "Check a build at a character level",
    description:
      "Rule-based checks for a planned build at a given character level: which skills are usable yet (and from what level), " +
      "gem attribute requirements vs Strength/Dexterity/Intelligence from the class, passives and gear (and how to spend " +
      "\"+5 to any Attribute\" passives), weapon attribute requirements (give `weapons`; Giant's Blood tripling is applied), " +
      "Spirit for persistent skills vs Spirit from quests, passives and gear, the passive point budget, and skill/support rules " +
      "(the same rules export_build enforces). Missing connecting passives are filled in and counted. Run it for each leveling " +
      "phase (e.g. levels 12, 28, 45, 65, 90). For damage and survival numbers use evaluate_build.",
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
      weapons: z
        .array(z.string())
        .optional()
        .describe("Weapons for their attribute requirements: item classes (\"Two Hand Mace\", \"Shield\") or exact base names"),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) =>
    run(async () => {
      const { data, tree } = await gameData();
      const { cls, asc } = findClass(data, args.class, args.ascendancy);
      const given = [...args.passives, ...(args.ascendancyPassives ?? [])].map((p) => resolveNode(tree, p));
      const completed = completePassives(tree, cls.startNode, given, asc?.id);
      const result = checkBuild(data, data.nodes, {
        cls,
        characterLevel: args.characterLevel,
        passives: completed.main,
        ascendancyPassives: completed.ascendancy,
        skills: args.skills.map((s) => ({ gem: findGem(data, s.gemId), supports: s.supports?.map((id) => findGem(data, id)) })),
        gearAttributes: args.gearAttributes,
        gearSpirit: args.gearSpirit,
        weapons: args.weapons,
      });
      if (completed.added.length) result.warnings.unshift(`Added ${completed.added.length} connecting passives the list was missing; they're counted in the budget.`);
      if (completed.unreachable.length) result.warnings.unshift(`Can't reach: ${completed.unreachable.join(", ")}.`);
      return json({ ...result, passivesAddedToConnect: completed.added });
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
            items: z
              .array(z.object({ unique: z.string().optional(), raw: z.string().optional(), slot: z.string().optional() }))
              .optional()
              .describe("Specific uniques (by name) or item text used for this phase's numbers"),
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
        opened: result.opened,
        path: result.path,
        folder: result.dir,
        buildFiles: result.buildFiles,
        warningsByPhase: result.warningsByPhase,
        tip: result.opened
          ? "Opened in the browser. The page is a local file; bookmark it or re-run this tool to update it."
          : "Not opened automatically: tell the player to open the path above (Documents › PoE2 Build Planner › guides) in a browser.",
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
