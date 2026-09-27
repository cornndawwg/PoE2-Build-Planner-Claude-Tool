// What the player wants from the build, asked before planning, and an honest check of a
// calculated build against it.

import type { PlayerGem } from "../data/gamedata.js";
import type { GearTier } from "../engine/gear.js";
import { verdict, type Band, type Content, type Verdict, type VerdictInput } from "../engine/verdict.js";

/** What the build is for. */
export const PURPOSES = ["campaign", "mapping", "bossing", "balanced"] as const;
export type Purpose = (typeof PURPOSES)[number];
/** How far the player realistically wants to push. */
export const PUSHES = ["campaign", "early maps", "T15", "T16 juiced", "pinnacle"] as const;
export type Push = (typeof PUSHES)[number];
/** How many buttons they want to press. */
export const BUTTONS = ["one", "few", "many"] as const;
export type Buttons = (typeof BUTTONS)[number];
/** What they'll spend. */
export const BUDGETS = ["self-found", "modest", "wealthy"] as const;
export type Budget = (typeof BUDGETS)[number];

export interface Goals {
  purpose: Purpose;
  push: Push;
  buttons?: Buttons;
  budget?: Budget;
  hardcore?: boolean;
}

/** The questions Claude asks before planning, in one message; skip any the player already answered. */
export const INTAKE_QUESTIONS = [
  {
    id: "fantasy",
    question: "What do you want to play? A skill, weapon, theme or feeling (e.g. \"big slow hammer hits\", \"summon an army\").",
    why: "Everything else is built around this.",
  },
  {
    id: "start",
    question: "Is this a league start (new character from level 1) or an existing character? If existing: level and roughly what gear.",
    options: ["league start", "existing character"],
    why: "League starts need a plan per campaign phase; existing characters start from what they have.",
  },
  {
    id: "purpose",
    question: "What's the build mainly for: getting through the campaign, fast map farming, killing bosses, or a bit of everything?",
    options: ["campaign", "mapping", "bossing", "balanced"],
    why: "Mapping builds favour clear speed and moving between packs; bossing builds favour single-target damage and surviving big hits.",
  },
  {
    id: "push",
    question: "How far do you realistically want to push it: finish the campaign, comfortable T15 maps, juiced T16 maps, or pinnacle bosses?",
    options: ["campaign", "early maps", "T15", "T16 juiced", "pinnacle"],
    why: "This sets the targets the build is checked against.",
  },
  {
    id: "buttons",
    question: "How many buttons do you want to press: a one-button build, a few (2-4 skills), or a full rotation?",
    options: ["one", "few", "many"],
    why: "Decides whether to add separate boss, utility and buff skills or fold everything into one.",
  },
  {
    id: "budget",
    question: "What's your budget: self-found, modest trading, or happy to spend? Trade league or SSF?",
    options: ["self-found", "modest", "wealthy"],
    why: "Sets the gear assumed for end-game numbers and which uniques are realistic.",
  },
  {
    id: "hardcore",
    question: "Softcore or Hardcore?",
    options: ["softcore", "hardcore"],
    why: "Hardcore needs a much higher survivability bar.",
  },
  {
    id: "dislikes",
    question: "Anything you don't want: melee, minions, channelling, lots of buffs to manage, slow attacks…?",
    why: "Rules out options early.",
  },
] as const;

/** The gear quality to assume for a budget at a level (campaign gear is always self-found quality). */
export function gearTierFor(budget: Budget | undefined, level: number): GearTier {
  if (level < 65 || !budget || budget === "self-found") return "budget";
  return budget === "modest" ? "mid" : "high";
}

/** The verdict content that matches how far they want to push. */
export function contentFor(push: Push, level: number): Content {
  if (level < 65 || push === "campaign") return level < 65 ? "campaign" : "early maps";
  return push;
}

export type GoalStatus = "on track" | "rough" | "not realistic yet";

export interface GoalCheck {
  goal: string;
  judgedAt: string;
  status: GoalStatus;
  /** The parts that matter for this goal and how they look. */
  focus: { part: "clearing" | "bossing" | "survival"; band: Band }[];
  verdict: Verdict;
  /** One or two plain sentences to tell the player. */
  message: string;
  /** Options to offer the player when it isn't on track. */
  options: string[];
  notes: string[];
}

const PURPOSE_LABEL: Record<Purpose, string> = {
  campaign: "the campaign",
  mapping: "fast map farming",
  bossing: "killing bosses",
  balanced: "mapping and bossing",
};
const PUSH_LABEL: Record<Push, string> = {
  campaign: "the campaign",
  "early maps": "early maps",
  T15: "T15 maps",
  "T16 juiced": "juiced T16 maps",
  pinnacle: "pinnacle bosses",
};

/** Check calculated numbers against the player's goals, honestly. */
export function goalCheck(numbers: Omit<VerdictInput, "content">, level: number, goals: Goals): GoalCheck {
  const content = contentFor(goals.push, level);
  const v = verdict({ ...numbers, content }, goals);
  const parts: GoalCheck["focus"][number]["part"][] =
    content === "pinnacle" || goals.purpose === "bossing"
      ? ["bossing", "survival"]
      : goals.purpose === "mapping"
        ? ["clearing", "survival"]
        : goals.purpose === "campaign" || content === "campaign"
          ? ["clearing", "survival"]
          : ["clearing", "bossing", "survival"];
  const focus = parts.map((part) => ({ part, band: v[part] }));
  const worstBand = focus.map((f) => f.band).reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "Comfortable" as Band);
  const status: GoalStatus = worstBand === "Comfortable" || worstBand === "Workable" ? "on track" : worstBand === "Borderline" ? "rough" : "not realistic yet";

  const goal = `${PURPOSE_LABEL[goals.purpose]}, pushing ${PUSH_LABEL[goals.push]}${goals.hardcore ? " (Hardcore)" : ""}`;
  const weak = focus.filter((f) => RANK[f.band] >= RANK.Borderline).map((f) => f.part);
  const judgedAt = level < 65 && goals.push !== "campaign" ? `level ${level} (campaign)` : `level ${level}, ${PUSH_LABEL[goals.push]}`;
  const message =
    status === "on track"
      ? `This build looks on track for ${goal} at ${judgedAt}${v.weakPoint ? `; the weakest part is ${v.weakPoint}` : ""}.`
      : `Honestly, ${goal} could be ${status === "rough" ? "rough" : "a struggle"} with this build as it stands: ${weak.map(describe).join(" and ")}. ${v.fixFirst ?? ""}`.trim();
  const options =
    status === "on track"
      ? ["Run optimize_build to find extra damage that doesn't cost survivability."]
      : [
          "Tweak it: run optimize_build and apply the best changes, then check again.",
          ...(goals.budget !== "wealthy" ? ["See it with a bigger budget (gearTier mid or high) to show what gear would fix."] : []),
          "Keep the fantasy but change the setup: compare another ascendancy, main skill or weapon with compare_builds.",
          `Lower the goal: say what it does handle well (e.g. ${content === "pinnacle" ? "T15 maps" : "earlier content"}).`,
          "Look at a different build that fits the same fantasy better.",
        ];
  const notes: string[] = [];
  if (level < 65 && goals.push !== "campaign") notes.push(`Judged for the campaign at level ${level}; evaluate at level 85-90 to check the end-game goal (${PUSH_LABEL[goals.push]}).`);
  if (goals.hardcore) notes.push("Hardcore: survival targets are raised.");
  return { goal, judgedAt, status, focus, verdict: v, message, options, notes };
}

const RANK: Record<Band, number> = { Comfortable: 0, Workable: 1, Borderline: 2, "Not yet": 3 };
function describe(part: string) {
  return part === "clearing" ? "clearing is slow" : part === "bossing" ? "bosses take too long to kill" : "it dies too easily";
}

// --- A complete skill setup ---

export interface SetupInput {
  skills: PlayerGem[];
  spirit?: number;
  spiritUnreserved?: number;
  buttons?: Buttons;
  purpose?: Purpose;
}

/** Suggestions for a fuller setup: unused Spirit, a boss skill, a utility or defensive skill. */
export function setupGaps(input: SetupInput): string[] {
  const gaps: string[] = [];
  const has = (...tags: string[]) => input.skills.some((g) => tags.some((t) => g.tags.includes(t)));
  const damage = input.skills.filter((g) => g.kind === "active" && !g.tags.some((t) => ["curse", "mark", "warcry", "banner", "travel"].includes(t)));
  const unused = input.spiritUnreserved ?? 0;
  if (unused >= 30) {
    gaps.push(`${unused} of ${input.spirit ?? unused} Spirit is unused: add a Spirit skill (herald, aura or buff) that fits — see suggest_extras (spirit, amuletSkills).`);
  }
  if (input.buttons !== "one") {
    if (damage.length < 2 && (input.purpose === "bossing" || input.purpose === "balanced" || !input.purpose)) {
      gaps.push("Only one damage skill: consider a second skill for bosses (single target) or for clearing, unless the player wants one button.");
    }
    if (!has("curse", "mark", "warcry", "banner")) {
      gaps.push("No curse, mark, warcry or banner: one of these usually adds a lot of damage or defence for one button press.");
    }
  }
  if (!input.skills.some((g) => g.kind === "spirit") && (input.spirit ?? 0) === 0) {
    gaps.push("No Spirit skills: Spirit comes from quests (Act 1 and later) and gear; plan at least one persistent buff.");
  }
  return gaps;
}
