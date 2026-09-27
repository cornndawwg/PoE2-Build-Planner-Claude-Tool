// Viability bands. These are heuristics (the game has no official targets), kept in one place so
// they're easy to review each patch. Kill times use Path of Building's monster life for the area
// level; survival uses its "hits you can take" against the configured enemy.

import type { Goals } from "../build/goals.js";

export type Band = "Comfortable" | "Workable" | "Borderline" | "Not yet";
const ORDER: Band[] = ["Comfortable", "Workable", "Borderline", "Not yet"];
const worst = (...bands: Band[]) => bands.reduce((a, b) => (ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a), "Comfortable" as Band);

/** Thresholds: [comfortable, workable, borderline]; anything worse is "Not yet". */
export const BANDS = {
  /** Seconds to kill a rare (lower is better). Community guides aim for 1–3 s in maps. */
  rareSeconds: [3, 6, 12],
  /** Seconds to kill a boss (lower is better). */
  bossSeconds: [45, 90, 180],
  /** Hits from normal monsters you survive (higher is better). */
  normalHits: [8, 4, 2],
  /** Hits from a boss you survive (higher is better). */
  bossHits: [2, 1, 0.5],
};

/** Extra monster life assumed for harder content (heuristic; map mods and juicing add life). */
export const CONTENT = {
  campaign: { label: "this point in the campaign", lifeMultiplier: 1, requireResistCap: false },
  "early maps": { label: "early maps", lifeMultiplier: 1, requireResistCap: true },
  T15: { label: "T15 maps", lifeMultiplier: 1.5, requireResistCap: true },
  "T16 juiced": { label: "juiced T16 maps", lifeMultiplier: 3, requireResistCap: true },
  /** Pinnacle bosses have far more life than map bosses; clearing doesn't matter here. */
  pinnacle: { label: "pinnacle bosses", lifeMultiplier: 4, requireResistCap: true },
} as const;

/** Stricter targets for what the player cares about (heuristics, like BANDS). */
export const GOAL_BANDS = {
  /** Bossing builds should kill bosses quickly. */
  bossingBossSeconds: [20, 45, 90],
  /** Mapping builds should delete rares. */
  mappingRareSeconds: [2, 4, 8],
  /** Hardcore survival. */
  hardcoreNormalHits: [12, 6, 3],
  hardcoreBossHits: [3, 1.5, 1],
};
export type Content = keyof typeof CONTENT;

const lowerIsBetter = (value: number | undefined, [a, b, c]: number[]): Band =>
  value === undefined ? "Not yet" : value <= a! ? "Comfortable" : value <= b! ? "Workable" : value <= c! ? "Borderline" : "Not yet";
const higherIsBetter = (value: number | undefined, [a, b, c]: number[]): Band =>
  value === undefined ? "Not yet" : value >= a! ? "Comfortable" : value >= b! ? "Workable" : value >= c! ? "Borderline" : "Not yet";

export interface VerdictInput {
  content: Content;
  rareSeconds?: number;
  bossSeconds?: number;
  normalHits?: number;
  bossHits?: number;
  missingResistance: { fire?: number; cold?: number; lightning?: number };
}

export interface Verdict {
  content: string;
  overall: Band;
  clearing: Band;
  bossing: Band;
  survival: Band;
  weakPoint?: string;
  fixFirst?: string;
}

export function verdict(input: VerdictInput, goals?: Goals): Verdict {
  const content = CONTENT[input.content];
  const scale = (s?: number) => (s === undefined ? undefined : s * content.lifeMultiplier);
  const bossFocus = input.content === "pinnacle" || goals?.purpose === "bossing";
  const clearing = lowerIsBetter(scale(input.rareSeconds), goals?.purpose === "mapping" ? GOAL_BANDS.mappingRareSeconds : BANDS.rareSeconds);
  const bossing = lowerIsBetter(scale(input.bossSeconds), bossFocus ? GOAL_BANDS.bossingBossSeconds : BANDS.bossSeconds);
  const missing = Object.entries(input.missingResistance).filter(([, v]) => (v ?? 0) > 0);
  let survival = worst(
    higherIsBetter(input.normalHits, goals?.hardcore ? GOAL_BANDS.hardcoreNormalHits : BANDS.normalHits),
    higherIsBetter(input.bossHits, goals?.hardcore ? GOAL_BANDS.hardcoreBossHits : BANDS.bossHits),
  );
  if (content.requireResistCap && missing.length) survival = worst(survival, "Borderline");

  const overall =
    input.content === "pinnacle"
      ? worst(bossing, survival)
      : bossFocus
        ? worst(clearing === "Not yet" ? "Borderline" : clearing, bossing, survival)
        : worst(clearing, survival, ORDER[Math.min(ORDER.indexOf(bossing), 2)]!); // slow bossing alone doesn't block clearing content
  const problems: [Band, string, string][] = [
    [clearing, "damage for clearing", "More damage: better weapon or main-skill levels, damage notables, or a stronger support."],
    [survival, "survivability", missing.length
      ? `Cap resistances first (missing ${missing.map(([k, v]) => `${Math.round(v!)}% ${k}`).join(", ")}), then more life or energy shield.`
      : "More life or energy shield and a defence layer (armour, evasion or block)."],
    [bossing, "boss damage", "More single-target damage: a boss-focused skill or supports, or better gear."],
  ];
  // Pinnacle bosses are about bossing and survival; clearing speed doesn't matter there.
  const relevant = input.content === "pinnacle" ? problems.filter(([, name]) => name !== "damage for clearing") : problems;
  const [band, weakPoint, fixFirst] = relevant.sort((a, b) => ORDER.indexOf(b[0]) - ORDER.indexOf(a[0]))[0]!;
  return {
    content: content.label,
    overall,
    clearing,
    bossing,
    survival,
    weakPoint: band === "Comfortable" ? undefined : weakPoint,
    fixFirst: band === "Comfortable" ? undefined : fixFirst,
  };
}
