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

Patch notes and announcement images are not sufficient to manufacture a
trustworthy tree. The website may also continue serving the previous
league briefly. The authoritative machine-readable launch boundary is
GGG's live PoE1 patch CDN: `PassiveSkillGraph.psg`, the dat schema, and
the passive/ascendancy/stat tables. The preload torrent is a standalone
client `Content.ggpk`; this pipeline does not require a separate GGPK
reader once the live CDN itself flips.

`poe1-tree --source auto` therefore uses the exact website export while
it matches the CDN release, then switches to first-party CDN shaping if
the website lags. Patch-note text remains a human watchlist, never a data
source.

**Labeling correction — DONE:** the dataset previously labeled
`poe1_3.26` was the live 3.28.0k Mirage tree (poe.ninja Mirage
characters match it 100% node-for-node). `poe1-tree` now self-labels
from the page's own `version:` marker and errors on a mismatching
`--label`; the dataset ships as `poe1_3.28.0k`.

## Launch-day play (the actual opportunity)

The full 3.29 ingest is deliberately ordered so no generator can mix a
3.29 local target with a still-live 3.28 CDN. Every CDN-backed PoE1
command checks the shared `major.minor.patch` release line before it
writes output.

```
./bw poe1-tree --source auto                # website or live CDN
./bw sprites --patch poe1_<ver>             # version-scoped live art
./bw mine --patch poe1_<ver>
for set in gems active_skills support_skills skill_levels \
           bases mods unique_art jewels passive_interop; do
  ./bw shape "$set" --patch poe1_<ver>
done
./bw skill-stats --patch poe1_<ver>
./bw uniques --patch poe1_<ver>
./bw catalogues --patch poe1_<ver>
./bw poe1-gem-icons  --patch poe1_<ver>
./bw poe1-item-icons --patch poe1_<ver>
./bw poe1-portraits  --patch poe1_<ver>
./bw render --tree-dir data/parsed/poe1_<ver>/tree \
  --output viewer/planner-poe1.html --title "PoE1 Passive Tree" \
  --agent-subdir poe1-agent --game poe1
./bw manifest --patch poe1_<ver>
./bw verify --patch poe1_<ver>
./bw diff poe1_3.28.0k poe1_<ver>
```

Because the socket rework doesn't touch the tree, OUR planner is
unaffected by the part that makes PoB's update hard — we can have the
full 3.29 tree (Luminary + rotated Reliquarian + new clusters) ready
locally as soon as the official patch CDN updates, without waiting for
the website JSON. Presentation machinery is data-driven: ascendancy
count and ownership come from the tables; Descendancy covers event and
bloodline choices; "pick one" notables are flag-derived; Reliquarian's
rotation is node data. The artifact manifest hashes every deployed
slice. Watchlist for the ingest diff: a third Scion entry, the two new
clusters, mastery text changes, and all changed runtime art.

## Step 2 plan: PoE1 gems/supports (post-launch)

Data first, UX second — same shape as everything else in this repo.
GROUND-TRUTHED 2026-07-20 (tests/poe1_cdn_probe.rs, run it with
--ignored --nocapture):

1. **Data source — verified live.** PoE1's patch server
   (`patch.pathofexile.com:12995`) speaks the exact handshake
   fetch.rs already implements (→ `https://patch.poecdn.com/3.28.0.15/`),
   and the index decodes with our existing bundle/oodle stack
   (1.17M paths). Every table the skills catalogue needs is served:
   SkillGems, GemTags, GrantedEffects(+PerLevel, StatSets,
   StatSetsPerLevel), ActiveSkills, ActiveSkillType, GemEffects, plus
   skill/gem_stat_descriptions.txt (same UTF-16 csd format our
   renderer parses). The poe-tool-dev schema we already pin carries
   the poe1 variants in the SAME file (validFor 1); dat_schema.rs
   currently filters to poe2 and needs a game mode.

   Field mapping to our gems.tsv shape, all official:
   - identity/name: GemEffects.Name/SupportName + BaseItemTypes
   - active vs support: SkillGems.IsSupport / GrantedEffects.IsSupport
   - colour: SkillGems.GemColour (post-3.29 this is a QUALITY BONUS
     hint, not legality)
   - tags: GemEffects.GemTags → GemTags.Tag
   - compatibility: GrantedEffects.Allowed/Excluded/AddedActiveSkillTypes
     (+ SupportsGemsOnly, CannotBeSupported, SupportWeaponRestrictions,
     IgnoreMinionTypes) against ActiveSkills.ActiveSkillTypes — the
     same set-algebra our support_compat precompute consumes
   - per-level: GrantedEffectsPerLevel (PlayerLevelReq, costs,
     reservation, cooldown) + GrantedEffectStatSetsPerLevel
   - variants: Vaal (IsVaalVariant) and Transfigured
     (ActiveSkills.TransfigureBase, GemEffects) come free — including
     3.29's new ones on launch-day data
   - icons: ActiveSkills.Icon_DDSFile via the DDS decoder (art paths
     differ from poe2's — enumerate by prefix at shaping time)

   Miner deltas are small: a POE1_PATCH_SERVER const + a
   game-parameterized CdnClient::connect, a validFor-aware schema
   mode, and a poe1 gems shaper mirroring shape.rs's joins.
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
## Step 2 status: PoE1 skill data pipeline — LANDED (2026-07-21)

The data half is done and verified against the live 3.28.0k CDN. No
new shaper code — the PoE2 shapers run on PoE1 data via a `Game` enum
(fetch.rs) that swaps the patch server + cache namespace, plus a
`validFor`-aware schema mode (dat_schema.rs). Column-name drift is
absorbed with documented aliases in the shapers (e.g. SkillGems
`BaseItemTypesKey`/`GemVariants`, BaseItemTypes `TagsKeys`), and
optional columns for concepts PoE1 lacks (GemType/Tier/MinLevelReq →
DropLevel fallback; PoE2's WeaponRequirements table). `autofit` gained
a shrink path for when the community schema runs ahead of a live
table (PoE1 BaseItemTypes is 48B wider by named-column count).

Flow (poe1 datasets keep their `poe1_<label>` dir, no `_native`):

```
./bw shape gems          --patch poe1_3.28.0k
./bw shape active_skills  --patch poe1_3.28.0k
./bw shape support_skills --patch poe1_3.28.0k
./bw catalogues           --patch poe1_3.28.0k   # → viewer/assets/poe1-agent/skill_catalogue.json
./bw manifest --patch poe1_3.28.0k && ./bw verify --patch poe1_3.28.0k
```

Output: 683-gem catalogue with tag strings, colour, req level/attrs,
and the support require/exclude skill-type lists the compat filter
needs — same schema as PoE2's, in PoE1's own asset namespace. Gem
ICON extraction + the skills OVERLAY (slot-based socket budgets) are
the next commit (Stage C).

4. Sequencing: 3.29 tree ingest (launch day) → miner poe1 endpoint →
   gems.tsv/supports shaping + verify gates → skills_overlay
   enablement behind the feature flag → gear later.
