-- parse_skills.lua  <input.lua>  <output.json>
-- Loads any PoB2 Skills/*.lua file (act_*, sup_*, spectre, minion, other)
-- and dumps `skills` table as JSON.
--
-- These files expect: local skills, mod, flag, skill = ...
-- They also reference SkillType.X enum values.
-- We stub SkillType so SkillType.X returns the string "X".
-- We stub mod/flag/skill so calls are captured as {__call=name, args=...}.

local function escape_str(s)
    return (s:gsub('\\', '\\\\'):gsub('"', '\\"'):gsub('\n', '\\n'):gsub('\r', '\\r'):gsub('\t', '\\t'))
end

local function is_array(t)
    local n = 0
    for k in pairs(t) do
        if type(k) ~= "number" then return false end
        n = n + 1
    end
    if n == 0 then return false end
    for i = 1, n do
        if t[i] == nil then return false end
    end
    return true
end

-- Limit depth to avoid runaway recursion on circular refs
local function to_json(v, depth, seen)
    depth = depth or 0
    seen = seen or {}
    if depth > 40 then return '"<depth-limit>"' end
    local tv = type(v)
    if tv == "nil" then return "null"
    elseif tv == "boolean" then return v and "true" or "false"
    elseif tv == "number" then
        if v ~= v then return "null"
        elseif v == math.huge or v == -math.huge then return "null"
        elseif v == math.floor(v) and math.abs(v) < 1e15 then return tostring(math.floor(v))
        else return string.format("%.10g", v) end
    elseif tv == "string" then return '"' .. escape_str(v) .. '"'
    elseif tv == "function" then return '"<function>"'
    elseif tv == "table" then
        if seen[v] then return '"<cycle>"' end
        seen[v] = true
        local result
        if is_array(v) then
            local parts = {}
            for i = 1, #v do parts[i] = to_json(v[i], depth+1, seen) end
            result = "[" .. table.concat(parts, ",") .. "]"
        else
            local parts = {}
            local keys = {}
            for k in pairs(v) do keys[#keys+1] = k end
            table.sort(keys, function(a,b) return tostring(a) < tostring(b) end)
            for _, k in ipairs(keys) do
                local kstr
                if type(k) == "number" then
                    kstr = '"' .. tostring(k) .. '"'
                elseif type(k) == "boolean" then
                    kstr = '"' .. tostring(k) .. '"'
                else
                    kstr = '"' .. escape_str(tostring(k)) .. '"'
                end
                parts[#parts+1] = kstr .. ":" .. to_json(v[k], depth+1, seen)
            end
            result = "{" .. table.concat(parts, ",") .. "}"
        end
        seen[v] = nil
        return result
    else
        return '"<' .. tv .. '>"'
    end
end

-- Enum-like stubs: any field access returns the field name as a string.
-- These globals are referenced inside the data files but not defined there.
local enum_mt = { __index = function(_, k) return k end }
SkillType = setmetatable({}, enum_mt)
KeywordFlag = setmetatable({}, enum_mt)
ModFlag = setmetatable({}, enum_mt)

-- Builder/modifier function stubs that capture their args
local function make_capture(name)
    return function(...)
        local args = {...}
        return { __call = name, args = args }
    end
end

local skills = {}
local mod = make_capture("mod")
local flag = make_capture("flag")
local skill = make_capture("skill")

local input_path = arg[1]
if not input_path then
    io.stderr:write("usage: parse_skills.lua <input.lua> [output.json]\n")
    os.exit(2)
end

local chunk, err = loadfile(input_path)
if not chunk then
    io.stderr:write("loadfile failed: " .. tostring(err) .. "\n")
    os.exit(1)
end

local ok, run_err = pcall(chunk, skills, mod, flag, skill)
if not ok then
    io.stderr:write("execution failed: " .. tostring(run_err) .. "\n")
    os.exit(1)
end

local out_path = arg[2]
local json_str = to_json(skills)
if out_path then
    local f, oerr = io.open(out_path, "w")
    if not f then io.stderr:write("cannot open output: " .. tostring(oerr) .. "\n"); os.exit(1) end
    f:write(json_str)
    f:close()
else
    io.write(json_str)
end
io.stderr:write(string.format("Parsed %d skills from %s\n", (function() local n=0 for _ in pairs(skills) do n=n+1 end return n end)(), input_path))
