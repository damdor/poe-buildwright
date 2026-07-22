# PoE1 planner support — tree, skills, and standard equipment

Scope: render and plan the PoE1 passive tree, skills, and every standard
equipment slot with the same planner UX and agentic grounding as PoE2.
That includes both weapon sets, armour, jewellery, belts, five flasks,
tinctures, base implicits/requirements/defences/weapon stats, craftable
mods, uniques, and real inventory art. Jewels (including cluster jewels)
and timeless mechanics remain explicitly deferred; the event/bloodline
ascendancies present in the data are also deferred.

## Pipeline (fully CLI, no hand fixing)

```
./bw poe1-tree                     # fetch + shape; SELF-LABELS from
                                   # the page's own version marker
./bw poe1-sprites --label <ver>    # fetch + slice the official atlases
./bw shape bases      --patch poe1_<ver>
./bw shape mods       --patch poe1_<ver>
./bw shape unique_art --patch poe1_<ver>
./bw uniques          --patch poe1_<ver> # pinned PoB1 recipe fallback
./bw catalogues       --patch poe1_<ver>
./bw poe1-item-icons  --patch poe1_<ver>
./bw manifest --patch poe1_<ver>   # hash everything (same contract as PoE2)
./bw verify   --patch poe1_<ver>   # integrity + referential ship gate
./bw render \
  --tree-dir data/parsed/poe1_<ver>/tree \
  --output viewer/planner-poe1.html \
  --title "PoE1 Passive Tree" \
  --agent-subdir poe1-agent --game poe1
```

`bw render` (both games) chains `gen_agent_meta.mjs` after
tree_render, so the agent sidecars regenerate with every bake — never
call tree_render directly for a shipped page.

`poe1-tree` fetches `pathofexile.com/passive-skill-tree` itself,
brace-matches the `passiveSkillTreeData` embed, and LABELS THE
DATASET FROM THE PAGE'S OWN `version:` MARKER — an explicit `--label`
must match it or the command errors (the first ingest trusted a
hand-passed "3.26" while fetching the live 3.28 tree). Offline
`--json` reuse requires an explicit label and is marked unverified. `poe1-sprites` needs the saved
`tree.json` and converts non-PNG atlases (JPG/WEBP) via macOS `sips` —
the one platform-specific step in the import.

## Data contracts

- `data/parsed/poe1_<label>/tree.json` — the official embed, verbatim.
- `tree/{nodes,edges,meta,sprites}.tsv` — the same 17-column shape the
  PoE2 shaper emits, so `tree_render` consumes both games unchanged.
- `items/{bases,mods,unique_art}.tsv` — first-party PoE1 CDN data shaped
  into the same catalogue contract as PoE2. Schema aliases are resolved
  in `data_miner::shape`, not in the browser.
- `items/uniques*.tsv` + `uniques.pob.json` — the only fallback seam:
  the pinned PoB1 `src/Export/Uniques/*.lua` grouping recipe, resolved
  against the first-party PoE1 mods and stat descriptions. Jewel recipes
  are excluded at ingestion, not hidden after catalogue generation.
- `/assets/poe1-agent/{bases,mods,item_catalogue}.json` and
  `item_icons/*.png` — the per-game grounding/catalogue namespace used
  by the shared gear overlay. The icon generator mirrors only supported
  equipment and resolved non-jewel uniques, pruning stale output.
- `.source` provenance marker + `manifest.json` (SHA-256 per file +
  rollup). `verify` requires the PoE1 tree, skill, base, mod, unique-art,
  and resolved-unique datasets to be present and non-empty.
- Node positions: `group.xy + r*(sin a, -cos a)` with
  `orbitRadii`/`skillsPerOrbit` from the embed's constants — but the
  angle is NOT uniform for every orbit. GGG's `getOrbitAngle`
  (skilltree.js) hand-tables orbits with 16 placements
  (0,30,45,60,90,… — the 12-position clock plus the four diagonals)
  and 40 placements (the clock angles with 10°/15°/20° sub-steps);
  only other counts use `2π*orbitIndex/skillsPerOrbit`. PoE1's
  skillsPerOrbit is [1,6,16,16,40,72,72], so orbits 2–4 need the
  tables (`poe1_orbit_angle` in handlers.rs) — uniform math puts
  those nodes up to 7.5° off and the start-emblem ornaments visibly
  miss their first passives.
- Dropped at ingest: nodes without groups (cluster-jewel proxies) and
  ascendancy↔main crossing edges (mechanics, not visuals — rendered
  literally they streak across the whole tree).
- "Pick one" notables (isMultipleChoice + isMultipleChoiceOption):
  emitted as `multichoice <parent> <opt1,opt2,…>` meta rows, derived
  from flags + adjacency — never hardcoded per ascendancy. Covers
  Ascendant's six class picks, the Reliquarian displays, Assassin's
  Assassination Style, and the event ascendancies alike (16 parents
  in 3.28.0k). tree_render bakes them as TREE.multi_choice; the planner's
  popout/zero-cost/icon-overlay machinery (shared with PoE2) runs off
  that map, and parent↔option edges are excluded from every render
  path (options are picked, never pathed).

## Art ratio — the one true rule

**World size = sheet pixels ÷ that sheet's zoom key.** This is GGG's
own renderer's rule (web.poecdn.com `dist/legacy/skilltree.<hash>.js`:
`offsetZoom = zoom / curImgZoom; dw = img.width * offsetZoom`), and it
is baked at the data layer: poe1 `sprites.tsv` width/height and the
`portrait` meta rows are already world units, and the emitter draws
them verbatim. If GGG ships sheets at a different zoom next league,
the division at ingest self-corrects — do not reintroduce scale
constants in the render path.

Do NOT borrow PoB's `DrawAsset` ×1.33 factor: it calibrates PoB's own
repackaged asset resolutions, not GGG's sheets (learned the hard way —
subtrees spilled outside their circles).

## Presentation rules (from GGG's own renderer)

The raw JSON group coordinates at the periphery are STORAGE, not
presentation — several overlap. GGG's renderer
(`getAscendancyPositionInfo` + `setCharacterClass` in skilltree.js)
relocates the chosen ascendancy at selection time:

```
dir    = (0,1) for the centered Scion start, else (x/d, -y/d)
angle  = atan2(dirX, dirY) + pi/2
button = start + 270 * (cos angle, sin angle)
circle = start + (270 + artWorldHeight/2) * (cos angle, sin angle)
```

Every group of that ascendancy shifts by `circle - startGroupCentre`,
and ONLY the current ascendancy is drawn. Ours implements this
verbatim (`ascAnchorInfo()` in render.ts): the selected subtree's
raw-baked statics draw through a uTranslate of the delta, hit-testing
follows via ascOffset, and the AscendancyButton plaque draws rotated
at the buttonPoint. A python harness in the PR history verifies
|start→circle| == 270 + h/2 for all 20 class/ascendancy pairs against
the official tree.json — re-run it after any rebake.

- Class starts: the selected class draws its own `center<class>` art
  at the start node; every other start shows the generic
  `PSStartNodeBackgroundInactive` medallion (skilltree.js
  drawStartNodeBackground). Start↔passive edges render on PoE1 (PoE2
  hides them under its central wedge art).
- Attribute totals: drawStartNodeBackground also draws, for the
  CURRENT class only, the allocated Str/Dex/Int sums as text over the
  medallion's coloured rings — `start + PSSCentreInnerRadius(130) *
  (sin a, cos a)` at Str 300° rgb(235,46,16), Dex 60° rgb(1,217,1),
  Int 180° rgb(88,130,255), 25pt Fontin × zoom (constant world size).
  No class base attributes — an empty build reads 0/0/0, like
  pathofexile.com. Ours: `attr_totals.ts`, which derives the sums by
  parsing the shipped stats text ("+N to X", "+N to X and Y", "+N to
  all Attributes") — verified equal to the embed's grantedStrength/
  Dexterity/Intelligence for all 3337 nodes of the embed.
- Mastery edges never render (structural only), same as PoE2.

## Page isolation and shared item ownership (`--game poe1` descriptor)

`tree_render --game poe1` embeds `window.PoE2Game`:

- features on: skills and gear. Features off: jewels, spirit, PoE2
  weapon-set passive budgets, and share. PoE1's two physical weapon sets
  are ordinary gear slots; the disabled feature is PoE2's tree-point
  weapon-set mechanic.
- `game.ts` owns the per-game slot board and data roots. The gear overlay
  stays shared and consumes `allowed_slots`, base tags, and mod domains
  emitted by the data layer. This prevents PoE1 schema/source knowledge
  from leaking into interaction code and prevents flask/tincture/jewel
  affixes from appearing on ordinary equipment.
- Flasks are a dedicated horizontal belt below regular gear, while the
  two surfaces reuse the same catalogue-backed item editor and the same
  `Capture.items` persistence. PoE1 exposes five positions (including
  utility flasks and tinctures); PoE2 exposes two and filters its broad
  mined `flask` domain down to Life/Mana flasks. Both PoE2 positions
  accept either recovery type to keep the unique-belt slot-swap
  exception representable. PoE2's three Charm positions form their own
  horizontal section and filter that same broad source domain to
  `UtilityFlask`/Charm bases; PoE1 does not render the section.
- PoE1 has no jewel slot. Repeated slots map to one grounding identity
  (`flask2..5 → flask1`, weapon/ring set 2 → set 1), while saved plan
  items keep their actual equipped slot. Old PoE2 plans using the former
  single `flask` key display in `flask1` until edited.
- `ascInPlace`: the in-place ascendancy presentation above.
- budgets 123 main + 8 ascendancy; storage namespaced to
  `poe1-planner:*`; agent assets under `/assets/poe1-agent`; the
  wizard patch badge reads that dir (shows "PoE1 3.28.0k").
- First visit with no `?build=` mints a fresh build in place instead
  of bouncing to the (PoE2) landing wizard.
- PoE2's node-id-keyed rule table `ASC_EFFECTS` is empty on
  non-PoE2 games — PoE1 reuses the id space, so leaving it populated
  would silently apply PoE2 ascendancy rules to unrelated PoE1 nodes.
  (`MULTI_CHOICE` is no longer such a table: it reads the baked
  per-game TREE.multi_choice map, so each page only ever sees its own
  game's ids.)

## Game-split ownership (where code goes)

One codebase serves both games; the split is by OWNERSHIP, not by
duplicated trees. The rule everywhere: a new thing goes in the
narrowest home that covers its consumers — never copied.

- Types: `types/shared.d.ts` / `poe1.d.ts` / `poe2.d.ts`.
- Planner gates: `game.ts` (zero-import leaf) is the ONLY reader of
  `window.PoE2Game`; everything checks `featureOn()` / `ASC_IN_PLACE`
  from it. Feature-gated cmd+K actions carry a `feature` tag.
- PoE2-only rule tables (ASC_EFFECTS, MULTI_CHOICE, weapon-set/spirit
  curves): `poe2_rules.ts` — empty on other games via the GAME gate.
- Ascendancy presentation geometry (both modes' anchoring/offsets,
  poe1 plaque + markers): `asc_present.ts`; `ascOffsetX/Y` is the one
  interface for "where is this asc node drawn".
- Tree TSV contract (headers, kind ladder, orbit angles, escaping):
  `data_miner::tree_tsv`, shared by all three shapers. tree_render's
  reader stays std-only and mirrors the 17-column contract under test
  on both sides. `tests/shape_golden.rs` is the offline byte-diff
  harness for shaper refactors; page bakes are deterministic, so a
  rebake of unchanged data is byte-identical.
- Node draw sizes: `emit.rs` `node_sizes_poe1` / `node_sizes_poe2`,
  kept adjacent on purpose.
- Agent sidecars with two writers (`agent/jewels.json`: tree_render
  base + gen_agent_meta's `uniques` enrichment): tree_render preserves
  top-level keys it doesn't emit (`text::preserve_unknown_top_level`),
  so a plain rebake can't destroy enrichment in any run order; the
  `agent_assets_coherent` cargo test gates the tracked file.

## Remaining deferred capabilities

- Cluster jewels (proxy groups are dropped at ingest).
- Event/bloodline alternate ascendancies (14 in the data, not
  class-pickable).
- PoE1 masteries popout UX (mastery nodes render; effect picking is
  PoE2-only).
- Server-side agent validate endpoints for poe1 (static grounding
  files exist under `/assets/poe1-agent`).
