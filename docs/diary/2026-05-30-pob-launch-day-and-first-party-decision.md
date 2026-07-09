# 2026-05-30 — PoE2 launch day, PoB v0.16.0 audit, decision to go first-party

PoE2 exited Early Access yesterday (2026-05-29). Path of Building
Community tagged **v0.16.0** today at 01:26 +1000 — their first
stable release with post-launch 0.5 data. We're on this commit:
`22028e355f447575b1f547fb81e8e53986176031` ("Fix name substitution").

## What I did

1. Updated `data/pob2/` to v0.16.0 (was on `dev`/`e867383b` from
   2026-05-29 morning).
2. Re-ran `scripts/extract_all.sh --patch=0_5`.
3. Set `data/parsed/0_5/.source` from `pob2-dev` → `pob2-stable` so
   the wizard badge stops reading "(preview)".
4. Flipped `data/parsed/CURRENT` symlink from `0_4` → `0_5`.
5. Rebuilt the planner (`cargo run -p tree_render --bin tree_render`)
   and regenerated wizard catalogues
   (`scripts/emit_wizard_catalogues.py`).
6. Shipped commit `0679ee9`, deployed to Cloudflare Pages
   (Cloudflare Pages preview URL).

Bumped local rustup default from `1.91` → `stable` (currently
`1.96.0`) since `tree_render` needs ≥1.95.

## Data audit findings

### Tree, items: clean delta from 0_4 to 0_5

| Dataset                 | 0_4    | 0_5    | Δ        |
| ----------------------- | ------ | ------ | -------- |
| `tree/nodes.tsv`        | 4702   | 4845   | **+143** |
| `tree/edges.tsv`        | 4992   | 5115   | **+123** |
| `items/bases.tsv`       | 1123   | 1123   | 0        |
| `items/uniques.tsv`     | 383    | 393    | **+10**  |
| `items/uniques_variants.tsv` | 3359 | 3451  | **+92**  |

### Skills: launch trimmed dev-only content

| Dataset                  | dev (yesterday) | v0.16.0 (today) | Δ        |
| ------------------------ | --------------- | --------------- | -------- |
| `skills/gems.tsv`        | 903             | 873             | **−30**  |
| `skills/active_skills.tsv` | 670           | 671             | +1       |
| `skills/support_skills.tsv` | 584          | 557             | **−27**  |
| `skills/skill_levels.tsv` | 18500          | 18357           | −143     |

The 57 cuts are CURSE skill gems (Conductivity, Flammability, Hinder,
Hobble, …) and the entire Daze\* support family
(DazedBreak / DazingCry / Dazzle / Desperation / Devastate) plus
EmpoweredDamage, FirstBlood, Flow, Leverage, Outmaneuver. These look
like dev-only content that didn't ship at launch.

### Ascendancies: 22 of 23 present, Abyssal Lich missing nodes

`tree/nodes.tsv` covers 22 ascendancies in 0_5 (vs 20 in 0_4 — added
**Spirit Walker** / Huntress2 and **Martial Artist** / Monk1).
**Abyssal Lich** (Witch3b) is registered in `tree/meta.tsv` (so the
wizard dropdown shows it) but has **zero passive nodes** in 0_5's
`nodes.tsv`. PoB v0.16.0 doesn't ship its passive tree yet — looks
like work-in-progress on their end. Every other ascendancy has 17–24
nodes.

Per-ascendancy counts in 0_5:

```
24  Smith of Kitava, Pathfinder
23  Infernalist, Disciple of Varashta
22  Acolyte of Chayula
21  Tactician, Stormweaver
20  Invoker, Gemling Legionnaire
19  Lich, Deadeye, Amazon
18  Spirit Walker, Blood Mage
17  Witchhunter, Warbringer, Titan, Shaman, Ritualist, Oracle,
    Martial Artist, Chronomancer
 0  Abyssal Lich
```

### Art audit: PoB stopped shipping atlases

Running `scripts/extract_sprite_assets.py` on v0.16.0 emitted ~25
"missing" warnings for `.dds.zst` files that 0_4 used to ship. The
new `data/pob2/src/TreeData/0_5/` directory contains:

- **90 PNG** orbit connector sprites — full coverage, extracted fine.
- **13 webp** files — 8 `background-{class}.webp` (class wheel
  backgrounds) + a few stragglers.
- **1 lua + 1 json** (the tree data PoB's exporter consumes).
- **Zero** `.dds.zst` files.

The 25 missing categories are:

- `ascendancy-background_*.dds.zst` — ascendancy panel backgrounds
- `background_*.dds.zst` — main canvas underlay
- `group-background_*.dds.zst` — orbital ring backgrounds per cluster
- `mastery-active-effect_*.dds.zst` — colored glow around allocated
  masteries
- `skills_*.dds.zst`, `skills-disabled_*.dds.zst` — skill overlay
- `jewel-sockets_*.dds.zst` — jewel slot frames
- `legion_*.dds.zst` — Legion cluster art

`tree.json`'s `assets` table only references the 90 orbit PNGs — the
.webp files aren't wired into the asset list, so they're effectively
unreferenced art PoB happens to ship.

This means **PoB is no longer the complete art source.** They publish
parse-ready tree/skill/item *data*; they expect users to source the
*art* themselves (presumably from the game's `.ggpk`).

### What art we still have

`viewer/assets/sprites/` carries 906 files from earlier 0_4 era
extractions. Coverage by new-ascendancy ID:

- **Abyssal Lich** — 7 frame sprites (frames yes, but no nodes to
  draw them on)
- **Spirit Walker / Martial Artist / Witch3b / Huntress2 / Monk1** —
  **0** sprites under those internal IDs. We have the class
  portraits (`ClassesAbyssal_Lich.png`, etc.) because those came
  through class-level naming, but ascendancy-specific frames + panel
  art for the two new launch ascendancies are missing.

The planner renders correctly today (orbit edges, node icons, class
portraits work), but allocated nodes on Spirit Walker/Martial Artist
won't get their ascendancy-specific frame art.

## Decision: go first-party

We're not staying PoB-derived. Reasons:

1. **Independence**: PoB v0.16.0 just demonstrated they can drop
   asset categories between releases. If GGG removes anything PoB
   considers redundant, our planner silently loses functionality.
2. **Latency**: PoB tagged v0.16.0 ~24h after launch. For pre-launch
   build planning (the user-base's actual peak interest window) PoB
   is unreliable — they reasonably refuse to publish dev/preview data.
3. **Completeness**: PoB doesn't publish all art and never published
   all data tables — only the subset their planner uses.
4. **Patch authority**: with first-party extraction we know our data
   matches the game build of the day, not whatever PoB's mirror is
   on.

The plan: build a native data miner that reads PoE2's `.ggpk` archive
directly. This is described in
[../native-data-miner.md](../native-data-miner.md).

## Interim period (deferred)

User noted: pre-release build planning is the high-value window
(people plan their league starter before official data exists). We'll
need a strategy for the pre-launch period (when the first-party miner
has nothing to extract yet because the patch hasn't shipped). Options
on the table:

- Keep the PoB scraper as a fallback / preview source
- Hand-curated overlays from GGG forum posts / patch-notes
- Crowd-sourced submissions

**This is explicitly deferred** until the first-party miner is
fully working. Documenting only so we remember.

## Followups tracked

- [ ] Build first-party native miner (separate crate, see design
  doc) — owned by the user on their Bazzite dev machine.
- [ ] Backfill Abyssal Lich passive node data once we have first-party
  extraction (or hold for PoB to ship it).
- [ ] Add a "data incomplete" warning in the wizard when a user
  selects an ascendancy with zero nodes.
- [ ] Define interim-period strategy once the miner ships.
- [ ] Sprite atlas refresh — currently the `extract_sprite_assets.py`
  warnings are non-fatal but the missing atlases will become real bugs
  the moment the user clicks on a 0.5-only ascendancy panel. Likely
  superseded by the first-party miner.

## Commits today

- `0679ee9` — Refresh 0_5 data to PoB v0.16.0, flip CURRENT → 0_5

## Pre-decision context (for completeness)

The user asked earlier in the session whether HTMX would help us. It
won't — the planner is a client-side WebGL2 app with zero
server-application logic; nothing benefits from server roundtrips.
hx-boost specifically also doesn't fit because the wizard chrome
already owns multi-page navigation, and WebGL teardown/setup across
swapped bodies would be more complex than letting the browser do
full-page loads. Decision: keep TS/WebGL as the planner architecture;
don't add HTMX until something needs the server to own state.
