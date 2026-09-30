// When ascendancy points arrive. The game data doesn't say when players do each trial, so these
// are rough, typical levels for a campaign character: estimates to plan around, not rules.

export interface Trial {
  trial: number;
  /** Ascendancy points it grants (2 per trial, 8 in total). */
  points: number;
  /** A typical character level when it's done. */
  typicalLevel: number;
  when: string;
}

export const ASCENDANCY_TRIALS: Trial[] = [
  { trial: 1, points: 2, typicalLevel: 22, when: "First trial in the campaign (Trial of the Sekhemas in Act 2, or Trial of Chaos in Act 3)" },
  { trial: 2, points: 2, typicalLevel: 35, when: "Second trial, later in the campaign (the other trial, or its next level)" },
  { trial: 3, points: 2, typicalLevel: 60, when: "Third trial, around the end of the campaign and early maps (higher-level trial)" },
  { trial: 4, points: 2, typicalLevel: 70, when: "Fourth trial, in maps (the hardest trial level)" },
];

export const TRIALS_NOTE =
  "Trial levels are rough typical estimates (the game data doesn't say when players do trials). Ask the player, and adjust.";

/** The trial that grants the nth ascendancy point (1-based). */
export function trialForAscendancyPoint(n: number): Trial | undefined {
  return ASCENDANCY_TRIALS[Math.ceil(n / 2) - 1];
}
