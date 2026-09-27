-- Runs Path of Building PoE2 headless and prints calculated stats as JSON on stdout.
-- Run from <pob>/src:  luajit <path>/host.lua selftest
-- Everything PoB prints goes to stderr so stdout carries only our JSON.

package.path = "../runtime/lua/?.lua;../runtime/lua/?/init.lua;" .. package.path

local OUT = io.stdout
_G.print = function(...)
  local parts = {}
  for i = 1, select("#", ...) do parts[i] = tostring((select(i, ...))) end
  io.stderr:write(table.concat(parts, "\t"), "\n")
end

-- HeadlessWrapper waits for a key press if startup fails; don't let it block.
local realRead = io.read
io.read = function() return nil end
local started = os.clock()
dofile("HeadlessWrapper.lua")
io.read = realRead
assert(build, "Path of Building failed to start")
local startupSeconds = os.clock() - started

local json = require("dkjson")

local function recalc()
  build.buildFlag = true
  build.modFlag = true
  runCallback("OnFrame")
end

local STAT_KEYS = {
  "TotalDPS", "CombinedDPS", "FullDPS", "Life", "EnergyShield", "Mana", "Spirit",
  "FireResist", "ColdResist", "LightningResist", "ChaosResist", "TotalEHP", "Armour", "Evasion",
}

local function stats()
  local out, result = build.calcsTab.mainOutput, {}
  for _, key in ipairs(STAT_KEYS) do result[key] = out[key] end
  return result
end

local function selectClass(className, ascendancyName)
  local spec = build.spec
  spec:SelectClass(spec.tree.classNameMap[className])
  if ascendancyName then
    local classData = spec.tree.classes[spec.curClassId]
    for id, asc in pairs(classData.classes) do
      if asc.name == ascendancyName then spec:SelectAscendClass(id) end
    end
  end
end

local mode = arg and arg[1] or "selftest"
local report = { mode = mode, startupSeconds = startupSeconds, steps = {} }
local function step(name, fn)
  local ok, err = pcall(fn)
  report.steps[#report.steps + 1] = { step = name, ok = ok, error = ok and nil or tostring(err) }
  return ok
end

if mode == "selftest" then
  -- A fresh level 90 Infernalist with Fireball, no items: proves the engine loads and calculates.
  step("newBuild", function() newBuild() end)
  step("selectClass", function() selectClass("Witch", "Infernalist") end)
  step("setLevel", function()
    build.characterLevelAutoMode = false
    build.characterLevel = 90
  end)
  step("pasteSkill", function() build.skillsTab:PasteSocketGroup("Fireball 20/0  1\n") end)
  step("mainSkill", function() build.mainSocketGroup = 1 end)
  step("recalc", recalc)
  step("stats", function() report.stats = stats() end)
  step("exportXml", function() report.xmlBytes = #build:SaveDB("code") end)
end

OUT:write(json.encode(report), "\n")
OUT:flush()
