// One set of skill-setup rules shared by check_build, export_build, evaluate_build and guides,
// so they can't disagree about what's allowed.

import type { GameData, PlayerGem } from "../data/gamedata.js";
import type { TreeNode } from "../data/types.js";
import { canSupport, skillOf } from "../skills/skills.js";
import { stripMarkup } from "../text.js";

export interface SkillIssue {
  /** "error": the game won't allow it. "warning": allowed but probably a mistake. */
  severity: "error" | "warning";
  skill: string;
  message: string;
}

// e.g. Controlled Destruction: "…preventing them from dealing Critical Hits."
const NO_CRIT = /cannot (deal )?critical hits|can't (deal )?critical hits|no critical hits|prevent\w* (them |it )?from dealing critical hits/i;
const CRIT = /critical/i;

export function validateSkills(
  data: GameData,
  skills: { gem: PlayerGem; supports?: PlayerGem[] }[],
  passives: TreeNode[] = [],
): SkillIssue[] {
  const issues: SkillIssue[] = [];
  const critPassives = passives.filter((n) => (n.stats ?? []).some((s) => CRIT.test(stripMarkup(s)))).map((n) => n.name ?? "");

  for (const { gem, supports } of skills) {
    if (gem.kind === "support") {
      issues.push({ severity: "error", skill: gem.name, message: `${gem.name} is a support gem; put it under a skill's supports.` });
      continue;
    }
    const active = skillOf(data, gem);
    const families = new Map<string, string>();
    for (const support of supports ?? []) {
      if (support.kind !== "support") {
        issues.push({ severity: "error", skill: gem.name, message: `${support.name} isn't a support gem.` });
        continue;
      }
      const supportSkill = skillOf(data, support);
      if (active && supportSkill) {
        const check = canSupport(supportSkill, active);
        if (!check.ok) issues.push({ severity: "error", skill: gem.name, message: `${support.name} can't support ${gem.name}: ${check.reason}.` });
      }
      if (support.family) {
        const other = families.get(support.family);
        if (other) {
          issues.push({ severity: "error", skill: gem.name, message: `${support.name} and ${other} are the same support family; only one can go on ${gem.name}.` });
        }
        families.set(support.family, support.name);
      }
      const text = stripMarkup(support.gem.support_text ?? "");
      if (NO_CRIT.test(text) && critPassives.length > 0) {
        issues.push({
          severity: "warning",
          skill: gem.name,
          message: `${support.name} stops ${gem.name} dealing critical hits, which wastes crit passives (${critPassives.slice(0, 3).join(", ")}${critPassives.length > 3 ? "…" : ""}).`,
        });
      }
      if (support.source === "lineage") {
        issues.push({ severity: "warning", skill: gem.name, message: `${support.name} is a lineage support: a rare drop, likely expensive.` });
      }
    }
  }
  return issues;
}
