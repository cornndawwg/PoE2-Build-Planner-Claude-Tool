// Find changes that raise damage without giving up survivability (and changes that raise
// survivability cheaply), by calculating each one in Path of Building. A best-effort search over
// likely candidates — supports, passives, Spirit skills, an anoint — not a guaranteed optimum.

import type { GameData, PlayerGem } from "../data/gamedata.js";
import { anointSuggestions, spiritSuggestions } from "../gear/extras.js";
import { compatibleSupports, findGem } from "../skills/skills.js";
import { completePassives } from "../tree/complete.js";
import { findScaling } from "../tree/scaling.js";
import { pointsAtLevel, type PassiveTree } from "../tree/tree.js";
import type { DefenceStyle } from "../gear/priorities.js";
import { evaluateBuild, type EvaluateInput, type Evaluation } from "./evaluate.js";
import type { PobEngine } from "./pob.js";

/** Per-candidate calculation limit; a stuck engine is restarted and the candidate skipped. */
const CANDIDATE_TIMEOUT_MS = 10_000;

/** Support sockets a skill gem can have. */
export const MAX_SUPPORTS = 5;

export type Objective = "clear" | "boss" | "balanced";
export type ChangeKind = "support" | "passive" | "spirit" | "anoint";

export interface OptimizeOptions {
  objective: Objective;
  /** What the build scales (as for find_passives), e.g. ["physical", "melee", "slam"]. */
  terms: string[];
  avoid?: string[];
  defence: DefenceStyle[];
  kinds?: ChangeKind[];
  /** Calculations to spend (default 45; each takes a fraction of a second). */
  maxEvaluations?: number;
  /** Consider lineage supports (rare, usually expensive). */
  includeLineage?: boolean;
}

interface Metrics {
  clearDps: number;
  bossDps: number;
  hitsFromNormal: number;
  hitsFromBoss: number;
  lifeAndEs: number;
  effectiveHp: number;
  maxHit: number;
  missingResistance: number;
  spiritUnreserved?: number;
}

export interface Change {
  kind: ChangeKind;
  /** What to change, in words ("Swap Close Combat for Heavy Swing on Sunder"). */
  change: string;
  /** How to apply it in evaluate_build / export_build. */
  apply: Record<string, unknown>;
  clearDps: string;
  bossDps: string;
  hitsFromBoss: string;
  lifeAndEs: string;
  effectiveHp: string;
  maxHit: string;
  /** Passive points it costs (passives, including connecting ones). */
  points?: number;
  /** More points than are free at this level: something else has to go. */
  overBudget?: boolean;
  /** Needs more Spirit than is free. */
  needsSpirit?: number;
  score: number;
}

const metrics = (e: Evaluation): Metrics => ({
  clearDps: e.clear.dps,
  bossDps: e.boss.dps,
  hitsFromNormal: e.survival.hitsFromNormal ?? 0,
  hitsFromBoss: e.survival.hitsFromBoss ?? 0,
  lifeAndEs: (e.defence.life ?? 0) + (e.defence.energyShield ?? 0),
  effectiveHp: e.defence.effectiveHp ?? 0,
  maxHit: e.survival.maxHit ?? 0,
  missingResistance: Object.values(e.defence.missingResistance).reduce<number>((sum, v) => sum + Math.max(0, v ?? 0), 0),
  spiritUnreserved: e.resources.spiritUnreserved,
});

const pct = (value: number, base: number) => {
  if (!base) return value ? "+∞" : "0%";
  const change = Math.round(((value - base) / base) * 1000) / 10;
  return `${change > 0 ? "+" : ""}${change}%`;
};
const gain = (value: number, base: number) => (base ? (value - base) / base : value > 0 ? 1 : 0);

function objectiveGain(m: Metrics, base: Metrics, objective: Objective): number {
  if (objective === "clear") return gain(m.clearDps, base.clearDps);
  if (objective === "boss") return gain(m.bossDps, base.bossDps);
  return gain(Math.sqrt(m.clearDps * m.bossDps), Math.sqrt(base.clearDps * base.bossDps));
}
/** Survivability: effective HP and the biggest hit survived (unrounded, unlike hits survived). */
const survivalGain = (m: Metrics, base: Metrics) => (gain(m.effectiveHp, base.effectiveHp) + gain(m.maxHit, base.maxHit)) / 2;
/** Doesn't give up survivability: effective HP and max hit within 2%, no new missing resistance. */
const keepsSurvival = (m: Metrics, base: Metrics) =>
  m.effectiveHp >= base.effectiveHp * 0.98 && m.maxHit >= base.maxHit * 0.98 && m.missingResistance <= base.missingResistance + 0.5;

export interface OptimizeResult {
  objective: Objective;
  baseline: { clearDps: number; bossDps: number; hitsFromBoss: number; effectiveHp: number; maxHit: number; pointsFree: number; spiritUnreserved?: number };
  /** Changes that raise the objective without giving up survivability, best first. */
  damage: Change[];
  /** Changes that raise survivability without losing more than 3% of the objective. */
  survival: Change[];
  /** Every Spirit skill tried and what it measured (some buffs aren't fully calculated). */
  spiritSkills: Change[];
  /** The best compatible picks together (one support change, affordable passives, one Spirit skill, an anoint). */
  combined?: { changes: string[]; clearDps: string; bossDps: string; effectiveHp: string; maxHit: string };
  evaluations: number;
  notes: string[];
}

export async function optimizeBuild(
  engine: PobEngine,
  data: GameData,
  tree: PassiveTree,
  base: EvaluateInput,
  options: OptimizeOptions,
): Promise<OptimizeResult> {
  const kinds = new Set<ChangeKind>(options.kinds ?? ["support", "passive", "spirit", "anoint"]);
  const budget = options.maxEvaluations ?? 45;
  let evaluations = 0;
  const notes: string[] = [];
  const failed: string[] = [];
  /** Calculate a candidate; undefined if Path of Building fails or gets stuck on it (it's skipped). */
  const run = async (input: EvaluateInput, label: string): Promise<Metrics | undefined> => {
    evaluations++;
    try {
      return metrics(await evaluateBuild(engine, data, input, CANDIDATE_TIMEOUT_MS));
    } catch {
      failed.push(label);
      return undefined;
    }
  };
  const baseEval = await evaluateBuild(engine, data, base);
  evaluations++;
  const b = metrics(baseEval);

  const mainIndex = base.mainSkill ?? 0;
  const main = base.skills[mainIndex]!;
  const completedBase = completePassives(tree, base.cls.startNode, base.passives, base.ascendancyId);
  const pointsFree = pointsAtLevel(base.level, data.questPoints) - completedBase.main.length;

  const damage: Change[] = [];
  const survival: Change[] = [];
  const record = (m: Metrics, change: Omit<Change, "clearDps" | "bossDps" | "hitsFromBoss" | "lifeAndEs" | "effectiveHp" | "maxHit" | "score">) => {
    const full: Change = {
      ...change,
      clearDps: pct(m.clearDps, b.clearDps),
      bossDps: pct(m.bossDps, b.bossDps),
      hitsFromBoss: pct(m.hitsFromBoss, b.hitsFromBoss),
      lifeAndEs: pct(m.lifeAndEs, b.lifeAndEs),
      effectiveHp: pct(m.effectiveHp, b.effectiveHp),
      maxHit: pct(m.maxHit, b.maxHit),
      score: 0,
    };
    const objective = objectiveGain(m, b, options.objective);
    const surv = survivalGain(m, b);
    if (objective > 0.01 && keepsSurvival(m, b)) damage.push({ ...full, score: objective });
    else if (surv > 0.02 && objective > -0.03 && m.missingResistance <= b.missingResistance + 0.5) survival.push({ ...full, score: surv });
    return full;
  };
  const spiritTried: Change[] = [];
  const left = () => budget - evaluations;

  // Supports on the main skill: add to a free socket, or swap out the weakest one.
  let bestSupport: { supports: PlayerGem[]; change: string; score: number } | undefined;
  if (kinds.has("support") && left() > 0) {
    const current = main.supports ?? [];
    const families = (list: PlayerGem[]) => new Set(list.map((g) => g.family).filter(Boolean));
    const candidates = compatibleSupports(data, main.gem.gameId, { prefer: options.terms, limit: 30, includeLineage: options.includeLineage ?? false })
      .map((m) => findGem(data, m.gameId))
      .filter((g) => !current.some((c) => c.gameId === g.gameId))
      .slice(0, 12);
    const withSupports = (supports: PlayerGem[]): EvaluateInput => ({
      ...base,
      skills: base.skills.map((s, i) => (i === mainIndex ? { ...s, supports } : s)),
    });
    let keep = current;
    let removed: PlayerGem | undefined;
    if (current.length >= MAX_SUPPORTS) {
      // The support whose removal costs least is the one to replace.
      let weakest: { gem: PlayerGem; loss: number } | undefined;
      for (const gem of current) {
        if (left() <= 0) break;
        const m = await run(withSupports(current.filter((g) => g !== gem)), `${main.gem.name} without ${gem.name}`);
        if (!m) continue;
        const loss = -objectiveGain(m, b, options.objective);
        if (!weakest || loss < weakest.loss) weakest = { gem, loss };
      }
      removed = weakest?.gem;
      keep = current.filter((g) => g !== removed);
    }
    const taken = families(keep);
    for (const gem of candidates.filter((g) => !g.family || !taken.has(g.family)).slice(0, 8)) {
      if (left() <= 0) break;
      const supports = [...keep, gem];
      const m = await run(withSupports(supports), `${main.gem.name} with ${supports.map((x) => x.name).join(", ")}`);
      if (!m) continue;
      const change = removed ? `Swap ${removed.name} for ${gem.name} on ${main.gem.name}` : `Add ${gem.name} to ${main.gem.name}`;
      record(m, { kind: "support", change, apply: { skill: main.gem.name, supports: supports.map((s) => s.name) } });
      const score = objectiveGain(m, b, options.objective);
      if (keepsSurvival(m, b) && score > 0.01 && (!bestSupport || score > bestSupport.score)) bestSupport = { supports, change, score };
    }
  }

  // Passives: notables that scale the build (damage) or its defences (survival).
  const passiveCost = (key: string) => completePassives(tree, base.cls.startNode, [...base.passives, key], base.ascendancyId).main.length - completedBase.main.length;
  const passiveChanges: { key: string; cost: number; score: number; change: string }[] = [];
  if (kinds.has("passive") && left() > 0) {
    const allocated = new Set(completedBase.main);
    const defenceTerms = options.defence.map((d) => (d === "life" ? "maximum life" : d));
    const pools = [
      ...findScaling(tree, { terms: options.terms, startKey: base.cls.startNode, kinds: ["notable"], limit: 40 }).map((n) => ({ n, damage: true })),
      ...findScaling(tree, { terms: defenceTerms, startKey: base.cls.startNode, kinds: ["notable"], limit: 20 }).map((n) => ({ n, damage: false })),
    ];
    const avoid = (options.avoid ?? []).map((a) => new RegExp(`\\b${a}`, "i"));
    const seen = new Set<string>();
    const picks = pools
      .filter(({ n }) => !allocated.has(n.key) && n.drawbacks.length === 0 && !n.stats.some((s) => avoid.some((re) => re.test(s))))
      .filter(({ n }) => (seen.has(n.key) ? false : (seen.add(n.key), true)))
      .map((p) => ({ ...p, cost: passiveCost(p.n.key) }))
      .filter((p) => p.cost > 0 && p.cost <= 8)
      .sort((x, y) => Number(y.damage) - Number(x.damage) || x.cost - y.cost);
    const damagePicks = picks.filter((p) => p.damage).slice(0, 10);
    const defencePicks = picks.filter((p) => !p.damage).slice(0, 5);
    for (const { n, cost } of [...damagePicks, ...defencePicks]) {
      if (left() <= 0) break;
      const m = await run({ ...base, passives: [...base.passives, n.key] }, `passive ${n.name}`);
      if (!m) continue;
      const change = `Take ${n.name} (${cost} point${cost === 1 ? "" : "s"} with its path)`;
      record(m, { kind: "passive", change, apply: { addPassive: n.name, id: n.id }, points: cost, overBudget: cost > pointsFree });
      const score = objectiveGain(m, b, options.objective);
      if (keepsSurvival(m, b) && score > 0.01) passiveChanges.push({ key: n.key, cost, score, change });
    }
  }

  // Spirit skills that fit the build.
  let bestSpirit: { gem: PlayerGem; change: string; score: number } | undefined;
  if (kinds.has("spirit") && left() > 0) {
    const using = base.skills.map((s) => s.gem.name);
    const options_ = spiritSuggestions(data, { level: base.level, terms: options.terms, avoid: options.avoid, defence: options.defence, alreadyUsing: using }).options;
    for (const o of options_.filter((o) => o.matched.length > 0).slice(0, 5)) {
      if (left() <= 0) break;
      const gem = findGem(data, o.gemId);
      const m = await run({ ...base, skills: [...base.skills, { gem }] }, `Spirit skill ${o.name}`);
      if (!m) continue;
      const free = b.spiritUnreserved ?? 0;
      const needsSpirit = o.spirit > free ? o.spirit - free : undefined;
      const change = `Add ${o.name} (${o.spirit} Spirit)${o.freeWithAmulet ? ` — or free from a ${o.freeWithAmulet.split(" (")[0]}` : ""}`;
      spiritTried.push(record(m, { kind: "spirit", change, apply: { addSkill: o.name }, needsSpirit }));
      const score = objectiveGain(m, b, options.objective) + survivalGain(m, b);
      if (!needsSpirit && score > 0.01 && keepsSurvival(m, b) && (!bestSpirit || score > bestSpirit.score)) bestSpirit = { gem, change, score };
    }
  }

  // An anoint on the amulet.
  let bestAnoint: { notable: string; change: string; score: number } | undefined;
  if (kinds.has("anoint") && !base.extras?.anoint && left() > 0) {
    const suggestions = anointSuggestions(data, { level: base.level, terms: options.terms, avoid: options.avoid, defence: options.defence, allocated: completedBase.main }).amulet;
    for (const a of suggestions.slice(0, 4)) {
      if (left() <= 0) break;
      const m = await run({ ...base, extras: { ...base.extras, anoint: a.notable } }, `anoint ${a.notable}`);
      if (!m) continue;
      const change = `Anoint ${a.notable} on the amulet (${a.recipe.join(" + ")})`;
      record(m, { kind: "anoint", change, apply: { anoint: a.notable } });
      const score = objectiveGain(m, b, options.objective);
      if (keepsSurvival(m, b) && score > 0.01 && (!bestAnoint || score > bestAnoint.score)) bestAnoint = { notable: a.notable, change, score };
    }
  }

  // The best compatible picks together.
  let combined: OptimizeResult["combined"];
  const affordable: typeof passiveChanges = [];
  let pointsLeft = pointsFree;
  for (const p of [...passiveChanges].sort((x, y) => y.score / y.cost - x.score / x.cost)) {
    if (p.cost <= pointsLeft) {
      affordable.push(p);
      pointsLeft -= p.cost;
    }
  }
  const picked = [bestSupport?.change, ...affordable.map((p) => p.change), bestSpirit?.change, bestAnoint?.change].filter((x): x is string => !!x);
  if (picked.length > 1) {
    const input: EvaluateInput = {
      ...base,
      skills: [
        ...base.skills.map((s, i) => (i === mainIndex && bestSupport ? { ...s, supports: bestSupport.supports } : s)),
        ...(bestSpirit ? [{ gem: bestSpirit.gem }] : []),
      ],
      passives: [...base.passives, ...affordable.map((p) => p.key)],
      extras: bestAnoint ? { ...base.extras, anoint: bestAnoint.notable } : base.extras,
    };
    const m = await run(input, "the combined changes");
    if (m) combined = { changes: picked, clearDps: pct(m.clearDps, b.clearDps), bossDps: pct(m.bossDps, b.bossDps), effectiveHp: pct(m.effectiveHp, b.effectiveHp), maxHit: pct(m.maxHit, b.maxHit) };
  }

  if (failed.length) notes.push(`Path of Building failed or got stuck on (skipped): ${failed.join("; ")}.`);
  if (evaluations >= budget) notes.push(`Stopped after ${budget} calculations; raise maxEvaluations or narrow kinds to search further.`);
  if (pointsFree <= 0 && passiveChanges.length) notes.push("No free passive points: a passive change means dropping a weaker passive (check_build shows the plan).");
  notes.push("Numbers are Path of Building estimates with assumed gear; a best-effort search over likely changes, not every possible build.");

  damage.sort((x, y) => y.score - x.score);
  survival.sort((x, y) => y.score - x.score);
  const round = (c: Change) => ({ ...c, score: Math.round(c.score * 1000) / 1000 });
  return {
    objective: options.objective,
    baseline: { clearDps: b.clearDps, bossDps: b.bossDps, hitsFromBoss: b.hitsFromBoss, effectiveHp: b.effectiveHp, maxHit: b.maxHit, pointsFree, spiritUnreserved: b.spiritUnreserved },
    damage: damage.slice(0, 10).map(round),
    survival: survival.slice(0, 6).map(round),
    spiritSkills: spiritTried.map(round),
    combined,
    evaluations,
    notes,
  };
}
