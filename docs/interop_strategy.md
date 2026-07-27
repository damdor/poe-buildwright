# Interoperability strategy

> Status: **PoE2 `.build` plus shared PoE1/PoE2 PoB import adapters
> implemented**.
>
> Audited against GGG's live
> [Build Planner documentation](https://www.pathofexile.com/developer/docs/game)
> on 2026-07-23. GGG still labels it **Version 1 (Experimental)** and
> **PoE2 only**. Re-audit the live document and
> [developer changelog](https://www.pathofexile.com/developer/docs/changelog)
> before implementing or releasing an adapter change.
>
> Companion documents:
> [native state architecture](character_state_architecture.md) and
> [phased delivery roadmap](character_state_roadmap.md).

Buildwright's native plan is richer than any external format. Interop is
therefore a projection with a report, not an alternative persistence model.

## Adapter contract

Every adapter implements the same high-level workflow:

```ts
interface InteropAdapter<Input, Output> {
  id: string;
  game: "poe1" | "poe2";
  direction: Array<"import" | "export">;

  inspectImport(input: Input): ImportInspection;
  import(input: Input, options: ImportOptions): ImportResult;

  analyzeExport(plan: BuildwrightPlanV3, route: string[]): ExportAnalysis;
  export(
    plan: BuildwrightPlanV3,
    route: string[],
    options: ExportOptions,
  ): ExportResult<Output>;
}

interface CompatibilityReport {
  imported: ReportEntry[];
  transformed: ReportEntry[];
  omitted: ReportEntry[];
  unresolved: ReportEntry[];
  errors: ReportEntry[];
}
```

Every entry names a stable state/entity path, the source field, the action,
and a human-readable reason. A successful conversion may contain omissions,
but it may not hide them.

Import has two passes:

1. validate and inspect the untrusted external payload;
2. normalize it into complete native states.

Export has two passes:

1. analyze the selected route and show compatibility;
2. emit a schema-clean file only after there are no blocking errors.

Importers are lenient about unknown optional fields so upstream additions
do not make files unreadable. Exporters are strict and emit only documented
fields. Buildwright-only extensions never appear in an official file.

### Browser and Rust CLI parity

Interop is not owned by a page controller or an ad-hoc script. The bounded
parsers, normalizers, game profiles, compatibility reports, and native-plan
validators are pure TypeScript modules bundled into the browser. The Rust
`buildwright` command owns the public automation surface and invokes those
same modules with a minimal Deno permission envelope:

```text
./bw pob-inspect --game poe1|poe2 --source build.xml --output review.json
./bw pob-import --game poe1|poe2 --source build.xml \
  --review review.json --output plan.json --report report.json

./bw build-inspect --game poe2 --source character.build \
  --output review.json
./bw build-import --game poe2 --source character.build \
  --review review.json --output plan.json --report report.json
```

`pob-inspect` also accepts one canonical `https://pobb.in/<code>` URL. The
Rust handler grants network access only to `pobb.in`; local inputs and
outputs receive only their exact read/write permissions.

Inspection writes an editable, versioned review envelope. Import requires
that envelope and verifies its SHA-256 digest against the exact source, so
review choices cannot accidentally be applied to another file. Both entry
points then enforce the same untrusted-JSON shape gate, graph invariants, and
selected-game profile rules before a native plan can be persisted.

## Official GGG `.build`

### What the live schema can represent

The current PoE2-only schema contains:

| Area | Official fields |
|---|---|
| Build identity | `name`, optional `author`, `link`, `description` |
| Character | one optional top-level `ascendancy` |
| Passives | `PassiveSkills.Id`, optional level interval, weapon set 0–2, hover text |
| Skills | `BaseItemTypes.Id`, optional level interval, hover text, supports |
| Supports | `BaseItemTypes.Id`, optional level interval, hover text |
| Inventory hints | inventory ID, grid x/y, optional unique name, level interval, hover text |

`level_interval` accepts an unsigned integer or an array of unsigned
integers; the official examples use `[0, 100]`. Skills may be bare strings
or objects. Meta gems are explicitly unsupported.

The file is an instruction overlay, not a full character or item model.
Inventory entries are hints for slots and unique names; they do not encode
rare item bases, rolls, sockets, or arbitrary mod stacks.

### Implementation checkpoint

The local branch now aligns the adapter with the live Version 1 contract:

| Area | Local implementation |
|---|---|
| Passive identity | Patch-generated bidirectional `PassiveSkills.Id` ↔ graph-ID sidecar; native rendering keeps graph IDs. |
| Skills | Bare-string roots/supports normalize correctly; exact current `BaseItemTypes.Id` sets distinguish active, support, and unsupported meta gems. |
| Inventory | Profile-owned placement maps are checked against a patch-generated `Inventories.Id` catalogue; Build Planner-only flask/charm targets are declared separately. |
| Unique identity | Only exact current `Words` matches cross `unique_name`; display/art fallbacks cannot become official identity. |
| Schema | Strict export omits Buildwright extensions, accepts weapon set 0 on import, and preserves legal level-0 intervals at the adapter boundary. |
| Markup | Generated formatting uses official brace markup; arbitrary authored/imported text is neutralized before export. |
| Route projection | One selected route is exported; ambiguous level-less/same-level routes become an explicit final-state projection. |
| Compatibility | Export and import both require a review dialog. Branches, actors, unknown IDs, unsupported metadata, and ascendancy progression are reported. |
| Source preservation | Unknown imported IDs and the original `.build` payload remain in native `gameData`; the editor never invents a source match. |
| Automation | Rust-owned inspect/import commands use the same pure importer and patch-generated catalogues as the browser. |

Remaining release gate: load a representative exported file in the current
PoE2 client during local user testing. The live schema remains experimental,
so the documentation and changelog must be re-audited before release.

The passive-ID issue is visible in the first-party extraction pipeline:
`PassiveSkills.tsv` contains both `Id` and `PassiveSkillGraphId`, but
`shape_tree` emits only the graph ID into `nodes.tsv`. The fix is to retain
the distinction, not to reinterpret numeric graph IDs as table IDs.

### Implemented ID boundary

The mined tree data should expose a compact map:

```ts
interface PassiveInteropIds {
  graphToBuild: Record<string, string>;
  buildToGraph: Record<string, string>;
}
```

All renderer, pathing, selection, jewel, and replay code continues to use
graph IDs. The `.build` adapter performs:

```text
native graph ID → PassiveSkills.Id → .build
.build PassiveSkills.Id → native graph ID → native state
```

Unknown external IDs are retained in the import report. They are never
silently dropped or inserted as non-renderable native allocations.

### Route projection

A `.build` file can represent one route, not the state graph. Export asks
the author to choose a leaf, defaulting to `defaultLeafId`.

For each entity on that route:

1. Compute consecutive state runs during which its exportable identity is
   unchanged.
2. Project meaningful level metadata to `level_interval`.
3. Emit no interval when the entity applies to the whole route and the
   absence is unambiguous.
4. Emit separate entries when it disappears and later returns.
5. Do not fabricate precise intervals for non-level states.

If a route contains multiple same-level or level-less endgame states, the
author chooses one of:

- export a selected state as a final-state build;
- provide explicit recommended level intervals;
- export multiple named `.build` files.

The adapter must not collapse “early maps,” “bossing,” and “mirror tier”
into fake character levels merely to fit the schema.

### Native-to-`.build` loss map

| Native feature | Projection |
|---|---|
| Plan name, author, description, link | Direct when valid; one link only |
| Selected route | Run-collapsed into one file |
| Other branches | Omitted; offer one file per leaf |
| Class | Inferred by the client from ascendancy/tree; no direct official field |
| Final ascendancy | Direct through internal ID mapping |
| Earlier ascendancies | Passives plus valid hover guidance; report approximation |
| Passive allocations | Direct after graph/table ID translation |
| Allocation specialization | Official weapon set 0–2 only |
| Exact acquisition level | Level interval when known |
| Skill identity/supports | Direct, except unsupported meta gems |
| Gem level, quality, variant, enabled state, slot | Omitted or described in hover text |
| Full item | Unique name if verified; otherwise slot hint and generated hover summary |
| Rare base and mods | Human-readable `additional_text`, not structured |
| Flasks, charms, jewels | Only if an official inventory ID exists; tree jewel allocation remains a passive |
| Cluster-jewel generated subgraph | Only official passive IDs the PoE2 format recognizes; PoE1 is not supported |
| Actors | Omitted |
| Guide chapters and rich native markup | Summary/hover text subset |
| Patch and provenance | Omitted |

Generated hover summaries should prioritize information the official
format otherwise loses, but remain within a configurable length budget.

### Import behavior

An official file imports into one linear native route:

1. Validate the JSON and known field types.
2. Translate official passive, gem, unique, and inventory IDs through the
   PoE2 profile.
3. Collect every interval boundary without clamping legal level 0.
4. Construct complete states for each meaningful boundary.
5. Preserve all `additional_text`.
6. Default missing gem level/quality only as an explicitly inferred native
   value, not as data claimed by the source.
7. Put unknown fields and unresolved IDs in the report.
8. Preserve author/link/provenance.

Import should never depend on a current browser page's selected class or
other ambient editor state.

### Future PoE1 `.build`

There is no official PoE1 `.build` schema today. We should not pre-label
the current PoE2 adapter as universal or invent a PoE1 file.

If GGG adds PoE1 support:

1. snapshot the published schema as a new adapter fixture;
2. compare it field-by-field with PoE2;
3. share parser primitives only where the schemas are actually identical;
4. implement PoE1 ID and inventory translation through the PoE1 profile;
5. add golden files produced by the game;
6. expose the adapter only after an import/export smoke test in that game.

The shared Export menu makes this addition small without assuming the
future format is identical.

## PoB import

PoB import is a natural extension for both games, but Buildwright imports
the authored build story—not become a browser-hosted clone of either PoB.

Reference implementation and format behavior should be studied from the
[Path of Building Community repository](https://github.com/PathOfBuildingCommunity/PathOfBuilding)
and the separate
[Path of Building 2 Community repository](https://github.com/PathOfBuildingCommunity/PathOfBuilding-PoE2).
No PoB source code or GGG assets need to be copied into this repository.

Both applications currently serialize the same broad set structure and
share-code envelope. Buildwright therefore owns one bounded decoder/parser
and one review workflow. The active `GameProfile.pathOfBuilding` adapter
owns exact slot vocabulary, numbered-slot capacity, target-version safety,
actor legality, and whether jewel-cluster expansion exists. The source
format never selects the active game implicitly.

### Implemented inputs

The local adapter accepts:

- a PoB share code;
- a PoB XML or `.pob` file;
- a `pobb.in` URL resolved through its raw endpoint.

All three inputs are also available through the Rust-owned inspect/import
commands. The CLI and browser do not maintain separate PoB implementations.

A remote URL is fetched by a server-side function with a clear user agent,
timeouts, size limits, and an allowlist. Buildwright does not scrape the
rendered page.

Share codes are decoded with strict compressed and decompressed size
limits. XML parsing forbids external entities, DTD expansion, and network
resolution.

The Cloudflare browser resolver is deliberately a single-purpose
`https://pobb.in/<code>` boundary: it rejects alternate schemes, hosts,
ports, credentials, query strings, fragments, extra path components, and
upstream redirects. The Rust CLI applies the same URL and response bounds
directly. The ordinary static local server does not execute the Cloudflare
function, so local browser testing uses pasted code/XML or a local file.

### What a PoB file actually contains

PoB stores independent sets rather than an explicit universal timeline:

- build identity, class, ascendancy, level, and calculated player stats;
- passive-tree specs;
- skill sets and skill groups;
- item sets, item text, equipped slots, jewels, and weapon swaps;
- configuration sets;
- notes, calculation state, tree-view state, party data, and import
  provenance.

In current PoB behavior, loadouts are inferred from those independent
sets:

1. tree specs drive the candidate loadout list;
2. matching titles connect tree, item, skill, and configuration sets;
3. a section containing only one set is shared by all loadouts;
4. brace identifiers such as `{mapping}` can link sets whose visible titles
   differ;
5. one title may contain more than one comma-separated identifier.

The importer must reproduce these linking semantics. Merely zipping arrays
by index will construct the wrong builds.

### Normalization algorithm

```text
decode and safely parse
  → index every independent set and special link identifier
  → resolve candidate PoB loadouts
  → broadcast single-set sections where PoB does
  → classify player sets vs actor-only sets
  → normalize each candidate to one complete CharacterState
  → infer possible branches, never chronology
  → show import review + compatibility report
  → persist only after user confirmation
```

Tree, skills, inventory, and configuration are resolved immediately into a
complete state. Buildwright does not preserve live inheritance back to a
PoB set.

Item-only sets referenced as minion equipment become actor loadouts—for
example Animate Guardian gear—not player timeline states.

### PoB field map

| PoB section | Native result | Initial unsupported behavior |
|---|---|---|
| `Build` | class, ascendancy, character level, supported choices, provenance | Calculated `PlayerStat` values are omitted and reported |
| `Tree` / `Spec` | passive allocations, masteries, sockets, jewels, cluster configuration, supported overrides | Unresolved nodes/tattoos retained in report |
| `Skills` / `SkillSet` | skill groups, slots, gems, levels, quality, variants, enabled state | Calculation-only flags omitted |
| `Items` / `ItemSet` | player inventory, weapon swap, game-owned flask/charm slots, jewels, full item text | Unparsed lines and unsupported game slots retained in `sourceText` and report |
| Minion/companion item set | matching profile-owned `ActorLoadout` | Unknown or illegal actor relationship reported |
| `Config` / `ConfigSet` | loadout linking; selected semantic choices where modeled | Combat calculation toggles omitted |
| `Notes` | plan guide or state descriptions | PoB markup normalized as plain text initially |
| `Import` | provenance | Credentials/private state never retained |
| `TreeView` | none | Omitted |
| `Calcs` | none | Omitted |
| `Party` | none initially | Omitted |

“Omitted” means listed in the compatibility report. It never means silently
discarded.

### Timeline and branch inference

PoB set titles and array order are not guaranteed to be chronological.
The importer therefore creates candidate states and a review screen.

Safe behavior:

- preserve source order as display order;
- match explicit level ranges such as `Lvl 1-12`;
- propose common phase labels such as “Early maps” or “Endgame”;
- recognize alternative markers such as `HC`, `SC`, `Bossing`, or
  `Mapping` as possible branches;
- show every inference before saving;
- never silently reorder states or choose the “best” build.

If no reliable progression exists, import states as siblings under a small
imported root and let the author arrange them. A useful PoB import does not
require pretending every profile is a timeline.

### What we deliberately strip

The initial importer strips:

- cached DPS, EHP, and other calculated result values;
- combat-configuration toggles with no Buildwright semantic equivalent;
- UI layout and panel state;
- unsupported party simulation;
- script/runtime state;
- unknown data that cannot be safely parsed.

It retains the existence and source path of every stripped field in the
report. This is analogous to `pobb.in` rendering the useful authored
surface without adopting all PoB calculations, but our output becomes
editable native states and replayable branches.

## Test fixtures and conformance

Interop work is not complete without committed, license-safe text fixtures:

- the official minimal `.build` example shape;
- bare-string passives, skills, and supports;
- all interval forms, including 0 and weapon set 0;
- every inventory ID Buildwright exports;
- valid nested official markup;
- a round trip that proves graph ID ↔ table ID translation;
- unknown future fields on import;
- forbidden Buildwright extensions on strict export;
- multiple route runs and one removed/re-added entity;
- sanitized hostile/oversized PoB inputs;
- PoB single-set broadcast, exact-title linking, brace linking, and
  unmatched-set reporting.
- PoB2 charms, two-flask capacity, companions, tree jewels, and explicit
  reporting for unsupported future inventory positions.

Golden tests compare semantic output and exact strict-export JSON. Native
round trips are lossless; external round trips are evaluated against the
declared compatibility report, not assumed to be lossless.
