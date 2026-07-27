# Asset handling & the patch-load report

How we load a patch's data/assets **robustly**, and give whoever loads a
new patch a precise picture of everything new/changed/removed. The
early manifests (sha256-per-file drift check) got us through building
the site; this is the robustness layer for ongoing patch operations.

Deterministic JSON matters here: the vendored `json` crate emits
key-sorted (BTreeMap) output, so identical data → byte-identical
manifests → stable hashes and clean git diffs.

## Hashing vs diffing — the split (decided 2026-07-03)

They solve different problems, so we do both, scoped:

- **Change detection → field-level diff, not hashing.** `buildwright
  diff` (DONE) loads both patches' TSVs and compares record-by-record,
  keyed by id, reporting the exact columns that moved. At our scale
  (~8k records, ~30 MB, both patches on disk) this is cheap and it
  *explains* changes ("name: Oisín's Oath → Oisin's Oath"), which a
  hash can't. So the manifest does **not** need per-record hashes.
- **Integrity → native SHA-256** (vendored `hash` crate). Used for
  per-file/asset content hashes: verify a checkout/deploy matches the
  mine and catch corruption or stale generated output.

## Implemented layers

### 1. Runtime artifact hashes

Every deployed game-owned artifact is recorded by repository-relative
path, byte count, and SHA-256: tree/item/gem/portrait art, catalogue and
agent payloads, and the rendered planner. Generated GGG art remains
gitignored; only its hashes live in the committed patch manifest.
`verify` recomputes every hash and compares the exact artifact set, so
missing, stale, or newly generated-but-unhashed files fail the gate.

### 2. Manifest v4 — parsed data, source lock + deployed artifacts

Parsed files retain per-file hashes, bytes, and TSV row counts. Runtime
files live in a separate `artifacts` map. The rollup covers both maps,
so one value identifies the complete patch payload. Field-level semantic
diffing continues to read TSV rows directly; binary changes compare
artifact hashes.

```jsonc
// data/parsed/<patch>/manifest.json
{
  "schema_version": 4,
  "patch": "poe1.3.28.0k",
  "source": "pathofexile.com/passive-skill-tree (3.28.0k)",
  "source_lock_sha256": "…",
  "datasets": {
    "tree/nodes.tsv": { "sha256": "…", "bytes": 123, "rows": 1058 }
  },
  "artifacts": {
    "viewer/assets/sprites/poe1_centerscion.png": {
      "sha256": "…", "bytes": 456
    },
    "viewer/assets/poe1-agent/item_catalogue.json": {
      "sha256": "…", "bytes": 789
    }
  },
  "rollup": "…"
}
```

`source.lock.json` is a first-class hashed dataset. It records the game,
generator contract, exact CDN/export/tree inputs, the dat-schema hash and
the narrowly pinned PoB unique-recipe seam. The manifest records the
lock's SHA-256 separately, and `verify` rejects a lock belonging to the
other game or one that no longer matches. Long-running updates also
compare the live CDN version at the beginning and end of the transaction:
if GGG rolls a hotfix during the build, no manifest is written and the
whole update must be rerun against the new exact version.

### 3. The patch-load report — `buildwright diff <old> <new>`

Reads both patches' TSVs for exact field-level changes and their
manifests for runtime artifact additions/removals/hash changes:

```
Patch 0.5.4 (cdn 4.5.4.3)  ·first-party   vs 0.5.3
────────────────────────────────────────────────────
TREE     +12 nodes  −3  ~47 changed
  + Voll's Devotion (notable, group 42)
  ~ Melting Maelstrom: +15% → +18% fire
  − Old Node (id 12345)
SKILLS   +5 gems  −2  ~8
ITEMS    +8 uniques  ~3
RUNTIME ARTIFACTS  +14  −2  ~3
```

### 4. Integrity gate — `buildwright verify <patch>`
Runs before a patch may become CURRENT; failures block the flip (or
require `--force` with a logged reason):

- **Completeness** — every expected dataset/file present + non-empty;
  schema v4 also rejects every unhashed or stale dataset.
- **Schema conformance** — every `.datc64` parses under the pinned
  schema (the `dat` reader's 0xBB row-width magic already enforces this).
- **Referential integrity** — every node icon resolves to a sprite;
  every gem→base, unique→base, mastery node→MasteryGroup; no dangling
  foreign keys.
- **Source integrity** — the source lock matches the selected game and
  manifest, with exact tree/CDN/schema/PoB provenance.
- **Runtime integrity** — every recorded art/payload hash matches, and
  the current artifact set exactly equals the manifest set.
- **Portrait coverage** — every active class and ascendancy in tree
  metadata has one source-hashed output with verified source game,
  exact upstream patch, dimensions, framing policy and output hash.
  PoE1 party portraits deliberately use GGG's shared UI family from the
  exact recorded PoE2 CDN patch because the current PoE1 client no longer
  carries those textures; missing bespoke faces fall back only to their
  parent class face.
- **Sanity bounds** — counts within range vs the prior patch (a 90 %
  node drop is a mining bug, not a patch change) — large deltas flagged
  for human review, not silently shipped.
- **Cross-source** — when both exist, diff first-party vs PoB-derived
  for the same patch and investigate divergences.

### 5. Provenance & versioning surface

The manifest carries its schema version, normalized patch label,
`.source` provenance, generator identity, both integrity maps, and the
combined rollup. It intentionally has no timestamp, so identical inputs
produce byte-identical output and clean git diffs. Builds pin their
patch; migration remains explicit.

## buildwright commands (all native, using the `json` crate)

| Command | Role | Replaces |
|---|---|---|
| `manifest [--patch p]` | (re)build source lock + manifest v4 | `build_manifests.py` |
| `diff <old> <new>` | field + runtime-artifact patch report | new |
| `verify <patch>` | the integrity gate | `build_manifests.py --check` + new |

Pipelines wire them at the end: `…→ manifest → verify → diff`, and
**refuse to flip CURRENT on a verify failure**. `status` gains "vs
live: N changes".

## Build order

Generate data → catalogues/art → render → `manifest` → `verify` →
`diff`. Manifesting before render is intentionally rejected because it
would describe stale runtime output.
