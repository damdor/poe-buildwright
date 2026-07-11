# Next data targets — mined table map (patch 4.5.4.3, 2026-07-11)

Findings from a live-CDN dive. All tables verified decodable with
`./bw dat <Table>` against patch 4.5.4.3 (dat-schema v7). This is the
map for two future work sessions; nothing here is shaped/served yet.

## Session A: base-item granted skills + spirit (data-driven)

The full chain for "Shrine Sceptre grants Purity of Fire" exists:

| Table | What it gives |
|---|---|
| `ItemSpirit` | BaseItemType → `SpiritGranted` (sceptres carry 100) — replaces the conservative-schedule-only model with real base spirit |
| `BaseItemTypes` | base → `ImplicitMods` (2.8 MB table; the implicit that carries the grant) |
| `ModGrantedSkills` | Mod → Skill, 65 rows — resolves which mod grants which skill |
| `GrantedSkillSocketNumbers` | granted-skill level → support sockets (L1→2, L10→3, L15→4, …) — the "free supports on granted skills" rule, quantified |
| `SkillGemsForUniqueStat` | stat index → SkillGems, 244 rows — unique-granted skills by id (replaces the latest_stats string parsing in gen_agent_meta) |

Shape plan: extend `shape.rs` to emit per-base `spirit` + `grants`
into bases.json, and a mods→skills sidecar; then gen_agent_meta stops
regex-parsing unique stat strings.

## Session B: jewels (deserves its own session)

| Table | What it gives |
|---|---|
| `PassiveJewelRadii` | 8 radius tiers with exact ring dimensions (VerySmall: outer 950 / inner 650 / radius 800) — tree-coordinate space |
| `PassiveJewelSlots` | the 7 tree jewel slots, incl. `ReplacesSlot` / `ProxySlot` (special/unlocked slot mechanics) + cluster fields |
| `PassiveJewelNodeModifyingStats` | which jewel stats modify nodes in radius |
| `PassiveJewelTransformations` + `...Types` | 16 stat-transformation rules — "nodes in radius: stat X becomes stat Y" (radius-transform uniques) |
| `AlternateTreeExtraAdditionsFromJewelStats`, `AlternateTreeExtraPassiveOverridesFromJewelStats`, `AlternatePassiveSkills`, `AlternatePassiveAdditions` | Timeless-style tree rewrites (e.g. vaal_keystone_1 → Divine Flesh) — "allocate around X / nodes become other nodes" |
| `UniqueJewelLimits` | per-unique-jewel equip limits |
| `PassiveJewelUniqueArt`, `PassiveJewelRadiiArt` | socket/radius art (11 unique-jewel arts incl. Delirium socket) |
| `MavenJewelRadiusKeystones` | radius-keystone interactions |

## Miner state on 4.5.4.3 (fixed in this commit)

- One bundle NAME contains a raw non-UTF8 byte (GGG-side typo'd art
  filename) → bundle names now decode lossily.
- The index's inner path bundle has 33 blocks ooz cannot decode
  (status -1 in strict, fuzz-safe, and windowed modes; upstream ooz
  HEAD 2025-10). Path-blob decoding is now TOLERANT: dead blocks are
  zero-filled, overlapping path specs skipped (~5.8k of ~94k specs,
  ~559k of 4.2M file paths — all observed in streaming-art
  territory). `Index::lookup` hashes full paths directly, so KNOWN
  data paths resolve regardless; all 201 `data/balance/*.datc64`
  tables the schema needs were reachable in testing.
- Note: tables moved from `data/*.datc64` to `data/balance/*.datc64`
  somewhere before this patch. `bw dat` handles it via the schema.
- Upstream issue worth filing: the undecodable-block repro against
  zao/ooz (block 418 of the 4.5.4.3 index inner bundle).
