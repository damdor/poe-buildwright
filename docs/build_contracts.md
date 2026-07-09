# Planner JSON contracts

This file pins the JSON shapes our planner reads and writes. Both
formats are versioned independently. **Bumping any version requires a
matching update here.**

| Contract | File suffix | Format tag | Current version |
|----------|-------------|------------|-----------------|
| Internal plan (lossless snapshot)  | `.poe2plan.json` | `poe2-planner-plan` | **1** |
| GGG in-game Build Planner (export) | `.build`         | (none — GGG owns the format) | targets schema rev **1** (patch 0.5 launch) |
| Static `TREE` blob shipped to JS   | (embedded)       | `tree_schema` field | **1** |

The validators live in `crates/tree_render/src/main.rs` (search:
`validatePlan`, `validateGGGBuild`). They are hand-written, dependency-
free, and run on every import / export. **Unknown TOP-LEVEL fields are
ignored**; unknown enum values, missing required fields, or unsupported
versions are rejected with a human-readable error.

---

## 1. Internal plan format (`.poe2plan.json`, v1)

Our lossless snapshot of the planner state. Round-trips through
`snapshotPlan()` and `loadPlanData()` without losing any user input.

### Required fields

| Path                | Type                | Notes                                                                  |
|---------------------|---------------------|------------------------------------------------------------------------|
| `format`            | `string`            | Must equal `"poe2-planner-plan"`. Used to distinguish from other JSON. |
| `version`           | `integer`           | Currently `1`. Loader refuses files with `version > PLAN_VERSION`.     |
| `allocations`       | `array`             | One entry per allocated node. Sorted ascending by `id` for stable diffs. |

### Optional fields

| Path                | Type             | Notes                                                                     |
|---------------------|------------------|---------------------------------------------------------------------------|
| `savedAt`           | `string` (ISO)   | Emit time. Informational; loader ignores.                                 |
| `name`              | `string`         | Display name. Defaults to `""`.                                           |
| `description`       | `string`         | Author blurb. Defaults to `""`.                                           |
| `class`             | `string` or `null` | Class name (`"Druid"`, `"Witch"`, etc.). `null` = no class chosen.       |
| `ascendancy`        | `string` or `null` | Ascendancy display name (`"Oracle"`, `"Shaman"`). NOT the GGG internalId. |

### `allocations[]` entry

| Path                | Type                                | Required | Notes                                                                                |
|---------------------|-------------------------------------|----------|--------------------------------------------------------------------------------------|
| `id`                | `string` or `number`                | yes      | GGG `PassiveSkills` id. Loader stringifies on import.                                |
| `set`               | `"main" \| "set1" \| "set2"`        | no       | Defaults to `"main"`. Weapon-set markers map to GGG's `weapon_set` field on export.  |
| `attrPick`          | `"Strength" \| "Dexterity" \| "Intelligence"` | no | Picked attribute on an attribute node. Exported as `additional_text` in `.build`.    |

### Example

```json
{
  "format":  "poe2-planner-plan",
  "version": 1,
  "savedAt": "2026-05-24T22:00:00Z",
  "name":    "Spirit Walker — Whirling Slash + Twister leveling → Minion endgame",
  "description": "Cold-vortex leveler that respecs into minions at 60.",
  "class": "Druid",
  "ascendancy": "Oracle",
  "allocations": [
    { "id": "42065", "set": "main" },
    { "id": "13855", "set": "main", "attrPick": "Intelligence" },
    { "id": "67890", "set": "set1" },
    { "id": "55400", "set": "set2" }
  ]
}
```

### Migration policy

The loader carries a `loadPlanData(plan)` function. Any future version
bump adds a migration branch:

```
if (plan.version === 0) plan = migrateV0toV1(plan);
if (plan.version === 1) plan = migrateV1toV2(plan);
```

Migrations are forward-only. We never accept a `version` higher than
the current `PLAN_VERSION`.

### Version history

| Version | Date       | Change                                  |
|---------|------------|-----------------------------------------|
| 1       | 2026-05-24 | Initial format (class + asc + allocations[set,attrPick]). |

---

## 2. GGG `.build` format (target schema rev 1)

The format our exporter emits and our importer reads, matching what
the in-game Build Planner (patch 0.5, 2026-05-29) consumes. Spec
lives at <https://www.pathofexile.com/developer/docs/game>; we
document the relevant subset in [build_planner_format.md](build_planner_format.md).

### Validator policy

- Strict on TYPES of known fields (reject malformed `weapon_set`,
  `level_interval`, `passives[]` etc).
- **Lenient on UNKNOWN fields** (silently ignored). This is forward-
  compatible — if GGG adds a field in a patch we keep loading.
- Validator rejects entire payload on first error; UI surfaces the
  string in an alert.

### Fields we read + write today (passive-tree slice)

| Path                          | Read | Write | Notes                                                  |
|-------------------------------|:----:|:-----:|--------------------------------------------------------|
| `name`                        |  ✓   |   ✓   |                                                        |
| `description`                 |  ✓   |   ✓   |                                                        |
| `ascendancy`                  |  ✓   |   ✓   | We emit the GGG `internalId` (`"Druid1"`, not `"Oracle"`). |
| `passives[]` (string form)    |  ✓   |   ✓   | Bare id when no metadata.                              |
| `passives[].id`               |  ✓   |   ✓   |                                                        |
| `passives[].weapon_set`       |  ✓   |   ✓   | `1` or `2` only.                                       |
| `passives[].level_interval`   |  ✓   |   ✓*  | Two-number `[low, high]`. *Write: emitted when present in our plan; UI for editing TBD. |
| `passives[].additional_text`  |  —   |   ✓   | Currently used only to convey attribute picks (`"<bold>Pick:</bold> Strength"`). |

### Fields we accept but DON'T process yet

These pass `validateGGGBuild()` and survive a round-trip via the
internal format. Implementation of read/write semantics is future
scope per [build_planner_format.md](build_planner_format.md).

- `skills[]` — skill-bar gems
- `skills[].support_skills[]` — socketed supports
- `items[]` — gear-slot hints (inventory_id, slot_x, slot_y, unique_name, additional_text)

### Field-mapping table (our `.poe2plan` → `.build`)

| `.poe2plan` field                               | `.build` field                                  |
|-------------------------------------------------|-------------------------------------------------|
| `name`                                          | `name`                                          |
| `description`                                   | `description`                                   |
| `ascendancy` (display name, e.g. `"Oracle"`)    | `ascendancy` (internalId, e.g. `"Druid1"`)      |
| `class`                                         | (implied by `ascendancy`; not directly emitted) |
| `allocations[].id`                              | `passives[].id`                                 |
| `allocations[].set === "main"`                  | `passives[]` as bare string (no `weapon_set`)   |
| `allocations[].set === "set1"`                  | `passives[].weapon_set = 1`                     |
| `allocations[].set === "set2"`                  | `passives[].weapon_set = 2`                     |
| `allocations[].attrPick === "Strength"` (etc.)  | `passives[].additional_text = "<bold>Pick:</bold> Strength"` |
| `allocations[].levelInterval = [low, high]`     | `passives[].level_interval = [low, high]`       |

### Example output (one allocation per set kind)

```json
{
  "name": "Spirit Walker — Whirling Slash + Twister leveling → Minion endgame",
  "description": "Cold-vortex leveler that respecs into minions at 60.",
  "ascendancy": "Druid1",
  "passives": [
    "42065",
    { "id": "13855", "additional_text": "<bold>Pick:</bold> Intelligence" },
    { "id": "67890", "weapon_set": 1 },
    { "id": "55400", "weapon_set": 2 }
  ]
}
```

### Jewel sockets

`isJewelSocket` nodes (12 in the live PoE2 tree) export the same way
as any other allocatable node: their id goes into `passives[]`. GGG
does not currently document a separate "socketed jewel" field — a
jewel item recommendation belongs in `items[]` with the appropriate
`inventory_id`. Cluster-jewel sub-trees are not yet documented in the
public `.build` schema; tracked as an open question in
[build_planner_format.md](build_planner_format.md).

### Schema-rev history

| Rev | Patch       | Date       | Notes                                                                                        |
|-----|-------------|------------|----------------------------------------------------------------------------------------------|
| 1   | PoE2 0.5    | 2026-05-29 | Initial public format. Fields documented above. We track via `GGG_BUILD_SCHEMA` constant.    |

When GGG bumps the schema (new patch adds / changes a field), the workflow is:

1. Read GGG's new patch notes / developer-docs diff.
2. Update [build_planner_format.md](build_planner_format.md) with the change.
3. Bump `GGG_BUILD_SCHEMA` in the JS module.
4. Add a new write/parse branch alongside the existing one (don't
   delete the old one — older `.build` files keep importing).
5. Update the table in this section.

---

## 3. Static `TREE` blob (embedded in `planner.html`)

The pre-computed JSON the Rust renderer embeds at build time. Not a
file format — but versioned via the `tree_schema` field so the JS can
refuse to render against a mismatched generator.

| Path             | Type      | Notes                                                                            |
|------------------|-----------|----------------------------------------------------------------------------------|
| `tree_schema`    | `integer` | Current: `1`. Bumped when the shape of `TREE.*` fields changes incompatibly.     |
| `bounds`         | object    | `{ x, y, w, h }`                                                                  |
| `nodes`          | object    | `id → { x, y, k, n, a, s, kl, g, i, iw, f0, f1, fw, me, mw, mh, o[] }`           |
| `edges_meta`     | array     | per-edge geometry tuples                                                          |
| `edges_for_sel`  | array     | `[a, b, path_piece]` triples — the adjacency graph for BFS                       |
| `edges_main`     | string    | concatenated SVG-path-data for all main-tree edges                                |
| `edges_asc`      | object    | `asc_name → SVG-path-data` per ascendancy                                        |
| `classes`        | array     | `[{ name, asc: [] }]`                                                            |
| `asc_internal`   | object    | `display_name → { internal, class }` — used by the `.build` exporter             |
| `asc_panels`     | object    | per-asc portrait position + size                                                  |
| `class_portraits`| object    | per-class portrait URL                                                           |
| `orbit_radii`    | array     | numbers — radii by orbit number                                                  |
| `bg_tile`, `bgtree`, `bgtree_active` | string | sprite URLs                                                |

### Version history

| Version | Date       | Change                                                                |
|---------|------------|-----------------------------------------------------------------------|
| 1       | 2026-05-24 | Initial schema marker. Includes `asc_internal` for `.build` exporter. |

---

## Adding new fields

Checklist for any change touching the above formats:

- [ ] Bump the relevant version constant in `crates/tree_render/src/main.rs`
      (`PLAN_VERSION`, `GGG_BUILD_SCHEMA`, or the `tree_schema` literal).
- [ ] Update validator to accept the new field (and reject old shapes
      if the change is breaking).
- [ ] If the change is breaking, add a migration branch in
      `loadPlanData()` (for the internal format) or a versioned
      read/write pair (for `.build`).
- [ ] Update the corresponding section of this document.
- [ ] Ship a sample valid file in `docs/samples/` (TODO: not yet
      created — add one when we have a non-trivial canonical example).
