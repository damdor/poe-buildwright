# Captures data model

> Status: **specified, not yet implemented**. This document is the
> contract. Code that reads or writes the plan goes through this shape;
> UI surfaces (slider, capture editor, share codec) consume it but do
> not extend it without amending this doc first.

This document defines how the planner stores leveling-stage data and
how that maps to GGG's `.build` format. It supersedes the earlier
"captures" system that was ripped out in commit `81b22b1` (delta-stored
snapshots + a phantom "live state" — that combination is what made the
old system unreliable). It also supersedes the interim "stages"
proposal (the previous version of this same doc).

The new model: **flat per-capture cumulative snapshots**, no deltas,
no separate live state. Each capture is fully self-contained and
represents the build's tree at the END of its level range. Switching
captures is a constant-time index update.

GGG's `.build` format expects a flat array of per-entry objects with
optional `level_interval` and the explicit statement (from the spec)
that "multiple passives at the same id with different intervals model
a progression / respec flow." Our captures map onto that pattern via
the **run-collapse** export rule below.

---

## Core idea: level = points spent

PoE2 grants **1 main passive point per level from level 2 onward** (99
total at level 100). The author does NOT tag individual nodes with a
level — the planner derives level from the position of the node in a
capture's ordered `passives[]`.

For a capture covering `[from, to]`:
- The capture is the **full cumulative tree state** at level `to`.
- `passives.length` MUST equal `to - 1` (the total main passive points
  granted by the game by level `to`, assuming all points spent).
- `passives[N]` is the (N+1)-th node in the *author's recommended
  allocation order* — also the node "added" at level N+1 on the slider.

For the slider at level L (where capture i contains L):
- Display `capture[i].passives.slice(0, L - 1)`.
- That is: 0 nodes at level 1, 14 nodes at level 15, 29 at level 30, etc.

---

## Plan structure

```jsonc
plan = {
  // Identity — unchanged from current
  name:        "string",
  description: "string (markup supported: <bold>{...}, <red>{...})",
  class:       "Ranger" | "Sorceress" | … | null,
  activeSet:   "main" | "set1" | "set2",

  // Captures — at least 1, ordered, contiguous, non-overlapping.
  // The LAST capture is typically the "active" one the author is
  // currently editing (state.asc, the visible tree, etc. read from it).
  // On snapshot, the active capture's range is fixed and a new
  // capture is appended carrying the same passives forward.
  captures: [
    {
      id:          "cap_xxxxxx",       // stable id for UI references
      levelRange:  [from, to],         // both bounds required, e.g. [1, 15]
      name:        "Act 1",            // optional, free text (sidebar label)
      description: "string (markup)",  // optional prose for this stage of the guide
      ascendancy:  "Pathfinder" | …,   // each capture owns its asc (per-capture respec OK)

      passives: [
        {
          id:    "12345",               // GGG passive id (tree.json numeric id)
          set:   "main" | "set1" | "set2",
          // For asc nodes + weapon-set passives (set1/set2), the
          // authoring level stamped at allocation time. Mains derive
          // their level from position in the cumulative array, so
          // they omit this. Optional.
          level: 30,
          // Picked Str / Dex / Int variant id, set when the parent is
          // an `isAttribute` node and the author committed a pick via
          // the popout. Only present on attribute parent entries.
          attrVariantId: "26297",
          note: "string"                // optional, per-node, scoped to THIS capture
        },
        …
      ],

      skills: [
        {
          id:      "Metadata/Items/Gems/SkillGemFoo",
          level:   8,                   // gem level at this capture; default 1
          quality: 0,                   // gem quality 0..23; default 0
          set:     "main" | "set1" | "set2",  // which weapon set hosts this skill
          note:    "string",            // optional, scoped to this capture
          supports: [
            {
              id:      "Metadata/Items/Gems/SupportGemBar",
              level:   1,
              quality: 0,
              note:    "..."
            },
            …
          ]
        },
        …
      ],

      // Items: one entry per occupied inventory slot. Mod-stack tracking
      // (rolled affixes on rare items) is out of scope for v1 — only
      // unique-item progression is modeled, which mirrors what GGG's
      // .build format actually carries.
      items: [
        {
          inventoryId: "Weapon1",       // required
          slotX:       0,                // required (slot grid x)
          slotY:       0,                // required (slot grid y)
          uniqueName:  "...",            // optional; for non-uniques leave empty
          note:        "..."             // optional, scoped to this capture
        },
        …
      ],
    },
    …
  ],

  // Index of the capture currently being edited. By convention this is
  // the last capture, but the author can jump back to edit an earlier
  // one. The visible tree always equals captures[activeCapture].passives.
  // There is no separate "live state".
  activeCapture: 0,
}
```

---

## ORDER vs SET semantics

Different sections inside a capture mean different things, and that
matters for the slider:

| Section  | Storage shape | Semantic                                                          |
|----------|---------------|-------------------------------------------------------------------|
| passives | ordered array | `passives[N]` = node allocated at level `levelRange[0] + N`. Slider reveals one-per-level. |
| skills   | array (display order, not semantic) | A SET of equipped gems for this capture. UI may sort. Slider shows wholesale at capture boundary. |
| items    | array (one per occupied slot) | A SET of equipped items. Slider shows wholesale at capture boundary. |

So **only passives use the array index as a level-encoding**. Skills
and items just snapshot the player's "loadout" for that level range.
This matches the in-game reality: tree grows one point per level;
gem bar and gear loadout change in discrete swaps.

The user-facing implication: tree slider has fine-grained 1-level
ticks; the "skills + items timeline" is a separate capture-step
visualization (capture 1 → 2 → 3 → … → N). They share the same
underlying data but render at different granularities.

## The 6 invariants

These are what keep the model reliable.

1. **`captures.length >= 1`.** A fresh plan has exactly one capture
   covering `[1, 100]` (or wherever the author plans to stop), with
   empty passives. Single-capture plans behave identically to the flat
   storage model the planner had before.

2. **The active capture IS the live state.** When the planner reads
   `state.selected`, it's reading `captures[activeCapture].passives`.
   Tree clicks write back into the same array. There is no separate
   live state next to captures. Period.

3. **Each capture is fully cumulative.** `captures[i].passives` is the
   full build at level `captures[i].levelRange[1]`, including every
   node carried forward from earlier captures. NOT a delta. Storage
   cost: a couple KB per capture. Trivial.

4. **Captures are contiguous, non-overlapping, ascending.**
   `captures[i+1].levelRange[0] == captures[i].levelRange[1] + 1`.
   The first capture's `levelRange[0]` MUST be 1. Range edits validate
   against this; the planner warns on violations but doesn't auto-fix
   (the author can be temporarily inconsistent while editing).

5. **`passives.length == levelRange[1] - 1` for every capture.**
   No unspent main points — if the capture covers up to level 30,
   exactly 29 main passives are allocated. The slider relies on this.
   The editor flags any capture that violates this and refuses to
   export `.build` until fixed.

6. **Notes live inside the capture that contains the entry.** A node
   in both capture 1 and capture 2 can have different notes in each.
   On export, each `level_interval` entry carries the note from the
   last capture in its consecutive run.

---

## Validation rules (warn, don't block)

Authors can mis-specify capture content (gear they can't actually
equip yet, gems too high level). The planner warns visibly but
never refuses the edit — authors iterate, sometimes deliberately,
and a hard block here would create a worse experience than a clear
warning that the export will still pass through.

For each capture covering `[from, to]`:

1. **Item level requirement** — every item's unique base must be
   equippable by level `to`. Source: `data/parsed/CURRENT/items/uniques.tsv`
   (`level_req` column).
2. **Gem level requirement** — every skill's gem level must be
   reachable by level `to`. Source: `data/parsed/CURRENT/skills/skill_levels.tsv`
   (gem level → required character level).
3. **Support gem level requirement** — same as gems.

Violations highlight the row in the capture's sidebar with a warning
icon and a tooltip explaining the mismatch. The capture still saves,
exports, and round-trips. Authors who genuinely need a higher-req
item early (e.g. for screenshots) can dismiss the warning.

---

## Snapshot workflow (how authors actually use this)

The data model is designed around this exact flow:

1. **Fresh plan** — `captures = [{levelRange: [1, 100], passives: []}]`.
   The author sees an empty tree.
2. **Author allocates** — clicks build the tree as if leveling. Each
   click appends to `captures[0].passives`. `activeCapture` stays at 0.
3. **Snapshot at level 15** — author clicks "Snapshot here".
   - `captures[0].levelRange` becomes `[1, 15]`.
   - The planner appends `captures[1]`: `levelRange: [16, 100]`,
     `passives` = full copy of `captures[0].passives`.
   - `activeCapture` advances to 1.
   - **The visible tree DOES NOT CHANGE** — same 14 nodes. The author
     continues exactly where they left off.
4. **Author adds 5 more nodes** — these append to `captures[1].passives`,
   which now has 19 entries.
5. **Snapshot at level 20** — `captures[1].levelRange` becomes `[16, 20]`;
   `captures[2]` appended with the same 19-entry passives, ranging
   `[21, 100]`.
6. **Respec at level 50** — author jumps to `captures[N]` covering
   level 50, deallocates a chunk of the tree, allocates a different
   chunk. The cumulative count must equal 49 to satisfy invariant 5.
   The DIFF vs `captures[N-1]` is computed on demand for visualization.

The key property: at any point, the author is editing the active
capture's passives directly. Snapshotting just freezes a range bound
and creates the next capture initialized to "keep going from here."

---

## How the planner reads and writes the model

### On capture switch (e.g. clicking an earlier capture chip)

```pseudocode
function switchToCapture(idx):
  plan.activeCapture = idx
  state.selected   = Map(plan.captures[idx].passives.map(p => [p.id, p.set]))
  state.notesMap   = Map(plan.captures[idx].passives
                          .filter(p => p.note)
                          .map(p => [p.id, p.note]))
  state.asc        = plan.captures[idx].ascendancy
  state.selDirty   = true
  render()
```

One index update, one render. No delta walking.

### On tree click (allocate)

```pseudocode
function allocate(id, set):
  state.selected.set(id, set)
  plan.captures[plan.activeCapture].passives.push({ id, set })
  state.selDirty = true
  autosave.queue()
```

### On tree click (deallocate)

```pseudocode
function deallocate(id):
  state.selected.delete(id)
  arr = plan.captures[plan.activeCapture].passives
  i = arr.findIndex(p => p.id === id)
  if (i >= 0) arr.splice(i, 1)
  autosave.queue()
```

### On note edit

```pseudocode
function setNote(id, text):
  arr = plan.captures[plan.activeCapture].passives
  e = arr.find(p => p.id === id)
  if (!e) return
  if (text) e.note = text
  else delete e.note
  autosave.queue()
```

### On snapshot

```pseudocode
function snapshotAt(level):
  active = plan.captures[plan.activeCapture]
  // 1. Fix the active capture's upper bound.
  active.levelRange[1] = level
  // 2. Append a new capture initialized to the active one.
  next = {
    id:         genId(),
    levelRange: [level + 1, lastCapturedLevelOrDefault(plan)],
    passives:   deepCopy(active.passives),
    skills:     deepCopy(active.skills),
    items:      deepCopy(active.items),
    ascendancy: active.ascendancy,
  }
  plan.captures.push(next)
  plan.activeCapture = plan.captures.length - 1
  // Tree state is unchanged — visible passives are identical.
  // Only the level range bookkeeping moved.
  autosave.queue()
```

---

## Slider behavior (the "play" mode)

The slider scrubs through level L from 1 to the highest authored level
(usually 85–93 — most guides stop before 100). It does NOT show
unauthored levels.

```pseudocode
function showAtLevel(L):
  i = captures.findIndex(c => c.levelRange[0] <= L && L <= c.levelRange[1])
  if (i < 0) return  // unauthored level
  c = captures[i]
  visiblePassives = c.passives.slice(0, L - 1)
  state.selected = Map(visiblePassives.map(p => [p.id, p.set]))
  state.asc      = c.ascendancy
  render()
```

### Visualizing respec at capture boundaries

When the slider crosses from level `to[i]` to `to[i]+1` (= boundary
between capture i and capture i+1), the planner computes:

```pseudocode
function diffBoundary(i):
  prev = Set(captures[i].passives.map(p => p.id))
  cur  = Set(captures[i+1].passives.map(p => p.id))
  added   = cur - prev
  removed = prev - cur
  kept    = prev ∩ cur
```

`removed` and `added` are not empty when the author has authored a
respec at this boundary. The slider animates them with the **same
visual vocabulary as live editing**:

- `removed` nodes fade out exactly like a manual deallocate (frame +
  icon dim back to unallocated state, connectors clean up).
- `added` nodes light up one per level over the next range.

No precomputed hashes are needed — set difference on a few hundred ids
takes microseconds and runs on demand. If we ever need to cache it
(animation hot-path), the cache key is `(capture[i].id, capture[i+1].id)`
and the diff is invalidated whenever either capture's `passives` changes.

### Slider ticks (comments as milestones)

A `passives[N]` with a non-empty `note` becomes a tick on the slider
at level `capture.levelRange[0] + N`. Hovering the tick shows the
note. Clicking the tick scrubs the slider to that exact level.

This is purely a UI surfacing — the data model only needs the per-
allocation `note` field, which it already has.

---

## Asc + weapon-set points

Both treated identically to main passives, with one nuance:

- **Ascendancy** is per-capture (`capture[i].ascendancy`). This is what
  enables the "level as Pathfinder, respec to Deadeye at level 60"
  flow — captures before the respec carry `ascendancy: "Pathfinder"`,
  captures after carry `ascendancy: "Deadeye"`. The asc nodes selected
  in each capture's `passives` (with `set: 'main'`) reflect the chosen
  ascendancy's tree.
- **Weapon-set points** carry `set: 'set1' | 'set2'` on the allocation.
  Counted against the set cap (24 + grants). Otherwise stored and
  diff'd identically to main passives.

Both follow the cumulative-snapshot rule (invariant 3): each capture
holds the full set of asc + set + main allocations at its `to` level.

---

## Migration from the current flat model

Existing plans currently have flat `allocations / skills / items`.
Migration wraps them into a single capture covering all levels:

```pseudocode
function migrate(plan):
  if Array.isArray(plan.captures) and plan.captures.length > 0:
    return plan  // already migrated
  capture = {
    id:         genId(),
    levelRange: [1, 100],
    name:       null,
    ascendancy: plan.ascendancy,
    passives:   (plan.allocations || []).map(a => ({
                  id:   String(a.id),
                  set:  a.set || 'main',
                  note: a.additionalText || undefined,
                })),
    skills: (plan.skills || []).map(s => ({
              id:       s.id,
              note:     s.additionalText || undefined,
              supports: (s.support_skills || []).map(supp =>
                ({ id: supp.id || supp,
                   note: supp.additionalText || undefined })),
            })),
    items:  (plan.items || []).map(it => ({
              inventoryId: it.inventoryId,
              slotX:       it.slotX || 0,
              slotY:       it.slotY || 0,
              uniqueName:  it.uniqueName || undefined,
              note:        it.additionalText || undefined,
            })),
  }
  plan.captures      = [capture]
  plan.activeCapture = 0
  delete plan.allocations
  delete plan.skills
  delete plan.items
  delete plan.ascendancy
  return plan
```

After migration the planner behaves identically to today's single-tree
authoring. Captures become useful when the author chooses to mark a
snapshot mid-leveling.

---

## Export to GGG `.build` (run-collapse)

The `.build` format wants ONE entry per (id, level_interval) pair,
where the interval describes a contiguous range of the build's life
during which that node is held. A node held across multiple consecutive
captures with no break collapses to ONE entry; a node respec'd out
and re-taken later emits TWO.

```pseudocode
function exportBuild(plan):
  out = { name, description, ascendancy: plan.captures[last].ascendancy,
          passives: [], skills: [], items: [] }

  // --- passives ---
  // For each unique id appearing in any capture, walk captures in
  // order. Each consecutive-presence run emits one .build entry.
  for each unique id appearing in any capture:
    run = null
    for i in 0 .. captures.length - 1:
      hit = captures[i].passives.find(p => p.id === id)
      if hit:
        if run == null:
          run = { from: captures[i].levelRange[0],
                  to:   captures[i].levelRange[1],
                  set:  hit.set, note: hit.note }
        else:
          // Same id, contiguous capture → extend the run.
          run.to   = captures[i].levelRange[1]
          run.note = hit.note   // last-write wins
      else:
        if run != null: emit(id, run); run = null
    if run != null: emit(id, run)

  // Same algorithm for skills + items, with DIFFERENT collapse keys
  // (see "Run-collapse keys per section" below).

function emit(id, run):
  out.passives.append({
    id,
    level_interval:  [run.from, run.to],
    weapon_set:      run.set === 'set1' ? 0 : run.set === 'set2' ? 1 : null,
    additional_text: run.note || null,
  })
```

### Run-collapse keys per section

"Same allocation across captures" is defined per-section. Two
consecutive captures merge into one `level_interval` entry iff the
collapse key matches. Different keys force a new entry.

| Section  | Collapse key (consecutive captures merge if all match)               |
|----------|----------------------------------------------------------------------|
| passives | `id` + `set`                                                         |
| skills   | `id` + `level` + `quality` + `set` + sorted list of (support.id, support.level, support.quality) |
| items    | `inventoryId` + `slotX` + `slotY` + `uniqueName`                     |

So a gem leveling from 8 → 14 between captures emits TWO `.build`
entries with different `level` fields and adjacent `level_interval`s —
this is the gem progression PoB-style guides show. A node respec'd
out and re-allocated later emits two passives entries with a gap.
Same un-changed item carried through captures 1–5 emits ONE item
entry with `level_interval: [1, captures[4].levelRange[1]]`.

Notes still follow last-write-wins within a single run.

A node id taken at level 5 and held through to 92 → ONE entry, `[5, 92]`.
A node respec'd OUT at level 50 and re-taken at level 75 → TWO entries,
`[5, 49]` and `[75, 92]`. Matches GGG's "progression / respec flow"
representation exactly.

### Notes carry "last-write wins" within a run

If a node held across captures has different notes in different
captures, the exported note is the one from the *last* capture in the
run. Rationale: the most recent author intent for that allocation
should be what the in-game build planner displays. Prior notes are
still preserved in the plan JSON; they only collapse on export.

---

## Why this cannot break like the old captures system

| Old captures bug                                    | Why it can't happen here                                  |
|-----------------------------------------------------|-----------------------------------------------------------|
| Edits silently overwrote a "frozen" snapshot        | No frozen vs live — active capture IS the live state      |
| Reading a capture required walking earlier deltas   | Direct array access; O(1) read                            |
| "Active" was ambiguous (chip click vs latest)       | `activeCapture` is an index; whatever it points to is edited |
| Snapshots needed pre-flush of debounced autosave    | Edits write to the capture directly; autosave just persists |
| Multiple sources of truth (captures, live, plan.*)  | One source of truth: `plan.captures[activeCapture]`       |
| Storage = deltas → required recomputation on every switch | Storage = full snapshots → switching is just `activeCapture = i` |

---

## API contract

`window.PoE2Plan.data` exposes the section accessors. The shape is the
same as today but operates on `captures[activeCapture]` instead of the
flat `plan.<section>` fields:

```js
window.PoE2Plan.data = {
  section: () => 'passives' | 'skills' | 'items' | null,

  // Read the active capture's section as the planner-friendly shape.
  // For passives: Map<id, set>. For skills/items: array of entries.
  effective: (section) => …,

  // Write a new "effective" back into the active capture. Preserves
  // notes for entries whose id stayed.
  commit: (next, section, metaMap?) => …,
}
```

Captures API (new):

```js
window.PoE2Plan.captures = {
  list:        () => plan.captures.slice(),
  active:      () => plan.activeCapture,
  setActive:   (idx) => …,                  // index update + event
  snapshotAt:  (level) => …,                // fixes active.levelRange[1] = level,
                                            // appends new capture initialized to active
  setRange:    (idx, [from, to]) => …,      // edit range; warns on overlap / gaps
  setName:     (idx, name) => …,
  setDescription: (idx, text) => …,
  setAscendancy:  (idx, asc) => …,          // per-capture asc override
  remove:      (idx) => …,                  // merges range into neighbor; refuses last capture
  // (no `reorder` — captures are inherently ordered by levelRange[0])

  // Read-side helpers
  diff:        (i, j) => { added, removed, kept },   // for slider animation
  pointBudgetFor: (capture) => capture.levelRange[1] - 1,
  isFull:      (capture) => capture.passives.length === pointBudgetFor(capture),
}
```

Capture-switch events dispatch `poe2-capture-change` with
`{ index, section }`. The planner / skills / items pages listen and
re-hydrate their local state from the new active capture.

---

## Decisions captured (formerly open questions)

1. **First capture's `levelRange[0]`**: enforced to be 1. Validator
   refuses any other value (invariant 4).
2. **Last capture's `levelRange[1]`**: any level. Most guides end at
   85–93; we do NOT force 100. The slider's max is `captures[last].levelRange[1]`.
3. **Asc allocations**: per-capture via `capture[i].ascendancy` +
   asc-tagged entries in `passives`. Carry forward via cumulative
   snapshot; respec across captures is supported (edge case for v1).
4. **Insert-in-middle UI**: defer to UI implementation. Dialog will
   ask the target split level.
5. **Empty captures**: invalid (invariant 5 — every capture must be
   fully allocated to its level cap). An empty capture would have
   `passives.length == 0` but `levelRange[1] - 1 > 0`. The editor
   never produces this state — snapshotting auto-copies passives.
6. **Per-capture description**: added to the spec (markup text). Used
   for "what to do in this stage of the guide" prose.
7. **`activeCapture` on load**: persisted in plan JSON; restored on
   load. Default for new plans = 0. Migration sets 0.
8. **Range-edit cascade**: NOT auto-applied. If the user edits
   `capture[1].levelRange` from `[16, 30]` to `[16, 35]`, capture[2]'s
   `[31, …]` now overlaps. The planner warns visibly but allows the
   inconsistent state so the user can fix it (autosave still persists
   the in-progress edit).
9. **`reorder` API**: not provided. Captures are ordered by
   `levelRange[0]`. To swap stage 1 and stage 2 the user would edit
   both ranges; that's a respec, not a reorder.
10. **Skills carry `level` + `quality`**: gem progression is first-class
    data, not an export-time afterthought. Same for supports.
    Default for a freshly added gem is `level: 1, quality: 0`.
11. **Items mod stack deferred**: v1 only tracks unique-item slot
    occupancy. Rare items + rolled affixes are a future expansion
    that the .build format itself doesn't fully carry yet.
12. **Level-requirement validation**: warn, never block. Items above
    the capture's max level get a row warning; gems whose required
    character level exceeds the capture's max level get the same.
    Author still saves, exports, and shares — the warning is a guide-
    quality signal, not a gatekeeper.
13. **Skills + items timeline**: rendered as a separate capture-step
    progression view (capture 1 → 2 → … → N), parallel to the
    level slider that drives passives. Same data, two views.
14. **Per-allocation level for asc + weapon-set**: each asc and
    weapon-set entry carries an explicit `level` field set at
    allocation time (`currentCharacterLevel()` at the moment of
    click). Mains derive their level from position in the cumulative
    array, so they omit this. Slider filters off-curve allocations
    by `level <= L`; `.build` export uses `level` as the run's
    `level_interval[0]` lower bound. Without this field a capture
    spanning 20-30 levels would have to approximate "all off-curve
    allocations appear at capture start" — wrong for guide-quality
    data. Legacy entries without a `level` field fall back to
    "appears at capture start" so old plans still slide cleanly.
