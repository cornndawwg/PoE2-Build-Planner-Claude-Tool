// Downloads (or re-checks) all game data, then prints what loaded.
// Usage: npm run data:summary [-- --force]

import { defaultCacheDir, ensureData, readCachedManifest } from "../src/data/cache.js";
import { loadGameData } from "../src/data/gamedata.js";
import { rollableMods } from "../src/data/mods.js";
import { stripMarkup } from "../src/text.js";

const force = process.argv.includes("--force");
const cacheDir = defaultCacheDir();
console.log(`Cache: ${cacheDir}`);

const results = await ensureData({ cacheDir, force, log: (m) => console.log(`  ${m}`) });
const manifest = await readCachedManifest(cacheDir);
for (const r of results) {
  const entry = manifest[r.key];
  const size = entry ? `${(entry.bytes / 1024 / 1024).toFixed(1)} MB` : "?";
  console.log(`  ${r.key.padEnd(10)} ${r.status.padEnd(14)} ${size.padStart(8)}  ${entry?.lastModified ?? ""}`);
}

const data = await loadGameData(cacheDir);

const nodes = [...data.nodes.values()];
const count = (pred: (n: (typeof nodes)[number]) => boolean) => nodes.filter(pred).length;
console.log("\nPassive tree");
console.log(`  nodes ${nodes.length}, keystones ${count((n) => !!n.isKeystone)}, ` +
  `notables ${count((n) => !!n.isNotable && !n.ascendancyId)}, ` +
  `ascendancy notables ${count((n) => !!n.isNotable && !!n.ascendancyId)}, ` +
  `jewel sockets ${count((n) => !!n.isJewelSocket)}`);

console.log("\nPlayable classes");
for (const c of data.classes) {
  console.log(`  ${c.name.padEnd(10)} start ${c.startNode.padEnd(6)} ${c.ascendancies.map((a) => a.name).join(", ")}`);
}

const gems = [...data.playerGems.values()];
const tally = new Map<string, number>();
for (const g of gems) tally.set(`${g.kind}/${g.source}`, (tally.get(`${g.kind}/${g.source}`) ?? 0) + 1);
console.log(`\nPlayer gems: ${gems.length} (of ${data.gems.size} RePoE entries)`);
console.log(`  ${[...tally].sort().map(([k, n]) => `${k} ${n}`).join(", ")}`);

const fireball = data.playerGems.get("Metadata/Items/Gem/SkillGemFireball");
const fireballSkill = fireball ? data.skills[fireball.grantedEffectId] : undefined;
if (fireball && fireballSkill?.active_skill) {
  console.log(`  Sample: ${fireball.name} (tier ${fireball.tier}) — tags [${fireball.tags.join(", ")}]`);
  console.log(`          types [${fireballSkill.active_skill.types.join(", ")}]`);
  console.log(`          ${stripMarkup(fireballSkill.active_skill.description ?? "")}`);
}

console.log(`\nMods: ${Object.keys(data.mods).length}, item bases: ${Object.keys(data.baseItems).length}`);
const jewels = Object.values(data.baseItems).filter((b) => b.item_class === "Jewel" && b.release_state === "released");
for (const jewel of jewels) {
  const pool = rollableMods(data.mods, jewel);
  const sample = pool[0]?.text ? ` e.g. "${stripMarkup(pool[0].text)}"` : "";
  console.log(`  ${jewel.name.padEnd(20)} ${String(pool.length).padStart(3)} rollable mods${sample}`);
}
