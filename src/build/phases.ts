// Leveling phases for a league-start character, derived from the campaign's quest data so they
// follow patches. Level ranges are approximate: they come from the area levels of reward quests.

import type { GameData, QuestReward } from "../data/gamedata.js";
import { gemLevelForCharacter } from "../skills/levels.js";
import { pointsAtLevel } from "../tree/tree.js";

export interface Phase {
  name: string;
  levels: [number, number];
  /** Level to run check_build at: the end of the phase. */
  checkpointLevel: number;
  passivePoints: number;
  spiritFromQuests: number;
  gemLevel: number;
  questRewards: Omit<QuestReward, "act">[];
}

/** Post-campaign phases; the campaign phases come from the quest data. */
const ENDGAME: { name: string; levels: [number, number] }[] = [
  { name: "Early maps", levels: [0, 75] }, // start filled in from the campaign's end
  { name: "End-game (T15/T16 juiced maps)", levels: [76, 90] },
];

const groupOf = (act: string) => (/^Act \d+$/.test(act) ? act : "Interludes and Epilogue");

export function levelingPhases(data: GameData): Phase[] {
  // Campaign groups in quest order, each ending at its highest reward-quest area level.
  const groups: { name: string; end: number; rewards: QuestReward[] }[] = [];
  for (const reward of data.questRewards) {
    const name = groupOf(reward.act);
    let group = groups.find((g) => g.name === name);
    if (!group) {
      group = { name, end: 0, rewards: [] };
      groups.push(group);
    }
    group.end = Math.max(group.end, reward.areaLevel);
    group.rewards.push(reward);
  }

  const ranges: { name: string; levels: [number, number]; rewards: QuestReward[] }[] = [];
  let start = 1;
  for (const group of groups) {
    const end = Math.max(group.end, start);
    ranges.push({ name: group.name, levels: [start, end], rewards: group.rewards });
    start = end + 1;
  }
  for (const phase of ENDGAME) {
    const levels: [number, number] = [Math.max(phase.levels[0], start), Math.max(phase.levels[1], start)];
    ranges.push({ name: phase.name, levels, rewards: [] });
    start = levels[1] + 1;
  }

  return ranges.map(({ name, levels, rewards }) => {
    const checkpointLevel = levels[1];
    return {
      name,
      levels,
      checkpointLevel,
      passivePoints: pointsAtLevel(checkpointLevel, data.questPoints),
      spiritFromQuests: data.questSpirit.filter((q) => q.areaLevel <= checkpointLevel).reduce((sum, q) => sum + q.spirit, 0),
      gemLevel: gemLevelForCharacter(checkpointLevel),
      questRewards: rewards.map(({ act: _act, ...rest }) => rest),
    };
  });
}
