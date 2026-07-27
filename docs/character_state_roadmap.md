# Character-state delivery roadmap

> Status: **implemented through the native state graph, shared timeline,
> reviewed imports, rich items, and actor loadouts**.
>
> This sequence keeps existing version-2 plans usable throughout the work.
> Each phase is independently reviewable and has an explicit user-test
> gate before any public deployment.
>
> Checkpoint (2026-07-27): Phases 0–3, 5, and 6 are implemented and
> browser-tested. Phase 4 is code-complete and awaiting an in-client
> `.build` smoke test. The PoB import was exercised with both the committed
> license-safe PoE1/PoE2 fixtures and a real 13-profile PoE1 user build.
> Rust-owned reviewed-import commands now cover both PoB games and official
> PoE2 `.build`, using the same adapters and validators as the browser.
>
> Companion documents:
> [native state architecture](character_state_architecture.md) and
> [external-format audit and adapters](interop_strategy.md).

The work should ship vertically rather than as one large rewrite. The
native state graph comes first; external formats adapt to it only after its
behavior is stable.

## Phase 0 — freeze the current contracts

Status: **implemented**.

Goal: make the existing behavior measurable before changing storage.

Work:

- add representative version-2 plan fixtures for both games;
- cover passives, skills, full items, jewels, PoE1 cluster jewels, flasks,
  PoE2 charms, weapon sets, notes, and ascendancy changes;
- record replay behavior and local-backup round trips;
- add an inventory of every module that reads `captures`,
  `activeCapture`, `levelRange`, or the PoE2-named window/events;
- separate current contract docs from proposed version-3 docs.

Exit gate:

- fixtures load on both generated planner pages;
- native backup restores byte-equivalent authored facts;
- current replay has a browser smoke test;
- no GGG art or extracted game assets are introduced into git.

## Phase 1 — typed game profiles and data providers

Status: **implemented**.

Goal: one shared UX whose behavior is supplied entirely by the active game.

Work:

- define `GameDefinition`, `GameDataProvider`, `GameRules`, and
  `GameIntegrations`;
- move slot groups, counts, accepted categories, labels, skill model,
  point rules, tree rules, and capabilities out of `gameId` branches;
- make native sharing a common capability and `.build` a PoE2 integration;
- normalize PoE1 and PoE2 catalogues behind the same provider interfaces;
- preserve source provenance and deterministic fallback priority;
- derive agent capabilities from the same profile inputs rather than
  maintaining unrelated manifests;
- introduce Buildwright-named plan services/events with compatibility
  aliases for the old PoE2 names.

Likely surfaces:

- `crates/tree_render/assets/planner/game.ts`
- `crates/tree_render/src/main.rs`
- `viewer/assets/wizard_chrome.ts`
- skills and gear overlays
- PoE1/PoE2 agent schemas and capability generation
- generated page descriptors

Exit gate:

- shared components contain no PoE1/PoE2 slot-count branches;
- switching only the profile renders the correct equipment, flask, charm,
  jewel, skill, and tree rules;
- the two games retain the same appearance and interaction structure;
- catalogue-source conflict tests pass.

## Phase 2 — version-3 state graph behind an adapter

Status: **implemented**.

Goal: introduce the new model without immediately rewriting every consumer.

Work:

- add v3 types, validation, normalization, and immutable copy helpers;
- implement v2 → v3 migration and v3 native backup;
- provide a temporary linear-capture view over a v3 route for old
  consumers;
- replace numeric `activeCapture` ownership with stable `activeStateId`;
- make every state editable;
- add create-child, create-branch, duplicate, reorder, delete-subtree, and
  explicit reparent operations;
- keep persistence transactional: validate a complete candidate before
  replacing the stored plan.

Likely surfaces:

- `types/shared.d.ts`
- `viewer/assets/wizard_chrome.ts`
- `crates/tree_render/assets/planner/wizard_sync.ts`
- `crates/tree_render/assets/planner/build_io.ts`
- local storage, index summaries, backup import/export
- agent API normalization

Exit gate:

- all v2 fixtures migrate without authored-data loss;
- opening a v2 plan alone does not overwrite it;
- save/reload of v3 preserves stable state IDs and branches;
- deleting/reparenting never mutates an unrelated state;
- both games use the same graph operations.

## Phase 3 — state timeline and route replay

Status: **implemented**. Optional recommended level ranges remain
guidance and are kept distinct from exact character levels.

Goal: expose the new mental model and retain replay as a signature feature.

Work:

- replace level-range chips with state cards and visible branch connections;
- add phase, optional character level, and optional recommended range;
- add selected/default route controls;
- implement the route cursor and computed transition service;
- update tree, skills, items, flasks, charms, jewels, and actors from the
  same replay frame;
- support optional exact-level detail when `acquiredAtLevel` exists;
- preserve and restore editor/camera/panel state around read-only replay;
- update guide generation to group by state and show parent-to-child diffs.

Likely surfaces:

- `viewer/assets/wizard_chrome.ts` and CSS
- `crates/tree_render/assets/planner/level_slider.ts`
- render/selection state
- skills and gear overlays
- guide generation and hover linking

Exit gate:

- a route with leveling, early endgame, late endgame, and aspirational
  states replays deterministically;
- two states at the same character level remain distinct;
- switching leaves preserves the common ancestor and changes only the
  divergent route;
- replay never persists partial frames;
- exit restores the exact editor state.

## Phase 4 — strict PoE2 `.build` adapter

Status: **implemented; current-client import is the remaining exit
gate**.

Goal: align completely with the live official schema before adding more
external formats.

Work:

- mine and emit `PassiveSkills.Id` alongside graph IDs;
- add bidirectional passive translation, including attribute variants;
- add official inventory and verified unique-name mappings;
- accept bare root skill strings and weapon set 0;
- preserve legal level-0 intervals on import;
- remove all Buildwright-only fields from strict exports;
- implement brace-based official markup generation;
- project one selected route and show its compatibility report;
- refresh local `.build` documentation for subscriptions, upload, and the
  file watcher.

Likely surfaces:

- native data miner and tree TSV/meta shape
- tree renderer emitted runtime data
- `types/poe2.d.ts`
- `build_schema.ts`, `build_io.ts`, and their tests
- export UI

Exit gate:

- official examples import with resolved passives and skills;
- strict exports contain no undocumented keys;
- exported files load in the current PoE2 client during local user testing;
- branches and native-only fields are reported, never silently flattened;
- live GGG docs and changelog have been re-audited.

## Phase 5 — richer native items and actors

Status: **implemented and browser-tested locally**. Actor kinds, legal
equipment positions, and source catalogues remain profile-owned while both
games use the same actor and rich-item editor.

Goal: make imported and authored states preserve useful build facts without
requiring a calculation engine.

Work:

- migrate string mod lists to typed mod records with loss-preserving text;
- formalize equipment/flask/charm/jewel placement;
- add stable item instance IDs for replay diffs;
- introduce actor loadouts;
- support PoE1 mercenary and Animate Guardian equipment when first-party
  and UI requirements are understood;
- generate human-readable `.build` inventory hints from rich native items.

Exit gate:

- current item fixtures migrate without losing displayed names or mods;
- item swaps diff by slot and instance;
- player and actor inventories cannot be mixed accidentally;
- PoE1 and PoE2 still use the same item-editor components.

## Phase 6 — PoB import preview

Status: **implemented and browser-tested locally**. Raw code/XML and the
full review/import/persistence flow are tested through the static local
planner. The allowlisted `pobb.in` Pages resolver is unit-tested locally;
the static server deliberately asks local testers to paste a code or choose
a file because it does not execute Cloudflare Functions.

Goal: turn PoB profiles into editable Buildwright states and branches.

Work:

- implement bounded share-code/XML decoding;
- resolve a `pobb.in` URL through a safe raw-fetch server function;
- parse independent tree, skill, item, and configuration sets;
- reproduce title, single-set broadcast, and brace-identifier linking;
- map minion item sets to actor loadouts;
- normalize each candidate to a complete state;
- add an import-review screen for order, phases, branches, and omissions;
- preserve source text and produce the compatibility report;
- deliberately omit calculation results and unsupported toggles.

Scope:

- one bounded PoB parser and review UX for both games;
- profile-owned PoE1/PoE2 slot, actor, target-version, and jewel rules;
- import only;
- no PoB export;
- no DPS/EHP parity promise.

Exit gate:

- fixtures cover multiple profiles, shared sets, brace links, weapon swaps,
  jewels/cluster jewels, flasks, and Animate Guardian gear;
- malformed or hostile payloads fail safely;
- unmatched sets are visible;
- no inferred chronology is persisted without review;
- the imported plan no longer depends on PoB or `pobb.in`.

Local checkpoint:

- bounded URL-safe base64/deflate and XML parsing reject oversized,
  malformed, DTD, and entity-declaration inputs;
- PoB's exact-title, brace identifier, and single-set broadcast behavior is
  reproduced from the Community Fork source behavior;
- independent profiles default to sibling branches and can become a linear
  route only through an explicit review choice;
- rich player items, five flasks, weapon swaps, tree jewels, cluster
  structure, skills, masteries, notes, and supported Animate Guardian
  equipment normalize into complete v3 states;
- PoB2 charms, two-flask capacity, companions, items, skills, and tree
  jewels normalize through the same workflow without enabling PoE1 cluster
  expansion or flattening unsupported PoB2 inventory positions;
- raw item blocks, unmatched sets, unsupported Abyss sockets, configuration
  inputs, and calculation omissions remain visible in the final report;
- a real 13-profile build normalized to 14 native states (including the
  synthetic branch root), 143 player placements, 68 skill groups, and three
  state-owned actor instances with zero v3 validation errors.

## Phase 7 — public hardening

Status: **in progress locally**. Runtime input validation, shared
browser/CLI adapters, full repository tests, both-game rebuilds, and data
integrity gates are implemented; performance and accessibility passes remain.

Goal: make the new architecture safe for existing and newly shared plans.

Work:

- performance-test large state trees and replay-diff caches;
- accessibility-test branch navigation and playback controls;
- add telemetry-free local diagnostics for profile/source resolution;
- document backup and downgrade behavior;
- retain a v2 read path for a defined compatibility window;
- verify generated assets and licensing boundaries;
- update public API/agent docs only after contracts stabilize.

Exit gate:

- full repository tests pass;
- both games complete the same end-to-end authoring checklist;
- local builds are rebuilt and served for user approval;
- user approves before push, PR, merge, or deployment;
- Cloudflare deployment occurs only from the approved merged revision.

## Cross-cutting verification matrix

Every implementation phase should test the same scenarios in both games
where the game supports them:

| Scenario | PoE1 | PoE2 |
|---|---:|---:|
| Create/edit/duplicate state | Required | Required |
| Branch and switch route | Required | Required |
| Replay tree/skills/items | Required | Required |
| Normal equipment | Required | Required |
| Flask belt | 5 positions | 2 positions |
| Charms | Not applicable | Required |
| Ordinary jewels/radius | Required | Required |
| Cluster jewels | Required | Not applicable unless game adds them |
| Skill links/Spirit | Links | Spirit |
| Weapon specializations | Profile-defined | Required |
| Native backup/share | Required | Required |
| Official `.build` | Not available today | Required |
| PoB import preview | Required | Required |

“Not applicable” must be a profile result, not a separate component or a
hidden `gameId` conditional in shared UX.

## Key risks and mitigations

| Risk | Mitigation |
|---|---|
| Rewriting storage and UI together makes regressions hard to isolate | Introduce v3 behind adapters, then switch consumers phase by phase |
| Branches make replay ambiguous | Replay always has an explicit selected leaf/route |
| Level metadata becomes fake ordering | State order is explicit; level remains optional metadata |
| Profiles become large bags of flags | Separate serializable definition, normalized data provider, executable rules, and integrations |
| Different data sources drift | Normalize at generation time, retain provenance, first-party wins, add conflict fixtures |
| External formats leak into native types | All translation lives at adapter boundaries |
| PoB scope turns into calculation-engine scope | Import authored facts; report and omit computed results |
| `.build` silently loses native branches/details | Mandatory pre-export compatibility report |
| A migration corrupts local-only plans | Non-destructive read, transactional write, native backup, fixtures from real v2 shapes |

## Decisions to revisit after the mapping phase

These do not block the architecture, but should be decided before their
implementation phase:

1. Whether the initial timeline control is a compact branch rail, a state
   card strip, or both at different widths.
2. Whether `defaultLeafId` is chosen per shared link or persisted only on
   the plan.
3. Which PoB semantic configuration choices are useful enough to model.
4. The exact actor types enabled first.
5. Whether exporting every leaf as a `.build` ZIP is valuable after
   single-route export ships.
6. How long v2 writes remain supported after v3 becomes the default.

None changes the key boundaries: complete native states, explicit routes,
shared UX, profile-owned game rules, and report-driven adapters.
