// Compare build variants side by side (e.g. two-handed vs shield Titan), all calculated the same way.

import type { GameData } from "../data/gamedata.js";
import { evaluateBuild, type EvaluateInput, type Evaluation } from "./evaluate.js";
import type { PobEngine } from "./pob.js";

export interface Variant {
  label: string;
  input: EvaluateInput;
}

export interface ComparisonRow {
  label: string;
  clearDps: number;
  rareSeconds?: number;
  bossDps: number;
  bossSeconds?: number;
  breakdown: Evaluation["clear"]["breakdown"];
  life?: number;
  energyShield?: number;
  hitsFromNormal?: number;
  hitsFromBoss?: number;
  resistances: Evaluation["defence"]["resistances"];
  attributesShort: { str: number; dex: number; int: number };
  verdicts: { content: string; overall: string; weakPoint?: string }[];
  /** Change against the first variant, in percent (damage, life + ES, survival). */
  vsFirst?: { clearDps: string; bossDps: string; lifeAndEs: string; hitsFromBoss: string };
  notes: string[];
}

const pct = (value: number | undefined, base: number | undefined) => {
  if (value === undefined || base === undefined || base === 0) return "—";
  const change = Math.round(((value - base) / base) * 100);
  return `${change > 0 ? "+" : ""}${change}%`;
};

export async function compareBuilds(engine: PobEngine, data: GameData, variants: Variant[]): Promise<{ rows: ComparisonRow[]; best: Record<string, string> }> {
  const rows: ComparisonRow[] = [];
  for (const variant of variants) {
    const e = await evaluateBuild(engine, data, variant.input);
    const short = (req?: number, have?: number) => Math.max(0, Math.round((req ?? 0) - (have ?? 0)));
    rows.push({
      label: variant.label,
      clearDps: e.clear.dps,
      rareSeconds: e.clear.secondsToKill.rare,
      bossDps: e.boss.dps,
      bossSeconds: e.boss.secondsToKill.boss,
      breakdown: e.clear.breakdown,
      life: e.defence.life,
      energyShield: e.defence.energyShield,
      hitsFromNormal: e.survival.hitsFromNormal,
      hitsFromBoss: e.survival.hitsFromBoss,
      resistances: e.defence.resistances,
      attributesShort: {
        str: short(e.attributes.required.str, e.attributes.str),
        dex: short(e.attributes.required.dex, e.attributes.dex),
        int: short(e.attributes.required.int, e.attributes.int),
      },
      verdicts: e.verdicts.map(({ content, overall, weakPoint }) => ({ content, overall, weakPoint })),
      notes: e.notes,
    });
  }
  const first = rows[0];
  if (first) {
    for (const row of rows.slice(1)) {
      row.vsFirst = {
        clearDps: pct(row.clearDps, first.clearDps),
        bossDps: pct(row.bossDps, first.bossDps),
        lifeAndEs: pct((row.life ?? 0) + (row.energyShield ?? 0), (first.life ?? 0) + (first.energyShield ?? 0)),
        hitsFromBoss: pct(row.hitsFromBoss, first.hitsFromBoss),
      };
    }
  }
  const bestBy = (score: (r: ComparisonRow) => number) => rows.reduce((a, b) => (score(b) > score(a) ? b : a)).label;
  const best: Record<string, string> = rows.length
    ? {
        clearing: bestBy((r) => r.clearDps),
        bossing: bestBy((r) => r.bossDps),
        survival: bestBy((r) => r.hitsFromBoss ?? 0),
      }
    : {};
  return { rows, best };
}
