-- parse_gems.lua  <input.lua>  <output.json>
--
-- PoB2's Data/Gems.lua is a single `return { ... }` table keyed by
-- "Metadata/Items/Gems/SkillGem<Name>" id. Unlike Skills/*.lua it
-- doesn't expect any context globals; we just dofile() it.

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

local function to_json(v, depth)
    depth = depth or 0
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
    elseif tv == "table" then
        if is_array(v) then
            local parts = {}
            for i = 1, #v do parts[i] = to_json(v[i], depth+1) end
            return "[" .. table.concat(parts, ",") .. "]"
        else
            local parts, keys = {}, {}
            for k in pairs(v) do keys[#keys+1] = k end
            table.sort(keys, function(a,b) return tostring(a) < tostring(b) end)
            for _, k in ipairs(keys) do
                local kstr
                if type(k) == "number" then kstr = '"' .. tostring(k) .. '"'
                elseif type(k) == "boolean" then kstr = '"' .. tostring(k) .. '"'
                else kstr = '"' .. escape_str(tostring(k)) .. '"' end
                parts[#parts+1] = kstr .. ":" .. to_json(v[k], depth+1)
            end
            return "{" .. table.concat(parts, ",") .. "}"
        end
    else
        return '"<' .. tv .. '>"'
    end
end

local input_path = arg[1]
local out_path   = arg[2]
if not input_path then
    io.stderr:write("usage: parse_gems.lua <input.lua> [output.json]\n")
    os.exit(2)
end

local chunk, err = loadfile(input_path)
if not chunk then
    io.stderr:write("loadfile failed: " .. tostring(err) .. "\n")
    os.exit(1)
end

local ok, gems = pcall(chunk)
if not ok then
    io.stderr:write("execution failed: " .. tostring(gems) .. "\n")
    os.exit(1)
end

local json_str = to_json(gems)
if out_path then
    local f, oerr = io.open(out_path, "w")
    if not f then io.stderr:write("cannot open output: " .. tostring(oerr) .. "\n"); os.exit(1) end
    f:write(json_str); f:close()
else
    io.write(json_str)
end

local count = 0
for _ in pairs(gems) do count = count + 1 end
io.stderr:write(string.format("Parsed %d gems from %s\n", count, input_path))
