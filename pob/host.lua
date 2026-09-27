-- Path of Building PoE2, headless, as a long-running calculation engine.
--
-- Run from <pob>/src:   luajit <path>/host.lua          (JSON-lines server on stdin/stdout)
--                       luajit <path>/host.lua selftest (one calculation, then exit)
--
-- Protocol: one JSON request per line, {"id":1,"method":"evaluate","params":{...}};
-- one JSON response per line, {"id":1,"ok":true,"result":{...}} or {"id":1,"ok":false,"error":"..."}.
-- The first line written is {"ready":true,...} once Path of Building has loaded.
-- Everything Path of Building prints goes to stderr so stdout carries only protocol lines.
-- (The overall approach follows avdergh/poe2-exile-architect's PoB bridge, MIT.)

package.path = "../runtime/lua/?.lua;../runtime/lua/?/init.lua;" .. package.path
-- Path of Building's startup replaces the global arg table, so read the mode first.
local MODE = arg and arg[1]

local OUT = io.stdout
_G.print = function(...)
  local parts = {}
  for i = 1, select("#", ...) do parts[i] = tostring((select(i, ...))) end
  io.stderr:write(table.concat(parts, "\t"), "\n")
end

-- HeadlessWrapper waits for a key press if startup fails; don't let it swallow a request.
local realRead = io.read
io.read = function() return nil end
local started = os.clock()
dofile("HeadlessWrapper.lua")
io.read = realRead
local json = require("dkjson")

local function send(message)
  OUT:write(json.encode(message), "\n")
  OUT:flush()
end

if not build then
  send({ ready = false, error = "Path of Building failed to start" })
  os.exit(1)
end

-- Enemy elemental resistances for each boss tier (PoB only shows these as on-screen defaults).
local BOSS_RESIST = { None = 0, Boss = 30, Pinnacle = 50, Uber = 50 }

local STAT_KEYS = {
  "TotalDPS", "CombinedDPS", "FullDPS", "AverageHit", "Speed", "CritChance", "HitChance",
  "Life", "LifeUnreserved", "EnergyShield", "Mana", "ManaUnreserved", "Spirit", "SpiritUnreserved",
  "FireResist", "ColdResist", "LightningResist", "ChaosResist",
  "FireResistOverCap", "ColdResistOverCap", "LightningResistOverCap",
  "MissingFireResist", "MissingColdResist", "MissingLightningResist", "MissingChaosResist",
  "TotalEHP", "TotalNumberOfHits", "EHPSurvivalTime", "totalEnemyDamageIn", "SecondMinimalMaximumHitTaken",
  "PhysicalMaximumHitTaken", "FireMaximumHitTaken", "ColdMaximumHitTaken", "LightningMaximumHitTaken", "ChaosMaximumHitTaken",
  "Armour", "Evasion", "BlockChance", "MovementSpeedMod",
  -- Damage over time, separate from hits.
  "TotalDot", "TotalDotDPS", "IgniteDPS", "PoisonDPS", "BleedDPS", "TotalIgniteDPS", "TotalPoisonDPS", "TotalBleedDPS",
  "WithIgniteDPS", "WithPoisonDPS", "WithBleedDPS",
  "Str", "Dex", "Int", "ReqStr", "ReqDex", "ReqInt",
}

local function recalc()
  build.buildFlag = true
  build.modFlag = true
  runCallback("OnFrame")
end

local function collectStats()
  local out, stats = build.calcsTab.mainOutput, {}
  for _, key in ipairs(STAT_KEYS) do
    local v = out[key]
    if type(v) == "number" and v == v and v ~= math.huge and v ~= -math.huge then stats[key] = v end
  end
  if type(out.Minion) == "table" then
    stats.MinionCombinedDPS = out.Minion.CombinedDPS
    stats.MinionLife = out.Minion.Life
  end
  return stats
end

--- A unique's item text from Path of Building's data, by exact name (case-insensitive).
local function uniqueText(name)
  local wanted = name:lower()
  for _, list in pairs(data.uniques) do
    for _, raw in ipairs(list) do
      local first = raw:match("^%s*([^\r\n]+)")
      if first and first:lower() == wanted then return "Rarity: UNIQUE\n" .. raw:gsub("^%s+", "") end
    end
  end
  return nil
end

local function equip(raw, slot)
  local ok, item = pcall(function() return new("Item"):Item(raw) end)
  if not ok or not item or not item.base then
    return "could not read item: " .. tostring(ok and "unknown base type" or item)
  end
  local slotName = slot or item:GetPrimarySlot()
  local control = build.itemsTab.slots[slotName]
  if not control then return "unknown slot " .. tostring(slotName) end
  build.itemsTab:AddItem(item, true)
  control:SetSelItemId(item.id)
  build.itemsTab:PopulateSlots()
  return nil
end

local methods = {}

function methods.ping()
  return { pong = true }
end

--- Build a character from scratch and calculate it.
-- params: className (class or ascendancy name), level, passives (node ids), skills (list of
-- socket-group texts, e.g. "Fireball 20/0  1\nFiery Death 1/0  1"), mainSkill (1-based),
-- items ({ raw, slot? }), config ({ enemyIsBoss, enemyLevel, resistancePenalty, ... }).
function methods.evaluate(p)
  local notes = {}
  newBuild()

  local hashes = {}
  for _, id in ipairs(p.passives or {}) do hashes[#hashes + 1] = tonumber(id) end
  -- "+5 to any Attribute" nodes: { [nodeId] = 1 (Strength) | 2 (Dexterity) | 3 (Intelligence) }.
  for id, choice in pairs(p.attributes or {}) do build.spec:SwitchAttributeNode(tonumber(id), tonumber(choice)) end
  local overrides = build.spec.hashOverrides or {}
  build.spec:ImportFromNodeList(p.className, nil, nil, nil, hashes, {}, overrides, {}, nil)
  local allocated = 0
  for _ in pairs(build.spec.allocNodes) do allocated = allocated + 1 end

  build.characterLevelAutoMode = false
  build.characterLevel = tonumber(p.level) or 90

  local config = p.config or {}
  local input = build.configTab.input
  for key, value in pairs(config) do
    if key ~= "questsUpToLevel" then input[key] = value end
  end
  -- PoB assumes every campaign quest reward by default; for a leveling checkpoint, only count
  -- rewards from quests at or below that level.
  if config.questsUpToLevel then
    for _, quest in ipairs(data.questRewards) do
      if quest.useConfig ~= false and quest.Stat then
        input["quest" .. quest.Description .. quest.Area .. quest.Info] = quest.AreaLevel <= config.questsUpToLevel
      end
    end
  end
  if config.enemyIsBoss ~= nil then
    local resist = BOSS_RESIST[config.enemyIsBoss] or 0
    input.enemyFireResist = config.enemyFireResist or resist
    input.enemyColdResist = config.enemyColdResist or resist
    input.enemyLightningResist = config.enemyLightningResist or resist
    input.enemyChaosResist = config.enemyChaosResist or 0
  end
  build.configTab:BuildModList()

  for _, item in ipairs(p.items or {}) do
    local raw = item.raw
    if not raw and item.unique then
      raw = uniqueText(item.unique)
      if not raw then notes[#notes + 1] = "Path of Building has no unique called '" .. item.unique .. "'" end
    end
    if raw then
      local err = equip(raw, item.slot)
      if err then notes[#notes + 1] = err end
    end
  end

  for _, text in ipairs(p.skills or {}) do build.skillsTab:PasteSocketGroup(text) end
  local groups = build.skillsTab.socketGroupList
  build.mainSocketGroup = math.max(1, math.min(tonumber(p.mainSkill) or 1, #groups))
  recalc()

  local skills = {}
  for i, group in ipairs(groups) do
    local gems = {}
    for _, gem in ipairs(group.gemList or {}) do
      gems[#gems + 1] = { name = gem.nameSpec, level = gem.level, found = gem.gemData ~= nil }
      if not gem.gemData then notes[#notes + 1] = "Path of Building doesn't know the gem '" .. tostring(gem.nameSpec) .. "'" end
    end
    skills[i] = { label = group.displayLabel, gems = gems }
  end

  local enemyLevel = math.max(1, math.min(tonumber(input.enemyLevel) or build.characterLevel, #data.monsterLifeTable))
  return {
    stats = collectStats(),
    -- Life of a normal monster at the enemy level (PoB's monster life table).
    enemyBaseLife = data.monsterLifeTable[enemyLevel],
    enemyLevel = enemyLevel,
    className = build.spec.curClassName,
    ascendancy = build.spec.curAscendClassName,
    level = build.characterLevel,
    allocatedPassives = allocated,
    skills = skills,
    notes = notes,
  }
end

local calls = 0
local function handle(line)
  local request, _, err = json.decode(line)
  if type(request) ~= "table" then
    send({ ok = false, error = "bad request: " .. tostring(err) })
    return
  end
  local method = methods[request.method]
  if not method then
    send({ id = request.id, ok = false, error = "unknown method " .. tostring(request.method) })
    return
  end
  local ok, result = pcall(method, request.params or {})
  if ok then
    send({ id = request.id, ok = true, result = result })
  else
    send({ id = request.id, ok = false, error = tostring(result) })
  end
  calls = calls + 1
  -- PoB builds up a lot of garbage between calculations.
  if calls % 5 == 0 then collectgarbage("collect") end
end

if MODE == "selftest" then
  local ok, result = pcall(methods.evaluate, {
    className = "Infernalist",
    level = 90,
    skills = { "Fireball 20/0  1\n" },
    config = { enemyIsBoss = "None", enemyLevel = 82 },
  })
  send({ selftest = true, ok = ok, startupSeconds = os.clock() - started, result = ok and result or tostring(result) })
  os.exit(ok and 0 or 1)
end

send({ ready = true, startupSeconds = os.clock() - started })
for line in io.stdin:lines() do
  if line:match("%S") then handle(line) end
end
