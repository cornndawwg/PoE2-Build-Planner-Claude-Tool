// Mechanics in a build that Path of Building (as we drive it) doesn't calculate, or calculates
// under assumptions, so the numbers can be told apart from what the game will do.

import type { GameData, PlayerGem } from "../data/gamedata.js";
import type { TreeNode } from "../data/types.js";
import { skillOf } from "../skills/skills.js";
import { stripMarkup } from "../text.js";

export function notModelled(
  data: GameData,
  skills: { gem: PlayerGem; supports?: PlayerGem[] }[],
  passives: TreeNode[],
): string[] {
  const out = new Set<string>();
  const described = (gem: PlayerGem) => stripMarkup(skillOf(data, gem)?.active_skill?.description ?? "");

  for (const { gem, supports } of skills) {
    const text = described(gem);
    if (gem.tags.includes("meta") || /^Cast on /i.test(gem.name)) {
      out.add(`${gem.name}: spells it triggers aren't calculated as triggered, so their damage isn't in the numbers.`);
    }
    if (gem.tags.includes("channelling")) out.add(`${gem.name} is channelled; its damage may be undercounted.`);
    if (/Infusion/i.test(text)) out.add(`${gem.name}: Elemental Infusions it can consume aren't counted (none are assumed active).`);
    if (/Projectiles? (?:fired|cast|shot|passing) through/i.test(text)) {
      out.add(`${gem.name}: damage it adds to projectiles passing through it isn't counted.`);
    }
    for (const s of supports ?? []) {
      if (/Overabundance|Rapid Casting|Faster Casting|Concurrence/i.test(s.name) && gem.tags.some((t) => ["duration", "sustained", "totem", "remnant", "hazard"].includes(t))) {
        out.add(`${s.name} on ${gem.name}: it changes how many or how often, not damage per second, so it may show no change here.`);
      }
    }
  }

  const passiveText = passives.flatMap((n) => (n.stats ?? []).map(stripMarkup));
  if (passiveText.some((l) => /\bRage\b/i.test(l))) out.add("Rage is assumed to be 0, so passives that grant or use Rage look weaker than in game.");
  if (passiveText.some((l) => /Infusion/i.test(l))) out.add("Elemental Infusions aren't assumed active.");
  if (passiveText.some((l) => /(?:you are|yourself).{0,20}(?:Ignited|Ignite)|lose .{0,20}Life per second|take .{0,30}damage per second/i.test(l))) {
    out.add("Self-damage and life drain from passives (e.g. igniting yourself, Demon Form) aren't in the survival numbers.");
  }
  if (passiveText.some((l) => /per (?:Power|Frenzy|Endurance) Charge/i.test(l))) {
    out.add("Charges (Power, Frenzy, Endurance) are assumed at 0, so bonuses per charge aren't counted.");
  }
  return [...out];
}

/** Assumptions behind every calculation. */
export const ASSUMPTIONS = [
  "Enemies have no curses or exposure unless a skill in the build applies them.",
  "No flasks, charges, Rage or infusions are active unless set.",
  "Boss numbers assume full uptime on a target standing still.",
];
