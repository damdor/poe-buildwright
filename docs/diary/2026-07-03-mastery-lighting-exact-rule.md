# 2026-07-03 — Mastery lighting: the exact structural rule

The planner used to light a mastery's radial pattern by *proximity*
(`ORPHAN_RADIUS = 300` in 06_pathfind.ts): if you allocated a node near
a mastery's cluster centre, it lit. "Close enough" — so it sometimes lit
a mastery you were merely near, not one you'd actually invested in. This
replaces that with the exact structural rule, derived automatically from
the tree.

## Dead end (recorded so we don't repeat it)

`PassiveSkills.MasteryGroup` (from GGG's CDN via the new dat reader)
looks like the answer, but it is **not** the lighting key. It's the
**effect pool** — which effects a mastery offers — and it's shared
across clusters: MasteryGroup 4 spans **31 separate clusters**. Lighting
by shared MasteryGroup would light all 31 Life masteries when you
allocate one Life notable. Verified against the data before shipping;
the mg-based attempt was reverted. (MasteryGroup is still useful data
for a future "pick a mastery effect" UI — just not for lighting.)

## The exact rule

A mastery's **cluster** — the set of nodes whose allocation lights it —
is, structurally:

> **(nodes sharing the mastery's group)  ∪  (the mastery's neighbours in
> the tree's undirected `connections` graph)**

- **Group** covers the common case: a mastery sits at its cluster's
  centre (orbit 0) and shares its tree group with the cluster's
  small/notable nodes (median 5 peers).
- **Connections** cover GGG's twin-group splits: ~49 masteries connect
  across to notables in an *adjacent* group (e.g. Chaos Mastery, group
  1301, connects to Pure Chaos in 1284 and Wither Away in 1304). The
  `connections` are stored on one endpoint only, so treat them
  undirected.

Validated on 0.5: **all 359 masteries** get ≥1 trigger node (zero
orphans), **1834 trigger→mastery links** over 1828 nodes (6 boundary
nodes light two masteries — kept exact). Every mastery covered, no
proximity fudge.

Key tree.json facts: masteries are `isOnlyImage: true`; each carries a
`connections` list (which our edges.tsv drops, since masteries aren't
pathable); at most one mastery per group.

## How it's wired (structural + automatic)

`buildwright masteries` reads `nodes.tsv` (kind+group) + PoB `tree.json`
(connections), computes the mapping, and writes
`data/parsed/<patch>/tree/masteries.tsv` (trigger_id → mastery_id). It
runs inside `update-preview` right after extraction, so **every future
tree import regenerates it** — no hand-tuning. tree_render joins it and
emits `n.lm` (mastery ids a node lights) per node; 04e_overlay lights
`n.lm`'s masteries on allocation. The old `groupPatternNode` heuristic
is gone.

Verified: data mapping matches analysis exactly; `lm` on 1828 nodes;
esbuild + deno-strict clean; manifest/verify green. Visual glow itself
needs confirming on a real GPU — headless software-GL is unreliable
here (same caveat as the UX audits).

## Next (when the native tree extractor lands)

This logic reads PoB's tree.json today. When tree extraction goes
first-party, the same group∪connections computation moves into it, and
`connections` come from GGG's graph tables directly.
