# Character-state architecture

> Status: **implemented through the native state graph, shared
> timeline/replay, strict PoE2 adapter, rich items, and actor loadouts**.
>
> The branch persists version 3 transactionally and exposes a temporary
> version-2 route projection to older UI consumers. Existing version-2 plans
> are migrated in memory and are not overwritten until a successful save.
> [captures_data_model.md](captures_data_model.md) remains the compatibility
> contract, not the native source of truth.
>
> Companion documents:
> [external-format audit and adapters](interop_strategy.md) and
> [phased delivery roadmap](character_state_roadmap.md).

This proposal turns the current level-range captures into a general
character-state timeline. It preserves the feature that makes Buildwright
different—a build can be replayed from its earliest form to any later form—
while allowing the authored steps to mean more than character levels.

The central rule is:

> Buildwright owns one lossless, game-neutral plan. PoE1, PoE2, GGG
> `.build`, and future PoB support are profiles and adapters around that
> plan; none of them defines the native model.

## Product decisions

The following are decisions, not open questions:

1. PoE1 and PoE2 use the same page structure, controls, state cards,
   timeline, guide, item editor, and replay language.
2. Game profiles provide the rules, slots, labels, catalogues, assets, and
   interoperability available to those shared components.
3. A timeline entry is a complete character state. It is not a delta and
   does not inherit mutable data from its parent.
4. Character level is useful metadata, but it is not the identity or sort
   key of a state.
5. The timeline may branch. Replay follows one selected root-to-leaf route.
6. The native `.buildwright.json` remains the lossless backup and sharing
   format.
7. GGG `.build` and PoB are imported and exported through explicit
   adapters with a compatibility report.
8. We do not become a calculation engine as a prerequisite for PoB import.
   Unsupported calculations are intentionally omitted rather than
   represented as stale truth.

## Terminology

| Term | Meaning |
|---|---|
| Plan | The complete authored build, including every state and branch. |
| State | A self-contained keyframe containing the character at one useful point in its progression. |
| Transition | A computed difference between a parent state and a child state. |
| Branch | Two or more states with the same parent, representing alternatives. |
| Route | The ordered ancestor chain from the root to one selected state or leaf. |
| Replay frame | One state boundary, or an optional level step inside a state when exact acquisition data exists. |
| Game profile | The data sources, rules, presentation facts, and integrations for one game. |
| Adapter | A translator between the native plan and an external format. |

## Proposed persisted model

The names below describe the implemented contract in `types/shared.d.ts`
and `viewer/assets/plan_v3.ts`. Small spelling differences in the concrete
types do not change these semantics and invariants.

```ts
interface BuildwrightPlanV3 {
  format: "buildwright-planner-plan";
  version: 3;
  id: string;
  game: "poe1" | "poe2";
  patch: string | null;
  savedAt: string;

  identity: {
    name: string;
    description: string;
    author?: string;
    links?: Array<{ label?: string; url: string }>;
  };

  states: CharacterState[];
  rootStateId: string;
  activeStateId: string;
  defaultLeafId: string;

  guide?: string;
  provenance?: PlanProvenance[];
}

interface CharacterState {
  id: string;
  parentId: string | null;
  order: number;

  name: string;
  description: string;
  phase:
    | "leveling"
    | "early-endgame"
    | "endgame"
    | "aspirational"
    | "custom";

  characterLevel?: number;
  recommendedLevelRange?: [number, number];

  character: {
    class: string | null;
    ascendancy: string | null;
    // Profile-owned choices such as PoE1 bandits and pantheon.
    choices?: Record<string, unknown>;
  };

  passiveTree: PassiveTreeState;
  skills: SkillLoadout;
  inventory: InventoryState;
  actors: ActorLoadout[];

  gameData?: Record<string, unknown>;
  provenance?: StateProvenance;
}
```

`activeStateId` is an editor pointer and may name any state. There is no
special “last state is mutable” rule. `defaultLeafId` selects the route
shown when a shared plan first opens; it is independent of the editor
pointer.

### Passive tree

```ts
interface PassiveTreeState {
  allocations: PassiveAllocation[];
}

interface PassiveAllocation {
  nodeId: string; // Buildwright graph/runtime id for this game and patch
  specialization?: "main" | "set1" | "set2" | string;
  optionId?: string;
  note?: string;
  acquiredAtLevel?: number;
}
```

The native ID remains the ID Buildwright uses to draw and validate the
tree. External IDs are translated by adapters. In particular, a PoE2
`.build` `PassiveSkills.Id` must not replace Buildwright's
`PassiveSkillGraphId` in this model.

Game rules validate reachability, point budgets, ascendancy rules, weapon
specializations, jewel placement, and generated cluster subgraphs.
The shared model does not hard-code PoE1 or PoE2 tree behavior.

`acquiredAtLevel` is optional. When present, it enables exact level-by-level
replay. When absent, Buildwright displays the allocation at the state
boundary and does not invent a level.

### Skills

```ts
interface SkillLoadout {
  groups: SkillGroup[];
}

interface SkillGroup {
  id: string;
  label?: string;
  slot?: string;
  specialization?: string;
  enabled?: boolean;
  gems: GemSocket[];
  note?: string;
}

interface GemSocket {
  id: string;
  gemRef: EntityRef;
  role: "active" | "support" | "meta" | "granted";
  level?: number;
  quality?: number;
  variant?: string;
  enabled?: boolean;
  note?: string;
}
```

One shared editor renders these groups. The profile decides whether a group
is constrained by PoE1 item links, PoE2 supports and Spirit, weapon sets,
meta-gem rules, or other game-specific constraints.

### Inventory and items

```ts
interface InventoryState {
  items: EquippedItem[];
}

interface EquippedItem {
  id: string; // stable instance id for diffs and replay
  slot: {
    group: "equipment" | "flask" | "charm" | "jewel" | string;
    id: string;
    set?: string;
    x?: number;
    y?: number;
  };
  item: ItemSpec;
  note?: string;
  acquiredAtLevel?: number;
}

interface ItemSpec {
  base?: EntityRef;
  rarity?: "normal" | "magic" | "rare" | "unique" | string;
  name?: string;
  unique?: EntityRef;
  itemLevel?: number;
  quality?: number;
  corrupted?: boolean;
  sockets?: ItemSocket[];
  mods?: ItemMod[];

  jewel?: {
    socketNodeId?: string;
    radius?: string;
    cluster?: ClusterJewelSpec;
  };

  sourceText?: string;
}

interface ItemMod {
  kind:
    | "implicit"
    | "explicit"
    | "enchant"
    | "crafted"
    | "fractured"
    | "scourged"
    | "desecrated"
    | "mutated"
    | "rune"
    | string;
  text: string;
  sourceId?: string;
  values?: number[];
}
```

The model separates slot placement from item identity. That lets the same
item editor serve normal gear, five PoE1 flask-belt positions, two PoE2
flask positions, PoE2 charms, and tree jewels without pretending that
those sections have identical game rules.

`sourceText` is a loss-preserving escape hatch for imported item text that
we can display but cannot yet parse. Parsed facts remain structured; the
raw text is not the authority for facts Buildwright understands.

```ts
interface ClusterJewelSpec {
  size: "Small" | "Medium" | "Large";
  smallPassive: EntityRef;
  passiveCount: number;
  jewelSocketCount: number;
  generatedNotables?: EntityRef[];
}
```

Cluster topology is derived from the item and the PoE1 profile's first-party
data. Generated nodes are a view of the socketed jewel, not ordinary
persisted main-tree nodes duplicated into every state.

### Other equipped actors

```ts
interface ActorLoadout {
  id: string;
  kind:
    | "mercenary"
    | "animate-guardian"
    | "companion"
    | "minion"
    | "custom";
  name: string;
  skills?: SkillLoadout;
  inventory?: InventoryState;
  notes?: string;
}
```

Actors prevent Animate Guardian equipment, PoE1 mercenary gear, or future
PoE2 companion data from being mixed into the player inventory. They are
generic in the native model but enabled and validated by each game profile.

### References and provenance

```ts
interface EntityRef {
  kind: "passive" | "gem" | "base" | "unique" | "mod" | "jewel" | string;
  key: string;        // Buildwright-normalized key
  name?: string;      // display fallback if the catalogue changes
}

interface PlanProvenance {
  source: "native" | "ggg-build" | "pob" | "pobb-in" | string;
  importedAt?: string;
  sourceUrl?: string;
  sourceVersion?: string;
}
```

Catalogues—not plans—record which source supplied a normalized entity. A
plan stores a Buildwright key plus a small display fallback, so moving an
entity from a PoB fallback catalogue to first-party GGG data does not
rewrite every plan.

Imported provenance is informative. It never changes validation or causes
Buildwright to depend on the original service after import.

## State graph invariants

Version 3 starts with a deliberately simple directed tree:

1. Exactly one state has `parentId: null`, and it is `rootStateId`.
2. Every other `parentId` names a state in the same plan.
3. Cycles are invalid.
4. A state has one parent and may have many children.
5. Sibling `order` values determine stable presentation order.
6. `activeStateId` names an existing state.
7. `defaultLeafId` names the root or one of its descendants.
8. Every state is independently renderable with no parent lookup.
9. Children do not mutate parent arrays or item instances.
10. A transition is always computed; persisted deltas are forbidden.

### Runtime trust boundary

The TypeScript type is not treated as runtime proof. Storage records,
uploaded backups, share payloads, PoB results, and official `.build` results
all pass through one validator stack:

```text
unknown JSON
  → explicit nested shape validation
  → game-neutral state/entity/graph invariants
  → selected GameProfile rules
  → transactional replacement or save
```

Shape validation runs first and must return errors rather than throw even
for arbitrarily malformed nested values. Game-specific validation is never
allowed to dereference a document until that gate succeeds. This same stack
is used by browser persistence and the Rust-owned interoperability commands.

Merges—one state with multiple parents—are deferred. They complicate
editing, replay, deletion, and provenance without solving a required
product case. Authors can duplicate a state when two alternatives later
converge.

## Authoring semantics

A state answers “what does the character look like here?” Examples:

- Act 1 leveling
- First lab
- Campaign finish
- Early maps on cheap gear
- Defensive bossing variant
- Late-game farming variant
- Aspirational or mirror-tier setup

Creating a child deep-copies the current state, assigns a stable ID, and
records the parent. Editing any state edits only that keyframe. Creating a
branch is the same action as creating a child when the parent already has
another child.

Deleting a state with children requires an explicit operation:

- delete the whole subtree, or
- reparent its children to the deleted state's parent after validation.

There is no implicit range merge comparable to version 2.

## Replay semantics

Replay is a first-class view of the state graph, not an animation bolted
onto the level slider.

### Route selection

The user chooses a state or leaf. Buildwright walks its ancestors to the
root and obtains an ordered route:

```text
Campaign → Early maps → Late-game mapper
                       ↘ Pinnacle bosser
```

Switching from mapper to bosser changes the route after their common
ancestor. Shared history is not replayed twice.

### Frames and cursor

The replay cursor is:

```ts
interface ReplayCursor {
  routeStateIds: string[];
  stateIndex: number;
  level?: number;
}
```

The primary axis is the discrete state index. Character level is a
secondary axis used only when a state or its allocations have meaningful
level metadata. This preserves separate “early maps” and “gear upgrade”
frames even when both are level 90.

At a state boundary, Buildwright computes:

- added, removed, and retained passive allocations;
- changed passive options or specializations;
- added, removed, replaced, and modified skill groups;
- equipment, flask, charm, and jewel changes by stable slot and item ID;
- actor changes;
- class, ascendancy, phase, and guide changes.

Tree changes may animate node-by-node. Skills, items, and actors change
atomically at the boundary and can use diff highlighting. The stored state
is never partially mutated to drive playback.

### Level-detail replay

If `acquiredAtLevel` is present, allocations or items may appear during the
level portion of a state. If it is absent, the element appears at the state
boundary. The UI must communicate “known at this state” separately from
“known to be acquired at this exact level.”

This avoids the version-2 assumption that passive array position always
equals level and that every possible passive point was spent immediately.
Point availability comes from the game profile, including quest rewards,
ascendancy points, weapon specializations, or later rule changes.

### Replay safety

Entering replay captures the editor state and makes the route read-only.
Exiting replay restores the exact `activeStateId`, selected equipment set,
camera, and open panel. Playback must not write persistence events.

Computed transition caches are keyed by parent state ID, child state ID,
and their content revisions. A cache miss changes performance, never
behavior.

## One UX, two game profiles

The current embedded descriptor is a useful start, but it still mixes
assets with hard-coded `gameId` branches. Version 3 promotes it into a
typed profile with four responsibilities:

```ts
interface GameProfile {
  definition: GameDefinition;       // serializable facts
  data: GameDataProvider;           // normalized catalogues
  rules: GameRules;                 // validation and derived behavior
  integrations: GameIntegrations;   // external adapters
}
```

### Serializable definition

`GameDefinition` owns labels and declarative layout facts:

- game ID, display name, current patch, and storage namespace;
- shared panel order and enabled sections;
- equipment, flask, charm, and jewel slot groups;
- supported character phases;
- class and ascendancy catalogue references;
- passive-tree asset references;
- skill socket model;
- native sharing availability;
- feature flags whose absence has a safe explicit default.

Slot definitions include their stable ID, visible label, group, repeat
count, accepted item categories, and optional set. Shared components render
the returned arrays. They never ask `if (gameId === "poe1")`.

### Normalized data provider

```ts
interface GameDataProvider {
  passives: Catalogue<PassiveRecord>;
  skills: Catalogue<SkillRecord>;
  items: Catalogue<ItemRecord>;
  mods: Catalogue<ModRecord>;
  classes: Catalogue<ClassRecord>;
}
```

Each catalogue merges ordered sources into one normalized schema. A source
adapter declares its coverage and priority:

```text
first-party GGG extraction
  → supported community fallback for missing records
  → author-entered display fallback
```

PoE1 and PoE2 may use completely different source adapters while the item
picker consumes the same `Catalogue<ItemRecord>` interface. Source
provenance stays attached to catalogue records for debugging and audits.

A fallback may fill a missing record; it may not silently overwrite a
first-party fact. Conflicts are recorded during data generation and covered
by fixtures.

### Executable rules

`GameRules` owns behavior that cannot be expressed as labels:

- passive and ascendancy point availability by level and quest state;
- pathing and allocation validity;
- weapon specialization rules;
- skill/socket/link/Spirit constraints;
- item-to-slot compatibility;
- PoE1 cluster-jewel topology;
- jewel-radius behavior;
- flask, tincture, and charm restrictions;
- legal actor types;
- state validation and patch migration.

The shared UI asks for results such as `validateItemPlacement`,
`availablePassivePoints`, or `describeSkillCapacity`. It does not reproduce
those rules.

### Integrations

Native backup and share links are Buildwright capabilities and should be
available to both games. External interoperability is separate:

- PoE2 profile: official GGG `.build` adapter.
- PoE1 profile: no official `.build` adapter until GGG publishes one.
- PoE1 and PoE2 profiles: reviewed PoB code/XML/file import through one
  parser and review UX, with separate slot, actor, version, and jewel
  policies.
- The allowlisted `pobb.in` raw resolver is source acquisition only; it
  never chooses a target game or bypasses the active profile.

The Export menu is shared and lists the adapters supplied by the active
profile. This avoids using “share” as a proxy for “supports `.build`.”

## Boundaries and dependency direction

```text
Shared components
    ↓
Native plan/state services
    ↓
GameProfile interfaces
    ↓
PoE1 or PoE2 profile
    ↓
First-party and fallback source adapters

External file or URL
    ↓
Interop adapter
    ↓
Native plan + compatibility report
```

External adapters may depend on native types and game profiles. Native
state, replay, and components must not import an external-format type.

The browser and CLI share adapter modules. Rust owns source acquisition,
permissions, command names, and file output; it does not shell out to
project scripts that contain a second parser. Generated browser bundles are
also built by `./bw js`, with `scripts/build_js.sh` retained only as a thin
compatibility shim.

The current `window.PoE2Game`, `window.PoE2Plan`, and
`poe2-capture-change` names should move behind Buildwright-named services
and events. Compatibility aliases remain for one migration cycle so
generated pages and old local data do not break together.

## Version-2 migration

Migration is deterministic and lossless for data version 2 currently
stores:

1. Create one state for each capture, preserving stable capture IDs where
   valid.
2. Link states linearly in current array order.
3. Set phase to `leveling` unless an explicit, reviewed name heuristic
   chooses otherwise. Heuristics never alter data.
4. Carry `levelRange` into `recommendedLevelRange`.
5. Use the range high point as `characterLevel` only when it was a
   meaningful authored boundary.
6. Deep-copy passives, skills, items, class, ascendancy, descriptions, and
   notes.
7. Convert current `level` stamps into `acquiredAtLevel`.
8. Preserve current item strings in structured fields or `sourceText`;
   never discard an unparsed mod.
9. Make the first capture the root, the current active capture the active
   state, and the last capture the default leaf.
10. Record migration provenance and keep the original backup available
    until the version-3 write succeeds.

The first version-3 loader should read both v2 and v3. It should never
rewrite a stored v2 plan merely because the user opened it; migration is
persisted only after a successful edit/save or explicit conversion.

## Intentionally deferred

- A PoB-compatible damage or defense calculation engine.
- State graph merges.
- Collaborative multi-author editing.
- Automatic chronological ordering of imported PoB sets.
- Persisted transition deltas.
- Making an external format the canonical save.

These may be valuable later, but none is required to deliver the shared
state timeline.
