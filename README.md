# PoE2 Build Planner — Claude Tool

A free Claude Desktop Extension that helps Path of Exile 2 players turn a play fantasy into a playable build. Tell your Claude what you want to play, and it uses this tool to work out the class, ascendancy, skills and supports, leveling path, passive tree, stat and jewel priorities, and whether the build can handle T15/T16 juiced maps. It then writes the plan into the game's Build Planner.

Built for casual players on a budget, not meta-chasers.

> **Status:** early development. See [docs/research-brief.md](docs/research-brief.md) for the design and build order.

## How it works

- Runs locally on your PC as an MCP server inside the Claude desktop app.
- Downloads public game data on first run: GGG's passive tree export, RePoE and Path of Building data. Nothing from the game data is shipped with this tool.
- Uses Path of Building's calculation engine for damage and defence numbers (bundled; Windows only for now).
- Viability verdicts are **estimates**, not guarantees.

## Install (players)

1. Download `poe2-build-planner-<version>.mcpb` from the Releases page.
2. Double-click it (or drag it into Claude Desktop → Settings → Extensions) and confirm the install.
3. Start a new chat and describe the build you want to play.

Works in the Claude desktop app on Windows and macOS. The first start downloads about 30 MB of public game data.

## Try it locally (developers)

Needs Node 20+.

```bash
npm install
npm run build
npm run smoke        # starts the server and calls every tool
npm run package      # builds release/poe2-build-planner-<version>.mcpb
```

Then add it to Claude Desktop's config (`%APPDATA%\Claude\claude_desktop_config.json` on Windows) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "poe2-build-planner": {
      "command": "node",
      "args": ["C:/path/to/PoE2-Build-Planner-Claude-Tool/dist/server.js"]
    }
  }
}
```

The first start downloads about 30 MB of game data to `%APPDATA%\poe2-build-finder\data`.

### Tools so far

| Tool | What it does |
| :- | :- |
| `list_classes` | Classes and released ascendancies |
| `search_skills` | Skills by tags/types/weapon, with where each comes from |
| `gem_details` | Everything about one gem: tags, skill types, description, level 1/20 text, Spirit cost, recommended supports |
| `compatible_supports` | Supports that work with a skill, ranked with reasons |
| `find_passives` | Notables/keystones/ascendancy notables that scale the build, with drawback flags |
| `plan_passive_tree` | Cheapest path to the chosen passives, with the level to take each point |
| `leveling_phases` | League-start phases (acts, interludes, maps) with levels, checkpoints and quest rewards |
| `check_build` | Checks a plan at a character level: skill availability, attribute and Spirit needs, passive budget |
| `evaluate_build` | Path of Building numbers (damage, kill times, hits survived, resists) and a viability verdict at a level, with budget/mid/high gear, anoints, instills, runes, free-Spirit amulet skills, flasks and weapon swap (Windows) |
| `compare_builds` | Two to four variants calculated the same way, side by side, with which is best for clearing, bossing and survival |
| `suggest_extras` | Spirit skills that fit and cost (and which a Lament/Portent/Absent Amulet grants free), jewels, flasks and charms (unique ones too), amulet anoints and helmet instills (Raven-Touched Shard), runes, soul cores and idols per slot, with costs |
| `item_prices` | Live prices from the official Currency Exchange for currency, runes, soul cores, Liquid Emotions, omens and other stackables |
| `trade_links` | Pre-filled trade site searches for rares (slot + mods + level) and uniques, opened in the player's own browser |
| `stat_priorities` | Offensive mods to look for per gear slot and on jewels, plus a defence baseline |
| `find_uniques` | Uniques that fit the build, with current mods, level and where they drop (no prices — see below) |
| `create_build_guide` | Writes a Maxroll-style guide page (phases, checks, quest rewards, highlighted passive tree, a Build Planner file per phase) and opens it |
| `export_build` | Writes the build into the game's Build Planner (passives with levels, skills and supports, gear hints) |
| `data_status` | Cached game data info |

Path of Building calculations run inside the extension on Windows (see [docs/engine.md](docs/engine.md)); they use assumed budget gear and heuristic verdict bands, so treat them as estimates.

Prices: stackable items (currency, runes, soul cores, Liquid Emotions, omens…) come from GGG's public Currency Exchange data. Uniques and rares aren't priced; `trade_links` gives trade site searches the player opens themselves (the tool never calls the trade site). poe.ninja's API terms ask desktop apps to go through their own backend, so unique prices from it are left for later.

Not calculated yet: timeless jewels (Path of Building for PoE2 has no seed data for them) and Headhunter's stolen monster mods.

`examples/Example - Fireball Infernalist.build` is a sample export. Copy it into `Documents/My Games/Path of Exile 2/BuildPlanner` to check that the game loads it.

## Credits

- Grinding Gear Games — [PoE2 passive tree export](https://github.com/grindinggear/poe2-skilltree-export)
- [RePoE](https://github.com/repoe-fork/repoe) — game data exports
- [Path of Building Community (PoE2)](https://github.com/PathOfBuildingCommunity/PathOfBuilding-PoE2) — calculation engine and data (MIT)

## License

Bundled third-party software: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).


MIT — see [LICENSE](LICENSE). Game data is downloaded at runtime and belongs to Grinding Gear Games.

## Donations

This tool is and will stay free. Donations support development and keeping it up to date with patches. Everyone gets the same tool.

---

This product isn't affiliated with or endorsed by Grinding Gear Games in any way.
