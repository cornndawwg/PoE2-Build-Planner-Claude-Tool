import type { GameData, GemSource, PlayerGem } from "../data/gamedata.js";
import type { Skill } from "../data/types.js";
import { stripMarkup } from "../text.js";
import { availableFromLevel } from "./levels.js";
import { matchesTypeExpression } from "./typeExpression.js";

export interface SkillMatch {
  gameId: string;
  name: string;
  kind: PlayerGem["kind"];
  source: GemSource;
  tier: number;
  weaponRequirements: string[];
  /** Earliest character level it can be used (skills from uncut gems only). */
  availableFromLevel?: number;
  tags: string[];
  skillTypes: string[];
  description: string;
  /** Requested terms this skill has. */
  matched: string[];
  score: number;
}

export interface SupportMatch {
  gameId: string;
  name: string;
  source: GemSource;
  tier: number;
  tags: string[];
  text: string;
  recommendedByGame: boolean;
  /** Other supports in the same family (only one per family fits on a skill). */
  alternatives: string[];
  score: number;
  reasons: string[];
}

export interface SkillSearchQuery {
  /** Every term must match (e.g. ["fire", "spell"]). */
  require?: string[];
  /** Nice-to-have terms that raise the ranking (e.g. ["projectile", "area"]). */
  prefer?: string[];
  /** Words that must all appear in the skill's description (e.g. ["poison"]). */
  text?: string[];
  /** Only skills usable with this weapon (e.g. "bow", "mace"). Skills with no weapon requirement always pass. */
  weapon?: string;
  kinds?: PlayerGem["kind"][];
  /** Include skills granted by items (weapon bases, uniques). Default false. */
  includeItemSkills?: boolean;
  /** Only skills a character of this level can already use. */
  availableBy?: number;
  limit?: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");

/** Ids differ only in "Gem/" vs "Gems/" and case; the game uses both spellings. */
const idKey = (id: string) => id.trim().toLowerCase().replace("/gems/", "/gem/");

/**
 * Find a gem by its exact id, the id with the other "Gem/"/"Gems/" spelling, or its name.
 * Names prefer the gem you can cut from an uncut gem over item-granted versions.
 */
export function findGem(data: GameData, ref: string): PlayerGem {
  const exact = data.playerGems.get(ref);
  if (exact) return exact;
  const key = idKey(ref);
  for (const gem of data.playerGems.values()) if (idKey(gem.gameId) === key) return gem;

  const name = ref.trim().toLowerCase();
  const named = [...data.playerGems.values()].filter((g) => g.name.toLowerCase() === name);
  const preferred = named.filter((g) => g.source !== "item");
  const candidates = preferred.length > 0 ? preferred : named;
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    throw new Error(`"${ref}" matches several gems: ${candidates.map((g) => `${g.name} (${g.gameId})`).join(", ")}. Use the gemId.`);
  }
  throw new Error(`Unknown gem "${ref}". Use a gemId or exact name from search_skills / compatible_supports.`);
}

export function skillOf(data: GameData, gem: PlayerGem): Skill | undefined {
  return data.skills[gem.grantedEffectId];
}

/** Everything a search term can match on: gem tags, skill types, weapon requirements and the name. */
function searchTerms(gem: PlayerGem, skill: Skill | undefined): Set<string> {
  const terms = new Set<string>();
  for (const tag of gem.tags) terms.add(norm(tag));
  for (const type of skill?.active_skill?.types ?? []) terms.add(norm(type));
  for (const weapon of gem.weaponRequirements) {
    terms.add(norm(weapon));
    terms.add(norm(weapon.replace(/^(One|Two) Hand /, "")));
  }
  terms.add(norm(gem.name));
  return terms;
}

export function usableWith(gem: PlayerGem, weapon: string): boolean {
  if (gem.weaponRequirements.length === 0) return true;
  const w = norm(weapon);
  return gem.weaponRequirements.some((req) => norm(req).includes(w));
}

export function searchSkills(data: GameData, query: SkillSearchQuery): SkillMatch[] {
  const require = (query.require ?? []).map(norm);
  const prefer = (query.prefer ?? []).map(norm);
  const kinds = query.kinds ?? ["active", "spirit"];

  const matches: SkillMatch[] = [];
  for (const gem of data.playerGems.values()) {
    if (!kinds.includes(gem.kind)) continue;
    if (gem.source === "item" && !query.includeItemSkills) continue;
    if (query.weapon && !usableWith(gem, query.weapon)) continue;
    const from = availableFromLevel(gem);
    if (query.availableBy !== undefined && from !== undefined && from > query.availableBy) continue;
    const skill = skillOf(data, gem);
    const terms = searchTerms(gem, skill);
    if (!require.every((t) => terms.has(t))) continue;
    const description = stripMarkup(skill?.active_skill?.description ?? "").toLowerCase();
    if (!(query.text ?? []).every((word) => description.includes(word.toLowerCase()))) continue;
    const preferred = (query.prefer ?? []).filter((t) => terms.has(norm(t)));
    matches.push({
      gameId: gem.gameId,
      name: gem.name,
      kind: gem.kind,
      source: gem.source,
      tier: gem.tier,
      weaponRequirements: gem.weaponRequirements,
      availableFromLevel: from,
      tags: gem.tags,
      skillTypes: skill?.active_skill?.types ?? [],
      description: stripMarkup(skill?.active_skill?.description ?? ""),
      matched: [...(query.require ?? []), ...preferred],
      score: require.length + preferred.length,
    });
  }
  return matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, query.limit ?? 25);
}

export type SupportCheck = { ok: true } | { ok: false; reason: string };

/** Can this support gem's skill support this active skill? Mirrors PoB's canGrantedEffectSupportActiveSkill. */
export function canSupport(support: Skill, active: Skill): SupportCheck {
  const rules = support.support_gem;
  if (!rules) return { ok: false, reason: "not a support" };
  const types = new Set(active.active_skill?.types ?? []);
  const minionTypes = new Set(active.active_skill?.minion_types ?? []);
  const excluded = rules.excluded_types ?? [];
  const allowed = rules.allowed_types ?? [];
  if (excluded.length > 0 && matchesTypeExpression(excluded, types)) {
    return { ok: false, reason: "the skill has a type this support excludes" };
  }
  if (allowed.length > 0 && !matchesTypeExpression(allowed, types, minionTypes)) {
    return { ok: false, reason: "the skill lacks a type this support requires" };
  }
  return { ok: true };
}

const SOURCE_NOTES: Partial<Record<GemSource, { penalty: number; note: string }>> = {
  lineage: { penalty: 1, note: "lineage support: a rare drop, likely expensive" },
  special: { penalty: 1, note: "not available from uncut support gems" },
};

export function compatibleSupports(
  data: GameData,
  activeGameId: string,
  options: { prefer?: string[]; limit?: number; includeLineage?: boolean } = {},
): SupportMatch[] {
  const activeGem = findGem(data, activeGameId);
  const active = skillOf(data, activeGem);
  if (!active?.active_skill) throw new Error(`${activeGem.name} has no active skill`);

  const recommended = new Set(activeGem.gem.recommended_supports ?? []);
  const wanted = new Set([...activeGem.tags, ...(options.prefer ?? [])].map(norm));
  const includeLineage = options.includeLineage ?? true;

  const matches: SupportMatch[] = [];
  for (const gem of data.playerGems.values()) {
    if (gem.kind !== "support") continue;
    if (gem.source === "lineage" && !includeLineage) continue;
    const support = skillOf(data, gem);
    if (!support || !canSupport(support, active).ok) continue;

    const overlap = gem.tags.filter((t) => t !== "support" && wanted.has(norm(t)));
    const recommendedByGame = recommended.has(gem.gameId);
    const sourceNote = SOURCE_NOTES[gem.source];
    const reasons: string[] = [];
    if (recommendedByGame) reasons.push(`the game lists it as a recommended support for ${activeGem.name}`);
    if (overlap.length > 0) reasons.push(`matches: ${overlap.join(", ")}`);
    if (sourceNote) reasons.push(sourceNote.note);

    matches.push({
      gameId: gem.gameId,
      name: gem.name,
      source: gem.source,
      tier: gem.tier,
      tags: gem.tags.filter((t) => t !== "support"),
      text: stripMarkup(gem.gem.support_text ?? ""),
      recommendedByGame,
      alternatives: [],
      score: (recommendedByGame ? 3 : 0) + overlap.length - (sourceNote?.penalty ?? 0),
      reasons,
    });
  }
  matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  // Keep the best-ranked support of each family; list the others as alternatives.
  const bestOfFamily = new Map<string, SupportMatch>();
  const result: SupportMatch[] = [];
  for (const match of matches) {
    const family = data.playerGems.get(match.gameId)?.family;
    const best = family ? bestOfFamily.get(family) : undefined;
    if (best) {
      best.alternatives.push(match.name);
      continue;
    }
    if (family) bestOfFamily.set(family, match);
    result.push(match);
  }
  return result.slice(0, options.limit ?? 30);
}
