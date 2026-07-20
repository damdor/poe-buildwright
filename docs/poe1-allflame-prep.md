# PoE1 3.29 "Curse of the Allflame" — readiness plan

League launches **July 24, 2026, 20:00 UTC** (announced July 16 at GGG
Live). This doc records what GGG has OFFICIALLY published pre-launch,
what our pipeline can do about it, and the step-2 plan for gems.
Official sources only:

- Patch notes: pathofexile.com/forum/view-thread/3985332
  (Content Update 3.29.0)
- Reliquarian changes: pathofexile.com/forum/view-thread/3984866
- Release date: pathofexile.com/forum/view-thread/3982050
- League site: pathofexile.com/allflame (marketing, no data)

## What 3.29 changes that concerns us

1. **Socket/colour rework** (the "gem link overhaul"): sockets are
   White by default and accept ANY gem colour; Red/Green/Blue rolls
   still exist and grant +10% gem Quality on colour match; Chromatic
   Orbs force one non-White socket; Jeweller's/Binding always add
   White sockets. The patch notes do NOT change link topology — links
   between sockets, Fusings, and six-links remain. Net effect for
   planning tools: colour legality DISAPPEARS as a constraint; links
   and socket count remain the constraint.
2. **Luminary** — a third Scion ascendancy: permanently hire up to 3
   Mercenaries (2 reserve, 1 active ally).
3. **Reliquarian rotates every league** (officially confirmed): the
   Allflame Reliquarian has shuffled notables; GGG published four tree
   IMAGES (left/top/right/bottom) but no data.
4. Tree adjustments: new clusters (Arcane Conservation NE of Witch,
   Contemplative Meditation NW of Templar), totem-crit mastery/notable
   nerfs, new gems (Pact of Beidat/Ghorr/K'tash/Lycia, Mana-Infused
   Staff; supports Coursing Currents, Crystalfall; four Transfigured
   skills).

## Pre-launch data reality

GGG publishes **no machine-readable PoE1 data before launch** — no
tree JSON (the website still serves the 3.28 Mirage tree), no gem
export (PoE1 has no equivalent of the poe2-skilltree-export repo).
Pre-launch artefacts are patch-notes text and announcement images.
Building a "plan for 3.29 now" tree from those would mean hand-forging
unofficial data — explicitly out of scope for this project's
"official sources only" stance.

**Labeling correction:** our `poe1_3.26` dataset was fetched from the
live site in July 2026 — it IS the 3.28 Mirage tree (poe.ninja Mirage
characters match it 100% node-for-node). The label is cosmetic but
wrong; the launch re-ingest should use the real version, and ideally
`poe1-tree` should read the version out of the page embed instead of
trusting `--label`.

## Launch-day play (the actual opportunity)

The pipeline is ready TODAY; the whole 3.29 ingest is:

```
./bw poe1-tree --label 3.29      # fetch the fresh embed
./bw poe1-sprites --label 3.29   # new atlases (Luminary art etc.)
./bw manifest --patch poe1_3.29 && ./bw verify --patch poe1_3.29
./bw render --tree-dir data/parsed/poe1_3.29/tree ... --game poe1
scripts/deploy.sh
```

Because the socket rework doesn't touch the tree, OUR planner is
unaffected by the part that makes PoB's update hard — we can have the
full 3.29 tree (Luminary + rotated Reliquarian + new clusters) live
within minutes of the website updating. Presentation machinery already
copes: ascendancy count per class is data-driven (Scion gaining a
third ascendancy needs no code), "pick one" notables are flag-derived,
and Reliquarian's rotation is just new node data. Watchlist for the
ingest diff: a third Scion entry, the two new clusters, mastery text
changes.

## Step 2 plan: PoE1 gems/supports (post-launch)

Data first, UX second — same shape as everything else in this repo:

1. **Data source**: PoE1's own patch CDN serves the same bundle
   format family our data_miner already parses for PoE2 (.datc64
   tables, .csd stat descriptions, DDS art). Extending the miner =
   a poe1 CDN endpoint + a poe1 schema pin + the poe1 table names
   (SkillGems, GrantedEffects, GrantedEffectsPerLevel, ItemExperience
   etc.). That gives us official gems/supports/per-level numbers
   without any third-party source. (RePoE/wiki are NOT acceptable
   sources here.)
2. **Support compatibility**: PoE1's rules are tag/type-based like
   PoE2's (our support_compat precompute reuses conceptually); after
   3.29, socket COLOUR is no longer a legality input — only "can this
   support apply to this skill" + link/socket-count budget per slot.
   Model colour match purely as the +10% quality annotation.
3. **UX reuse**: skills_overlay's shape maps 1:1 — a skill with
   attached supports per group. Differences to encode: link-group
   budget lives on ITEMS (up to 6) instead of PoE2's per-gem spirit
   sockets; a build typically runs one 6-link + several 4-links. Gate
   with `featureOn("skills")` flipping on for poe1 when the catalogue
   ships, exactly like the game-split rules in poe1-tree.md.
4. Sequencing: 3.29 tree ingest (launch day) → miner poe1 endpoint →
   gems.tsv/supports shaping + verify gates → skills_overlay
   enablement behind the feature flag → gear later.
