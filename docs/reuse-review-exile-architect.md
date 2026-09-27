# Reuse review: avdergh/poe2-exile-architect

Reviewed 2026-09-26 at commit `f70c8e3` (2026-09-18). Read-only review; nothing from it has been copied into this repo yet.

## What it is

A Python MCP server (FastMCP, ~181 tools) with a skill pack, aimed at Codex / OpenCode / DeepSeek Harness rather than Claude Desktop. MIT, "Copyright (c) 2026 Max Wilk". Very active (~228 commits since July 2026), 8 stars. Heavily over-engineered for our scope; docs mostly in Chinese.

## Verdict by component

| Component | Verdict | Why |
| :- | :- | :- |
| `pob/pob_headless.lua` — JSON-RPC bridge to PoB over stdin/stdout | Adapt | Proven pattern: `ready` frame, line-delimited `{id, method, params}` → `{id, ok, result}`, prints redirected to stderr, snapshot/restore via `SaveDB` → `loadBuildFromXML`. Port a slim subset (load_build_xml, get_stats, get_xml, alloc_passive, search_passives, gem_level_requirements) with a Node client. |
| `pob/patches/*` + `pob/PINNED.md` clone-and-patch recipe | Adapt | **Patch 0007 rewrites newer Lua syntax (`continue`, `+=`, `??`, lambdas) that current PoB-PoE2 dev uses and stock LuaJIT can't parse.** We will likely need the same. Re-pin to our own commit. |
| LuaJIT built from source in release CI (`.github/workflows/release.yml`) | Reference | Model for bundling `luajit.exe` + `lua51.dll` in our `.mcpb`. PoB art is dropped from the bundle (~400 MB → ~30 MB). |
| PoB code encode/decode (`server/compute/pob_code.py`) | Reference | Trivial with Node's zlib. |
| `.build` export via **PraedythXIV/poe2-build-converter** (TypeScript, MIT) | Evaluate directly | Native TS, could drop into our Node server. exile-architect strips all `level_interval` (single-stage only) — we need staged leveling, so check whether the upstream converter supports it. |
| `.build` validation rules (`server/build_planner/converter.py`) | Adapt | Useful schema checks and slot map (Weapon1, Offhand1, Helm1, BodyArmour1, …, charms as Flask1 at slot_x 2–4), but must allow `level_interval`. |
| RePoE snapshot pinning / hash manifest | Reference | Good immutability idea. |
| `corpus.sqlite`, `release.sqlite`, reference builds, wiki mechanics | **Avoid** | Derived from poe.ninja build data, community PoB codes, or CC BY-NC-SA wiki content. |
| `server/live/meta.py`, `freshness/ninja.py`, `mature_*`, `pob_sharing.py`, `live/prices.py` | **Avoid** | Use poe.ninja's internal builds API, scrape poe.ninja character pages, upload to poe.ninja — against poe.ninja's terms and our rules. |
| `server/live/update.py` self-update (downloads code zips) | **Avoid** | Code-download risk. |
| Judge, optimizers, study renderer, research workflow | Avoid | Far beyond a casual-player tool. |

## Useful facts it confirmed

- Gem ids in `.build` files use the gem's real metadata path; `Gem/` and `Gems/` both occur in real data. Never normalise the prefix.
- `.build` `ascendancy` is e.g. `"Ranger1"`; passives are tree node string ids (e.g. `dexterity46`, `AscendancyRanger1Notable3`).
- Their PoB pin: PathOfBuilding-PoE2 dev `ce566eac45ea8a86477f513c7ee65a1ebe60014e` (2026-09-10, game data 0.5.5).
- Their `lua-utf8` replacement is an ASCII-only shim — non-ASCII names may misbehave.
- In-game import of their `.build` output is not proven (tests mock the converter).

## Attribution if we port anything

Keep "Copyright (c) 2026 Max Wilk" and the MIT permission text in a `THIRD_PARTY_NOTICES.md` entry (and in the ported file header). Same for PraedythXIV's converter and for Path of Building itself.
