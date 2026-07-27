// shared.d.ts — game-agnostic type declarations for the planner + wizard
// frontends. One planner codebase serves both games; the ownership rule
// for these files is:
//
//   • shared.d.ts — everything both games consume: the persisted plan
//     contracts, the TREE runtime shape's core, and the window bridges
//     the wizard/planner always expose.
//   • poe1.d.ts  — PoE1-only surface (the in-place ascendancy
//     presentation fields emit.rs bakes for --game poe1).
//   • poe2.d.ts  — PoE2-only surface (GGG .build interop, jewels,
//     gems, share).
//
// A new field goes in the narrowest file that covers its consumers —
// never copy a declaration between them. TreeData composes the per-game
// extras below so runtime code can keep reading one `TREE` object.
//
// Update rules:
//   • Mirror the shape that actually exists on disk + at runtime. If
//     you change a field's name/type in code, change it here in the
//     same commit — otherwise tsc lies to you.
//   • Optional (?) fields are persisted only when set, so loaders need
//     to tolerate `undefined`.

import type { Poe1TreeData } from "./poe1.d.ts";
import type { Poe2TreeData } from "./poe2.d.ts";

// ===========================================================================
// Plan data contracts (persisted, version 2)
// ===========================================================================

/** Local-storage plan format tag. Bump PLAN_VERSION when the on-disk shape
 *  changes incompatibly; older plans return null from loadPlan() and the
 *  caller mints a fresh one. */
export type GameId = "poe1" | "poe2";
export type PlanFormat = "poe2-planner-plan" | "buildwright-planner-plan";
export type PlanVersion = 2;

/** A single passive-tree allocation inside a capture. `set` distinguishes
 *  main-tree vs weapon-set 1/2 allocations (PoE2 lets you pick different
 *  tree paths per equipped weapon set; PoE1 pages only ever use 'main'). */
export interface Allocation {
  id: string; // passive node id
  set?: "main" | "set1" | "set2"; // default: 'main'
  note?: string; // user-authored per-node note
  attrVariantId?: string; // picked Str/Dex/Int variant id
  level?: number; // per-allocation level stamp (asc + set only)
  level_interval?: [number, number]; // transient — only on .build-import normalize stage
}

/** A skill entry inside a capture. Mirrors GGG's .build `BuildSkill` shape. */
export interface Skill {
  id: string; // gem id (e.g. 'Metadata/Items/Gems/SkillGemFireball')
  level: number; // gem level 1-20+
  quality?: number; // gem quality 0-20
  set?: "main" | "set1" | "set2";
  slot?: string; // PoE1 links model: item slot (helmet/body/…) that bounds support count
  note?: string; // optional gem note
  supports?: SupportGem[]; // attached support gems
  level_interval?: [number, number]; // transient — only on .build-import normalize stage
}

/** A support gem attached to a skill. `additional_text` in GGG-land. */
export interface SupportGem {
  id: string;
  level: number;
  quality?: number;
  note?: string; // BuildSupport.additional_text
}

/** Equipped item inside a capture. Shape evolves with the items overlay.
 *
 * The export pipeline (build_io.ts) needs the GGG-style positional
 * fields (`inventoryId` + `slotX/slotY`); the items overlay UI carries
 * the higher-level display fields (`name`, `slot`, `uniqueName`).
 * Both surface here optionally — call sites populate what's relevant.
 */
export interface Item {
  id?: string;
  name?: string;
  slot?: string;
  set?: "main" | "set1" | "set2";
  note?: string;
  // GGG-side positional fields, used by the .build round-trip.
  inventoryId?: string;
  slotX?: number;
  slotY?: number;
  uniqueName?: string;
  /** Exact `Words.Text` value verified against GGG's current native data.
   * `uniqueName` remains the authored/display label; only this verified
   * value may cross the official `.build` boundary. */
  officialUniqueName?: string;
  // Grounded composition (agent plans / base picker): the real
  // base-item name + rarity + the priority mods that matter. Drives
  // base art, rarity color and the hover text in the strip.
  base?: string;
  rarity?: string;
  mods?: string[];
  /** Rich native item facts carried through the temporary v2 editor view. */
  itemLevel?: number;
  quality?: number;
  corrupted?: boolean;
  sockets?: ItemSocketV3[];
  /** Original imported item block retained even when only part is parsed. */
  sourceText?: string;
  // Jewels only: the tree node id of the jewel socket this jewel sits
  // in (kind=jewel node). Unset = jewel exists but isn't placed yet.
  socket?: number;
  // PoE1 cluster jewels generate a real passive-tree subgraph. These
  // are structural item properties, separate from ordinary affixes:
  // the enchant-selected small passive, number of generated passives,
  // and its size-derived number of child jewel sockets. `sockets`
  // remains persisted so old plans stay readable, but is normalised
  // to Large=2, Medium=1, Small=0 by the current rules.
  cluster?: {
    size: "Small" | "Medium" | "Large";
    skill: string;
    nodeCount: number;
    sockets: number;
  };
  // Per-allocation level stamp + level interval (for items the author
  // marks as "swap in at level L"). Mirrors Allocation/Skill semantics.
  level?: number;
  level_interval?: [number, number];
}

/** A capture = cumulative snapshot of (passives + skills + items) at a
 *  specific level range. `levelRange = [lo, hi]` inclusive on both ends.
 *  The LAST capture in plan.captures is the "working" capture — the one
 *  that gets mutated when the user clicks on the tree. Earlier captures
 *  are frozen historical snapshots. */
export interface Capture {
  id: string; // stable per-capture id (genCapId())
  levelRange: [number, number];
  name: string | null; // user-authored short label ("L13-49: leech setup"), or null
  passives: Allocation[];
  skills: Skill[];
  items: Item[];
  ascendancy: string | null; // per-capture (changes via Oracle's "switch asc" mid-leveling)
  description: string;
  class?: string; // optional override of plan.class for this capture
  /** Transitional v3 route projection metadata. Old v2 files omit these. */
  characterLevel?: number;
  statePhase?: CharacterStatePhase;
  /** External adapter facts not understood by v2 UI consumers. */
  gameData?: Record<string, unknown>;
}

/** Top-level plan. The unit persisted at localStorage[KEY_PREFIX + id]. */
export interface Plan {
  id?: string; // stamped on persist
  format?: PlanFormat; // stamped on persist
  version?: PlanVersion; // stamped on persist
  savedAt?: string; // ISO 8601 timestamp on persist
  /** Authoritative game identity. New plans always carry it; loaders
   *  infer it from the page/legacy patch only while migrating old v2
   *  poe2-planner-plan files. */
  game?: GameId;

  name: string;
  description: string;
  /** Transitional identity fields retained while v2 consumers remain. */
  author?: string;
  links?: Array<{ label?: string; url: string }>;
  class: string | null; // top-level class; per-capture asc overrides
  patch: string | null; // game patch the plan was authored against ('0.4', 'poe1.3.26', ...)

  captures: Capture[]; // length >= 1; last entry = working capture
  activeCapture: number; // index into captures[]; -1 / OOB normalizes to last

  activeSet?: "main" | "set1" | "set2"; // currently-edited weapon set
  guide?: string; // free-text leveling guide (with @[type:id] tokens)
}

// ===========================================================================
// Proposed character-state contract (persisted version 3)
// ===========================================================================
//
// Version 2 remains the live editor contract until the migration adapter,
// state graph, and replay UI have all passed local testing. These types let
// that work proceed behind a pure conversion boundary without rewriting a
// user's stored plan merely because it was opened.

export type CharacterStatePhase =
  | "leveling"
  | "early-endgame"
  | "endgame"
  | "aspirational"
  | "custom";

export interface EntityRefV3 {
  kind: "passive" | "gem" | "base" | "unique" | "mod" | "jewel" | string;
  key: string;
  name?: string;
  /** Identifier owned by an external/native source when it differs from
   * Buildwright's stable key or display name. */
  sourceId?: string;
  /** Namespace that owns `sourceId` (for example `ggg` or `pob`). */
  source?: string;
}

export interface PassiveAllocationV3 {
  nodeId: string;
  specialization?: "main" | "set1" | "set2" | string;
  optionId?: string;
  note?: string;
  acquiredAtLevel?: number;
  availableAt?: [number, number];
}

export interface PassiveTreeStateV3 {
  allocations: PassiveAllocationV3[];
}

export interface GemSocketV3 {
  id: string;
  gem: EntityRefV3;
  role: "active" | "support" | "meta" | "granted";
  level?: number;
  quality?: number;
  variant?: string;
  enabled?: boolean;
  note?: string;
}

export interface SkillGroupV3 {
  id: string;
  label?: string;
  slot?: string;
  specialization?: string;
  enabled?: boolean;
  gems: GemSocketV3[];
  note?: string;
  availableAt?: [number, number];
}

export interface SkillLoadoutV3 {
  groups: SkillGroupV3[];
}

export interface ItemModV3 {
  kind: string;
  text: string;
  sourceId?: string;
  values?: number[];
}

export interface ItemSocketV3 {
  group: number;
  color?: string;
  kind?: "gem" | "abyss" | "rune" | string;
}

export interface ItemSpecV3 {
  base?: EntityRefV3;
  rarity?: string;
  name?: string;
  unique?: EntityRefV3;
  itemLevel?: number;
  quality?: number;
  corrupted?: boolean;
  sockets?: ItemSocketV3[];
  mods?: ItemModV3[];
  jewel?: {
    socketNodeId?: string;
    radius?: string;
    cluster?: {
      size: "Small" | "Medium" | "Large";
      smallPassive: EntityRefV3;
      passiveCount: number;
      jewelSocketCount: number;
      generatedNotables?: EntityRefV3[];
    };
  };
  sourceText?: string;
}

export interface EquippedItemV3 {
  id: string;
  slot: {
    group: "equipment" | "flask" | "charm" | "jewel" | string;
    id: string;
    set?: string;
    x?: number;
    y?: number;
    /** External inventory table id retained through v2 migration. */
    sourceId?: string;
  };
  item: ItemSpecV3;
  note?: string;
  acquiredAtLevel?: number;
  availableAt?: [number, number];
}

export interface InventoryStateV3 {
  items: EquippedItemV3[];
}

export type InventoryOwnerV3 =
  | { kind: "player" }
  | { kind: "actor"; actorId: string };

export interface ActorLoadoutV3 {
  id: string;
  kind: "mercenary" | "animate-guardian" | "companion" | "minion" | "custom";
  name: string;
  skills?: SkillLoadoutV3;
  inventory?: InventoryStateV3;
  notes?: string;
}

export interface CharacterStateV3 {
  id: string;
  parentId: string | null;
  order: number;
  name: string;
  description: string;
  phase: CharacterStatePhase;
  characterLevel?: number;
  recommendedLevelRange?: [number, number];
  character: {
    class: string | null;
    ascendancy: string | null;
    choices?: Record<string, unknown>;
  };
  passiveTree: PassiveTreeStateV3;
  skills: SkillLoadoutV3;
  inventory: InventoryStateV3;
  actors: ActorLoadoutV3[];
  gameData?: Record<string, unknown>;
  provenance?: {
    source: string;
    sourceId?: string;
  };
}

export interface PlanV3 {
  format: "buildwright-planner-plan";
  version: 3;
  id?: string;
  game: GameId;
  patch: string | null;
  savedAt?: string;
  identity: {
    name: string;
    description: string;
    author?: string;
    links?: Array<{ label?: string; url: string }>;
  };
  states: CharacterStateV3[];
  rootStateId: string;
  activeStateId: string;
  defaultLeafId: string;
  editor?: {
    activeSpecialization?: "main" | "set1" | "set2";
    /** Leaf whose root-to-leaf route is open in the editor. */
    routeLeafId?: string;
  };
  guide?: string;
  provenance?: Array<{
    source: string;
    importedAt?: string;
    sourceUrl?: string;
    sourceVersion?: string;
    /** SHA-256 of the exact PoB/.build source reviewed by the user. */
    sourceSha256?: string;
    /** SHA-256 of the exact approved review envelope. */
    reviewSha256?: string;
    /** Versioned shared adapter that produced this normalized state. */
    adapterVersion?: string;
    /** Patch manifest rollup whose ids/catalogues validated the import. */
    dataRollup?: string;
  }>;
}

export type AnyPersistedPlan = Plan | PlanV3;

/** Index entry written alongside each plan — feeds the /index.html builds list. */
export interface PlanIndexEntry {
  id: string;
  name: string;
  savedAt: string;
  class: string | null;
  ascendancy: string | null;
  nodeCount: number;
  captureCount: number;
}

// ===========================================================================
// TREE runtime shape (baked into planner.html by Rust's emit.rs)
// ===========================================================================

/** A single passive-tree node, as it appears at runtime in TREE.nodes[id].
 *  Fields are short to keep the JSON blob compact (3MB+ at full size).
 *  Source-of-truth: crates/tree_render/src/emit.rs node emission. */
export interface TreeNode {
  x: number; // tree coords (NOT screen px — apply state.scale + state.tx/ty)
  y: number;
  k: string; // kind: 'small' | 'notable' | 'keystone' | 'mastery' | 'attribute' | 'switchable' | 'jewel' | 'class_start' | 'asc_start' | 'asc_notable' | 'asc_small' | 'multichoice' | 'multichoice_opt'
  n?: string; // display name
  s?: string; // stats text (newline-separated)
  g?: number; // group id (for orbit math)
  lm?: number[]; // mastery node ids this node lights when allocated (exact structural map)
  iw?: number; // icon target size (px)
  fw?: number; // frame target size (px)
  o?: NodeOption[]; // attribute/switchable picker options
  i?: string; // icon sprite URL
  f0?: string; // frame sprite (unallocated)
  f1?: string; // frame sprite (allocated)
  me?: string; // mastery effect sprite (radial pattern)
  mw?: number; // mastery effect width (px)
  mh?: number; // mastery effect height
  a?: string; // ascendancy name (truthy iff this is an asc node)
  kl?: string; // class home for class_start nodes ('Druid|Sorceress|...')
  ca?: string; // connectionArt override ('CharacterPlanned' for ~197 nodes)
  uc?: { a: string; n: string[] }; // unlockConstraint (e.g. Oracle's Unseen Path)
  gs?: { n: string; d: string }[]; // granted skills resolved to name + description (shown inline in tooltip)
}

/** One picker option on an attribute/switchable node. */
export interface NodeOption {
  n: string; // option display name ('Strength', 'Dexterity', class name…)
  i?: string; // option icon sprite URL (may be empty for switchable variants)
  id?: string; // variant id (.build references this, not the parent)
}

/** Class metadata baked into TREE.classes. Differs from the
 *  build_meta.json shape (which uses `ascendancies` with internal ids):
 *  here `asc` is just the display names, since the planner sidebar
 *  doesn't need internal ids — only emit.rs's build_meta layer does. */
export interface TreeClassInfo {
  name: string; // e.g. 'Druid'
  asc: string[]; // ascendancy display names
}

/** Top-level TREE shape — every field the planner JS reads off `TREE`.
 *  Composes the per-game extras (Poe1TreeData / Poe2TreeData) so the
 *  single runtime `TREE` object stays typed in one place; the per-game
 *  fields are optional and only present on that game's baked page. */
export interface TreeData extends Poe1TreeData, Poe2TreeData {
  // Geometry / canvas (top-left origin + width/height; not min/max).
  bounds: { x: number; y: number; w: number; h: number };
  orbit_radii: number[];
  // Edges, partitioned for different render passes
  edges_main: Array<[string, string, number]>; // [a, b, orbit]
  edges_asc: Array<[string, string, number, string]>; // [a, b, orbit, asc]
  edges_for_sel: Array<[string, string]>; // adjacency for pathfind / BFS (no orbit info)
  // Edge metadata for the procedural tessellator + GGG textured
  // connectors. Two heterogeneous tuple shapes, discriminated by [0]:
  //   ["a", aId, bId, cx, cy, midAngle, orbitNum, asc?]  — arc edge
  //   ["l", aId, bId, midX, midY, dist, angleRad, asc?]  — straight line
  // Trailing asc field is present only for ascendancy edges. Typed as
  // a loose mixed array because the indexed access pattern in
  // edge_tessellate.ts inspects [0] before branching on [3..7]
  // shape — a stricter discriminated tuple would force every consumer
  // to narrow before accessing.
  edges_meta: Array<(string | number)[]>;
  // Nodes keyed by string id
  nodes: Record<string, TreeNode>;
  // Background sprites + per-class portraits
  bg_tile?: string;
  bgtree?: string;
  bgtree_active?: string;
  class_portraits: Record<string, string>; // class name → portrait sprite URL
  // ascendancy name → { panel sprite URL + tree-coord position +
  // doubled size (PoB DrawAsset doubles bg.width/height per
  // PassiveTreeView.lua:1239) }. Rust emits this per Portrait with
  // kind == "asc".
  asc_panels: Record<
    string,
    { p: string; x: number; y: number; w: number; h: number }
  >;
  classes: TreeClassInfo[];
  /** "Pick one" notables: parent node id → option node ids, derived at
   *  shape time from GGG's isMultipleChoice/-Option flags (never
   *  hardcoded per ascendancy). Options are hidden from the tree; the
   *  parent's popout offers them at zero extra point cost. */
  multi_choice?: Record<string, string[]>;
  // display name → { internal: GGG canonical id, class: parent class name }
  asc_internal?: Record<string, { internal: string; class: string }>;
  /** External-only PoE2 Build Planner ids. Native tree code always uses
   * graph ids; the strict `.build` adapter alone crosses this map. */
  passive_ids?: {
    graphToBuild: Record<string, string>;
    buildToGraph: Record<string, string>;
  };
  tree_schema?: number;
}

// ===========================================================================
// Window globals — cross-file API surfaces both games expose
// ===========================================================================

/** Per-allocation metadata passed to BuildwrightPlan.data.commit() for the
 *  passives section. Keys: passive node id (string). Each entry may
 *  carry an optional note, attribute-variant pick, and per-allocation
 *  level stamp. */
export interface CommitMeta {
  notes?: string;
  attrVariantId?: string;
  level?: number;
}

/** wizard_chrome exposes this for the planner + summary page to talk to
 *  the persisted plan store without going through localStorage directly. */
export interface BuildwrightPlanAPI {
  buildId: () => string;
  get: () => Plan;
  set: (next: Plan) => void;
  save: () => void;
  flash: (msg: string, isError?: boolean) => void;
  step: () => string;
  reload: () => Plan;
  /** Native v3 state graph. The capture-shaped methods above remain a
   * temporary compatibility view for existing planner components. */
  native: {
    get: () => PlanV3;
    /** Fold pending edits from the temporary capture view into v3. */
    sync: () => boolean;
    /** Transactionally replace the current local build with a validated
     * native backup. The URL/storage build id remains authoritative. */
    replace: (plan: PlanV3) => boolean;
    sourceVersion: () => 2 | 3;
    route: () => CharacterStateV3[];
    setActiveState: (stateId: string) => boolean;
    selectRoute: (leafId: string) => boolean;
    addChildState: (
      parentId: string,
      input?: {
        name?: string;
        phase?: CharacterStatePhase;
        characterLevel?: number;
        recommendedLevelRange?: [number, number];
        makeDefault?: boolean;
      },
    ) => string | false;
    updateState: (
      stateId: string,
      patch: {
        name?: string;
        description?: string;
        phase?: CharacterStatePhase;
        characterLevel?: number | null;
        recommendedLevelRange?: [number, number] | null;
      },
    ) => boolean;
    removeStateSubtree: (stateId: string) => boolean;
    setDefaultLeaf: (stateId: string) => boolean;
    upsertActor: (stateId: string, actor: ActorLoadoutV3) => boolean;
    removeActor: (stateId: string, actorId: string) => boolean;
    upsertInventoryItem: (
      stateId: string,
      owner: InventoryOwnerV3,
      item: EquippedItemV3,
    ) => boolean;
    removeInventoryItem: (
      stateId: string,
      owner: InventoryOwnerV3,
      itemId: string,
    ) => boolean;
  };
  data: {
    section: () => string | null;
    /** Returns Map<id, set> for 'passives', or array for 'skills' / 'items'. */
    effective: (
      section?: string,
    ) => Map<string, string> | Skill[] | Item[] | null;
    /** `next` shape depends on section:
     *    passives → Map<string, string>  (id → set)
     *    skills   → Skill[]
     *    items    → Item[]                                                  */
    commit: (
      next: Map<string, string> | Skill[] | Item[],
      section?: string,
      meta?: Map<string, CommitMeta>,
    ) => void;
  };
  clearNoteEverywhere: (id: string) => void;
  captures: {
    list: () => Capture[];
    count: () => number;
    active: () => Capture;
    activeIndex: () => number;
    isWorking: (idx?: number) => boolean;
    setActive: (idx: number) => boolean;
    snapshotAt: (level: number) => number | false;
    remove: (idx: number) => boolean;
    setRange: (idx: number, range: [number, number]) => boolean;
    setName: (idx: number, name: string | null) => boolean;
    setDescription: (idx: number, text: string) => boolean;
    setAscendancy: (idx: number, asc: string | null) => boolean;
    diff: (iA: number, iB: number) => {
      added: Set<string>;
      removed: Set<string>;
      kept: Set<string>;
    } | null;
    pointBudgetFor: (cap: Capture | null | undefined) => number;
    isFull: (cap: Capture | null | undefined) => boolean;
  };
}
/** @deprecated Compatibility name for older generated planner bundles. */
export type PoE2PlanAPI = BuildwrightPlanAPI;

export interface BuildwrightShareAPI {
  encode: (plan: AnyPersistedPlan) => Promise<string>;
  decode: (code: string) => Promise<AnyPersistedPlan>;
  buildUrl: (plan: AnyPersistedPlan, origin?: string) => Promise<string>;
}

export interface GamePageDescriptor {
  schema: number;
  id: GameId;
  storageNamespace: string;
  budgets?: { main?: number; asc?: number; weaponSet?: number };
  features?: Record<string, boolean>;
  /** Legacy page hint; the typed browser profile is authoritative. */
  socketModel?: "spirit" | "links";
  assets: {
    skillCatalogue: string;
    skillStats: string | null;
    itemCatalogue: string;
    bases: string;
    mods: string;
    grantedSkills: string | null;
    jewels: string | null;
    spirit: string | null;
    buildMeta: string;
    nodes: string;
    graph: string;
    supportCompat: string | null;
    capabilities: string | null;
  };
}

/** level_slider exposes this so tests + the summary page can inspect
 *  the slider's resolved per-level state without driving the UI. */
export interface BuildwrightReplayDebugAPI {
  capCache: () => Array<{
    levelRange: [number, number];
    grants: number;
    mains: string[];
    ascs: string[];
    sets: string[];
  }>;
  stateAt: (L: number) => { selected: string[]; capIdx: number } | null;
  rebuild: () => unknown;
  state: () => {
    replayActive: boolean;
    replayCapIdx: number;
    selectedCount: number;
    allocationMeta: Array<{ id: string; m: object }>;
    pickedAttrs: Array<[string, string]>;
    klass: string | null;
    asc: string | null;
    activeSet: "main" | "set1" | "set2";
  };
  flushNow: () => void;
}
/** @deprecated Compatibility name for older generated planner bundles. */
export type PoE2SliderDebugAPI = BuildwrightReplayDebugAPI;

declare global {
  /** The runtime tree payload. Baked into planner*.html by Rust at
   *  build time and injected as a <script> tag BEFORE planner.js runs,
   *  so no .ts file declares it — it's ambient by construction. */
  const TREE: TreeData;

  interface Window {
    /** Per-game page/data descriptor embedded by tree_render (--game). */
    BuildwrightGame?: GamePageDescriptor;
    /** @deprecated Compatibility alias; use BuildwrightGame. */
    PoE2Game?: GamePageDescriptor;
    BuildwrightPlan?: BuildwrightPlanAPI;
    /** @deprecated Compatibility alias; use BuildwrightPlan. */
    PoE2Plan?: BuildwrightPlanAPI;
    BuildwrightShare?: BuildwrightShareAPI;
    /** @deprecated Compatibility alias; use BuildwrightShare. */
    PoE2Share?: BuildwrightShareAPI;
    /** Shared jewel interaction bridge. The implementation and data
     * source are selected by the embedded game descriptor. */
    BuildwrightJewels?: {
      handleSocketClick: (nodeId: string, cx: number, cy: number) => boolean;
      infoForSocket?: (
        nodeId: string,
      ) => { title: string; lines: string[] } | null;
      conversionForKeystone?: (
        nodeId: string,
      ) => { title: string; lines: string[] } | null;
    };
    /** Jewel-granted pathing rules for the active capture. */
    BuildwrightJewelRules?: {
      starts: string[];
      freeAlloc: string[];
      freeAllocBySocket: Record<string, string[]>;
      voicesActive: boolean;
    };
    BuildwrightReplayDebug?: BuildwrightReplayDebugAPI;
    BuildwrightReplayExit?: () => void;
    BuildwrightReplayExitRestore?: () => void;
    // Note map published by level_slider.ts so the tree-side note
    // overlay (note_overlay.ts) and the tooltip (hover.ts) can
    // look up author notes by node id without re-walking captures.
    BuildwrightNotes?: Map<
      string,
      { num: number; level: number; text: string }
    >;
    BuildwrightGemsById?: Map<string, { name?: string }>;
    BuildwrightPatch?: string;
    BuildwrightDataSource?: string;
    /** @deprecated Compatibility aliases for older generated feature bundles. */
    PoE2SliderDebug?: BuildwrightReplayDebugAPI;
    PoE2SliderExit?: () => void;
    PoE2SliderExitRestore?: () => void;
    PoE2Notes?: Map<string, { num: number; level: number; text: string }>;
    POE2_PATCH?: string;
    POE2_SOURCE?: string;
  }
}

export {};
