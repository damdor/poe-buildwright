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

## THE BLOCKER, understood (2026-07-11): GGG upgraded Oodle at 4.5.4.3

The scattered failures above are one root cause: patch 4.5.4.3 is
compressed with a NEWER Oodle version than the reverse-engineered ooz
decoder (vendored at upstream HEAD, 2025-10) understands. Three
symptoms, one cause:

1. **Silently wrong output** — some 128K quanta "decode successfully"
   but contain dense byte corruption (single-byte deltas: `bb→ba`,
   UTF-16 high bytes `00→03`, spirit `30 → 0x0100001E`). Verified by
   diffing mined GrantedEffectsPerLevel reservation ladders against
   the last good bake: 41 of 98 ladders corrupt, in contiguous
   row bands ≈256KB apart. PassiveSkills has ~5 such bands (67+ live
   tree nodes affected) — DO NOT rebake the tree from this patch.
2. **Hard failures** — the 33 undecodable index blocks (same cause,
   quanta using a mode ooz errors on instead of mis-decoding).
3. **"New format" tables** — `data/balance/{baseitemtypes,skillgems}`
   fail the 0xBB-magic check not because the format changed but
   because corruption hit the magic bytes themselves (dense corruption
   regions). No fallback copy exists (older `data/` copies were
   removed at this patch for these; localized SkillGems don't exist).

What still works: any value that can be independently validated.
`scripts/extract_spirit_extras.mjs` ships exactly those (support cost
multipliers via constant-ladder validation, granted-skill sockets,
sceptre spirit) into `data/curated/spirit_extras.json`.

Paths out (pick one in a dedicated session):
- Reverse the Oodle delta in vendored ooz (new entropy mode(s)) —
  upstream zao/ooz has no fix as of 2026-07-11; community readers
  (poe-dat-viewer, LocalIdentity/poe2-datconverter) haven't caught up
  to this patch either. Whoever fixes it first unblocks everyone.
- Wait for upstream/community; re-run `bw update-native` when a
  decoder handles 4.5.4.3 (the pipeline additions in this commit —
  grants dataset, cost_multiplier + granted_skill_sockets bake — then
  light up end-to-end, and spirit_extras.json can be retired).

Detection heuristic that worked: mine → count `[?]` cells per column
(garbage array counts now rejected by `Dat::array_ref` bounds), and
diff re-baked ladders against the last good committed bake. Jewels
(Session B) are blocked on the same decoder for `PassiveJewel*`.

## RESOLVED (2026-07-11, same day): official Oodle decoder

The blocker above is closed. The miner now dlopens RAD/Epic's
OFFICIAL oo2core decoder at mine time (`crates/oodle_official` —
fetched on first use from Epic's publicly-distributed SDK, SHA-256
pinned, never committed; the GPL'd vendored ooz is deleted).
Verification at 4.5.4.3, decoder vs the old ooz backend:

- ooz had 258,111 wrong bytes in ONE bundle (silent); official: 0.
- `[?]` cells: PassiveSkills 5,923→0, GEPL 16,292→0, Mods 15,733→0,
  GrantedEffects 2,660→0. BaseItemTypes + SkillGems (formerly
  "unparseable" — their 0xBB magic was corrupt) decode cleanly.
- All 1,232 live tree node names present (was 831); all 110
  reservation ladders match the live bake exactly (was 57).
- The index decodes with ZERO dead blocks (was 33) — the tolerant
  path-blob decode remains as a safety net only.
- Sceptre/wand/staff granted skills mined first-party at last: the
  missing link is the `ItemInherentSkills` table (BaseItemType →
  SkillsGranted → SkillGems), NOT Implicit_Mods — base sceptres have
  no implicits. grants.tsv now carries 253 rows ("Shrine Sceptre →
  Purity of Fire/Ice/Lightning" per variant, spot-checked vs the
  in-game text).

Jewels (Session B) are UNBLOCKED. `data/curated/spirit_extras.json`
can be retired once the full 4.5.4.3 rebake ships.

## Session C: unique-jewel mods & rules (the "advanced" jewel pass)

Jewel v1 (shipped): sockets, placement UX, GGG art, radii, agent
radius reports. What's deliberately NOT in it — unique jewels
currently carry no mods, and several need them to matter:

| Unique | What it needs |
|---|---|
| Split Personality | rolled variant = which class START it lets you allocate from → planner needs an extra pathfinding root while socketed (precedent: Pathfinder's altStartClass handling in pathfind.ts) |
| Controlled Metamorphosis | "Passives in Radius can be Allocated without being connected" → radius-scoped free allocation |
| Against the Darkness / "near keystone X" rolls | variant = which keystone; per-variant stat lines |
| Voices | allocates the 5 voices_jewel_slot sockets (PassiveJewelSlots ProxySlot rows) |
| Timeless (Heroic Tragedy / Undying Hate) | AlternateTree* tables: nodes in radius are REWRITTEN (seed-based); huge, needs its own design |
| Grand Spectrum | per-socketed-count scaling (3 variants already in catalogue) |

Data sources already in hand: items/uniques_variants.tsv (per-variant
stats for PoB-known uniques), PassiveJewelSlots (proxy/replaces
mechanics), AlternateTreeExtra* + AlternatePassiveSkills/Additions
(timeless rewrites), UniqueJewelLimits (equip limits, 12 rows). The
15 game-only uniques (no PoB data yet) get variants when the PoB pin
catches up — re-run `bw uniques` then.

## Timeless-jewel rewrites: investigated (2026-07-18), seeds opted out

Tables mined clean at the current patch. What they settle:

- **Outcome pools are fully first-party**: AlternatePassiveSkills
  (231 rows across 7 factions — Kalguuran = Heroic Tragedy,
  Abyss = Undying Hate) + AlternatePassiveAdditions (95) +
  AlternateTreeVersions (per-faction policy: which node classes get
  REPLACED vs AUGMENTED, spawn weights).
- **Keystone replacement is deterministic, no seed**: ConquerorIndex
  keys the rolled conqueror variant to the replacement keystone
  (e.g. Karui index 1 → Strength of Blood). "Keystones in radius
  become X" is table-derivable per variant — a cheap future add for
  tooltip + agent report.
- **Small/notable rewrites are seed-driven** (the "Remembrancing
  (100-8000)" roll) through the game's internal PRNG — in code, not
  tables. PoE1's took the community years and dedicated sites;
  PoE2's variant is unverified, and porting PoE1's algorithm would
  be a guess with no ground truth to validate against.

DECISION: opt out of per-seed computation (owner's call). Shipped
behavior stands: timeless jewels socket normally and show their
1500 radius. Revisit if the community cracks the PoE2 PRNG — the
pool tables are already mined and waiting.

## Housekeeping: GGG rolled CDN 4.5.4.4

Noticed during the timeless mine (banner: "cdn 4.5.4.4"). With the
official decoder this is routine now: bw update-native → verify →
tree-diff parity → deploy. The investigation tables above were
pulled from 4.5.4.4 into the 4.5.4.3_native dir — harmless for
analysis, but do a clean full re-mine when refreshing.
