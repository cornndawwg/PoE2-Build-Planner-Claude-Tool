// Builds a guide from Claude's phase-by-phase plan: resolves ids and names, runs the checks for
// each phase, adds quest rewards, writes a Build Planner file per phase, and renders the page.

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkBuild } from "../build/checks.js";
import type { GameData, PlayableClass } from "../data/gamedata.js";
import { buildFileName, toBuildFile, type PlanSlot } from "../export/buildFile.js";
import { availableFromLevel } from "../skills/levels.js";
import { findGem } from "../skills/skills.js";
import { stripMarkup } from "../text.js";
import { nodeKind, type PassiveTree } from "../tree/tree.js";
import { evaluateBuild } from "../engine/evaluate.js";
import type { PobEngine } from "../engine/pob.js";
import type { DefenceStyle } from "../gear/priorities.js";
import { renderGuide, type GuideModel, type GuidePhase } from "./render.js";

export interface GuidePassiveInput {
  id: string;
  /** Level to take it at (takeAtLevel from plan_passive_tree). */
  level?: number;
}

export interface GuidePhaseInput {
  name: string;
  levels: [number, number];
  summary?: string;
  /** Plain-language viability read for this phase. */
  assessment?: string;
  skills: { gemId: string; note?: string; supports?: { gemId: string; note?: string }[] }[];
  gear?: { slot: string; priorities: string[]; note?: string }[];
  checklist?: string[];
  switchNote?: string;
  /** Full passive list for this phase when it differs from the main plan (e.g. after a respec). */
  passives?: GuidePassiveInput[];
  gearAttributes?: { str?: number; dex?: number; int?: number };
  gearSpirit?: number;
}

export interface GuideInput {
  name: string;
  cls: PlayableClass;
  ascendancyId?: string;
  ascendancyName?: string;
  leagueStart: boolean;
  summary: string;
  playstyle?: string;
  strengths?: string[];
  weaknesses?: string[];
  notes?: string[];
  /** The main passive plan, in order, with the level to take each (from plan_passive_tree). */
  passivePlan: GuidePassiveInput[];
  /** Ascendancy passives with the phase (0-based) they're taken in; default: the last phase. */
  ascendancyPassives?: { id: string; phase?: number }[];
  phases: GuidePhaseInput[];
  /** For the assumed gear in Path of Building numbers (as for stat_priorities). */
  terms?: string[];
  avoid?: string[];
  defence?: DefenceStyle[];
  weapons?: string[];
}

/** Guide slot names (from stat_priorities) mapped to Build Planner inventory slots. */
const SLOT_TO_INVENTORY: Record<string, string[]> = {
  Helmet: ["Helmet"],
  "Body Armour": ["Body Armour"],
  Gloves: ["Gloves"],
  Boots: ["Boots"],
  Amulet: ["Amulet"],
  Ring: ["Left Ring", "Right Ring"],
  "Left Ring": ["Left Ring"],
  "Right Ring": ["Right Ring"],
  Belt: ["Belt"],
  Shield: ["Off Hand"],
  Focus: ["Off Hand"],
  Quiver: ["Off Hand"],
  "Off Hand": ["Off Hand"],
  "Main Hand": ["Main Hand"],
  Wand: ["Main Hand"],
  Staff: ["Main Hand"],
  Sceptre: ["Main Hand"],
  Bow: ["Main Hand"],
  Crossbow: ["Main Hand"],
  "One Hand Mace": ["Main Hand"],
  "Two Hand Mace": ["Main Hand"],
  Spear: ["Main Hand"],
  Quarterstaff: ["Main Hand"],
  Talisman: ["Main Hand"],
};

export function guidesDir(): string {
  if (process.env.POE2BF_GUIDES_DIR) return process.env.POE2BF_GUIDES_DIR;
  const base = process.env.APPDATA ?? join(homedir(), ".local", "share");
  return join(base, "poe2-build-finder", "guides");
}

export function openInBrowser(path: string): void {
  if (process.env.POE2BF_NO_OPEN) return;
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", path]]
      : process.platform === "darwin"
        ? ["open", [path]]
        : ["xdg-open", [path]];
  const child = spawn(cmd, args as string[], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

export interface GuideResult {
  path: string;
  dir: string;
  buildFiles: string[];
  warningsByPhase: Record<string, string[]>;
}

export async function createGuide(
  data: GameData,
  tree: PassiveTree,
  resolveNode: (ref: string) => string,
  input: GuideInput,
  options: { open?: boolean; toolVersion: string; engine?: PobEngine | null },
): Promise<GuideResult> {
  if (input.phases.length === 0) throw new Error("A guide needs at least one phase.");
  const phases = [...input.phases].sort((a, b) => a.levels[0] - b.levels[0]);
  const last = phases.length - 1;
  const phaseOfLevel = (level?: number) => {
    if (level === undefined) return last;
    const i = phases.findIndex((p) => level <= p.levels[1]);
    return i === -1 ? last : i;
  };

  const mainPlan = input.passivePlan.map((p) => ({ key: resolveNode(p.id), level: p.level }));
  const asc = (input.ascendancyPassives ?? []).map((p) => ({ key: resolveNode(p.id), phase: Math.min(p.phase ?? last, last) }));

  // Passives allocated by the end of each phase (a phase's own list replaces the plan, e.g. after a respec).
  const allocatedBy = phases.map((phase, i) =>
    phase.passives
      ? phase.passives.map((p) => ({ key: resolveNode(p.id), level: p.level }))
      : mainPlan.filter((p) => phaseOfLevel(p.level) <= i),
  );
  const firstPhase = new Map<string, number>();
  allocatedBy.forEach((list, i) => list.forEach((p) => firstPhase.has(p.key) || firstPhase.set(p.key, i)));
  const ascFirst = new Map(asc.map((a) => [a.key, a.phase]));

  const dir = join(guidesDir(), buildFileName(input.name).replace(/\.build$/, ""));
  await mkdir(dir, { recursive: true });

  const describe = (key: string) => {
    const node = tree.nodes.get(key)!;
    return { name: node.name ?? key, kind: nodeKind(node), stats: (node.stats ?? []).map(stripMarkup) };
  };

  const buildFiles: string[] = [];
  const warningsByPhase: Record<string, string[]> = {};
  const guidePhases: GuidePhase[] = [];

  for (const [i, phase] of phases.entries()) {
    const skills = phase.skills.map((s) => ({
      gem: findGem(data, s.gemId),
      note: s.note,
      supports: (s.supports ?? []).map((sup) => ({ gem: findGem(data, sup.gemId), note: sup.note })),
    }));
    const allocated = allocatedBy[i]!;
    const ascKeys = asc.filter((a) => a.phase <= i).map((a) => a.key);

    const check = checkBuild(data, tree.nodes, {
      cls: input.cls,
      passives: allocated.map((p) => p.key),
      ascendancyPassives: ascKeys,
      skills: skills.map((s) => ({ gem: s.gem, supports: s.supports.map((x) => x.gem) })),
      characterLevel: phase.levels[1],
      gearAttributes: phase.gearAttributes,
      gearSpirit: phase.gearSpirit,
    });
    const warnings = [...check.warnings];

    // A Build Planner file for this phase.
    let buildFile: string | undefined;
    try {
      const slots: PlanSlot[] = (phase.gear ?? []).flatMap((g) =>
        (SLOT_TO_INVENTORY[g.slot] ?? []).map((slot) => ({ slot, title: g.slot, priorities: g.priorities, note: g.note })),
      );
      const { build, warnings: exportWarnings } = toBuildFile(data, {
        name: `${input.name} - ${i + 1} ${phase.name}`,
        description: phase.summary,
        ascendancyId: input.ascendancyId,
        passives: [
          ...allocated.map((p) => ({ id: tree.nodes.get(p.key)!.id ?? p.key, level: p.level })),
          ...ascKeys.map((k) => ({ id: tree.nodes.get(k)!.id ?? k })),
        ],
        skills: skills.map((s) => ({
          gemId: s.gem.gameId,
          note: s.note,
          supports: s.supports.map((x) => ({ gemId: x.gem.gameId, note: x.note })),
        })),
        slots,
      });
      warnings.push(...exportWarnings);
      buildFile = buildFileName(build.name);
      await writeFile(join(dir, buildFile), JSON.stringify(build, null, 2));
      buildFiles.push(join(dir, buildFile));
    } catch (error) {
      warnings.push(`Build Planner file not made: ${error instanceof Error ? error.message : String(error)}`);
    }
    warningsByPhase[phase.name] = warnings;

    // Real numbers at the end of the phase, when the Path of Building engine is available.
    let numbers: GuidePhase["numbers"];
    let verdicts: GuidePhase["verdicts"];
    if (options.engine && skills.length > 0) {
      try {
        const main = skills[0]!.gem;
        const evaluation = await evaluateBuild(options.engine, data, {
          cls: input.cls,
          ascendancyName: input.ascendancyName,
          level: phase.levels[1],
          passives: [...allocated.map((p) => p.key), ...ascKeys],
          skills: skills.map((s) => ({ gem: s.gem, supports: s.supports.map((x) => x.gem) })),
          gear: {
            kind: "budget",
            terms: input.terms?.length ? input.terms : main.tags.filter((t) => !["intelligence", "strength", "dexterity", "repeatable"].includes(t)),
            avoid: input.avoid,
            defence: input.defence?.length ? input.defence : ["life"],
            weapons: input.weapons,
          },
        });
        numbers = {
          level: evaluation.level,
          clearDps: evaluation.clear.dps,
          rareSeconds: evaluation.clear.secondsToKill.rare,
          bossDps: evaluation.boss.dps,
          bossSeconds: evaluation.boss.secondsToKill.boss,
          bossLabel: evaluation.boss.enemy,
          hitsFromNormal: evaluation.survival.hitsFromNormal,
          hitsFromBoss: evaluation.survival.hitsFromBoss,
          life: evaluation.defence.life,
          energyShield: evaluation.defence.energyShield,
          resistances: evaluation.defence.resistances,
        };
        verdicts = evaluation.verdicts.map(({ content, overall, weakPoint, fixFirst }) => ({ content, overall, weakPoint, fixFirst }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Path of Building numbers unavailable: ${message.split(/\r?\n/)[0]}`);
      }
    }

    const newKeys = allocated.filter((p) => firstPhase.get(p.key) === i);
    guidePhases.push({
      name: phase.name,
      levels: phase.levels,
      summary: phase.summary,
      assessment: phase.assessment,
      skills: skills.map((s) => ({
        name: s.gem.name,
        availableFromLevel: availableFromLevel(s.gem),
        note: s.note,
        supports: s.supports.map((x) => ({ name: x.gem.name, tier: x.gem.tier, note: x.note })),
      })),
      keyPassives: newKeys
        .map((p) => ({ ...describe(p.key), level: p.level }))
        .filter((p) => p.kind !== "small" && p.kind !== "attribute"),
      pointsUsed: check.points.used,
      pointsAvailable: check.points.available,
      ascendancy: asc.filter((a) => a.phase === i).map((a) => describe(a.key)),
      gear: (phase.gear ?? []).map((g) => ({ slot: g.slot, priorities: g.priorities, note: g.note })),
      checklist: phase.checklist ?? [],
      switchNote: phase.switchNote,
      checkWarnings: warnings,
      questRewards: data.questRewards
        .filter((q) => q.areaLevel >= phase.levels[0] && q.areaLevel <= phase.levels[1])
        .map((q) => `${q.act} — ${q.quest}: ${q.reward ?? `choose ${q.options?.join(" or ")}`}`),
      buildFile,
      numbers,
      verdicts,
    });
  }

  const drawable = (key: string) => {
    const n = tree.nodes.get(key);
    return n && n.x !== undefined && key !== "root" && !n.isMastery;
  };
  const model: GuideModel = {
    name: input.name,
    className: input.cls.name,
    ascendancyName: input.ascendancyName,
    leagueStart: input.leagueStart,
    summary: input.summary,
    playstyle: input.playstyle,
    strengths: input.strengths ?? [],
    weaknesses: input.weaknesses ?? [],
    phases: guidePhases,
    notes: input.notes ?? [],
    generatedAt: new Date().toISOString().slice(0, 10),
    toolVersion: options.toolVersion,
    tree: [...tree.nodes]
      .filter(([key, node]) => drawable(key) && !node.ascendancyId)
      .map(([key, node]) => ({ key, node, phase: firstPhase.get(key) })),
    ascendancyTree: input.ascendancyId
      ? [...tree.nodes]
          .filter(([key, node]) => drawable(key) && node.ascendancyId === input.ascendancyId)
          .map(([key, node]) => ({ key, node, phase: ascFirst.get(key) }))
      : [],
  };

  const path = join(dir, "index.html");
  await writeFile(path, renderGuide(model));
  if (options.open !== false) openInBrowser(path);
  return { path, dir, buildFiles, warningsByPhase };
}
