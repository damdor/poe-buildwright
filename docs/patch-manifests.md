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
- **Integrity + content-addressing → native SHA-256** (vendored
  `hash` crate). Used for per-file/asset content hashes: verify a
  checkout/deploy matches the mine, catch corruption, and dedup /
  cache-bust assets. This is where hashing earns its keep.

## Five layers

### 1. Content-addressed assets
Every binary asset (sprite/icon) is recorded by **content hash**.
Unchanged art across patches is identical-by-hash → not re-emitted /
dedup-able, and changed art gets a new hash → automatic cache-busting
(the `immutable` long-cache headers stay correct). The manifest's
`assets` map is the index; `diff` reports "+14 sprites, ~3 changed,
2.1 MB new, 4.0 MB shared with 0.5.3".

### 2. Manifest v2 — id-keyed record hashes
Beyond per-file sha256, each dataset records **stable_id → record_hash**.
That makes semantic diffing exact and cheap — set-compare two
manifests to get added / removed / changed ids without loading the full
TSVs. Rollup hash per dataset + per patch stays for fast integrity.

```jsonc
// data/parsed/<patch>/manifest.json
{
  "schema_version": 2,
  "patch": "0.5.4", "cdn_version": "4.5.4.3",
  "source": "first-party", "miner_version": "0.1.0",
  "extracted_at": "2026-07-03T…", "dat_schema_commit": "…",
  "datasets": {
    "tree/nodes":   { "count": 4844, "hash": "<rollup>",
                      "records": { "<node_id>": "<hash>", … } },
    "skills/gems":  { "count": 901,  "hash": "…", "records": { … } },
    "items/uniques":{ … }
  },
  "assets": { "sprites": { "<name>": { "hash": "…", "bytes": N }, … } },
  "diff_from": { "patch": "0.5.3",
                 "tree/nodes": { "added": 12, "removed": 3, "changed": 47 }, … }
}
```

~8k id→hash entries (nodes+gems+bases+uniques+sprites) ≈ a few hundred
KB compact — a fine price for exact diffs.

### 3. The patch-load report — `buildwright diff [old] <new>`
Reads two manifests → a changelog, human (colour terminal) and machine
(`--json`, feeds a future "What's new in <patch>" page):

```
Patch 0.5.4 (cdn 4.5.4.3)  ·first-party   vs 0.5.3
────────────────────────────────────────────────────
TREE     +12 nodes  −3  ~47 changed
  + Voll's Devotion (notable, group 42)
  ~ Melting Maelstrom: +15% → +18% fire
  − Old Node (id 12345)
SKILLS   +5 gems  −2  ~8
ITEMS    +8 uniques  ~3
SPRITES  +14  ~3   (2.1 MB new, 4.0 MB shared)
```

Field-level "~changed" detail: the manifest gives changed ids cheaply;
the report loads just those rows from old+new TSVs to show which fields
moved. (Cheap because it's only the changed set.)

### 4. Integrity gate — `buildwright verify <patch>`
Runs before a patch may become CURRENT; failures block the flip (or
require `--force` with a logged reason):

- **Completeness** — every expected dataset/file present + non-empty.
- **Schema conformance** — every `.datc64` parses under the pinned
  schema (the `dat` reader's 0xBB row-width magic already enforces this).
- **Referential integrity** — every node icon resolves to a sprite;
  every gem→base, unique→base, mastery node→MasteryGroup; no dangling
  foreign keys.
- **Sanity bounds** — counts within range vs the prior patch (a 90 %
  node drop is a mining bug, not a patch change) — large deltas flagged
  for human review, not silently shipped.
- **Cross-source** — when both exist, diff first-party vs PoB-derived
  for the same patch and investigate divergences.

### 5. Provenance & versioning surface
The manifest already carries patch (marketing + CDN), `.source`,
miner_version, timestamp, schema commit, and the diff summary. The
wizard patch badge extends to "N changes from <prev>" +
authoritative/preview. Old patches stay immutable; builds pin their
patch (done); migration is explicit (done in wizard_chrome).

## buildwright commands (all native, using the `json` crate)

| Command | Role | Replaces |
|---|---|---|
| `manifest [--patch p]` | (re)build manifest v2 | `build_manifests.py` |
| `diff [old] <new>` | the patch-load report (+`--json`) | new |
| `verify <patch>` | the integrity gate | `build_manifests.py --check` + new |

Pipelines wire them at the end: `…→ manifest → verify → diff`, and
**refuse to flip CURRENT on a verify failure**. `status` gains "vs
live: N changes".

## Build order
1. `manifest` (native, id-keyed) on the existing TSVs — immediate value,
   retires `build_manifests.py`.
2. `diff` on two manifests — the changelog.
3. `verify` — integrity gate; wire into the pipelines.
4. Content-addressed asset dedup — once mining emits art natively.
