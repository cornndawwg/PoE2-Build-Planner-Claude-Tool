// Suggestions beyond the main skill: what to spend Spirit on, which jewels to look for, and
// which flasks and charms to carry.

import type { GameData, PlayerGem } from "../data/gamedata.js";
import { rollableMods } from "../data/mods.js";
import { JEWEL_FOR_ATTRIBUTE, mainAttribute, pickBase } from "../engine/gear.js";
import { availableFromLevel } from "../skills/levels.js";
import { skillOf } from "../skills/skills.js";
import { stripMarkup } from "../text.js";
import { termPattern } from "../tree/scaling.js";
import type { DefenceStyle } from "./priorities.js";
import { findUniques } from "./uniques.js";

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");

export interface SpiritOption {
  name: string;
  gemId: string;
  spirit: number;
  availableFromLevel?: number;
  source: PlayerGem["source"];
  tags: string[];
  description: string;
  matched: string[];
}

export interface ExtrasQuery {
  level: number;
  /** Words the build scales (as for stat_priorities), e.g. ["fire", "spell"]. */
  terms: string[];
  avoid?: string[];
  defence: DefenceStyle[];
  /** Main skill, for the jewel type (its main attribute). */
  mainSkill?: PlayerGem;
  /** Spirit from gear the player has or plans (sceptre, body armour…). */
  gearSpirit?: number;
  /** Spirit skills already chosen, to leave out of suggestions. */
  alreadyUsing?: string[];
}

export function spiritSuggestions(data: GameData, q: ExtrasQuery) {
  const available = data.questSpirit.filter((s) => s.areaLevel <= q.level).reduce((sum, s) => sum + s.spirit, 0) + (q.gearSpirit ?? 0);
  const using = new Set((q.alreadyUsing ?? []).map((n) => n.toLowerCase()));
  const terms = q.terms.map((t) => [t, norm(t), termPattern(t)] as const);
  const avoid = (q.avoid ?? []).map(termPattern);

  const options: SpiritOption[] = [];
  for (const gem of data.playerGems.values()) {
    if (gem.kind === "support" || using.has(gem.name.toLowerCase())) continue;
    const skill = skillOf(data, gem);
    const spirit = skill?.static?.reservations?.spirit;
    if (!spirit) continue;
    const from = availableFromLevel(gem);
    if (from !== undefined && from > q.level) continue;
    if (gem.source === "item") continue; // granted by specific items; not something to pick
    const description = stripMarkup(skill?.active_skill?.description ?? "");
    if (avoid.some((re) => re.test(description))) continue;
    const haystack = new Set([...gem.tags.map(norm), ...(skill?.active_skill?.types ?? []).map(norm)]);
    const matched = terms.filter(([, n, re]) => haystack.has(n) || re.test(description)).map(([t]) => t);
    options.push({ name: gem.name, gemId: gem.gameId, spirit, availableFromLevel: from, source: gem.source, tags: gem.tags, description, matched });
  }
  options.sort((a, b) => b.matched.length - a.matched.length || a.spirit - b.spirit || a.name.localeCompare(b.name));

  // A simple pick that fits the budget: best matches first.
  const pick: string[] = [];
  let left = available;
  for (const o of options) {
    if (o.matched.length === 0 || o.spirit > left) continue;
    pick.push(o.name);
    left -= o.spirit;
  }
  return {
    spiritAvailable: available,
    fromQuests: available - (q.gearSpirit ?? 0),
    suggestedPick: { skills: pick, spiritLeft: left },
    options: options.slice(0, 12),
    note: "More Spirit comes from gear (sceptres, some body armours and amulets) and a few passives.",
  };
}

export function jewelSuggestions(data: GameData, q: ExtrasQuery) {
  const avoid = (q.avoid ?? []).map(termPattern);
  const perType = (["Ruby", "Emerald", "Sapphire"] as const).map((name) => {
    const base = Object.values(data.baseItems).find((b) => b.name === name && b.item_class === "Jewel")!;
    const mods = rollableMods(data.mods, base)
      .map((m) => stripMarkup(m.text ?? ""))
      .map((text) => ({ text, matched: q.terms.filter((t) => termPattern(t).test(text)) }))
      .filter((m) => m.matched.length > 0 && !avoid.some((re) => re.test(m.text)))
      .sort((a, b) => b.matched.length - a.matched.length);
    return { jewel: name, bestMods: [...new Map(mods.map((m) => [m.text, m])).values()].slice(0, 6) };
  });
  const recommended = q.mainSkill ? JEWEL_FOR_ATTRIBUTE[mainAttribute(q.mainSkill)] : perType.sort((a, b) => b.bestMods.length - a.bestMods.length)[0]!.jewel;
  return {
    recommendedType: recommended,
    why: q.mainSkill
      ? `${recommended}s roll mods for ${mainAttribute(q.mainSkill) === "int" ? "Intelligence" : mainAttribute(q.mainSkill) === "str" ? "Strength" : "Dexterity"} builds like ${q.mainSkill.name}.`
      : `${recommended}s have the most mods matching this build.`,
    byType: perType,
    uniques: findUniques(data, { terms: q.terms, avoid: q.avoid, slots: ["Jewel"], maxRequiredLevel: q.level, limit: 5 }).map((u) => ({
      name: u.name,
      baseType: u.baseType,
      mods: u.mods,
      bossDrop: u.bossDrop,
    })),
    note: "Jewels go in jewel socket passives on the tree; plan_passive_tree and find_passives (includeJewelSockets) show where they are.",
  };
}

export function flaskSuggestions(data: GameData, q: ExtrasQuery) {
  const itemLevel = Math.min(q.level, 82);
  const life = pickBase(data, "LifeFlask", itemLevel);
  const mana = pickBase(data, "ManaFlask", itemLevel);
  const flaskMods = (base: typeof life) =>
    base
      ? [...new Map(rollableMods(data.mods, base, ["flask"]).map((m) => [m.type, m])).values()]
          .map((m) => stripMarkup(m.text ?? ""))
          .filter((t) => /recover|instant|life|mana|duration|charges/i.test(t))
          .slice(0, 5)
      : [];
  const props = (base: typeof life) => (base as { properties?: Record<string, number> } | undefined)?.properties ?? {};

  const charms = Object.values(data.baseItems)
    .filter((b) => b.item_class === "UtilityFlask" && b.release_state === "released" && (b.drop_level ?? 1) <= itemLevel)
    .map((b) => ({ name: b.name, trigger: (b.implicits ?? []).map((id) => stripMarkup(data.mods[id]?.text ?? "")).join("; "), dropLevel: b.drop_level }));
  // Charms most builds want: the ailments that stop you acting, then the damage type you're weakest to.
  const priority = ["Thawing Charm", "Stone Charm", "Silver Charm", "Dousing Charm", "Grounding Charm", "Staunching Charm", "Antidote Charm"];
  charms.sort((a, b) => (priority.indexOf(a.name) + 1 || 99) - (priority.indexOf(b.name) + 1 || 99));

  const usesMana = !q.defence.includes("life") || q.defence.includes("energy shield");
  return {
    lifeFlask: life && { base: life.name, recovers: props(life).life_per_use, goodMods: flaskMods(life) },
    manaFlask: mana && { base: mana.name, recovers: props(mana).mana_per_use, goodMods: flaskMods(mana) },
    advice: usesMana
      ? "Carry a life flask and a mana flask; casters and energy shield builds often lean on the mana flask."
      : "Carry a life flask and a mana flask; upgrade each to the best base you find.",
    charms: charms.slice(0, 6),
    charmNote: "Charms fire automatically on their trigger. You start with one charm slot; more come from gear (belts) and a quest choice in Act 2.",
  };
}
