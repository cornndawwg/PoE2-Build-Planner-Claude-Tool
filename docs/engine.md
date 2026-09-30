# Path of Building engine

`evaluate_build` (and the numbers on guide pages) come from Path of Building PoE2 running headless under LuaJIT.

## How it fits together

| Piece | Where |
| :- | :- |
| LuaJIT 2.1 (`2460b3ff`, the commit PoB itself pins) + `lua-utf8` (`d65ebfa4`) | Built from source by `.github/workflows/pob-engine.yml` on `windows-latest` (MSYS2 UCRT64) |
| Path of Building PoE2 (`2450f2fc`, 0.5.5 data, 2026-09-29), without art (~51 MB) | Sparse checkout in the same workflow |
| `pob/host.lua` | Starts PoB headless and answers JSON-line requests (`evaluate`, `ping`) |
| `src/engine/pob.ts` | Finds the engine, runs it as a child process, restarts it if it crashes or hangs |
| `src/engine/gear.ts` | Assumed budget gear per level and defence style |
| `src/engine/evaluate.ts` | Builds the request (campaign resistance penalty, quest rewards by level, enemy level, normal vs boss) and summarises results |
| `src/engine/verdict.ts` | Heuristic viability bands — review each patch |

Current LuaJIT supports the newer Lua syntax PoB uses (`continue`, `+=`, `??`, `?.`, short lambdas), so PoB runs unpatched.

## Local development (Windows)

The engine lives in the git-ignored `vendor/` folder:

```
vendor/runtime/   luajit.exe, lua51.dll, lua-utf8.dll   ← the "engine-windows" artifact of the PoB engine workflow (runtime/ folder)
vendor/pob/       Path of Building checkout at the pinned commit (src/ and runtime/lua/ only)
```

Get the runtime from the latest successful workflow run:

```bash
gh run download --repo cornndawwg/PoE2-Build-Planner-Claude-Tool -n engine-windows -D build/engine
cp -r build/engine/runtime vendor/runtime
```

Check out Path of Building without art (Git Bash: `MSYS_NO_PATHCONV=1` stops path rewriting):

```bash
MSYS_NO_PATHCONV=1 git clone --filter=blob:none --no-checkout https://github.com/PathOfBuildingCommunity/PathOfBuilding-PoE2 vendor/pob
git -C vendor/pob config core.autocrlf false
MSYS_NO_PATHCONV=1 git -C vendor/pob sparse-checkout set --no-cone '/src/' '/runtime/lua/' '/LICENSE.md' '!*.zst' '!*.png' '!*.jpg' '!*.dds' '!*.webp' '!/src/Export/'
git -C vendor/pob checkout 2450f2fc6ff5d35ace9b35bcd9d31e648ae9d7f1
```

Quick check: `cd vendor/pob/src && ../../runtime/luajit.exe ../../../pob/host.lua selftest`

`npm test` runs the engine tests when `vendor/` is present; `npm run package` bundles it into the extension (or set `POE2BF_PACKAGE_ENGINE_DIR` to a downloaded `engine-windows` artifact).

## Updating Path of Building

Change `POB_COMMIT` in the workflow and the checkout above, run the workflow, and check the self-test and `npm test`. Keep `POB_REF` in `src/data/sources.ts` in step for data files.

## Known limits

- Windows only for now (a macOS LuaJIT build is future work).
- Numbers use assumed budget gear and heuristic verdict bands — estimates, not guarantees.
- Rarity life multipliers (rare ×5, boss ×25) and map life multipliers are heuristics in `verdict.ts`/`evaluate.ts`.
