# PoE2 Build Finder — Research Brief (v1)

A free tool that lets a player's own Claude turn a play fantasy into a playable Path of Exile 2 build. The player says what they want to play ("a ranged fire caster that summons things and freezes enemies"), and Claude uses this tool to work out the class, ascendancy, skills, supports, leveling path, passive tree, stat priorities and jewels, and to say honestly whether it can reach T15/T16 juiced maps. Written for handoff to Claude Code.

Game version at time of research: **PoE2 0.5.5**, September 2026 (GGG tree export "0.5.5", RePoE export 4.5.5.2).

---

## 1. Who it's for and what it does

**Audience: casual players with a play fantasy.** Players who aren't deep into theorycrafting, can't farm or buy the expensive gear a streamer's showcase build needs, and want to know: *can I make the thing I want to play work, and how?* Hardcore players may find it useful, but they aren't the target.

**Principles:**
- **Play fantasy first.** Start from what the player wants to do, not from what's strongest. Stay true to the fantasy, and say so plainly when part of it isn't viable, offering the closest viable version.
- **Budget-aware by default.** Assume self-found or cheap gear. Expensive uniques are optional upgrades, never requirements.
- **Explain the why.** Every choice comes with a short, plain reason ("this support is here because Fireball is a projectile spell").
- **Honest verdicts.** Viability is a heuristic band, not a promise (§6).
- **No loophole hunting.** Use public, permitted data only. No scraping, no meta or usage data, no workarounds for missing data. Finding strong off-meta builds is a welcome side effect, not a goal.

**What the player gets:**

| Output | Detail |
| :- | :- |
| Class and ascendancy | With the reason it fits the fantasy |
| Main skills and supports | Main skill(s) with supports, plus utility skills (movement, curse, aura/buff). Support choices checked for compatibility |
| Leveling path | Staged plan: which skills to use while leveling (e.g. 1–12, 12–30, 30–60, 60+), when to swap to the final setup, and passive stages in order |
| Passive tree | Final allocation plus the order of stages. Key notables and keystones explained |
| Offensive stat priorities | What to look for on gear, in order (e.g. "+ levels to fire spell skills > cast speed > spell damage > crit"). Defences are assumed as a baseline and summarised briefly |
| Jewel stats | Which jewel type and which jewel mods to look for, in priority order |
| Gear guidance by slot | Stat priorities per slot and budget uniques that fit (with current price where available) |
| Viability verdict | Band for campaign / early maps / T15 / T16 juiced, plus the main weak point and what to fix first |
| Files | An in-game Build Planner file (written straight to the game's BuildPlanner folder) and a Path of Building code |

---

## 2. Hard constraints (read first)

### GGG policy (pathofexile.com/developer/docs)

- "As a general rule, we cannot allow our Intellectual Property to be used to generate commercial revenue." → The tool is **free**. Donations support development; **donors get no extra features or access**.
- Required notice on the site, README and in-app: **"This product isn't affiliated with or endorsed by Grinding Gear Games in any way."**
- "We can only support resources defined in our API Reference or listed in our Data Exports." Reverse-engineering undocumented endpoints breaks the Terms of Use. Breaking the guidelines "can result in account termination for you as well as your users."
- The tool never interacts with the game client, reads game memory, or extracts the game's own files. The only thing it touches is the **BuildPlanner folder**, which GGG documents for exactly this purpose.

### Data we can't use (verified)

| Source | Why not |
| :- | :- |
| poe.ninja builds / profiles / character data | poe.ninja's API docs: builds and every other non-economy endpoint "are internal… not available for third-party use." Clients that misbehave get blocked. |
| GGG ladder API | Needs a confidential (server) client. Entries hold only rank, name, level, class and account — no gear or skills. |
| GGG OAuth (Characters API) | GGG: "We are currently unable to process new applications." |
| Trade-site API (`/api/trade2/...`) | Not a documented GGG API. |
| Extracting data from the game install (`Bundles2`, `.datc64`) | Grey area. Some tools do it; we don't need it. |

Consequence: the tool reasons from game mechanics and calculations only. It has no knowledge of what other players run.

---

## 3. Data sources (all public, all downloaded by the player's install)

The tool **downloads data on first run and refreshes it when a new patch appears**. It never ships or redistributes GGG's data.

| Data | Source | Status |
| :- | :- | :- |
| Passive tree: nodes, stat text, notables, keystones, jewel sockets, class starts, ascendancy nodes | GGG official export — github.com/grindinggear/poe2-skilltree-export (`data.json`, 5.1 MB) | ✅ Verified. Commit "0.5.5" (2026-09-04). Listed in GGG's Data Exports. No LICENSE file. |
| Skill and support gems: tags, types, per-level damage/cost, cast time, support compatibility | RePoE PoE2 — repoe-fork.github.io/poe2 (`skill_gems.json`, `skills.json`) | ✅ Verified. 1,191 gems (505 active, 642 support, 44 spirit). |
| Item bases, jewel bases | RePoE `base_items.json` | ✅ Verified. 5,496 bases. |
| Gear and jewel mods (for stat priorities) | RePoE `mods.json` | ✅ Verified. Jewel mods: 320 in `domain: "misc"`, keyed by `strjewel` / `dexjewel` / `intjewel` / `radius_jewel` tags (e.g. `JewelAreaofEffect`: "(4-6)% increased Area of Effect"). |
| Stat text translations | RePoE `stat_translations/` | ✅ Exists. |
| Unique items with their mods | Path of Building PoE2 — `src/Data/Uniques/*.lua` | ✅ Verified. Base type, variants, mod text. (RePoE's `uniques.json` has names only.) |
| Calculations: DPS, life/ES, resists, effective HP | Path of Building PoE2 engine, run headless (`src/HeadlessWrapper.lua`) | ✅ Verified. MIT-licensed code. Needs LuaJIT + lua-zlib, luautf8, luafilesystem. Use a pinned git checkout (installed releases leave the headless wrapper out). |
| Unique prices (budget flags) | poe.ninja economy API — `/poe2/api/economy/...` | ✅ Allowed for third parties. Rules: cache ~5 min+, identifying User-Agent. Exact unique-item endpoint shape to confirm. |
| In-game export format | GGG Build Planner `.build` (developer docs → File Formats) | ✅ Documented, "Version: 1 (Experimental)". |

### Passive tree export — details

- Top-level: `tree`, `classes` (12), `groups` (1,623), `nodes` (5,153), `edges` (6,076), `skillOverrides` (80), `jewelSlots` (31), bounds.
- Node: `id` (string, e.g. `"attributes70"`, **the same id the .build file uses**), `skill` (numeric hash), `name`, `icon`, `stats[]` (text with markup like `[Ignite|Ignites]`), position, `in`/`out`/edges.
- Flags: `isNotable`, `isKeystone`, `isMastery`, `isJewelSocket`, `isGenericAttribute`, `ascendancyId`, `isAscendancyStart`, `classStartIndex`, `grantedSkill`, `grantedStrength/Dex/Int`, `weaponPassivePointsGranted`, `unlockConstraint`, `isMultipleChoice`.
- Counts: 33 keystones, 984 notables, 208 ascendancy notables, ~2,781 small passives, 293 attribute nodes, 19 jewel sockets, 669 ascendancy nodes.
- ⚠ Filtering needed: 12 classes are listed but the PoE1-style ones (Marauder, Duelist, Shadow, Templar) have empty ascendancy lists, and some ascendancies have `name: null` (e.g. Ranger2, Druid3) — likely unreleased. Only offer released class/ascendancy pairs.
- Weapon sets: no per-node flag; assignment lives in the build (`weapon_set` 0–2).

### Skills — details

- `skill_gems.json`: `tags` (Fireball: spell, area, projectile, fire), `color`, `requirement_weights`, `grants_skills`, `recommended_supports`, `support_text`, `is_lineage`.
- `skills.json`: `active_skill.types` (Fireball: Spell, Projectile, Fire, AreaSpell, …), `cast_time`, `per_level` costs (levels 1–40), `stat_sets[].per_level` with raw stats and text, `static.crit_chance`.
- **Support compatibility is rule-based:** a support's `allowed_types` / `excluded_types` / `added_types` against the skill's `active_skill.types`.
- ⚠ Gem id mismatch: RePoE uses `Metadata/Items/Gem/...`; GGG's .build example mixes `Gem/` and `Gems/`. Use the exact BaseItemTypes id and test an import in game.

---

## 4. How it works

The player's Claude does the conversation and reasoning. The tool does lookups, search and calculations.

**Flow:**
1. **Understand the fantasy.** Claude turns the request into tags: damage type (fire), delivery (spell, projectile), range, mechanics (minions, freeze), weapon preferences, budget, and any must-have skill.
2. **Find skills.** Match active skills by tags and types. Offer 2–3 main-skill options that fit, plus utility skills.
3. **Pick supports.** Filter by compatibility, then rank by how well each support's effect matches the build's tags.
4. **Pick class and ascendancy.** Score each released ascendancy by how many of its notables scale the build's tags, and how close its class start is to the relevant tree areas.
5. **Find scaling on the tree.** Search notables and keystones whose stat text or stat ids match the build's tags. Prefer clusters that also give defences.
6. **Path the tree.** Find the cheapest set of nodes connecting the class start to the chosen notables within the point budget (a Steiner-tree approximation). Then order it into leveling stages: early damage first, then defence, then the rest.
7. **Leveling plan.** Choose leveling skills from what's available at each gem level range, and when to swap to the final setup.
8. **Stat priorities.** Derive offensive gear priorities and jewel priorities from the mods that can roll on each slot or jewel type and that match the build's scaling (e.g. a fire spell build → "+ levels to fire spell skills", cast speed, fire damage, crit). Defences get a one-line baseline.
9. **Assume budget gear and evaluate.** Build a "cheap/self-found" gear set (reasonable mid-tier rares matching the priorities, plus affordable uniques) and run it through Path of Building. Optionally a "mid-budget" set for comparison.
10. **Verdict** (§6), then **export** the Build Planner file and PoB code.

**The build between steps** is passed back and forth as a compact build code (like a PoB code), not re-sent in full. The server is stateless; the player's Claude chat holds the conversation.

---

## 5. Tools Claude will call (MCP)

| Tool | Does | Cost |
| :- | :- | :- |
| `list_classes()` | Released classes and ascendancies with a one-line summary | Cheap |
| `search_skills(tags, weapon?)` | Active skills matching tags, with level requirement and weapon | Cheap |
| `compatible_supports(skill, tags?)` | Compatible supports, ranked by fit, with reasons | Cheap |
| `find_scaling(tags, class?)` | Notables, keystones, ascendancy notables, jewel mods and gear mods that scale those tags | Cheap |
| `plan_tree(class, ascendancy, target_nodes, points?)` | Allocated path and leveling stages | Moderate |
| `leveling_plan(build)` | Skills and gear focus per level range | Cheap |
| `stat_priorities(build)` | Offensive stat priorities per gear slot, jewel priorities, defensive baseline | Cheap |
| `find_uniques(tags, max_price?)` | Uniques that fit, with current price if known | Cheap |
| `evaluate_build(build, budget)` | PoB calculation: DPS, life/ES, resists, effective HP, plus verdict band and weak point | Expensive (PoB) |
| `export_build(build)` | Writes the `.build` file to the BuildPlanner folder; returns the path and a PoB code | Cheap |
| `data_status()` | Game version of cached data and whether an update is available | Cheap |

Every tool returns **reasons**, not just results, so Claude can explain choices to a new player.

---

## 6. Viability verdict

There are **no authoritative T15/T16 thresholds**. Community numbers disagree by 2–5×. The verdict is a heuristic band, stated as such.

| Source | What it says | Reliability |
| :- | :- | :- |
| maxroll Defence Guide (updated 2026-09-18) | Cap elemental resistances at 75%. No numeric DPS or HP targets. | High, but only this one firm number |
| timesaver.gg (0.5.5, 2026-09-08) | ~100k single-target DPS barely clears T15; 200–500k comfortable; 1M+ for juiced maps and pinnacle bosses. Rares should die in 1–3 s. 3k+ effective HP plus one active defence layer. | Low (no sources cited) |
| poe2-mcp readiness checker (hard-coded) | T11–15: min 4k life / 8k EHP, 85% res, chaos > 20%, 50–100k DPS. T16: min 5k / 12k, 90% res, 40% chaos, 100–200k DPS. | Low; life-only, misjudges energy-shield builds |

**Approach:**
- Bands per content level: **Comfortable / Workable / Borderline / Not yet**.
- Hard rule: elemental resistances below 75% → can't be "Comfortable" at T15+.
- DPS and effective-HP thresholds live in an editable `verdict_bands.json`, set conservatively from the range above, and reviewed each patch.
- Always name the **main weak point** and **the first thing to fix**, in plain language.
- Label it everywhere: "estimate based on Path of Building calculations with budget gear."

---

## 7. Build Planner export (in-game)

GGG's `.build` format — JSON with one Build object, placed in `Documents/My Games/Path of Exile 2/BuildPlanner` (the game picks it up automatically). It can also be uploaded on the website.

| Object | Fields |
| :- | :- |
| Build | `name`, optional `author`, `link`, `description`, `ascendancy` (e.g. `"Warrior1"`), `passives[]`, `skills[]`, `inventory_slots[]` |
| BuildPassive | `id` (tree export node id), `level_interval` (number or [min, max]), `weapon_set` (0–2), `additional_text` |
| BuildSkill | `id` (gem BaseItemTypes id), `level_interval`, `additional_text`, `support_skills[]` |
| BuildSupport | Same as BuildSkill, minus `support_skills` |
| BuildInventorySlot | `inventory_id` (e.g. `Weapon1`, `Helm1`, `Ring2`), `slot_x`/`slot_y`, `level_interval`, `unique_name`, `additional_text` |

- **`level_interval` gives the leveling path for free:** passives, skills and gear hints can each be tied to level ranges, so the in-game planner shows what to take when.
- `additional_text` supports markup (sizes, colours) — use it for the plain-language "why" notes and the stat priorities per slot.
- Limits: meta gems aren't supported; items are hints only (a unique name or free text, no rare mod specs); players can't edit builds in game. Stat priorities go in `additional_text` instead.
- Also export a **PoB code** for players who use Path of Building.

---

## 8. Packaging and architecture

**Form: a local Claude Desktop Extension (`.mcpb`)** — players download one file and double-click it; Claude installs it as a connector. Runs entirely on the player's PC. Works in the Claude desktop app (not web/mobile). Windows first; Mac later (needs its own LuaJIT build).

- **Server: Node / TypeScript** (Claude Desktop bundles a Node runtime, so players install nothing else).
- **Bundled:** portable LuaJIT + lua-zlib, luautf8, luafilesystem (Windows builds), and a pinned Path of Building PoE2 checkout (MIT; include its license and credits).
- **Data cache:** `%APPDATA%/poe2-build-finder/` — GGG tree export, RePoE files, PoB data. Refresh when the tree export / RePoE / PoB version changes, or weekly.
- **Calculation worker:** a long-lived LuaJIT process running PoB headless, fed builds over stdin/stdout. Cache results by build code. Search features that need many evaluations run with a visible progress note.
- **Keep the tool logic separate from the MCP transport** so a hosted version can be added later without a rewrite.
- Modules: `data` (download, cache, version check), `tree` (graph, pathing, stages), `skills` (search, supports), `scaling` (tag → nodes/mods/uniques), `gear` (budget gear sets, stat priorities, jewels), `pob` (headless worker), `verdict`, `export` (.build + PoB code), `mcp` (tool definitions).
- Tests: fixtures from the real data (a few known builds), golden tests for pathing and support compatibility, and a check that exported `.build` files import in game.

---

## 9. Distribution and donations

| Piece | What | Cost |
| :- | :- | :- |
| Code and downloads | Public GitHub repo; `.mcpb` on the Releases page | Free |
| Website | GitHub Pages landing page: what it does, a demo (screenshot/GIF of a Claude chat), "Download for Claude Desktop", install steps, donation button | Free (custom domain ~$10–15/year optional) |
| Donations | GitHub Sponsors (no platform fee) and/or Ko-fi (one-off tips) | Platform fees only |

The site, README and extension must include:
- GGG's notice: "This product isn't affiliated with or endorsed by Grinding Gear Games in any way."
- Credits: GGG tree export, RePoE, Path of Building (MIT license text).
- "Donations support development. Everyone gets the same tool."
- "Verdicts are estimates, not guarantees."
- A link to report issues (the fastest way to hear when a patch breaks something).

---

## 10. Existing tools worth studying

- **avdergh/poe2-exile-architect** (MIT, updated 2026-09-18): closest to this idea. Research / Create / Audit workflows, headless PoB with a pinned patched checkout and LuaJIT, exports `.build` files. Study first; borrowing code is allowed under MIT with attribution.
- **juddisjudd/pob-mcp** (MIT): PoB MCP bridge with tree and gear editing and an optimizer. Reference for driving PoB headless.
- **BPL-v2/PathOfBuildingHttpServer**: Go server with a LuaJIT worker pool — reference for running PoB as a worker.
- **HivemindOverlord/poe2-mcp** (MIT, 81 stars): many tools, but uses its own game-file extraction and poe.ninja profile imports — both approaches we're avoiding.

---

## 11. Open questions / verify before relying on them

1. Total passive points at max level, and how weapon-set passive points work (tree has `weaponPassivePointsGranted`).
2. Does Path of Building PoE2 fully cover 0.5.5? (dev branch pushed 2026-09-25; release v0.23.1 2026-07-28.)
3. Gem id format that the in-game Build Planner accepts (`Gem/` vs `Gems/`).
4. poe.ninja unique-price endpoint shape for PoE2.
5. Which ascendancies are actually released (null names, legacy classes).
6. Headless PoB performance on a typical PC (evaluations per second), which decides how much searching is practical.
7. Claude Desktop Extension details: bundling native binaries (LuaJIT, compiled modules) in `.mcpb`, and signing for Windows.

---

## 12. Build order for Claude Code

1. **Data layer:** download and cache the GGG tree export, RePoE (skill_gems, skills, base_items, mods) and PoB data; version check. Print summary counts to confirm.
2. **Skill tools:** `search_skills`, `compatible_supports` with reasons. Tests on known skills (Fireball, a minion skill, a bow skill).
3. **Scaling + tree:** `find_scaling`, tree graph, `plan_tree` with leveling stages.
4. **Stat priorities + jewels + uniques.**
5. **PoB headless worker** and `evaluate_build`; verdict bands.
6. **Export:** `.build` file (test it imports in game) and PoB code.
7. **MCP server + `.mcpb` packaging**, install test on a clean Windows PC.
8. **Website** (GitHub Pages) with download and donation links.

Never interact with the game client. Never redistribute GGG data.

---

## Sources

- GGG developer docs (policy, API reference, data exports, Build Planner format): https://www.pathofexile.com/developer/docs/index · /reference · /data · /game
- GGG PoE2 passive tree export: https://github.com/grindinggear/poe2-skilltree-export
- RePoE PoE2 export: https://repoe-fork.github.io/poe2/ · https://github.com/repoe-fork/repoe
- Path of Building PoE2: https://github.com/PathOfBuildingCommunity/PathOfBuilding-PoE2 (HeadlessWrapper.lua, src/Data/Uniques, LICENSE.md)
- poe.ninja API terms: https://poe.ninja/docs/api
- Viability references: https://maxroll.gg/poe2/getting-started/defence-guide · https://timesaver.gg/blog/poe2-t15-dps-requirement-0-5-5
- Prior art: https://github.com/avdergh/poe2-exile-architect · https://github.com/juddisjudd/pob-mcp · https://github.com/BPL-v2/PathOfBuildingHttpServer · https://github.com/HivemindOverlord/poe2-mcp
