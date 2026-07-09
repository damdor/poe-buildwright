-- parse_uniques.lua  <input.lua>  <output.json>
--
-- PoB2's Data/Uniques/*.lua is `return { [[text]], [[text]], ... }`
-- where each block is one unique in PoB's custom text format
-- (name, base, variants, stat lines with {variant:N} prefixes).
-- We dofile() and dump the array of strings as JSON; the Python
-- side parses the text format into structured rows.

local function escape_str(s)
    return (s:gsub('\\', '\\\\'):gsub('"', '\\"'):gsub('\n', '\\n'):gsub('\r', '\\r'):gsub('\t', '\\t'))
end

local function to_json(v)
    local tv = type(v)
    if tv == "string" then return '"' .. escape_str(v) .. '"'
    elseif tv == "table" then
        local parts = {}
        for i = 1, #v do parts[i] = to_json(v[i]) end
        return "[" .. table.concat(parts, ",") .. "]"
    else
        return 'null'
    end
end

local input_path = arg[1]
local out_path   = arg[2]
if not input_path then
    io.stderr:write("usage: parse_uniques.lua <input.lua> [output.json]\n")
    os.exit(2)
end
local chunk, err = loadfile(input_path)
if not chunk then io.stderr:write("loadfile failed: " .. tostring(err) .. "\n"); os.exit(1) end
local ok, uniques = pcall(chunk)
if not ok then io.stderr:write("execution failed: " .. tostring(uniques) .. "\n"); os.exit(1) end

local json_str = to_json(uniques)
if out_path then
    local f, oerr = io.open(out_path, "w")
    if not f then io.stderr:write("cannot open output: " .. tostring(oerr) .. "\n"); os.exit(1) end
    f:write(json_str); f:close()
else
    io.write(json_str)
end
io.stderr:write(string.format("Parsed %d uniques from %s\n", #uniques, input_path))
