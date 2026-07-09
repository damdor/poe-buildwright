# Build-planner roadmap

> **Status note:** this is the original architecture/design plan,
> kept as history. The pipeline it sketches has since gone fully
> first-party (GGG CDN mining — see native-data-miner.md); the
> poedb2/scrape fallbacks discussed below were considered and
> ultimately not used.


What we're building, in what order, with the data architecture worked
out up-front so we don't have to revisit it once skills, items, and
the atlas tree start landing.

---

## Vision (one paragraph)

A web-based PoE2 build-guide authoring tool that exports the new
in-game `.build` format. Authors walk through a guided flow — Identity
→ Passives → Skills → Items → Summary — and get a publishable guide
plus a shareable URL. Backed by data extracted directly from GGG
(passive tree, skill catalogues, item bases, uniques) plus icon
mirrors from the game client or poedb2, with strict patch-version
tracking so guides never silently drift when GGG ships a balance
update.

## Design principle: level-range-aware authoring everywhere

GGG's `.build` format puts `level_interval: [low, high]` on every
element type (`BuildPassive`, `BuildSkill`, `BuildSupport`,
`BuildItem`). The in-game Build Planner filters its recommendation
overlay by the player's current level, so the same file can drive a
"levels 1–60 leveling" stage and a "60+ endgame respec" stage in one
guide.

**Every authoring surface in this planner must surface a level-range
control alongside the element it edits**, not as a power-user
hidden option. Specifically:

- Each allocated passive node carries an optional level range
  (default `[1, 100]` = always active).
- Each picked skill / support gem carries one (so gem-swap
  progressions are first-class).
- Each gear-slot hint carries one (so leveling weapons vs endgame
  weapons can be expressed in one guide).
- The Summary page MUST visualise the timeline — at minimum, a strip
  showing "by level N, you have X main / Y set1 / Z set2 nodes +
  these gems + these items." Without that consumer, authors won't
  bother filling in the ranges and the leveling guidance evaporates.
- The Spirit Walker league build (Whirling Slash + Twister leveling →
  minion respec at 60) is the canonical test case for this whole
  feature; see [[project-spirit-walker]] memory.

---

## Data architecture

### Patch-versioned layout

**Every patch-dependent dataset lives under a patch-version directory.**
The directory name is GGG's patch tag with `.` → `_` (filesystem-safe):

```
data/parsed/
  0_4/                          ← PoE2 patch 0.4 ("current" before 0.5)
    tree/
      nodes.tsv
      edges.tsv
      meta.tsv
      sprites.tsv
      manifest.json
    skills/
      gems.tsv
      active_skills.tsv
      support_skills.tsv
      manifest.json
    items/
      bases.tsv
      uniques.tsv
      manifest.json
    atlas/                      ← future: atlas passive tree
      ...
    manifest.json               ← top-level: lists sub-manifests + their hashes
  0_5/                          ← arrives when patch 0.5 lands
    ...
  CURRENT → 0_5                 ← symlink so the renderer always pulls the latest
```

The Rust extractors take a `--patch` argument (defaults to whatever
`tree.json` reports). The renderer (and any saved build) records the
patch it was authored against.

### Manifest files

Each `manifest.json` is a tiny JSON document listing the files in its
directory with their SHA-256 hashes and emit timestamps:

```jsonc
{
  "patch": "0.4",
  "schema_version": 1,
  "extracted_at": "2026-05-24T19:07:00Z",
  "files": {
    "gems.tsv":            { "sha256": "a1b2…", "rows": 902 },
    "active_skills.tsv":   { "sha256": "c3d4…", "rows": 359 },
    "support_skills.tsv":  { "sha256": "e5f6…", "rows": 595 }
  }
}
```

The top-level `data/parsed/<patch>/manifest.json` rolls up the
sub-manifests by their own hashes, so a single hash compare answers
"did anything change in patch X?".

### Why hashes (and why SHA-256 truncated to 16 chars in UI)

- **Patch diffing** — "did anything change in 0.5 vs 0.4?" is a single
  hash compare per file. For per-entity diffs (which gems / uniques /
  passive nodes actually changed), we read both versions and diff the
  rows.
- **Build integrity** — a published guide stores the patch tag it was
  authored under (plus optional row-hashes for the specific entities
  it references). On import we can detect "this build references Ice
  Nova at hash X; current Ice Nova is hash Y — show what changed".
  Not implemented v1 but the data scaffolding supports it.
- **Cache busting / ETags** — when we serve parsed data over HTTP, the
  file hash becomes the ETag. Browser cache hits are immediate; one
  byte changes → fresh fetch.
- **Detecting corruption** — `verify` subcommand on the extractor
  compares disk vs manifest.

SHA-256 is overkill for security purposes but matches our `sha256` use
elsewhere in the toolchain (see `data/pob2/runtime/lua/sha1` — they
ship one). Truncate to 16 hex chars when shown to humans; full hash
stored in manifest.

### Per-row hashes — decision: NOT v1

Storing a hash per row (per gem, per item, per node) is appealing for
fine-grained patch diffs and build-integrity warnings, but it doubles
file size and adds an emit-time cost without an immediate consumer.
Deferred. When we want patch-diff or build-vs-current-state warnings,
we add a `row_hash` column to the relevant TSVs and bump the
file-`schema_version`.

### Backwards compat policy

| Asset                  | Versions kept on disk   | Versions supported by renderer       |
|------------------------|-------------------------|--------------------------------------|
| `data/parsed/<patch>/` | Latest **3 patches**    | Renderer reads `CURRENT/`            |
| `.build` saved files   | All (read-only history) | Renderer auto-migrates older→current |
| `.poe2plan.json` saves | All                     | Renderer migrates via version chain  |
| Old `nodes.txt` quick-saves (legacy)| Until next breaking change | Best-effort import; warn        |

Older patches stay on disk so a saved build pinned to an older patch
can still render correctly (it'd load `data/parsed/0_4/` instead of
`CURRENT/`). When we add a 5th patch, the oldest gets moved to
`data/archive/<patch>.tar.gz` rather than deleted, so they're
recoverable.

---

## Where the data comes from

| Asset                      | Primary source                            | Notes                                                                       |
|----------------------------|-------------------------------------------|-----------------------------------------------------------------------------|
| Passive tree (nodes/edges) | `data/pob2/src/TreeData/<v>/tree.json`    | ALREADY EXTRACTED — covers 4701 nodes, 4991 edges                          |
| Passive node icons         | `data/pob2/src/TreeData/<v>/*.dds.zst`    | ALREADY EXTRACTED — sprite atlases                                          |
| Skill / gem definitions    | `data/pob2/src/Data/Gems.lua` + `Skills/*.lua` | 902 gems + 1064 active/support skills with levels, tags, costs           |
| Skill stat templates       | `data/pob2/src/Data/StatDescriptions/`    | converts internal stat ids → display text                                   |
| Skill icons                | game client DDS atlases  (preferred)      | OR poedb2.tw mirror as fallback                                             |
| Item bases                 | `data/pob2/src/Data/Bases/*.lua`          | 1137 bases across 26 slot types — weapon stats, requirements, tags          |
| Uniques                    | `data/pob2/src/Data/Uniques/*.lua`        | 318 uniques with multi-variant stats (per patch)                            |
| Item icons                 | game client DDS atlases (preferred)       | OR poedb2.tw mirror as fallback                                             |
| Cluster jewels             | `data/pob2/src/Data/ClusterJewels.lua`    | Subtree node definitions                                                    |
| Minions / spectres         | `data/pob2/src/Data/Minions.lua`, `Spectres.lua` | For minion-build authoring                                         |
| Quest rewards (points)     | `data/pob2/src/Data/QuestRewards.lua`     | ALREADY USED — 24 weapon-swap points cap                                    |
| Bosses, ailment data       | `data/pob2/src/Data/Bosses.lua`           | Future, for advanced calc display                                           |
| Atlas tree (future)        | TBD — likely also in PoB2 fork once data lands | Same extraction pattern as the passive tree                          |

**Things PoB2 does NOT carry that we'll need to source elsewhere:**
- Skill / gem / item icons. PoB is a desktop calculator; UI uses
  placeholders. Two viable sources:
  - **Game client DDS extraction** (same toolchain as our passive
    tree icons). Canonical art, requires the client install, doesn't
    update without re-running the extractor.
  - **poedb2.tw scrape** (or similar community mirror). No client
    needed, easier to automate, but introduces a third-party
    dependency on someone else's scrape.
  - **Decision**: do client extraction first (canonical), fall back
    to poedb2 for anything missing.
- Polished skill/item descriptions beyond the raw `description`
  field. We probably don't need this for v1 — the raw description is
  accurate.

---

## Implementation phases

Ordered for highest-leverage-first and minimal blocking between
parallel work. Each phase has concrete deliverables. We're explicitly
prioritising **functionality** over **visual polish** — every page
ships first as a working monospace prototype, then gets a styling
pass once the flow is stable.

### Phase 0 — Versioned data layout (foundation)

Restructures what's already on disk into the patch-versioned tree
above. Must come first because every subsequent extractor lands into
this layout.

- Move `data/parsed/tree_render/` → `data/parsed/0_4/tree/`.
- Add `data/parsed/0_4/tree/manifest.json` generator.
- Add top-level `data/parsed/0_4/manifest.json` generator (recursive).
- Add `data/parsed/CURRENT` → `0_4` symlink.
- Update `tree_render` binary to read from `CURRENT/tree/` (or take a
  `--patch` flag).
- Add `scripts/build_manifests.py` (or Rust binary) that scans a
  patch dir, computes SHA-256 of every `.tsv` / `.json` file,
  produces the manifests.

**Deliverable**: same renderer output, but the data dir reorganised
and hashed.

### Phase 1 — Skill catalogue ingestion

The single most blocking piece: without skills as data, the wizard's
"step 3" can't even be a stub.

- `scripts/extract_skill_data.py` reads `data/pob2/src/Data/Gems.lua`
  and `Skills/*.lua`, emits:
  - `data/parsed/CURRENT/skills/gems.tsv` (902 rows: id, name,
    gem_type, tag_string, req_str/dex/int, weapon_reqs, max_level)
  - `data/parsed/CURRENT/skills/active_skills.tsv` (~628 rows: id,
    name, granted_effect_id, color, cast_time, base_cost, base_flags,
    description, skill_types_csv)
  - `data/parsed/CURRENT/skills/support_skills.tsv` (~595 rows:
    similar shape)
  - per-skill level tables in a single
    `data/parsed/CURRENT/skills/skill_levels.tsv` (skill_id × level
    → mana_cost, spirit_reservation, level_requirement, ...)
- Manifest updated.
- A small Rust loader exposes this data to the renderer / future
  pages.

**Deliverable**: queryable skill catalogue. No UI yet.

### Phase 2 — Skill icon extraction

Parallel with phase 1 (different file types, different bottleneck).

- `scripts/extract_skill_icons.py`:
  - Identify the DDS atlases containing skill icons in the
    `data/pob2/src/TreeData/<v>/` tree (or in the game client install
    if pointed at one).
  - Slice them like we already do for passive tree sprites.
  - Map skill `gameId` → PNG path.
  - Emit `data/parsed/CURRENT/skills/icons.tsv` (gem_id, png_path,
    width, height).
- Fallback path: `scripts/scrape_poedb2_icons.py` for anything the
  atlas extraction misses. Stores in `data/raw/poedb2_mirror/` so
  re-running is idempotent.

**Deliverable**: `viewer/assets/skill_icons/<name>.png` for every
known gem.

### Phase 3 — Item base + unique ingestion

Same shape as phases 1–2 but for items.

- `scripts/extract_item_data.py`:
  - Parses `Bases/*.lua` → `data/parsed/CURRENT/items/bases.tsv`
    (name, slot_type, req_level/str/dex/int, socket_limit, tags,
    weapon stats if applicable, implicit text)
  - Parses `Uniques/*.lua` → `data/parsed/CURRENT/items/uniques.tsv`
    plus `uniques_variants.tsv` (one row per variant). Variants
    matter because GGG numbers them and PoB tags stats per variant.
- `scripts/extract_item_icons.py` — same DDS approach as skill icons.
- Manifest updated.

**Deliverable**: queryable item catalogue + icon assets.

### Phase 4 — Wizard scaffold (multi-page authoring flow)

First UI work. Splits the current single-page planner into a guided
flow without losing the single-page mode for power users.

- Server-side: extend `serve` crate to handle multiple routes:
  - `/` — landing page (list saved + start new)
  - `/build/new` — wizard step 1 (identity)
  - `/build/<id>/passives` — step 2 (tree, the existing renderer
    embedded as a step)
  - `/build/<id>/skills` — step 3 stub for now
  - `/build/<id>/items` — step 4 stub for now
  - `/build/<id>/summary` — step 5 (export-ready preview)
- Shared layout chrome: fixed top progress bar showing the 5 steps,
  with `.completed` / `.active` indicators.
- HTMX for cross-step transitions; each step is its own HTML doc but
  the layout stays.
- An "expert mode" toggle that returns to the current single-page UI.

**Deliverable**: routable wizard with step 1 working end-to-end,
steps 2–5 wired but only step 2 has real content (the tree).

### Phase 5 — Skill picker UI (step 3)

- Reads phase-1 data + phase-2 icons.
- Filterable grid by tag (Fire, Lightning, AoE, Minion, etc.).
- Two-column layout: active skill on the left, support gem slots
  (4–6 sockets typical) on the right.
- Save each skill+supports combination as a `BuildSkill` (matches the
  `.build` schema directly).
- Per-skill `additional_text` editor with the 6 inline markup tags.

**Deliverable**: working step 3 that round-trips through the `.build`
exporter.

### Phase 6 — Item picker UI (step 4)

- Reads phase-3 data + icons.
- Slot picker: Weapon1, Weapon2, BodyArmour, Helmet, Gloves, Boots,
  Belt, Amulet, Ring1, Ring2, Flask1..5.
- Per-slot: choose a unique (optional), or write a stat-priority hint
  in prose. Both map to `BuildItem` fields.
- Discovery: we need the full `inventory_id` enum from the in-game
  client; either dig it out of patch 0.5 once it ships or experiment
  with the obvious strings.

**Deliverable**: working step 4 with at least the documented
`inventory_id` ("Weapon1") plus our best guesses for the rest, fixed
post-launch.

### Phase 7 — Summary + share

- Step 5 page renders a print-friendly preview of the whole build
  (identity card, mini tree thumbnail, skill bar, gear panel).
- Export buttons: `.build`, `.poe2plan.json`, "Copy share link".
- Share-link generation:
  - **Short builds** → base64-encoded plan in URL fragment
    (`/share#b=<base64>`). Works offline, no server needed, < 2KB.
  - **Long builds** → server-side slug:
    - `POST /api/share` with the plan body → `{ slug: "aB7cD2",
      url: "/share/aB7cD2" }`
    - `GET /share/<slug>` → public read-only render
    - Slug = first 8 chars of SHA-256 of the plan body (collision
      resolved by suffix), so identical plans collapse to the same
      URL.
  - The summary page picks short or long based on URL-length budget.

**Deliverable**: shareable builds end-to-end.

### Phase 8 — Polish pass

Visual styling, animations, mobile/responsive layout, dark/light
theme. Deliberately deferred until phases 0–7 prove the flow works.

---

## Recommended order (minimum thrash)

The phases above are roughly ordered, but several can land in
parallel because they don't block each other:

```
                    ┌──── Phase 1 (skill data) ────┐
Phase 0 (versions) ─┼──── Phase 2 (skill icons) ───┤
                    ├──── Phase 3 (item data + icons) ─┤
                    │                                  ├─── Phase 5 (skill picker) ──┐
                    └──── Phase 4 (wizard scaffold) ──┤                              ├──── Phase 7 (share) ── Phase 8 (polish)
                                                       └─── Phase 6 (item picker) ──┘
```

**Critical path**: 0 → 4 → 5/6 → 7 (≈ 5–7 dev-days).
**Off-critical**: 1, 2, 3 can run alongside in any order.

Concrete week-1 ordering I'd suggest:

1. **Day 1** — Phase 0 (versioned data layout, manifest generation,
   move existing tree data into `0_4/`). Small but unblocks
   everything.
2. **Day 1–2** — Phase 1 (skill catalogue ingestion). Pure data
   work, no UI.
3. **Day 2–3** — Phase 4 (wizard scaffold). Routes, layout chrome,
   step navigation; tree renderer drops into step 2 as-is.
4. **Day 3–4** — Phase 2 (skill icons), Phase 3 (item data) — can
   parallelise since they're independent.
5. **Day 4–5** — Phase 5 (skill picker). First "new" UI surface
   beyond the tree.
6. **Day 5–6** — Phase 6 (item picker).
7. **Day 6–7** — Phase 7 (summary + share).
8. **Later** — Phase 8 polish, after using the flow to actually
   author the Spirit Walker build for league launch on 2026-05-29.

---

## Explicit non-goals for v1

These will be tempting and should be deferred:

- **Damage calculations / DPS preview.** PoB does this brilliantly
  and we're not trying to be PoB. The summary page can SHOW
  recommended skills + supports but doesn't compute output.
- **Item crafting / mod weighting.** Out of scope.
- **Per-row data hashes.** Useful for patch diffs but no UI consumer
  yet — deferred.
- **Visual polish before the flow works.** Monospace prototype until
  Phase 7 passes a Spirit Walker round-trip test.
- **Account auth / user-owned builds.** The slug share model is
  anonymous-publish. We can add user accounts in v2 if needed.
- **Mobile-first UI.** Desktop authoring tool. Responsive layout in
  Phase 8.

---

## Open questions (worth deciding before phase 4 begins)

- **Routing framework on the JS side?** Currently we have one HTML
  page with HTMX-driven panels. The wizard could be built with HTMX
  page swaps (server renders each step as a full page), or with a
  client-side router. HTMX-first is simpler and matches what we have.
- **Do we serve from `serve` crate or move to a static SSG?** The
  build artefacts are templated at compile time anyway; we could ship
  pre-built HTML and host on any static CDN. The serve crate stays
  for `/api/share` + `/api/builds`. **Recommendation: yes, static
  build pre-rendered by `tree_render`; serve crate handles only
  the dynamic API endpoints.**
- **Slug storage backend.** Flat-file JSON in `builds/share/<slug>.json`
  is fine for the first 10K shares. SQLite when we cross that
  threshold.
- **Patch update workflow.** When PoE2 0.5 lands on 2026-05-29, what
  does the operator (you) run? Suggest: one wrapper script
  `scripts/sync_patch.sh <version>` that pulls fresh PoB2 data,
  re-runs all extractors into the new versioned dir, regenerates
  manifests, and updates the `CURRENT` symlink.

---

## Acceptance criteria for "v1 done"

Round-trip the Spirit Walker league build through the planner:

- [ ] Step 1: name, description, class Huntress, ascendancy Spirit Walker
- [ ] Step 2: ~120 passive nodes allocated, including 2-3 weapon-set
      nodes with set 1 / set 2 markers. Leveling-stage nodes tagged
      `level_interval: [1, 60]`; endgame-respec nodes tagged
      `[60, 100]`
- [ ] Step 3: Whirling Slash + Twister + Frostbolt + Barrage skill
      bar with their supports for level 1–60, swapping to the
      minion/companion gem set for 60+. Each gem and support carries
      its own `level_interval`
- [ ] Step 4: 12 inventory-slot hints with stat priority prose.
      Leveling weapon (Spear, leveling phys+cold mods) at
      `[1, 60]`; endgame weapon (Sylvan's Effigy unique sceptre or
      similar Companion-damage weapon) at `[60, 100]`
- [ ] Step 5: summary page renders the timeline (by-level snapshot
      strip), copy-share link produces a working URL, `.build`
      download opens cleanly in PoE2 0.5's in-game Build Planner
- [ ] Round-trip: import the `.build` we just exported → all fields
      restored, including level_intervals and weapon_set markers on
      every element type
