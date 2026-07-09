# Native data miner

Goal: extract everything we need (tree, skills, items, art, ascendancy
metadata) directly from a local PoE2 install, write outputs into
`data/parsed/<patch>/` in the same TSV/JSON shape our extractors
already use. Be PoB-independent.

Background and the decision to go this way is in
[diary/2026-05-30-pob-launch-day-and-first-party-decision.md](diary/2026-05-30-pob-launch-day-and-first-party-decision.md).

This doc is the design + reference. **No code yet** — that's the
Bazzite-side build, since we need the game files to develop against.

## What the miner needs to produce

The miner **replaced** every script that was under `scripts/extract_*.py`
with the `data_miner` crate + `buildwright` shapers (done in the 2026-07
cleanup). The output directory structure stays the same so the rest of
the pipeline (manifest builder, wizard catalogue
emitter, planner build) doesn't have to change:

```
data/parsed/<patch>/
├── manifest.json          # patch + source + sha256s; build_manifests.py-compatible
├── .source                # "first-party" (vs "pob2-stable" / "pob2-dev")
├── tree/
│   ├── nodes.tsv          # id, x, y, kind, klass, ascendancy, name, stats,
│   │                      # group, orbit, orbit_index, icon, node_overlay,
│   │                      # active_effect, node_options, connection_art,
│   │                      # unlock_constraint
│   ├── edges.tsv          # a_id, b_id, [arc params or line params]
│   ├── meta.tsv           # classes + ascendancies registry
│   ├── sprites.tsv        # url → file mapping
│   └── manifest.json
├── skills/
│   ├── gems.tsv           # gem id, display name, base, tags, …
│   ├── active_skills.tsv  # active_skill internal id, level/quality scaling
│   ├── support_skills.tsv # support gem entries
│   ├── buffs.tsv          # visible buff name + tooltip text (granted-buff tips)
│   ├── skill_levels.tsv   # per-level base stats
│   ├── icons.tsv          # hotbar / action icon mapping
│   ├── gem_icons.tsv      # gem-as-item icon mapping
│   └── manifest.json
└── items/
    ├── bases.tsv          # base type id, slot, requirements
    ├── uniques.tsv        # unique → base + latest-variant stats (pob-pinned)
    ├── uniques_variants.tsv  # per-variant stat rolls
    ├── uniques.pob.json   # provenance: pinned PoB commit + source files
    ├── icons.tsv          # unique-item icon mapping
    └── manifest.json
```

Match the column order in the existing `.tsv` files in
`data/parsed/0_5_native/` exactly so downstream code (`buildwright
manifest`, `buildwright catalogues`, `tree_render`) doesn't need to
learn a new schema.

Sprites also need to land in `viewer/assets/sprites/` (PNG, possibly
.webp for the new class backgrounds — esbuild + browsers handle both).

## Where the game files live

**Primary source: GGG's public patch CDN — no install needed.**
Verified live 2026-07-02 and implemented in
`crates/data_miner/src/fetch.rs` + the `cdn` CLI:

1. Plain TCP to `patch.pathofexile2.com:13060`, send `[0x01, 0x06]`.
   Response (~200 B): opcode `0x02`, 33 skip bytes, u8 length,
   UTF-16LE CDN base URL — e.g.
   `https://patch-poe2.poecdn.com/4.5.4.1.3/`. The patch version is
   the URL's last segment (5-part dotted; no separate field).
2. Files at `<base><game-relative-path>`:
   `<base>Bundles2/_.index.bin` (~109 MiB), then individual
   `Bundles2/<name>.bundle.bin` as the index directs. HTTPS, no auth,
   `Accept-Ranges: bytes` (206 works for partial-bundle fetches).
3. **Only the current version is served** — old version paths 404 the
   moment a patch ships. 404 mid-run ⇒ redo the handshake.

This is how the community tooling works too (SnosMe's
`pathofexile-dat` `toCdnUrl()`: version prefix `4.` ⇒ the poe2 CDN
host; LibGGPK3 `PatchClient.cs` has the same endpoints/protocol).
Fallback version check: `https://poe-versions.obsoleet.org` returns
`{"poe": ..., "poe2": ...}` (third-party). Steam buildid via
`https://api.steamcmd.net/v1/info/2694490` is a good
"did-it-update?" signal but doesn't map to the CDN version string.

**Version naming:** the CDN/internal version (`4.5.4.1.3`) is not the
marketing version (`0.5.4`). Roughly `4.<major>.<minor>…` ↔
`0.<major>.<minor>`, but record both in provenance manifests rather
than deriving one from the other.

Live stats for `4.5.4.1.3`: 61,605 bundles, 4,201,992 files; index
decompresses to 147 MB; full fetch+parse+path-resolution ≈ 3 s warm.

**Secondary source: a local install** (the original plan — still
supported for offline work):

```
Linux/Bazzite (via Proton/Steam):
  ~/.local/share/Steam/steamapps/common/Path of Exile 2/
  └── Bundles2/              # everything — see below
  └── PathOfExile_x64Steam.exe   # game binary (Oodle is statically linked)

Windows (for reference):
  C:\Program Files (x86)\Grinding Gear Games\Path of Exile 2\
```

The standalone client (non-Steam) puts everything in
`~/.local/share/PathOfExile2/` on Linux.

## No .ggpk — bundle-only since PoE2 launch

The 0.5 / Early Access PoE2 install **does not contain Content.ggpk**.
GGG completed the bundle migration before public launch; every game
asset is under `Bundles2/`. The historical .ggpk wrapper is gone.

```
Bundles2/
├── _.index.bin          # master index (109 MiB)
├── _.index.high.bin     # ?  (smaller; possibly hash-only)
├── _.index.low.bin      # ?
├── Shared.bundle.bin    # core shared data (1.4 MiB)
├── Tiny.V0..VB.bundle.bin + .V0.1..VB.1.bundle.bin  # major content shards
├── Content/{art,data,metadata}/...  # per-asset streaming bundles
├── Folders/00..FF/...               # hash-bucketed streaming bundles
└── Streaming/...                    # mirror layout for streaming-loaded assets
```

A survey of the full install (via `cargo run -p data_miner --bin survey
-- <install>`) found:

- **60,051 bundle files**, 127 GiB on disk, 250 GiB uncompressed
- Per-bundle header parses cleanly across the whole tree (zero errors)
- Compressors in use: **Hydra 54.6%**, Leviathan 34.7%, Mermaid 9.5%,
  Kraken 1.2%

All four are proprietary Oodle variants. There is no LZ4 escape hatch;
every byte we want to read goes through an Oodle decoder.

## Bundle file format (confirmed)

Reverse-engineered by LibGGPK2; our `bundle::read_header` parses the
following on real files with zero errors across all 60k bundles:

```
offset  size  field
0x00    u32   uncompressed_size_low      // duplicated as u64 at 0x14
0x04    u32   total_payload_size_low     // duplicated as u64 at 0x1c
0x08    u32   head_payload_size          // bytes after 0x0c, i.e. 48 + 4*block_count
0x0c    u32   first_file_encode          // 8=Kraken 9=Mermaid 12=Hydra 13=Leviathan
0x10    u32   unk10
0x14    u64   uncompressed_size
0x1c    u64   total_payload_size         // sum of block_sizes
0x24    u32   block_count
0x28    u32   uncompressed_block_granularity  // always 0x40000 (256 KiB) in 0.5
0x2c    u32[4] reserved_zeros
0x3c    u32[block_count]  block_sizes
...     bytes[total_payload_size]  blocks_payload
```

Every block except the last decompresses to exactly `granularity`
bytes; the last decompresses to whatever remainder makes the total
match `uncompressed_size`.

## Oodle decompression — RESOLVED (2026-07-02)

GGG **does not ship `oo2core_*.dll`** in PoE2's install. Oodle is
statically linked into `PathOfExile_x64Steam.exe`. We cannot
`libloading::Library::new("oo2core_*.dll")` against the user's install
the way PoE1 tools did.

**Decision: vendored `zao/ooz` in `crates/ooz_sys/`.** The
community-maintained fork (Linux/CMake + simde portability; commit
pinned in `crates/ooz_sys/VENDOR.md`), compiled decode-only via
`-DOOZ_BUILD_DLL=1` with the `cc` crate. Its `Ooz_Decompress` entry
point self-dispatches between Kraken/Mermaid/Hydra/Leviathan, so one
FFI call covers every 0.5 bundle. Validated: Kraken, Mermaid, and
Leviathan decode the ooz test corpus to byte-identical output.

**License correction:** earlier drafts of this doc called ooz
"public domain" — it is **GPL-3.0-or-later** (and two files are
formally unlicensed). The sources are therefore not committed to the
repo at all: `ooz_sys`'s build.rs fetches them from zao/ooz at a
pinned, SHA-256-verified commit, so each user obtains them directly
from upstream and neither sources nor binaries are ever distributed
by us. Details in `crates/ooz_sys/VENDOR.md`.

The hand-written pure-Rust port (BitReader + per-compressor stubs)
stays in-tree behind the off-by-default `oodle-port` feature of
`data_miner`. It graduates by passing differential tests against ooz
on real bundles; until then dispatch always goes through `ooz_sys`.
If it ever completes, `ooz_sys` (and the GPL constraint) can be
dropped.

## Existing reference implementations

Read these before writing — they've all hit the same edge cases:

- **LibGGPK2** (.NET, MIT): <https://github.com/aianlinb/LibGGPK2>
  Full ggpk + bundle reader, mature, well-maintained for PoE1+PoE2.
- **PathOfBuildingCommunity ScriptedExporter** (Lua, PoB1+2):
  <https://github.com/PathOfBuildingCommunity/PathOfBuilding-PoE2>
  See `src/Export/` for the data extraction logic — what tables to
  read, what fields to grab. This is the reference for **what** to
  extract, even though we're not using their **how**.
- **dat-schema** (TypeScript): <https://github.com/poe-tool-dev/dat-schema>
  Community-maintained schema for the `.dat` tables inside the
  bundles. PoB uses this. Read this to know what columns are in each
  table (e.g., `PassiveSkills.dat` has `Id`, `Name`,
  `AscendancyKey`, …).

## What tables matter for us

For the passive tree:

- `PassiveSkills.dat` — node id, name, stats, icon, ascendancy
- `PassiveTrees.dat` — root tree definitions per character class
- `PassiveTreeExpansionJewels.dat` — jewel sockets
- `PassiveTreeExpansionSpecialSkills.dat` — mastery effects
- `AscendancyPassiveTrees.dat` — ascendancy roots

For skills:

- `BaseItemTypes.dat` — gem base info (BaseItemTypes filtered to gems)
- `Gems.dat` / `SkillGems.dat` — gem-specific data
- `GrantedEffects.dat` — what the gem grants (active or support)
- `GrantedEffectsPerLevel.dat` — per-level scaling
- `GrantedEffectStatSets.dat` — stat sets per level

For items:

- `BaseItemTypes.dat` — every item base
- `UniqueStashLayout.dat` + `Words.dat` — unique names
- `ItemVisualIdentity.dat` — icon mapping (DDS path)
- `Mods.dat` + `ModType.dat` + `StatDescriptions.dat` — mod text

For art:

- DDS files under `Art/2DArt/Skills/`, `Art/2DArt/SkillIcons/`,
  `Art/2DItems/`, `Art/UIImages/InGame/PassiveTree/`,
  `Art/2DArt/UIImages/InGame/PassiveMastery/`
- These need DDS → PNG/webp conversion (DXT1/3/5 / BC1/3/7 family).
  Rust crate: `image-dds` or `intel_tex_2`; or shell out to
  `texconv` / `magick`.

## Suggested crate layout

```
crates/
├── ooz_sys/                       # NEW — Oodle decompressor (option 1 above)
│   ├── Cargo.toml                 #   per-crate lint override to allow unsafe
│   ├── build.rs                   #   cc-builds vendored ooz.c
│   ├── src/lib.rs                 #   safe Rust wrapper around extern "C"
│   └── vendor/                    #   powzix/ooz public-domain sources
├── data_miner/
│   ├── Cargo.toml
│   ├── src/
│   │   ├── lib.rs                 # public API: extract_patch(install_dir, out_dir)
│   │   ├── bundle.rs              # bundle header parser (DONE)
│   │   ├── bundle_decode.rs       # block-level decompression via ooz_sys
│   │   ├── index.rs               # Bundles2/_.index.bin → path map
│   │   ├── dat/
│   │   │   ├── mod.rs
│   │   │   ├── schema.rs          # dat-schema JSON loader
│   │   │   └── table.rs           # generic .dat row reader
│   │   ├── tree.rs                # PassiveSkills + edges + groups → tree/*.tsv
│   │   ├── skills.rs              # Gems + GrantedEffects → skills/*.tsv
│   │   ├── items.rs               # BaseItemTypes + Uniques → items/*.tsv
│   │   ├── art.rs                 # DDS → PNG/webp conversion
│   │   └── provenance.rs          # patch detection, manifest emission
│   └── bin/
│       ├── mine.rs                # CLI: data_miner --install <path> --out <patch_dir>
│       └── survey.rs              # bundle header survey (DONE)
```

Wire into the workspace:

```toml
# Cargo.toml (workspace)
members = ["crates/serve", "crates/tree_render", "crates/data_miner"]
```

CLI:

```bash
cargo run --release -p data_miner -- \
  --install ~/.local/share/Steam/steamapps/common/'Path of Exile 2' \
  --patch 0_5 \
  --out data/parsed/0_5
```

## Provenance + the `.source` marker

Output manifest should record:

```json
{
  "patch": "0.5",
  "source": "first-party",
  "game_install_path": "...",
  "ggpk_sha256": "...",
  "ggpk_size_bytes": ...,
  "extracted_at": "...",
  "miner_version": "0.1.0"
}
```

`data/parsed/<patch>/.source` writes `first-party` (vs the current
`pob2-stable` / `pob2-dev`). The wizard's existing patch badge already
distinguishes "preview" — extend the rule to flag `first-party` as
**authoritative** in the UI.

## Current state of the crate (2026-07-02)

| Layer            | Status   | Code                                                  |
| ---------------- | -------- | ----------------------------------------------------- |
| Header parsing   | DONE     | `crates/data_miner/src/bundle.rs`                     |
| Block dispatch   | DONE     | `crates/data_miner/src/bundle_decode.rs`              |
| Oodle decode     | DONE     | `crates/ooz_sys/` (vendored ooz; all four families)   |
| pure-Rust port   | optional | `crates/data_miner/src/oodle/*` behind `oodle-port`   |
| CDN fetch        | DONE     | `fetch.rs` + `bin/cdn.rs`; validated on live CDN      |
| `_.index.bin`    | DONE     | `index.rs`; 4,201,987/4,201,992 paths resolved live   |
| `.datc64` reader | DONE     | `dat.rs`; validated on real mastery tables (81 grps)  |
| dat-schema load  | DONE     | `dat_schema.rs`; JSON → TableSchema, validated live   |
| mine (flat TSV)  | DONE     | `mine.rs`; array-expand + foreignrow→Id resolution    |
| shape (joins)    | DONE     | `shape.rs`; bases/gems/active/support/mods (see below)|
| skills           | DONE     | `shape active_skills` + `shape support_skills`        |
| tree layout      | deferred | no geometry in `.datc64`; PoB-derived (see below)     |
| art (DDS → WebP) | pending  | DDS decode + atlas slicing                            |

Note PoE2 0.5 table paths: `data/balance/passiveskills.datc64` (not
`Data/PassiveSkills.dat`); localized copies live in sibling dirs
(`data/balance/traditional chinese/…`). Stat descriptions:
`data/statdescriptions/*.csd` (UTF-16). Use
`cargo run --release -p data_miner --bin cdn -- find <substr>` to
locate tables.

## Shapers — the join layer (`buildwright shape <dataset>`)

Where `mine` dumps one flat TSV per GGG table (self-describing but raw),
a **shaper** joins several tables into one of the datasets the site
consumes, writing to `data/parsed/<patch>_native/`. Each shaper is a
single linear scan of a primary table plus O(1) joins (forward
`foreignrow` = direct row index; reverse = a `HashMap` built in one
pass). Code: `crates/data_miner/src/shape.rs`.

| Dataset          | Output                      | Join (primary ⋈ …)                                             |
| ---------------- | --------------------------- | -------------------------------------------------------------- |
| `bases`          | `items/bases.tsv`           | `BaseItemTypes` ⋈ Armour/Weapon/Attribute-req/Flask/Shield     |
| `gems`           | `skills/gems.tsv`           | `SkillGems` ⋈ `BaseItemTypes` (base/tags/reqs)                 |
| `active_skills`  | `skills/active_skills.tsv`  | `ActiveSkills` ⋈ `GrantedEffects` (cast time)                  |
| `support_skills` | `skills/support_skills.tsv` | `GrantedEffects`(support) ⋈ gem item (name) + `SupportText`    |
| `buffs`          | `skills/buffs.tsv`          | `BuffDefinitions`: visible buffs' name + tooltip text          |
| `mods`           | `items/mods.tsv`            | `Mods` ⋈ `Stats`/`Tags`: ranges, spawn-weight tags, tiers      |
| `skill_levels`   | `skills/skill_levels.tsv`   | `GrantedEffectsPerLevel` ⋈ stat sets: per-level cost/cd/crit   |
| `soul_cores`     | `items/soul_cores.tsv`      | `SoulCoreStats` ⋈ `SoulCores`: runes/cores/idols + socket stats|
| `gem_quality`    | `skills/gem_quality.tsv`    | `GrantedEffectQualityStats`: a skill's quality bonus at 20 %   |
| `tree`           | `tree/{nodes,edges,meta}`   | `passiveskillgraph.psg` (geometry+topology) ⋈ `PassiveSkills` |
| (`masteries`)    | `tree/masteries.tsv`        | derived from our `tree/edges.tsv` (mastery-lighting clusters)  |

**Schema-drift tolerance.** The community dat-schema lags the live game;
a game patch that appends a column leaves the schema's row width a few
bytes short, and the strict `.datc64` reader rejects the file (this is
what hid `SoulCores`). `dat::autofit` reconciles it: on a parse failure
it finds the real `0xBB` boundary, and if the file is a little *wider*
than the schema (trailing growth), appends unnamed padding so earlier
columns still read correctly. `shape` runs every loaded table through it
and logs `schema drift +NB — auto-fit`.

Notes that cost real investigation:

- **support names have no direct column.** A support `GrantedEffects`
  row has no `ActiveSkill`, and the name fields *on* `GemEffects`
  (`SupportName`/`Name`) are unused in 0.5 (2 rows populated). The name
  lives on the gem **item**: walk every `SkillGems.GemEffects[]` to the
  `GemEffects.GrantedEffect` it points at, and take the gem's
  `BaseItemTypes.Name`. Reminder text *is* on `GemEffects.SupportText`
  (631 rows). Covers 632/680 supports; the rest are internal/monster
  supports with no player gem (correctly nameless).
- **mod tiers are derived, not stored.** GGG has no tier column. `mods`
  ranks each mod within its `ModType` affix ladder by required `Level`
  (highest level = tier 1, ties share a tier). The authoritative fields
  (`required_level`, `mod_type`, `spawn_weights`, stat ranges) are all
  emitted too, so the site can compute its own tiering if it wants a
  per-item-applicability model instead.
- **`SpawnWeight_Tags`/`_Values`** are the "what can roll it" pairs —
  item tag → weight (weight 0, usually the trailing `default`, = cannot
  roll). This is the gate the site needs for craftable-mod lookups.

### Complete dataset map

Every dataset the site consumes, and how it's sourced first-party:

| Dataset                      | Status        | Source                                            |
| ---------------------------- | ------------- | ------------------------------------------------- |
| `items/bases.tsv`            | ✅ `shape`     | `BaseItemTypes` ⋈ stat/req tables                 |
| `items/mods.tsv`             | ✅ `shape`     | `Mods` ⋈ `Stats`/`Tags` (native-only bonus)       |
| `skills/gems.tsv`            | ✅ `shape`     | `SkillGems` ⋈ `BaseItemTypes`                     |
| `skills/active_skills.tsv`   | ✅ `shape`     | `ActiveSkills` ⋈ `GrantedEffects`                 |
| `skills/support_skills.tsv`  | ✅ `shape`     | `GrantedEffects` ⋈ gem items                      |
| `skills/buffs.tsv`           | ✅ `shape`     | `BuffDefinitions` (granted-buff/aura tooltips)    |
| `skills/skill_levels.tsv`    | ✅ `shape`     | `GrantedEffectsPerLevel` ⋈ stat sets              |
| `tree/nodes.tsv`             | ✅ `shape`     | `.psg` ⋈ `PassiveSkills` + `.csd`                 |
| `tree/edges.tsv`             | ✅ `shape`     | `.psg` connections                                |
| `tree/meta.tsv`              | ✅ `shape`     | `.psg` groups + `Characters`/`Ascendancy`         |
| `tree/masteries.tsv`         | ✅ `masteries` | derived from our `tree/edges.tsv`                 |
| `tree/sprites.tsv` icons+patterns | ✅ `sprites` | node icons (BC1) + mastery patterns (BC7)         |
| node frames (keystone/…/asc) | ✅ `sprites`   | `passiveskillscreen*frame*` (BC7), renderer keys  |
| orbit connectors             | ✅ `sprites`   | synthesised from the line texture (`arc.rs`)      |
| class backdrops / portraits  | ✅ `sprites`   | `classes/<attr>/…startnodebackground.dds` (BC7)   |
| `items/uniques.tsv`          | 🔶 `uniques`   | PoB-pinned mod-id **list** ⋈ our `mods.tsv` + `.csd` |
| `items/uniques_variants.tsv` | 🔶 `uniques`   | same                                              |
| `items/uniques.pob.json`     | 🔶 `uniques`   | provenance: pinned PoB commit + files + counts    |

Everything table-derivable is first-party. Uniques are the one dataset
GGG ships no source for; `buildwright uniques` still resolves the stat
text/ranges first-party and pins PoB to a single mod-id list (§ Uniques).

### Art pipeline — `buildwright sprites` (node icons done; portraits pending)

Passive-tree node icons ship as **individual** `.dds` files
(`art/2dart/skillicons/…`), all DX10 **BC1_UNORM**. `buildwright sprites`
walks `tree/nodes.tsv`, fetches each icon's `.dds`, decodes it, and
re-encodes as PNG into `viewer/assets/sprites/`, writing `tree/sprites.tsv`
(icon → png + width/height). Zero external libraries:

- [`crate::dds`] — DDS reader + **every block format GGG uses**:
  BC1/BC3/BC4/BC5 and a full **BC7** decoder (all 8 modes, 2/3-subset
  partitions, p-bits, rotation, dual index planes). BC1 verified
  byte-exact against an independent decode; BC7 verified on the live
  mastery patterns (correct alpha gradient).
- [`crate::png`] — RGBA8 → PNG using *stored* DEFLATE blocks (no
  compressor), CRC32 + Adler32 by hand.

`sprites` decodes both the node **icons** (col `icon`, BC1) and the
mastery **radial patterns** (col `active_effect`, BC7), trying both
bundle roots (`art/2dart/…` for SkillIcons, `art/textures/interface/2d/…`
for UIImages). On 0.5: **638/638 sprites decode** — every `nodes.tsv`
icon + `active_effect` resolves. (One icon lives in a bundle whose name
has a space — `vaal skill icons` — so the fetch URL percent-encodes it.)
The PNGs are gitignored generated assets; `tree/sprites.tsv` is hashed
into the manifest.

**Frames are first-party too.** `ui_sprite_map` (in the `sprites` handler)
maps the renderer's frame keys — `KeystoneFrame*`, `NotableFrame*`,
`PSSkillFrame*`, `JewelFrame*`, `<Asc>FrameLarge/Small*` — to their GGG
sources `passiveskillscreen<type>frame<state>.dds` (state: `active` =
allocated, `canallocate`, `normal` = unallocated; all BC7). We emit the
PNG under the renderer's key, so **no renderer change** is needed — zero
regression risk. Ascendancy nodes reuse the generic notable/small frame
(GGG ships a bespoke one for only a couple of ascendancies; it's the same
ornate ring in-game). Total: **787 sprites** — every icon, mastery
pattern, and frame the live tree references.

**Connectors are first-party too — synthesised.** The game bundles ship
only the *straight* connector line texture
(`passiveskillscreenline<state>` — a horizontal band with a soft glow
cross-section). The renderer samples per-orbit **arc** sprites whose
curvature is baked into the PNG alpha (the WebGL kite-quad maps the
texture onto a corner and the alpha carves the arc — see
`04c_edge_tessellate.ts`). GGG doesn't ship those arcs, so
[`crate::arc`] generates them: it extracts the line's cross-section and
bends it into a quarter circle of the orbit's radius, centred at the
sprite's bottom-right corner (= the orbit centre in kite space). Verified
against the reference sprites — the arc band sits at the right radius for
every orbit (orbit 1: 76–88 px vs reference 76–87; orbit 9: 1312–1324 vs
1318). `sprites` writes all 90 (`<prefix>_orbit_<state><idx>.png`), orbit
0 as a straight strip. **877 sprites total.**

**Class backdrops are first-party too.** They aren't under the
per-ascendancy `passiveskillscreenbackground.dds` (that path only has the
PoE1 ascendancies + `intfour/infernalist`) — the class-level illustration
is `classes/<attr>/passiveskillscreenstartnodebackground.dds` (BC7,
632×580). `sprites` extracts one per PoE2 class, keyed to its class-start
hub's attribute, derived from the `Characters` metadata: Warrior=Str,
Witch=IntFour, Sorceress=Int, Ranger/Huntress=Dex, Mercenary=StrDex,
Monk=DexInt, Druid=StrInt. Six distinct images cover the eight classes —
Witch/Sorceress share the Int hub and Ranger/Huntress the Dex hub, so
they legitimately share art (as they share a class-start hub in the
tree). Emitted as `Classes<Name>` sprites plus `portrait class` rows in
`meta.tsv`, centred on the tree.

**Everything the game bundles ship is now first-party** — all data, and
every tree sprite: node icons, mastery patterns, frames, the synthesised
connectors, and the class backdrops (885 sprites). The only datum with no
GGG source is *which mods a specific unique grants* — and even that we
resolve first-party from a pinned list (§ Uniques).

### Uniques — `buildwright uniques` (one pinned seam, resolved first-party)

A *specific* unique's fixed mod list is the **only** thing GGG ships no
source for. It's applied server-side at item generation: there is no
table mapping a unique → its rolls. (The unique *mods themselves* exist
in `Mods` with `GenerationType = UNIQUE` and real ranges — `shape mods`
emits them — but nothing groups them to a parent item. `UniqueStashLayout`
is the stash-tab bank layout, not item defs; a full bundle-index search
for `uniques` turns up only art/audio assets.) So, like every other tool,
we take that list from Path of Building's hand-maintained files — but we
take the **smallest possible seam** and resolve everything else ourselves.

**The seam is one file set, pinned.** `buildwright uniques` reads only
`data/pob2/src/Export/Uniques/*.lua` — the *recipe*: `name → base →
[mod ids + variant masks + roll overrides]`. It never reads PoB's resolved
`Data/Uniques` text or PoB's mod database. Every mod id
(`UniqueLocalArmourAndEvasionAndEnergyShield4`, …) is a GGG `Mods.Id`, so
we resolve it against **our** first-party `items/mods.tsv` (ranges + tags)
and render the display text with **our** [`crate::csd`] range renderer
(`render_ranges` → `+(30-40) to maximum Life`). PoB contributes nothing
but the list; the numbers, wording, and ordering are all GGG's, mined live.

- Reader: [`crate::uniques`] (`parse` → `Vec<Unique>`; handles variant
  masks, `Implicits:`, `[lo,hi]` roll overrides, bare item flags like
  `Mirrored`/`Historic`, and verbatim literal lines for timeless jewels).
- Output: `items/uniques.tsv` (latest variant) + `items/uniques_variants.tsv`
  (every historical variant) + `items/uniques.pob.json` — provenance that
  records the pinned PoB commit + exact source files + resolved/skipped
  counts. It's hashed by the manifest, so **the PoB lock is itself
  diffable** across imports.

**Fully decoupled — GGG updates never wait on PoB.** `uniques` is a
separate command; `update-native` runs it best-effort *after* the
first-party datasets are written + hashed, so a PoB failure only warns:

- *GGG newer than PoB:* new uniques are simply absent until PoB lists
  them; every existing unique keeps resolving against the fresh `mods.tsv`
  — and picks up **live** number changes automatically. (Real case:
  GGG buffed Ab Aeterno's mod to `200-250%`; PoB's hand-authored Data
  still shows the stale `100-150%`. We resolve the pinned id → the live
  range, so we're *more* current than PoB for existing uniques.)
- *PoB newer than GGG:* a unique referencing a mod id not yet in our pool
  is **skipped and logged** (never emitted half-resolved); it appears once
  the matching GGG patch is mined.
- *PoB absent:* the command errors, `update-native` warns, and all
  first-party datasets still stand + hash. Nothing else is affected.

**Fidelity vs the old PoB-resolved baseline (0.5):** 392/392 uniques
resolve; **86% byte-identical stat text, 93% identical stat content**
(counting live-value and line-wrap differences as equal). Every remaining
divergence is us being *more current* than PoB's pinned Data — GGG
reworded or rebalanced a stat after PoB's commit and we render the live
`.csd` (e.g. Collapsing Horizon's `elemental_damage_+%` reads "increased
Elemental Damage" verbatim from the live file; Wylund's stat id is
literally `local_apply_elemental_exposure…`, so "Fire"→"Elemental") — plus
us dropping PoB's `Sockets:`/`Requires Level` metadata lines. **No genuine
render gaps remain.** Closing them hardened the shared `.csd` renderer,
which also *fixed 36 tree nodes* that showed raw values (`360% Rage/sec` →
`6%`, `5000 seconds` → `5`):

- **Partial multi-stat matching** — a description whose only *absent* stats
  are guard flags (default 0, not shown by the format) still renders, e.g.
  `local_physical_damage_+%` beside `local_weapon_no_physical_damage`.
- **Prefix-based handlers** — `_0dp`/`_1dp`/`_2dp`/`_if_required` are
  precision hints on the same op, so `apply_handler` matches the operation
  prefix (`divide_by_ten_1dp_if_required`, `per_minute_to_per_second_2dp_if_required`,
  …) instead of exact names; adds `negate_and_double`, `deciseconds_to_seconds`,
  `add_one`/`subtract_one`, `plus_two_hundred`.
- **Zero-low-bound spans** — a `0..N` roll whose low end (0) matches no rule
  (the `1|#` "increased" rule excludes 0) falls back to the high end, so it
  renders `(0-30)% increased …` instead of dropping.

### Deferred shape — no GGG table source

- **`tree`** — *not* a table shape, but the data **is** first-party, and
  the format is now largely reverse-engineered (see below). The geometry
  ships as **`metadata/passiveskillgraph.psg`** (165 KB, PoE1 PyPoE
  layout does **not** fit). `PassiveSkills` (70 cols) supplies the node
  *metadata* (name via `Name`, icon via `Icon_DDSFile`, flags
  `IsKeystone`/`IsNotable`/`IsJewelSocket`/`IsAttribute`, `Ascendancy`,
  `MasteryGroup`, `Stats[]`+`StatNValue`), joined by
  `PassiveSkillGraphId` = the PSG node id. Stat *text* needs the
  `statdescriptions/*.csd` files. So a first-party tree = **PSG
  (geometry+topology) ⋈ PassiveSkills (metadata) + statdescriptions (stat
  text) + derived constants**, emitted in the existing
  `tree/{nodes,edges,meta}.tsv` shape (produced by `buildwright shape
  tree`, i.e. `data_miner::tree_json`). The reader is the one piece
  between us and a PoB-independent tree.

  **`.psg` format (PoE2 0.5, fully reverse-engineered — reader:
  `crates/data_miner/src/psg.rs`).** Records are packed with no global
  alignment (a lone `u8` in each group header shifts parity — this is why
  a naïve even-offset scan finds only ~half the nodes). The reader walks
  the stream deterministically: a node's first word is a u16-range id
  (`< 0x10000`); a group header's first word is an `f32` coordinate whose
  bit pattern is `≥ 0x10000`, so `first_word < 0x10000` ⇒ node, else ⇒ a
  new group header.
  - Header: `u16 version` (=3), `u16` (266 on 0.5), then a fixed preamble
    (the class-start hub), then repeating `[group header][node run]`.
  - **Group header** — 21 bytes: `x:f32, y:f32` (group centre, render
    space), `u32 = 0` (the invariant that identifies a header),
    `u32` + `u32` flags, and a trailing `u8` (the odd byte). The node run
    that follows belongs to that group.
  - **Node record**:
    ```
    id:u32  orbit:u32  orbit_index:u32  conn_count:u32
    connections: conn_count × ( target_id:u32, conn_orbit:i32 )
    ```
    `conn_orbit` is the signed arc curvature (−9..+9 in 0.5); the sentinel
    `0x7FFFFFFF` (`psg::STRAIGHT`) means a straight connector. A node has
    no group field — membership is positional (the run it sits in).
    Placement: `x = gx + radii[orbit]·sin(θ)`,
    `y = gy − radii[orbit]·cos(θ)`, `θ = 2π·orbit_index /
    skillsPerOrbit[orbit]` (PoE2 angles are uniform — no special-case
    angle table, unlike PoE1's 16/40 orbits).

  **Validation.** On live `passiveskillgraph.psg` (4.5.4.3) the reader
  parses version 3, 1624 groups, 5150 nodes, **27/165144 bytes unparsed**
  (the preamble tail) and 2 dangling connections. Cross-checked against
  the parsed 0.5 baseline: **4276 node positions match to < 1 px** exactly
  (`x = gx + r·sinθ`, etc.); the remaining differences are the real
  0.5.0→0.5.4.3 tree delta (live has more nodes/groups) — confirmed by
  node/group counts growing, not by parser drift. `skills_per_orbit` /
  `orbit_radii` are stable tree constants passed into the reader.

  `.psg` inventory in 0.5: `metadata/passiveskillgraph.psg` (character
  tree), `metadata/atlasskillgraphs/atlasskillgraph.psg` (atlas), plus
  league/alternate variants — same format, so one reader covers all.

  **`buildwright shape tree`** now emits `tree/{nodes,edges,meta}.tsv`
  first-party: the `.psg` graph (positions via the orbit formula, edges,
  group centres) joined to `PassiveSkills` by `PassiveSkillGraphId` for
  name, icon (`.dds`→`.png`), kind (keystone/notable/jewel/attribute/
  mastery/ascendancy), ascendancy id, and **rendered stat text** via the
  `.csd` reader ([`crate::csd`]). Manifest/verify hash the three files
  and `diff <patch> <patch>_native` cross-checks them. Against the parsed
  0.5 baseline: **name 99.5 %, stat text 97.3 % (semantic), kind 93.5 %,
  position 88.5 %** of shared nodes — the gaps are the real 0.5.0→0.5.4.3
  tree delta (live has +308 nodes), confirmed by `diff` (`tree/nodes.tsv
  +308 −2 ~4842`). "Stat text semantic" folds in PoB's own line-ordering,
  which differs from the GGG-native `Stats[]` order (12.8 % of nodes);
  84.5 % are byte-identical.

  The tree is now first-party end to end: positions, edges, group
  centres, node name/icon/kind/stats, the `klass` column (from
  `PassiveSkills.Characters[]`), the `class`/`asc_internal` meta rows
  (from `Ascendancy` ⋈ `Characters`, byte-identical to PoB), and
  `tree/masteries.tsv` (the `masteries` command now derives its adjacency
  from our own `edges.tsv`, so it no longer reads PoB's `tree.json`).
  Only the sprite-sheet art (`tree/sprites.tsv` + portrait rows) needs
  the DDS pipeline — see below.

## Stat text — the `.csd` reader

`data/statdescriptions/*.csd` are UTF-16LE text files of rules mapping
`(stat_id, value)` → display text (`"15% increased …"`). [`crate::csd`]
parses them (English only) and renders a node/item's stats: it matches
the description whose stat set is present (longest first), checks the
value against each rule's range, applies any value handler
(`divide_by_one_hundred`, `milliseconds_to_seconds`, `per_minute_to_
per_second`, `negate`, …), substitutes `{}`/`{0}`/`{0:+d}` placeholders,
and strips GGG inline markup (`[a|b]`→`b`). The passive tree loads the
master `stat_descriptions.csd` then the `passive_skill_stat_descriptions.
csd` override; the same reader will serve item/gem stat text.

### Known future work (not yet modelled)

- **Gemling Legionnaire conditional gem quality.** That ascendancy
  grants *additional* quality effects on skill gems that should only be
  shown when the character has it specced. This is display-time
  conditional logic keyed on the ascendancy, not a property of the
  static gem data — handle it in the planner, not in `gems.tsv`.

## How this fits with what we already have

The pipeline (fully first-party as of the 2026-07 cleanup):

```
GGG CDN + data.json export  →  buildwright mine/shape/sprites/catalogues
                            →  data/parsed/<patch>_native/  →  render → deploy
```

Everything downstream — wizard catalogue, tree_render, planner build —
consumes the same on-disk schema. The old `scripts/extract_*.py` +
`emit_wizard_catalogues.py` PoB-preview path was **deleted** once the
miner reached parity; `buildwright catalogues` and the `shape` datasets
replaced them. Each `manifest.json` still records the source that
produced it.

## Validation strategy

When the miner first runs, **diff its output against PoB-derived
data** for the same patch (we have a stable known-good baseline for
0_5 from PoB v0.16.0). Use the same `sha256` infrastructure in
`scripts/build_manifests.py`:

1. Run miner against game install, output to `data/parsed/0_5_native/`
2. `diff -r data/parsed/0_5/ data/parsed/0_5_native/`
3. Investigate every line that differs — likely candidates: name
   normalization (Title Case vs Some Casing), stat-text whitespace,
   row ordering. Most diffs will be trivial.

This catches schema misunderstandings before they ship.

## Open questions to resolve during build

1. **Oodle decoder source** — RESOLVED: vendored zao/ooz in
   `crates/ooz_sys` (see the Oodle section above; note the GPL-3.0
   license consequence).
2. **dat-schema versioning**: pin to a specific dat-schema commit or
   fetch latest? Patches add columns; schema usually lags by a day.
3. **Art delivery**: convert DDS to PNG locally and commit, or ship
   raw DDS and decode at build/render time? PNG conversion is one-off
   and the file size is similar.
4. **Patch detection** — RESOLVED for the CDN path: the patch server
   handshake returns the version (see "Where the game files live").
   For local installs, still open (a `_.index.bin` header field or a
   metadata file).

## Mastery lighting — GGG's exact model (verified 2026-07-02)

Parsed live from `4.5.4.1.3` tables (scratch Python against the CDN
pulls; schema-computed row size matched `passiveskills.datc64`
exactly, 487/487 — the generic reader design below is sound):

- `PassiveSkills.MasteryGroup` → `PassiveSkillMasteryGroups`. In our
  0.5 tree, **623 nodes carry a group**: all 359 masteries plus the
  **261 notables + 3 smalls that act as triggers**. 81 distinct
  groups.
- `PassiveSkillMasteryGroups.Art` → `PassiveSkillTreeMasteryArt`
  (82 rows): per group **InactiveIcon**, **ActiveIcon** (both DDS,
  e.g. `PassiveMasteryAccuracy{Inactive,Active}.dds`) and
  **ActiveEffectImage** (the big cluster pattern).
- `MasteryCountStat` tracks allocated points among the group's
  member nodes.

**Exact rule: a mastery lights (Inactive→Active icon + pattern glow)
when ≥1 allocated node shares its MasteryGroup.** The planner's
current heuristic (any allocation in the same *visual* group, plus a
nearest-group fallback for the 562 orphan groups) approximates this
but is wrong at the margins — cross-group clusters and small-node
triggers.

Implementation plan (rides the `.dat` milestone):
1. `.datc64` reader + pinned dat-schema → emit `mastery_group` as a
   nodes.tsv column (extractor + `tree_render` io/emit + planner TS).
2. Replace `groupPatternNode` heuristic with MasteryGroup membership.
3. Art layer extracts the Inactive/Active DDS icon pairs (PoB only
   ships the pattern + blank); planner swaps icon by state.
4. Masteries stay non-hoverable (names are internal plumbing —
   already shipped).

## Once the miner works

Then we revisit:

- Interim-period strategy (pre-release builds when there's no
  current-patch game to mine yet) — the PoB-preview scenario was retired
  in the 2026-07 cleanup; if a future pre-release needs it, extend the
  miner rather than resurrecting the Python extractors
- First-party skill/gem/item **icon** extraction (proven via
  `ItemVisualIdentity` / `UniqueStashLayout`) — deferred while the wizard
  is text-only
- Abyssal Lich's missing passive nodes — first-party mining should
  surface them if they exist in `PassiveSkills.dat`
