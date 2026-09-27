// Parses Path of Building's unique item text blocks (src/Data/Uniques/*.lua):
//
//   Name
//   {variant:1}Old Base Type        <- base type, possibly per variant, possibly after headers
//   {variant:2}Base Type
//   Variant: Pre 0.4.0              <- headers, in any order
//   Variant: Current
//   Source: Drops from unique{Boss}
//   Requires Level 55
//   Implicits: 1
//   {tags:life}+(30-40) to maximum Life              <- implicit(s), then explicit mods
//   {variant:2}{tags:attribute}+(50-100) to all Attributes
//
// Lines can be limited to variants ({variant:1,2}) or versions ({version:2}); only the
// current variant and version are kept.

import { stripMarkup } from "../text.js";

export interface UniqueItem {
  name: string;
  baseType: string;
  requiredLevel?: number;
  /** Where it drops, when PoB records it. */
  source?: string;
  implicits: string[];
  mods: string[];
  /** PoB's mod tags, e.g. fire, life, attack. */
  tags: string[];
}

// "Grants Skill:" and "Left ring slot:" look similar but are real mod text.
const HEADER =
  /^(Variant|Version|Selected Variant|Source|League|Limited to|Radius|LevelReq|Item Level|Quality|Sockets|Upgrade|Has Alt Variant[\w ]*|Selected Alt Variant[\w ]*|Allow Duplicate Variants|Crafted|Implicits):\s*(.*)$/;

interface Line {
  text: string;
  variants?: number[];
  versions?: number[];
  tags: string[];
}

function splitPrefixes(raw: string): Line {
  const line: Line = { text: raw, tags: [] };
  for (let m = /^\{([^}]*)\}/.exec(line.text); m; m = /^\{([^}]*)\}/.exec(line.text)) {
    const [key, value = ""] = m[1]!.split(":");
    if (key === "variant") line.variants = value.split(",").map(Number);
    else if (key === "version") line.versions = value.split(",").map(Number);
    else if (key === "tags") line.tags.push(...value.split(",").filter(Boolean));
    line.text = line.text.slice(m[0].length);
  }
  return line;
}

/** 1-based index of the "Current" entry, else the last one; undefined if there are none. */
const currentOf = (labels: string[]) => (labels.length === 0 ? undefined : labels.findIndex((v) => /current/i.test(v)) + 1 || labels.length);

/**
 * @param isBase recognises base type names; without it the line after the name is the base.
 */
export function parseUnique(text: string, isBase?: (name: string) => boolean): UniqueItem | undefined {
  const [name, ...rest] = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!name || rest.length === 0) return undefined;

  const variants: string[] = [];
  const versions: string[] = [];
  const bases: Line[] = [];
  const modLines: Line[] = [];
  let implicitCount = 0;
  let requiredLevel: number | undefined;
  let source: string | undefined;

  rest.forEach((raw, index) => {
    const level = /^Requires Level (\d+)/.exec(raw);
    if (level) {
      requiredLevel = Number(level[1]);
      return;
    }
    const header = HEADER.exec(raw);
    if (header) {
      const [, key, value = ""] = header;
      if (key === "Variant") variants.push(value);
      else if (key === "Version") versions.push(value);
      else if (key === "Source") source = stripMarkup(value.replace(/\w+\{([^}]*)\}/g, "$1"));
      else if (key === "Implicits") implicitCount = Number(value);
      return;
    }
    const line = splitPrefixes(raw);
    const looksLikeBase = isBase ? isBase(line.text) : index === 0 && modLines.length === 0;
    if (looksLikeBase && modLines.length === 0) bases.push(line);
    else modLines.push(line);
  });

  const variant = currentOf(variants);
  const version = currentOf(versions);
  const current = (l: Line) =>
    (!l.variants || variant === undefined || l.variants.includes(variant)) &&
    (!l.versions || version === undefined || l.versions.includes(version));

  const base = bases.find(current) ?? bases.at(-1);
  if (!base) return undefined;

  const implicits: string[] = [];
  const mods: string[] = [];
  const tags = new Set<string>();
  modLines.forEach((line, index) => {
    if (!current(line) || !line.text) return;
    line.tags.forEach((t) => tags.add(t));
    (index < implicitCount ? implicits : mods).push(stripMarkup(line.text));
  });

  return { name, baseType: base.text, requiredLevel, source, implicits, mods, tags: [...tags] };
}

export function parseUniqueFile(entries: unknown, isBase?: (name: string) => boolean): UniqueItem[] {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    const item = typeof entry === "string" ? parseUnique(entry, isBase) : undefined;
    return item ? [item] : [];
  });
}
