// Rule-based sanity checks for a planned build: when skills become available, whether the
// character meets gem attribute requirements, whether Spirit covers persistent skills, and
// whether the passive plan fits the point budget. No damage numbers — those need Path of Building.

import type { GameData, PlayableClass, PlayerGem } from "../data/gamedata.js";
import type { TreeNode } from "../data/types.js";
import { availableFromLevel, gemLevelForCharacter } from "../skills/levels.js";
import { pickBase } from "../engine/gear.js";
import { skillOf } from "../skills/skills.js";
import { stripMarkup } from "../text.js";
import { validateSkills, type SkillIssue } from "./validate.js";

/** Giant's Blood: "Triple Attribute requirements of Martial Weapons". */
const TRIPLE_MARTIAL = /triple attribute requirements of martial weapons/i;
const CASTER_WEAPONS = new Set(["Wand", "Staff", "Sceptre", "Focus"]);
import { ASCENDANCY_POINTS, pointsAtLevel } from "../tree/tree.js";

export { GEM_LEVEL_REQUIREMENT, availableFromLevel, gemLevelForCharacter } from "../skills/levels.js";

/** Attribute a gem of this level needs for a requirement weight (0–100). Same formula as PoB's calcLib.getGemStatRequirement. */
export function gemAttributeRequirement(gemLevel: number, weight: number): number {
  if (weight <= 0) return 0;
  const req = Math.round((5 + (gemLevel - 3) * 1.7) * (weight / 100) ** 0.9) + 4;
  return req < 8 ? 0 : req;
}

export type Attribute = "str" | "dex" | "int";
export type Attributes = Record<Attribute, number>;
const ATTRIBUTES: Attribute[] = ["str", "dex", "int"];
const zero = (): Attributes => ({ str: 0, dex: 0, int: 0 });

/** Attributes a passive gives, from its stat text (e.g. "+10 to Strength", "+5 to all Attributes"). */
export function nodeAttributes(node: TreeNode): Attributes {
  const out = zero();
  out.str += node.grantedStrength ?? 0;
  out.dex += node.grantedDexterity ?? 0;
  out.int += node.grantedIntelligence ?? 0;
  for (const line of node.stats ?? []) {
    const text = line.replace(/\[([^\]|]*)\|([^\]]*)\]/g, "$2").replace(/\[([^\]]*)\]/g, "$1");
    const all = /^\+(\d+) to all Attributes$/i.exec(text);
    if (all) {
      for (const a of ATTRIBUTES) out[a] += Number(all[1]);
      continue;
    }
    const m = /^\+(\d+) to (Strength|Dexterity|Intelligence)(?: and (Strength|Dexterity|Intelligence))?$/i.exec(text);
    if (!m) continue;
    for (const name of [m[2], m[3]]) {
      if (!name) continue;
      const key = ({ strength: "str", dexterity: "dex", intelligence: "int" } as const)[name.toLowerCase() as "strength"];
      out[key] += Number(m[1]);
    }
  }
  return out;
}

/** Flat Spirit a passive gives ("+N to Spirit"). */
export function nodeSpirit(node: TreeNode): number {
  let total = 0;
  for (const line of node.stats ?? []) {
    const m = /^\+(\d+) to \[?Spirit/i.exec(line);
    if (m) total += Number(m[1]);
  }
  return total;
}

/** Flat Spirit a persistent skill reserves; undefined if the skill doesn't reserve a flat amount. */
export function spiritCost(data: GameData, gem: PlayerGem): number | undefined {
  return skillOf(data, gem)?.static?.reservations?.spirit;
}

export interface CheckInput {
  cls: PlayableClass;
  /** Main-tree passives taken (tree keys). */
  passives: string[];
  ascendancyPassives?: string[];
  skills: { gem: PlayerGem; supports?: PlayerGem[] }[];
  characterLevel: number;
  /** Attributes expected from gear, if the player knows. */
  gearAttributes?: Partial<Attributes>;
  /** Spirit from gear (sceptre, body armour, amulet…), if known. */
  gearSpirit?: number;
  /** Weapons (item classes like "Two Hand Mace", or exact base names), for their attribute requirements. */
  weapons?: string[];
}

export interface CheckResult {
  characterLevel: number;
  gemLevel: number;
  points: { used: number; available: number; overBudget: boolean; ascendancyUsed: number; ascendancyAvailable: number };
  skills: {
    name: string;
    availableFromLevel?: number;
    usableNow: boolean;
    source: PlayerGem["source"];
    requirement: Attributes;
    spirit?: number;
    supports: { name: string; tier: number; source: PlayerGem["source"] }[];
  }[];
  attributes: {
    required: Attributes;
    fromClass: Attributes;
    fromPassives: Attributes;
    /** "+5 to any Attribute" passives taken: the player chooses which attribute each gives. */
    flexibleNodes: number;
    fromGear: Attributes;
    /** Missing after spending the flexible passives as well as possible. */
    shortfall: Attributes;
    /** How to spend the flexible passives. */
    assignFlexible: Attributes;
  };
  spirit: { reserved: number; fromQuests: number; fromPassives: number; fromGear: number; shortfall: number; unused: number; unknownCosts: string[] };
  /** Weapon attribute requirements, with Giant's Blood-style multipliers applied. */
  weapons: { base: string; itemClass: string; requirement: Attributes; multiplier: number }[];
  /** Problems with skill and support combinations (same rules as export_build). */
  skillIssues: SkillIssue[];
  warnings: string[];
  /** Not problems, but the build leaves something on the table (e.g. unused Spirit). */
  suggestions: string[];
}

export function checkBuild(data: GameData, nodes: ReadonlyMap<string, TreeNode>, input: CheckInput): CheckResult {
  const warnings: string[] = [];
  const level = input.characterLevel;
  const gemLevel = gemLevelForCharacter(level);

  // Passive budget.
  const available = pointsAtLevel(level, data.questPoints);
  const used = input.passives.length;
  const ascendancyUsed = input.ascendancyPassives?.length ?? 0;
  // Ascendancy points come from trials during the campaign; when isn't in the data, so this is the maximum.
  const ascendancyAvailable = ASCENDANCY_POINTS;
  if (used > available) warnings.push(`The plan uses ${used} passive points but a level ${level} character has ${available}.`);
  if (ascendancyUsed > ascendancyAvailable) warnings.push(`The plan uses ${ascendancyUsed} ascendancy points; the most is ${ascendancyAvailable}.`);

  // Skills: availability, attribute needs, Spirit.
  const required = zero();
  const skills: CheckResult["skills"] = [];
  let reserved = 0;
  const unknownCosts: string[] = [];
  for (const { gem, supports } of input.skills) {
    const from = availableFromLevel(gem);
    const usableNow = from === undefined || from <= level;
    if (!usableNow) warnings.push(`${gem.name} can't be used until level ${from}.`);
    const weights = gem.gem.requirement_weights;
    const requirement: Attributes = {
      str: gemAttributeRequirement(gemLevel, weights?.strength ?? 0),
      dex: gemAttributeRequirement(gemLevel, weights?.dexterity ?? 0),
      int: gemAttributeRequirement(gemLevel, weights?.intelligence ?? 0),
    };
    for (const a of ATTRIBUTES) required[a] = Math.max(required[a], requirement[a]);
    const cost = spiritCost(data, gem);
    if (cost !== undefined) reserved += cost;
    else if (gem.kind === "spirit") unknownCosts.push(gem.name);
    skills.push({
      name: gem.name,
      availableFromLevel: from,
      usableNow,
      source: gem.source,
      requirement,
      spirit: cost,
      supports: (supports ?? []).map((s) => ({ name: s.name, tier: s.tier, source: s.source })),
    });
  }

  // Weapon requirements (a base the character can find by this level, or the exact base named).
  const allocatedNodes = [...input.passives, ...(input.ascendancyPassives ?? [])].flatMap((k) => nodes.get(k) ?? []);
  const tripleMartial = allocatedNodes.some((n) => (n.stats ?? []).some((s) => TRIPLE_MARTIAL.test(stripMarkup(s))));
  const weapons: CheckResult["weapons"] = [];
  for (const ref of input.weapons ?? []) {
    const byName = Object.values(data.baseItems).find((b) => b.name.toLowerCase() === ref.toLowerCase() && b.release_state === "released");
    const base = byName ?? pickBase(data, ref, Math.min(level, 82));
    if (!base) {
      warnings.push(`No weapon base "${ref}" found for level ${level}.`);
      continue;
    }
    const reqs = (base as { requirements?: { strength?: number; dexterity?: number; intelligence?: number } }).requirements ?? {};
    const multiplier = tripleMartial && !CASTER_WEAPONS.has(base.item_class) ? 3 : 1;
    const requirement: Attributes = {
      str: (reqs.strength ?? 0) * multiplier,
      dex: (reqs.dexterity ?? 0) * multiplier,
      int: (reqs.intelligence ?? 0) * multiplier,
    };
    for (const a of ATTRIBUTES) required[a] = Math.max(required[a], requirement[a]);
    weapons.push({ base: base.name, itemClass: base.item_class, requirement, multiplier });
  }

  // Skill and support rules.
  const skillIssues = validateSkills(data, input.skills, allocatedNodes);
  for (const issue of skillIssues) warnings.push(issue.message);

  // Gated passives (e.g. Oracle-only ones) need their unlocking node, usually an ascendancy notable.
  const taken = new Set([...input.passives, ...(input.ascendancyPassives ?? [])]);
  for (const key of input.passives) {
    const by = ((nodes.get(key)?.unlockConstraint as { nodes?: number[] } | undefined)?.nodes ?? []).map(String);
    if (by.length && !by.some((k) => taken.has(k))) {
      const names = by.map((k) => nodes.get(k)?.name ?? k).join(" or ");
      warnings.push(`${nodes.get(key)?.name ?? key} can only be taken after ${names}; add it to the ascendancy passives, or leave this passive out until that trial.`);
    }
  }

  // Attributes: class base + passives + gear; spend "+5 any" nodes where they're most needed.
  const fromClass: Attributes = { str: input.cls.baseStr, dex: input.cls.baseDex, int: input.cls.baseInt };
  const fromPassives = zero();
  let flexibleNodes = 0;
  let passiveSpirit = 0;
  for (const key of [...input.passives, ...(input.ascendancyPassives ?? [])]) {
    const node = nodes.get(key);
    if (!node) continue;
    if (node.isGenericAttribute) {
      flexibleNodes++;
      continue;
    }
    const attrs = nodeAttributes(node);
    for (const a of ATTRIBUTES) fromPassives[a] += attrs[a];
    passiveSpirit += nodeSpirit(node);
  }
  const fromGear: Attributes = { str: input.gearAttributes?.str ?? 0, dex: input.gearAttributes?.dex ?? 0, int: input.gearAttributes?.int ?? 0 };
  const missing = zero();
  for (const a of ATTRIBUTES) missing[a] = Math.max(0, required[a] - fromClass[a] - fromPassives[a] - fromGear[a]);
  const assignFlexible = zero();
  let spare = flexibleNodes;
  for (const a of [...ATTRIBUTES].sort((x, y) => missing[y] - missing[x])) {
    const nodesNeeded = Math.min(spare, Math.ceil(missing[a] / 5));
    assignFlexible[a] = nodesNeeded;
    spare -= nodesNeeded;
  }
  const shortfall = zero();
  for (const a of ATTRIBUTES) shortfall[a] = Math.max(0, missing[a] - assignFlexible[a] * 5);
  const names = { str: "Strength", dex: "Dexterity", int: "Intelligence" };
  for (const a of ATTRIBUTES) {
    if (shortfall[a] > 0) {
      warnings.push(`Short ${shortfall[a]} ${names[a]} for the gems${weapons.length ? " and weapon" : ""} at level ${level}: take more ${names[a]} passives or look for it on gear.`);
    }
  }

  // Spirit.
  const fromQuests = data.questSpirit.filter((q) => q.areaLevel <= level).reduce((sum, q) => sum + q.spirit, 0);
  const fromGearSpirit = input.gearSpirit ?? 0;
  const spiritShortfall = Math.max(0, reserved - fromQuests - passiveSpirit - fromGearSpirit);
  if (spiritShortfall > 0) {
    warnings.push(`Persistent skills need ${reserved} Spirit but only ${reserved - spiritShortfall} is available at level ${level}: needs ${spiritShortfall} more from gear (e.g. a sceptre or body armour) or passives.`);
  }
  const suggestions: string[] = [];
  const unusedSpirit = Math.max(0, fromQuests + passiveSpirit + fromGearSpirit - reserved);
  if (unusedSpirit >= 30) {
    suggestions.push(`${unusedSpirit} Spirit unused at level ${level}: add a Spirit skill that fits (herald, aura or buff) — see suggest_extras.`);
  }
  if (unknownCosts.length) warnings.push(`Spirit cost not in the data for: ${unknownCosts.join(", ")}.`);

  return {
    characterLevel: level,
    gemLevel,
    points: { used, available, overBudget: used > available, ascendancyUsed, ascendancyAvailable },
    skills,
    attributes: { required, fromClass, fromPassives, flexibleNodes, fromGear, shortfall, assignFlexible },
    spirit: { reserved, fromQuests, fromPassives: passiveSpirit, fromGear: fromGearSpirit, shortfall: spiritShortfall, unused: unusedSpirit, unknownCosts },
    weapons,
    skillIssues,
    warnings,
    suggestions,
  };
}
