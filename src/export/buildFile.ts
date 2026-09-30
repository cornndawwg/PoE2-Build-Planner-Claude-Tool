// GGG's in-game Build Planner format (PoE2, "Version: 1 (Experimental)").
// Spec: https://www.pathofexile.com/developer/docs/game — "Build Planner".

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GameData } from "../data/gamedata.js";
import type { PlayerGem } from "../data/gamedata.js";
import { validateSkills } from "../build/validate.js";
import { findGem } from "../skills/skills.js";

type LevelInterval = number | [number, number];

/** Author on every file we write; also how we recognise our own files before overwriting. */
export const AUTHOR = "PoE2 Build Planner (Claude tool)";

export interface BuildPassive {
  id: string;
  level_interval?: LevelInterval;
  weapon_set?: number;
  additional_text?: string;
}

export interface BuildSupport {
  id: string;
  level_interval?: LevelInterval;
  additional_text?: string;
}

export interface BuildSkill extends BuildSupport {
  support_skills?: (string | BuildSupport)[];
}

export interface BuildInventorySlot {
  inventory_id: string;
  slot_x?: number;
  slot_y?: number;
  level_interval?: LevelInterval;
  unique_name?: string;
  additional_text?: string;
}

export interface BuildFile {
  name: string;
  author?: string;
  link?: string;
  description?: string;
  ascendancy?: string;
  passives?: (string | BuildPassive)[];
  skills?: (string | BuildSkill)[];
  inventory_slots?: BuildInventorySlot[];
}

/** Inventory ids the game uses for equipment hints. */
export const INVENTORY_IDS: Record<string, string> = {
  "Main Hand": "Weapon1",
  "Off Hand": "Offhand1",
  "Weapon Swap Main Hand": "Weapon2",
  "Weapon Swap Off Hand": "Offhand2",
  Helmet: "Helm1",
  "Body Armour": "BodyArmour1",
  Gloves: "Gloves1",
  Boots: "Boots1",
  Amulet: "Amulet1",
  "Left Ring": "Ring1",
  "Right Ring": "Ring2",
  Belt: "Belt1",
};

// --- What the planner hands us ---

export interface PlanPassive {
  /** Tree node id (from plan_passive_tree), e.g. "spells18". */
  id: string;
  /** Level to take it at; it stays relevant to level 100. */
  level?: number;
  note?: string;
  weaponSet?: number;
}

export interface PlanSkill {
  gemId: string;
  /** Levels this skill is used for, e.g. 1–30 for a leveling skill. Default: from its first use to 100. */
  fromLevel?: number;
  toLevel?: number;
  note?: string;
  supports?: { gemId: string; fromLevel?: number; note?: string }[];
}

export interface PlanSlot {
  /** A key of INVENTORY_IDS, e.g. "Helmet", "Left Ring". */
  slot: string;
  /** Short heading, e.g. "Energy Shield (Int base)". */
  title?: string;
  /** Stats to look for, most important first. */
  priorities?: string[];
  uniqueName?: string;
  note?: string;
}

export interface BuildPlan {
  name: string;
  description?: string;
  /** Ascendancy id from the tree data, e.g. "Witch1". */
  ascendancyId?: string;
  passives: PlanPassive[];
  skills: PlanSkill[];
  slots?: PlanSlot[];
}

/** Braces are markup syntax in additional_text; keep free text from breaking it. */
const plain = (text: string) => text.replace(/[{}]/g, "").trim();

const interval = (from?: number, to?: number): LevelInterval | undefined =>
  from === undefined && to === undefined ? undefined : [Math.max(0, from ?? 0), Math.min(100, to ?? 100)];

function slotText(slot: PlanSlot): string | undefined {
  const parts: string[] = [];
  if (slot.title) parts.push(`<silver>{${plain(slot.title)}}`);
  if (slot.priorities?.length) {
    const lines = slot.priorities.map((p, i) => `${i + 1}. ${plain(p)}`).join("\n");
    parts.push(`<grey>{Stat Priority\n-------------------\n${lines}}`);
  }
  if (slot.note) parts.push(plain(slot.note));
  return parts.length ? parts.join("\n\n") : undefined;
}

export interface BuildResult {
  build: BuildFile;
  /** Problems that don't stop the export but the player should know about. */
  warnings: string[];
}

/** Turn a plan into a .build object, checking every id against the game data. */
export function toBuildFile(data: GameData, plan: BuildPlan): BuildResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const passiveIds = new Set<string>();
  const ascendancyOfNode = new Map<string, string | undefined>();
  for (const node of data.nodes.values()) {
    if (node.id) {
      passiveIds.add(node.id);
      ascendancyOfNode.set(node.id, node.ascendancyId);
    }
  }
  const ascendancies = new Set(data.classes.flatMap((c) => c.ascendancies.map((a) => a.id)));
  if (plan.ascendancyId && !ascendancies.has(plan.ascendancyId)) errors.push(`Unknown ascendancy id "${plan.ascendancyId}"`);

  const passives: (string | BuildPassive)[] = [];
  for (const p of plan.passives) {
    if (!passiveIds.has(p.id)) {
      errors.push(`Unknown passive id "${p.id}"`);
      continue;
    }
    const nodeAscendancy = ascendancyOfNode.get(p.id);
    if (nodeAscendancy && nodeAscendancy !== plan.ascendancyId) {
      errors.push(`Passive "${p.id}" belongs to ascendancy ${nodeAscendancy}, not ${plan.ascendancyId ?? "none"}`);
      continue;
    }
    const entry: BuildPassive = { id: p.id };
    if (p.level !== undefined) entry.level_interval = interval(p.level);
    if (p.weaponSet !== undefined) entry.weapon_set = p.weaponSet;
    if (p.note) entry.additional_text = plain(p.note);
    passives.push(Object.keys(entry).length === 1 ? p.id : entry);
  }

  const lookup = (ref: string): PlayerGem | undefined => {
    try {
      return findGem(data, ref);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  };

  const skills: BuildSkill[] = [];
  for (const s of plan.skills) {
    const gem = lookup(s.gemId);
    if (!gem) continue;
    if (gem.kind === "support") {
      errors.push(`${gem.name} is a support gem; put it under a skill's supports`);
      continue;
    }
    if (gem.source === "item") warnings.push(`${gem.name} comes from an item, not a gem; the Build Planner may not show it`);
    const supportGems = (s.supports ?? []).flatMap((sup) => {
      const supportGem = lookup(sup.gemId);
      return supportGem ? [{ sup, supportGem }] : [];
    });
    // Same rules as check_build: rule errors stop the export before anything is written.
    for (const issue of validateSkills(data, [{ gem, supports: supportGems.map((x) => x.supportGem) }])) {
      (issue.severity === "error" ? errors : warnings).push(issue.message);
    }
    const supports: (string | BuildSupport)[] = [];
    for (const { sup, supportGem } of supportGems) {
      if (supportGem.kind !== "support") continue;
      const entry: BuildSupport = { id: supportGem.gameId };
      if (sup.fromLevel !== undefined) entry.level_interval = interval(sup.fromLevel);
      if (sup.note) entry.additional_text = plain(sup.note);
      supports.push(Object.keys(entry).length === 1 ? supportGem.gameId : entry);
    }
    const entry: BuildSkill = { id: gem.gameId };
    const range = interval(s.fromLevel, s.toLevel);
    if (range !== undefined) entry.level_interval = range;
    if (s.note) entry.additional_text = plain(s.note);
    if (supports.length) entry.support_skills = supports;
    skills.push(entry);
  }

  const slots: BuildInventorySlot[] = [];
  for (const slot of plan.slots ?? []) {
    const inventoryId = INVENTORY_IDS[slot.slot];
    if (!inventoryId) {
      errors.push(`Unknown slot "${slot.slot}". Slots: ${Object.keys(INVENTORY_IDS).join(", ")}`);
      continue;
    }
    const entry: BuildInventorySlot = { inventory_id: inventoryId };
    if (slot.uniqueName) entry.unique_name = slot.uniqueName;
    const text = slotText(slot);
    if (text) entry.additional_text = text;
    slots.push(entry);
  }

  if (errors.length) throw new Error(`Can't export build:\n- ${errors.join("\n- ")}`);

  const build: BuildFile = { name: plan.name.trim(), author: AUTHOR };
  if (plan.description) build.description = plan.description;
  if (plan.ascendancyId) build.ascendancy = plan.ascendancyId;
  if (passives.length) build.passives = passives;
  if (skills.length) build.skills = skills;
  if (slots.length) build.inventory_slots = slots;
  return { build, warnings };
}

// --- Writing the file ---

/** The game's BuildPlanner folder, if Path of Exile 2 has created its My Games folder. */
export function findBuildPlannerDir(): string | undefined {
  if (process.env.POE2BF_BUILDPLANNER_DIR) return process.env.POE2BF_BUILDPLANNER_DIR;
  const documents = [join(homedir(), "Documents"), join(homedir(), "OneDrive", "Documents")];
  for (const docs of documents) {
    const game = join(docs, "My Games", "Path of Exile 2");
    if (existsSync(game)) return join(game, "BuildPlanner");
  }
  return undefined;
}

export function buildFileName(name: string): string {
  const safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${safe || "build"}.build`;
}

/**
 * Write the build into the game's BuildPlanner folder. Refuses to replace a file this tool
 * didn't write unless `overwrite` is set.
 */
export async function writeBuildFile(build: BuildFile, dir: string, overwrite = false): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, buildFileName(build.name));
  if (existsSync(path) && !overwrite) {
    let ours = false;
    try {
      ours = (JSON.parse(await readFile(path, "utf8")) as BuildFile).author === AUTHOR;
    } catch {
      ours = false;
    }
    if (!ours) throw new Error(`${path} already exists and wasn't made by this tool. Pick another name or set overwrite.`);
  }
  await writeFile(path, JSON.stringify(build, null, 2));
  return path;
}

export interface BuildFileInfo {
  /** File name, e.g. "WFO - Leveling.build". */
  file: string;
  /** The build's name inside the file. */
  name?: string;
  madeByThisTool: boolean;
  modified: string;
}

/** The .build files in the BuildPlanner folder, newest first. */
export async function listBuildFiles(dir: string): Promise<BuildFileInfo[]> {
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".build"));
  const infos = await Promise.all(
    files.map(async (file) => {
      const path = join(dir, file);
      let name: string | undefined;
      let ours = false;
      try {
        const build = JSON.parse(await readFile(path, "utf8")) as BuildFile;
        name = build.name;
        ours = build.author === AUTHOR;
      } catch {
        // not readable as a build file
      }
      return { file, name, madeByThisTool: ours, modified: (await stat(path)).mtime.toISOString() };
    }),
  );
  return infos.sort((a, b) => b.modified.localeCompare(a.modified));
}

/**
 * Move files or folders out of the way into `archiveDir` (not deleted, so they can be restored).
 * Only entries directly inside `dir` whose names are given; returns what was moved.
 */
export async function archiveEntries(dir: string, entries: string[], archiveDir: string): Promise<{ moved: string[]; to: string }> {
  await mkdir(archiveDir, { recursive: true });
  const moved: string[] = [];
  for (const entry of entries) {
    const from = join(dir, entry);
    if (entry.includes("/") || entry.includes("\\") || entry.startsWith(".") || !existsSync(from)) continue;
    let target = join(archiveDir, entry);
    for (let n = 2; existsSync(target); n++) target = join(archiveDir, `${n} ${entry}`);
    await rename(from, target);
    moved.push(entry);
  }
  return { moved, to: archiveDir };
}
