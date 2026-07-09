-- Convert PoB2's TreeData/<patch>/tree.lua into tree.json for the
-- Python extractors. PoB2 ships only tree.lua in fresh patch dirs (e.g.
-- 0_5 as of 2026-05-29); the JSON form gets produced ad-hoc when
-- somebody needs it. We don't want to wait on upstream to commit a JSON
-- before we can extract — this script does the conversion locally.
--
-- Usage:
--   lua5.4 scripts/lua_tree_to_json.lua <patch>     # e.g. 0_5
--
-- Why a handwritten encoder instead of dkjson: the dkjson shipped in
-- data/pob2/runtime/lua/dkjson.lua (v2.5) sets `local _ENV = nil` to
-- forbid global access in Lua 5.2+, but doesn't import `table.sort`
-- as a local — so sortedkeys() blows up under Lua 5.4 with "attempt to
-- index a nil value (upvalue '_ENV')". Rather than patch a third-party
-- file (or pull in an extra dep), we encode by hand. The tree data is
-- only primitives + nested tables, so the encoder stays small.

local patch = arg[1] or '0_5'
local lua_file = 'data/pob2/src/TreeData/' .. patch .. '/tree.lua'
local json_file = 'data/pob2/src/TreeData/' .. patch .. '/tree.json'

local chunk = assert(loadfile(lua_file), 'cannot open ' .. lua_file)
local tree = chunk()

-- A table is an "array" iff every key is an integer in 1..n with no
-- gaps. Otherwise it's an object. Matches dkjson's default behaviour;
-- empty tables encode as objects ({}) so PoB2 fields like `assets={}`
-- don't turn into arrays.
local function is_array(t)
  local n = 0
  for k in pairs(t) do
    if type(k) ~= 'number' then return false end
    n = n + 1
  end
  if n == 0 then return false end
  for i = 1, n do
    if t[i] == nil then return false end
  end
  return true
end

local esc_map = {
  ['"'] = '\\"', ['\\'] = '\\\\',
  ['\b'] = '\\b', ['\f'] = '\\f', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t',
}
local function esc_str(s)
  return (s:gsub('[%z\1-\31"\\]', function(c)
    return esc_map[c] or string.format('\\u%04x', c:byte())
  end))
end

local enc
enc = function(v)
  local tv = type(v)
  if tv == 'nil' then return 'null' end
  if tv == 'boolean' then return v and 'true' or 'false' end
  if tv == 'number' then
    if v ~= v or v == math.huge or v == -math.huge then return 'null' end
    if v == math.floor(v) and math.abs(v) < 1e16 then
      return string.format('%d', v)
    end
    return string.format('%.17g', v)
  end
  if tv == 'string' then return '"' .. esc_str(v) .. '"' end
  if tv == 'table' then
    if is_array(v) then
      local parts = {}
      for i = 1, #v do parts[i] = enc(v[i]) end
      return '[' .. table.concat(parts, ',') .. ']'
    end
    -- Stable key order so re-conversions produce byte-identical output
    -- (manifests pick up real content changes, not key reorderings).
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = k end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    local parts = {}
    for _, k in ipairs(keys) do
      parts[#parts + 1] = '"' .. esc_str(tostring(k)) .. '":' .. enc(v[k])
    end
    return '{' .. table.concat(parts, ',') .. '}'
  end
  error('cannot encode type: ' .. tv)
end

local out = assert(io.open(json_file, 'w'), 'cannot write ' .. json_file)
out:write(enc(tree))
out:close()
local sz = io.open(json_file):seek('end')
io.stderr:write(string.format('wrote %s (%d bytes)\n', json_file, sz))
