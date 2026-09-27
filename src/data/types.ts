// Shapes of the upstream data files, limited to the fields we use.
// Field names match the upstream JSON exactly.

// --- GGG passive tree export (data.json) ---

export interface TreeAscendancy {
  id: string;
  /** null for ascendancies present in the data but not released. */
  name: string | null;
}

export interface TreeClass {
  name: string;
  base_str: number;
  base_dex: number;
  base_int: number;
  ascendancies: TreeAscendancy[];
}

export interface TreeNode {
  /** String id used by GGG's Build Planner (.build) files, e.g. "attributes70". Missing on the root node. */
  id?: string;
  skill?: number;
  name?: string;
  icon?: string;
  stats?: string[];
  isNotable?: boolean;
  isKeystone?: boolean;
  isMastery?: boolean;
  isJewelSocket?: boolean;
  isGenericAttribute?: boolean;
  isAscendancyStart?: boolean;
  isMultipleChoice?: boolean;
  /** One option of a multiple-choice node; picked at the end of a path, never walked through. */
  isMultipleChoiceOption?: boolean;
  /** Extra passive points granted by allocating this node. */
  grantedPassivePoints?: number;
  ascendancyId?: string;
  /** Indexes into `classes` for the classes that start at this node. */
  classStartIndex?: number[];
  grantedStrength?: number;
  grantedDexterity?: number;
  grantedIntelligence?: number;
  weaponPassivePointsGranted?: number;
  unlockConstraint?: { ascendancy?: string };
  group?: number;
  x?: number;
  y?: number;
  out?: string[];
  in?: string[];
}

export interface TreeExport {
  classes: TreeClass[];
  /** Keyed by the node's numeric skill hash as a string. */
  nodes: Record<string, TreeNode>;
  jewelSlots: number[];
}

// --- RePoE skill_gems.json ---

export interface SkillGem {
  base_item: { display_name: string; id: string; release_state: string };
  color?: string;
  gem_type: "active" | "support" | "spirit" | string;
  grants_skills?: string[];
  recommended_supports?: string[];
  requirement_weights?: { strength: number; dexterity: number; intelligence: number };
  tags?: string[];
  support_text?: string;
  is_lineage?: boolean;
}

// --- RePoE skills.json ---

export interface Skill {
  is_support: boolean;
  cast_time?: number;
  active_skill?: {
    id: string;
    display_name: string;
    description?: string;
    types: string[];
    /** Types of the minion's skills, for minion skills. */
    minion_types?: string[];
    /** Always empty in the PoE2 RePoE export — weapon requirements have to come from elsewhere. */
    weapon_restrictions?: string[];
  };
  support_gem?: {
    /** Postfix (RPN) boolean expressions over skill types, e.g. ["A", "B", "AND", "NOT"]. */
    allowed_types?: string[];
    excluded_types?: string[];
    added_types?: string[];
    supports_gems_only?: boolean;
  };
}

// --- RePoE base_items.json ---

export interface BaseItem {
  name: string;
  item_class: string;
  tags: string[];
  drop_level?: number;
  release_state: string;
  implicits?: string[];
}

// --- RePoE mods.json ---

export interface Mod {
  name: string;
  domain: string;
  generation_type: string;
  type: string;
  groups: string[];
  required_level: number;
  /** Ordered: the first tag the item has decides. PoE2 weights are 0/1 (can / can't roll). */
  spawn_weights: { tag: string; weight: number }[];
  implicit_tags?: string[];
  is_essence_only?: boolean;
  stats: { id: string; min: number; max: number }[];
  text?: string;
}
