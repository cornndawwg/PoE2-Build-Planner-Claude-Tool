# PoE2 Build Planner — Claude Tool

A free Claude Desktop Extension that helps Path of Exile 2 players turn a play fantasy into a playable build. Tell your Claude what you want to play, and it uses this tool to work out the class, ascendancy, skills and supports, leveling path, passive tree, stat and jewel priorities, and whether the build can handle T15/T16 juiced maps. It then writes the plan into the game's Build Planner.

Built for casual players on a budget, not meta-chasers.

> **Status:** early development. See [docs/research-brief.md](docs/research-brief.md) for the design and build order.

## How it works

- Runs locally on your PC as an MCP server inside the Claude desktop app.
- Downloads public game data on first run: GGG's passive tree export, RePoE and Path of Building data. Nothing from the game data is shipped with this tool.
- Uses Path of Building's calculation engine for damage and defence numbers.
- Viability verdicts are **estimates**, not guarantees.

## Try it locally (developers)

Needs Node 20+.

```bash
npm install
npm run build
npm run smoke        # starts the server and calls every tool
```

Then add it to Claude Desktop's config (`%APPDATA%\Claude\claude_desktop_config.json` on Windows) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "poe2-build-planner": {
      "command": "node",
      "args": ["H:/PoE2_Tools/PoE2-Build-Planner-Claude-Tool/dist/server.js"]
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
| `compatible_supports` | Supports that work with a skill, ranked with reasons |
| `find_passives` | Notables/keystones/ascendancy notables that scale the build, with drawback flags |
| `plan_passive_tree` | Cheapest path to the chosen passives, with the level to take each point |
| `stat_priorities` | Offensive mods to look for per gear slot and on jewels, plus a defence baseline |
| `data_status` | Cached game data info |

Not yet: Path of Building calculations and viability verdicts, unique items, and exporting to the in-game Build Planner.

## Credits

- Grinding Gear Games — [PoE2 passive tree export](https://github.com/grindinggear/poe2-skilltree-export)
- [RePoE](https://github.com/repoe-fork/repoe) — game data exports
- [Path of Building Community (PoE2)](https://github.com/PathOfBuildingCommunity/PathOfBuilding-PoE2) — calculation engine and data (MIT)

## Donations

This tool is and will stay free. Donations support development and keeping it up to date with patches. Everyone gets the same tool.

---

This product isn't affiliated with or endorsed by Grinding Gear Games in any way.
