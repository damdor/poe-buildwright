# GGG PoE2 Build Planner format (`.build`)

Documentation of the new in-game Build Planner feature introduced in
**Path of Exile 2 patch 0.5 "Return of the Ancients"** (launching
**2026-05-29**). This is GGG's official way for community authors to
publish build guides that import directly into the client and overlay
recommendations onto the player's tree, skill bar, and gear slots.

This document is the source-of-truth reference for our own planner's
exporter — the goal is to author guides that conform to this format
end-to-end (not just passive trees).

---

## What kind of feature is this?

**Read-only guide follower, not an in-client editor.** The client never
generates `.build` files; it only consumes them. The author flow is:

1. Author writes a `.build` file (typically with a third-party tool —
   Maxroll, Mobalytics, poeplanner, eventually our planner).
2. Player downloads the file and drops it in their local Build Planner
   folder, **or** subscribes via a community site (see "Subscribe API"
   below — not shipping at 0.5).
3. Restart the client. The build appears in the in-game Build Planner
   panel.
4. While playing, the recommended passive nodes light up on the tree,
   ascendancy picks are flagged, the skill bar shows priority gems +
   supports, and inventory slots gain hover hints for what stats to
   look for.

Jonathan Rogers (GGG): *"It's not on us to decide what's good… we're
there to put the tools in, the community are there to create the
builds."* GGG explicitly will not ship first-party builds.

---

## File location

| OS       | Path                                                              |
|----------|-------------------------------------------------------------------|
| Windows  | `Documents\My Games\Path of Exile 2\BuildPlanner\<name>.build`    |
| Linux (Proton) | `~/.steam/steam/steamapps/compatdata/<id>/pfx/drive_c/users/steamuser/Documents/My Games/Path of Exile 2/BuildPlanner/` |
| macOS    | (not yet documented; PoE2 macOS support pending)                  |

Files appear in the in-game panel **after a client restart**. Filename
becomes the default display name when `name` is absent from the JSON.

---

## Container format

A `.build` is a **plain UTF-8 JSON document**. No compression, no
base64, no envelope — just JSON the client reads directly. Typical
guides are 2–15 KB.

No clipboard codes, no build URLs. The only delivery mechanisms in
0.5 are file-system drop and (when GGG ships it) the account-linked
Subscribe API.

---

## JSON schema

Source: GGG's developer docs at <https://www.pathofexile.com/developer/docs/game>
under the "Build Planner (PoE2 only)" section.

### Root: `Build`

```jsonc
{
  "name":        "string, required — display name in the panel",
  "description": "string, optional — short blurb shown under the name",
  "ascendancy":  "string, optional — class internalId, e.g. \"Druid1\"",
  "passives":    [ /* string or BuildPassive */ ],
  "skills":      [ /* string or BuildSkill   */ ],
  "items":       [ /* BuildItem              */ ]
}
```

- All four arrays are **optional**. A tree-only guide can omit
  `skills` / `items`; a leveling-skills guide can omit `passives`.
- Within `passives` and `skills`, entries may be bare strings (just the
  id) when no metadata is needed. The object form is required as soon
  as you want `level_interval`, `weapon_set`, or `additional_text`.

### `BuildPassive`

One entry per recommended passive node allocation.

```jsonc
{
  "id":              "string, required — GGG PassiveSkills table id",
  "level_interval":  [low, high],     // optional uint pair, inclusive
  "weapon_set":      1 | 2,           // optional — weapon-swap marker
  "additional_text": "string"          // optional — tooltip prose w/ markup
}
```

- **`id`** is the GGG internal id from the `PassiveSkills` data table,
  not the display name. We currently store our nodes keyed by GGG's
  `tree.json` numeric id — that's the same id space (verified by the
  community `poe2-build-forge` converter, see references).
- **`level_interval`** is the per-stage gate. `[1, 30]` means "highlight
  this node while the player is level 1–30." Out of range, the node is
  hidden from the recommendation overlay. Multiple passives at the same
  id with different intervals model a progression / respec flow.
- **`weapon_set`** marks the passive as belonging to weapon swap set 1
  or 2. The client overlay distinguishes set1/set2 highlights from
  shared "main" highlights. This is the **only** documented place
  where the field appears (open question: is it valid on `BuildSkill`
  / `BuildItem` too?).
- **`additional_text`** renders as a hover tooltip on the node. Inline
  markup tags supported (see below).

### `BuildSkill`

One entry per slot on the player's skill bar.

```jsonc
{
  "id":              "string, required — Skills table id",
  "level_interval":  [low, high],     // optional
  "additional_text": "string",         // optional
  "support_skills":  [ BuildSupport ]   // optional
}
```

### `BuildSupport`

A support gem socketed into the parent skill.

```jsonc
{
  "id":              "string, required",
  "level_interval":  [low, high],
  "additional_text": "string"
}
```

### `BuildItem`

A hint about an inventory slot — **not** an item award. The client uses
these to annotate which slots to focus on and what stats to look for.

```jsonc
{
  "inventory_id":    "string, required — slot identifier (e.g. \"Weapon1\")",
  "slot_x":          uint, required,
  "slot_y":          uint, required,
  "level_interval":  [low, high],     // optional
  "unique_name":     "string",         // optional — recommended unique
  "additional_text": "string"          // optional — stat priorities, etc.
}
```

- **`inventory_id`** — full enum not yet public. Confirmed: `"Weapon1"`.
  Inferred by convention: `Weapon2`, `BodyArmour`, `Helmet`, `Gloves`,
  `Boots`, `Belt`, `Amulet`, `Ring1`, `Ring2`, `Flask1..5`. (Open
  question — see below.)
- **`slot_x`, `slot_y`** — grid coordinates inside the slot (likely for
  flask/jewel sockets that have multiple positions). Convention unclear.
- **`unique_name`** lets the guide pin a specific unique item if one is
  central to the build.

---

## Inline markup (in `additional_text`)

Supports a small set of tags:

| Tag                       | Renders as                         |
|---------------------------|------------------------------------|
| `<bold>...</bold>`        | bold                               |
| `<italics>...</italics>`  | italic                             |
| `<underline>...</underline>` | underlined                      |
| `<red>...</red>`          | red text                           |
| `<green>...</green>`      | green text                         |
| `<rgb(r,g,b)>...</rgb>`   | arbitrary RGB (0–255 channels)     |

No nesting depth limit is documented. There are **no headings, lists,
images, or links** — guide prose is plain-runs-of-words with these
inline emphases only.

---

## Where free-form guide notes go

There is **no top-level `notes` or `sections` array**. All guide prose
lives in per-element `additional_text` strings.

That means a "leveling guide section" is encoded as the union of
`additional_text` strings on the passives, skills, and items that belong
to the corresponding `level_interval`. The author distributes their
narrative across the allocations, not into a separate prose pane.

---

## Modelling stages, respecs, and leveling sequences

There is **no ordinal "take node N at level X" sequence**. Progression
is expressed only through `level_interval` ranges.

Patterns:

- **Two-stage leveling → endgame**: every passive carries either
  `[1, 60]` or `[60, 100]`. When the player crosses level 60 the
  leveling nodes un-highlight from the overlay and the endgame ones
  light up. A respec build (Whirling Slash + Twister → Minions, for example) is a
  natural fit — the leveling allocations cease to be recommended
  exactly when the player should respec out of them.
- **Continuous progression**: stacked overlapping intervals like
  `[1, 30]`, `[20, 60]`, `[50, 100]` — each notable comes into focus
  as the player approaches a stage boundary.
- **Single endgame plan**: omit `level_interval` entirely or use
  `[1, 100]`. The whole tree is recommended throughout.

The granularity is decided by the author. There is no enforced step
size — `level_interval` is just two unsigned ints.

---

## Ascendancy encoding

The root `ascendancy` field is a string. Open question (see below): is
the canonical value the **internalId** like `"Druid1"`, `"Druid2"` or
the **display id** like `"Oracle"`, `"Shaman"`? Both exist in
`tree.json`:

```json
"ascendancies": [
  { "id": "Oracle",  "internalId": "Druid1", ... },
  { "id": "Shaman",  "internalId": "Druid2", ... }
]
```

The convention in the rest of GGG's data tables is to use `internalId`
for system-level references and `id` (or `name`) for display. The
build-planner docs example doesn't disambiguate. Our exporter should
emit `internalId` and verify against the client when 0.5 ships.

Per-ascendancy-node picks (Oracle's notables, etc.) go in the `passives`
array like any other passive; the `ascendancy` field just tells the
client which sub-tree to bring up.

---

## Account-linked "Subscribe" API (not in 0.5)

Rogers confirmed GGG is building an account-linked push API: third-
party sites get a "Subscribe" button that delivers a `.build` directly
to the player's account, important for console players (who can't
sideload files). The API is **not shipping in 0.5** — no endpoint, no
auth flow, no payload published yet.

This means at launch, every guide flow has to route through
file-system drop. Console reach is post-launch.

---

## Third-party adoption confirmed at 0.5 launch

| Tool                              | Status                                            |
|-----------------------------------|---------------------------------------------------|
| Maxroll.gg                        | Native `.build` export, "progressive level notes" |
| Mobalytics.gg                     | Native `.build` export                            |
| poeplanner.com                    | Native `.build` export                            |
| Path of Building Community (PoE2) | LocalIdentity confirmed in-progress, not yet released |
| chesler410/poe2-build-forge       | Standalone PoB-string → `.build` converter (open source, Ajv-validated) |
| poe2.dev                          | Build Planner Import/Export route — compat unclear|

The community converter is the most useful reference for us:
**<https://github.com/chesler410/poe2-build-forge>**. It owns the
mapping from PoB node ids to GGG `PassiveSkills` ids and a published
JSON Schema (`@poe2-build-forge/schema`), both of which we can mirror.

---

## Mapping our planner's state to `.build`

Our current state fields and their `.build` counterparts:

| Our state                          | `.build` field                              | Notes |
|------------------------------------|---------------------------------------------|-------|
| `state.klass`                      | (implied by `ascendancy`)                   | The class is derivable from the ascendancy. If no ascendancy chosen, the class isn't directly encodable — `.build` doesn't have a class-only field. |
| `state.asc` (e.g. "Oracle")        | `ascendancy` (likely `internalId`)          | Convert via `tree.json` `classes[].ascendancies[].internalId`. |
| `state.selected.get(id) === 'main'`| `passives[].id` (no `weapon_set` field)     | Bare-string form is fine. |
| `state.selected.get(id) === 'set1'`| `passives[].weapon_set = 1`                 | 1:1 mapping. |
| `state.selected.get(id) === 'set2'`| `passives[].weapon_set = 2`                 | 1:1 mapping. |
| `state.pickedAttrs.get(id)`        | (encode via `additional_text` for now)      | The attribute-choice mechanism isn't called out separately in the docs — it likely flows through a sub-id on the option node. Needs verification on 0.5 launch. |
| (not yet in our state) skill gems  | `skills[]` + `support_skills[]`             | We'd need a sidebar / palette section for gem selection. |
| (not yet in our state) gear hints  | `items[]`                                   | Sidebar / palette section for slot-by-slot prose. |
| (not yet in our state) `level_interval` | `level_interval` on every relevant entry | We'd need a per-allocation level-range editor; default `[1, 100]` for endgame-only guides. |
| (not yet in our state) prose notes | `additional_text` on each element           | Free-text input per entry, with the markup tags above. |

---

## What we'd need to build to ship a full guide exporter

Concrete scope (not just trees):

1. **Node-id mapping table**. Cross-check our nodes.tsv ids against
   GGG's `PassiveSkills` ids. If they match (they should — both come
   from `tree.json`), no mapping needed. If they don't, mirror the
   `poe2-build-forge` table.

2. **Skill-gem catalogue**. We currently have no skill-gem data; we'd
   need to ingest GGG's `Skills` data table (likely from the PoB2 fork
   or from `pob2/src/Data/`). Build a sidebar gem picker similar to
   the node picker.

3. **Support-gem catalogue**. Same as above for support gems, with a
   nested socketing UI under each skill.

4. **Inventory slot picker**. A "gear hints" sidebar where the user
   selects a slot, optionally pins a unique by name, and writes prose
   for stat priorities. Discover the full `inventory_id` enum from
   client behaviour at 0.5 launch.

5. **Level-interval editor**. A per-allocation control — probably a
   two-handled range slider — letting the author set the level window.
   Default to `[1, 100]` and let the user split allocations into
   stages.

6. **Free-form prose with markup**. A textarea per element that
   accepts the 6 inline tags above. A small toolbar for inserting
   them, plus a preview pane that mirrors how the client would render
   the tooltip.

7. **`.build` export button**. Serialise the in-memory build object to
   JSON, validate against the schema, offer a download.

8. **`.build` import button** (round-trip). Parse a dropped or pasted
   `.build`, populate our state, render the recommended allocations.
   Lets users edit existing community guides in our tool.

9. *(Future)* **Subscribe-API publish**. When GGG ships the account-
   linked push API, add a Publish button that authenticates and pushes
   straight to a player's library.

The first item is small; items 2–6 are real product surface area —
each is its own UI domain. Worth prioritising 2–3 of them based on
what guide formats matter most for the league launch and adding the
rest as users ask for them.

---

## Open questions

These weren't pinned down in the public materials I could fetch:

- **Full `inventory_id` enum** — only `"Weapon1"` is shown in the
  example. The other slots are presumably standard names but the docs
  don't enumerate them.
- **`weapon_set` on `BuildSkill` / `BuildItem`** — documented only on
  `BuildPassive`. PoE2's dual-weapon-set feature is broader than the
  tree (different skill bars per set), so it probably applies; not yet
  confirmed.
- **`ascendancy` value form** — `internalId` (`"Druid1"`) vs `id`
  (`"Oracle"`). Need to verify at 0.5 launch.
- **Per-node attribute picks** — the Str/Dex/Int sub-choice on
  attribute nodes (which we model as `state.pickedAttrs`) isn't
  obviously a field in the schema. May ride inside the node id (an
  attribute node selecting Str probably has a different id than the
  same node selecting Dex) or via a sub-passive id; needs investigation.
- **Jewel sockets** — how socketed cluster jewels and the passive
  sub-trees they unlock get serialised isn't documented.
- **Versioning** — what happens when a creator publishes v2 of a
  guide. Overwrite by filename? Versioned id? Not specified.
- **Update mechanism for subscribed guides** — out of scope until the
  API ships.

---

## Citations

- **GGG developer docs (BuildPlanner section)** —
  <https://www.pathofexile.com/developer/docs/game>
- **Patch 0.5 reveal summary (Maxroll)** —
  <https://maxroll.gg/poe2/news/patch-0-5-return-of-the-ancients-reveal-summary>
- **Build Planner deep-dive + file path + UI behaviour (Boostmatch)** —
  <https://boostmatch.gg/blog/poe-2/articles/poe2-build-planner-guide-return-of-the-ancients>
- **Jonathan Rogers interview on the Subscribe API + no-official-builds
  stance (FRVR)** —
  <https://frvr.com/blog/news/path-of-exile-2-build-planner-will-never-include-official-ggg-builds/>
- **Launch coverage (InGameNews)** —
  <https://www.ingamenews.com/2026/05/path-of-exile-2-return-of-ancients.html>
- **Community PoB → `.build` converter (open source, schema-validated)**
  — <https://github.com/chesler410/poe2-build-forge>
- **PoB-to-`.build` converter forum thread** —
  <https://www.pathofexile.com/forum/view-thread/3931151>
- **Mobalytics 0.5 livestream summary** —
  <https://mobalytics.gg/poe-2/guides/0-5-return-of-the-ancients-content-livestream-summary>
- **Mobalytics PoE2 planner** —
  <https://mobalytics.gg/poe-2/planner/builds>
- **Maxroll PoE2 planner** —
  <https://maxroll.gg/poe2/planner>
- **Maxroll PoB2 import/export** —
  <https://maxroll.gg/poe2/pob>
- **poeplanner.com PoE2 tab** —
  <https://poeplanner.com/poe2>
- **poe2buildplanner.com aggregator (host for community `.build` files)**
  — <https://poe2buildplanner.com>

---

*Last updated: 2026-05-24. Patch 0.5 launches 2026-05-29; some fields
above will be verifiable directly against the client once it ships.*
