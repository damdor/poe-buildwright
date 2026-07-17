// poe2.d.ts — global type declarations for the planner + wizard frontends.
//
// What lives here:
//   • Plan / Capture / Allocation / Skill / Item — the data contracts
//     persisted in localStorage (KEY_PREFIX + buildId).
//   • TreeNode / TreeData — the runtime shape of the TREE constant that
//     Rust's emit.rs bakes into planner.html.
//   • Window.PoE2Plan, Window.PoE2SliderDebug, Window.PoE2Notes etc. —
//     the global API surfaces wizard_chrome.ts exposes for cross-file
//     communication (we still rely on a few globals to keep planner ↔
//     wizard decoupled across script tag boundaries).
//
// Update rules:
//   • Mirror the shape that actually exists on disk + at runtime. If
//     you change a field's name/type in code, change it here in the
//     same commit — otherwise tsc lies to you.
//   • Optional (?) fields are persisted only when set, so loaders need
//     to tolerate `undefined`.

// ===========================================================================
// Plan data contracts (persisted, version 2)
// ===========================================================================

/** Local-storage plan format tag. Bump PLAN_VERSION when the on-disk shape
 *  changes incompatibly; older plans return null from loadPlan() and the
 *  caller mints a fresh one. */
export type PlanFormat = "poe2-planner-plan";
export type PlanVersion = 2;

/** A single passive-tree allocation inside a capture. `set` distinguishes
 *  main-tree vs weapon-set 1/2 allocations (PoE2 lets you pick different
 *  tree paths per equipped weapon set). */
export interface Allocation {
  id: string;                           // passive node id
  set?: "main" | "set1" | "set2";       // default: 'main'
  note?: string;                        // user-authored per-node note
  attrVariantId?: string;               // picked Str/Dex/Int variant id
  level?: number;                       // per-allocation level stamp (asc + set only)
  level_interval?: [number, number];    // transient — only on .build-import normalize stage
}

/** A skill entry inside a capture. Mirrors GGG's .build `BuildSkill` shape. */
export interface Skill {
  id: string;                           // gem id (e.g. 'Metadata/Items/Gems/SkillGemFireball')
  level: number;                        // gem level 1-20+
  quality?: number;                     // gem quality 0-20
  set?: "main" | "set1" | "set2";
  note?: string;                        // optional gem note
  supports?: SupportGem[];              // attached support gems
  level_interval?: [number, number];    // transient — only on .build-import normalize stage
}

/** A support gem attached to a skill. `additional_text` in GGG-land. */
export interface SupportGem {
  id: string;
  level: number;
  quality?: number;
  note?: string;                        // BuildSupport.additional_text
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
  // Grounded composition (agent plans / base picker): the real
  // base-item name + rarity + the priority mods that matter. Drives
  // base art, rarity color and the hover text in the strip.
  base?: string;
  rarity?: string;
  mods?: string[];
  // Jewels only: the tree node id of the jewel socket this jewel sits
  // in (kind=jewel node). Unset = jewel exists but isn't placed yet.
  socket?: number;
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
  id: string;                           // stable per-capture id (genCapId())
  levelRange: [number, number];
  name: string | null;                  // user-authored short label ("L13-49: leech setup"), or null
  passives: Allocation[];
  skills: Skill[];
  items: Item[];
  ascendancy: string | null;            // per-capture (changes via Oracle's "switch asc" mid-leveling)
  description: string;
  class?: string;                       // optional override of plan.class for this capture
}

/** Top-level plan. The unit persisted at localStorage[KEY_PREFIX + id]. */
export interface Plan {
  id?: string;                          // stamped on persist
  format?: PlanFormat;                  // stamped on persist
  version?: PlanVersion;                // stamped on persist
  savedAt?: string;                     // ISO 8601 timestamp on persist

  name: string;
  description: string;
  class: string | null;                 // top-level class; per-capture asc overrides
  patch: string | null;                 // PoE2 patch the plan was authored against ('0.4', '0.5', ...)

  captures: Capture[];                  // length >= 1; last entry = working capture
  activeCapture: number;                // index into captures[]; -1 / OOB normalizes to last

  activeSet?: "main" | "set1" | "set2"; // currently-edited weapon set
  guide?: string;                       // free-text leveling guide (with @[type:id] tokens)
}

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
// GGG .build format (patch 0.5+, interop boundary)
// ===========================================================================
//
// The in-game Build Planner's JSON shape. Used by build_io.ts both
// as an export target (planToGGGBuild) and an import source
// (gggBuildToPlan). Fields here mirror the spec at
// <https://www.pathofexile.com/developer/docs/game> and the
// docs/build_planner_format.md notes. Strict on TYPES we know; lenient
// on UNKNOWN fields (GGG can add forward-compatible properties without
// breaking our import).

/** Level applicability per GGG's schema: an inclusive [lo, hi] pair,
 *  a single-element [lo] array, or a bare uint — the docs write it as
 *  "(array of uint, or uint)". The short forms have no documented
 *  upper bound; our importer reads them as "from lo onward"
 *  (normalizeInterval in build_io). Our exporter always emits the
 *  two-element form. */
export type GGGLevelInterval = number | number[];

/** A passive entry in a GGG .build. Bare string/number form means
 *  "always present" (no level_interval). Object form carries the
 *  optional metadata. */
export type GGGPassive = string | number | GGGPassiveEntry;

export interface GGGPassiveEntry {
  id: string | number;                     // passive node id (or attr-variant id)
  weapon_set?: 1 | 2;                      // unset = main tree
  level_interval?: GGGLevelInterval;
  additional_text?: string;                // author note + auto-pivot annotations
}

/** A skill entry. Mirrors GGG's BuildSkill (id, level_interval,
 *  additional_text, support_skills). `level`, `quality`, and
 *  `weapon_set` are OUR extensions — not in GGG's schema; the client
 *  ignores unknown fields, and our re-import round-trips them. */
export interface GGGSkill {
  id: string;
  level?: number;
  quality?: number;
  weapon_set?: 1 | 2;
  level_interval?: GGGLevelInterval;
  additional_text?: string;
  support_skills?: Array<string | GGGSupport>; // GGG allows bare id strings
}

/** A support gem inside a GGGSkill.support_skills. Mirrors GGG's
 *  BuildSupport (id, level_interval, additional_text); `level` and
 *  `quality` are our extensions. */
export interface GGGSupport {
  id: string;
  level?: number;
  quality?: number;
  level_interval?: GGGLevelInterval;
  additional_text?: string;
}

/** An equipped item entry. Mirrors GGG's InventorySlot: the official
 *  positional fields are `slot_x`/`slot_y` (default 0). `x`/`y` are
 *  accepted on import for files our exporter wrote before the
 *  2026-07-10 spec audit. */
export interface GGGItem {
  inventory_id: string;
  slot_x?: number;
  slot_y?: number;
  /** @deprecated pre-audit alias of slot_x — import-only */
  x?: number;
  /** @deprecated pre-audit alias of slot_y — import-only */
  y?: number;
  unique_name?: string;
  level_interval?: GGGLevelInterval;
  additional_text?: string;
}

/** Top-level .build JSON (GGG schema "Version 1 (Experimental)").
 *  `name` is the one field GGG marks required — our exporter always
 *  emits it. `patch` is OUR extension (client ignores it; other tools
 *  and our re-import can use it). */
export interface GGGBuild {
  name?: string;                           // required by the client; optional here so import can degrade gracefully
  author?: string;
  link?: string;                           // 0.5.3+: renders a button in the client (whitelisted domains only)
  description?: string;
  ascendancy?: string;                     // GGG internal id (TreeData.asc_internal[name].internal)
  patch?: string;                          // our extension: game patch the build was authored against
  passives?: GGGPassive[];
  skills?: GGGSkill[];
  inventory_slots?: GGGItem[];             // official field name
  /** @deprecated pre-audit exports used `items` — import-only */
  items?: GGGItem[];
}

// ===========================================================================
// TREE runtime shape (baked into planner.html by Rust's emit.rs)
// ===========================================================================

/** A single passive-tree node, as it appears at runtime in TREE.nodes[id].
 *  Fields are short to keep the JSON blob compact (3MB+ at full size).
 *  Source-of-truth: crates/tree_render/src/emit.rs node emission. */
export interface TreeNode {
  x: number;                            // tree coords (NOT screen px — apply state.scale + state.tx/ty)
  y: number;
  k: string;                            // kind: 'small' | 'notable' | 'keystone' | 'mastery' | 'attribute' | 'switchable' | 'jewel' | 'class_start' | 'asc_start' | 'asc_notable' | 'asc_small' | 'multichoice' | 'multichoice_opt'
  n?: string;                           // display name
  s?: string;                           // stats text (newline-separated)
  g?: number;                           // group id (for orbit math)
  lm?: number[];                        // mastery node ids this node lights when allocated (exact structural map)
  iw?: number;                          // icon target size (px)
  fw?: number;                          // frame target size (px)
  o?: NodeOption[];                     // attribute/switchable picker options
  i?: string;                           // icon sprite URL
  f0?: string;                          // frame sprite (unallocated)
  f1?: string;                          // frame sprite (allocated)
  me?: string;                          // mastery effect sprite (radial pattern)
  mw?: number;                          // mastery effect width (px)
  mh?: number;                          // mastery effect height
  a?: string;                           // ascendancy name (truthy iff this is an asc node)
  kl?: string;                          // class home for class_start nodes ('Druid|Sorceress|...')
  ca?: string;                          // connectionArt override ('CharacterPlanned' for ~197 nodes)
  uc?: { a: string; n: string[] };      // unlockConstraint (e.g. Oracle's Unseen Path)
  gs?: { n: string; d: string }[];      // granted skills resolved to name + description (shown inline in tooltip)
}

/** One picker option on an attribute/switchable node. */
export interface NodeOption {
  n: string;                            // option display name ('Strength', 'Dexterity', class name…)
  i?: string;                           // option icon sprite URL (may be empty for switchable variants)
  id?: string;                          // variant id (.build references this, not the parent)
}

/** Class metadata baked into TREE.classes. Differs from the
 *  build_meta.json shape (which uses `ascendancies` with internal ids):
 *  here `asc` is just the display names, since the planner sidebar
 *  doesn't need internal ids — only emit.rs's build_meta layer does. */
export interface TreeClassInfo {
  name: string;                         // e.g. 'Druid'
  asc: string[];                        // ascendancy display names
}

/** Top-level TREE shape — every field the planner JS reads off `TREE`. */
export interface TreeData {
  // Geometry / canvas (top-left origin + width/height; not min/max).
  bounds: { x: number; y: number; w: number; h: number };
  orbit_radii: number[];
  // Edges, partitioned for different render passes
  edges_main: Array<[string, string, number]>;        // [a, b, orbit]
  edges_asc: Array<[string, string, number, string]>; // [a, b, orbit, asc]
  edges_for_sel: Array<[string, string]>;             // adjacency for pathfind / BFS (no orbit info)
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
  class_portraits: Record<string, string>;            // class name → portrait sprite URL
  // ascendancy name → { panel sprite URL + tree-coord position +
  // doubled size (PoB DrawAsset doubles bg.width/height per
  // PassiveTreeView.lua:1239) }. Rust emits this per Portrait with
  // kind == "asc".
  asc_panels: Record<string, { p: string; x: number; y: number; w: number; h: number }>;
  asc_variants?: Record<string, { parent: string; nodes: Record<string, { n: string; s: string; k: string; i?: string }> }>; // variant ascendancies (Abyssal Lich): parent panel + node content overrides
  classes: TreeClassInfo[];
  // display name → { internal: GGG canonical id, class: parent class name }
  asc_internal?: Record<string, { internal: string; class: string }>;
  tree_schema?: number;
}

// ===========================================================================
// Window globals — cross-file API surfaces
// ===========================================================================

/** Per-allocation metadata passed to PoE2Plan.data.commit() for the
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
export interface PoE2PlanAPI {
  buildId: () => string;
  get: () => Plan;
  set: (next: Plan) => void;
  save: () => void;
  flash: (msg: string, isError?: boolean) => void;
  step: () => string;
  reload: () => Plan;
  data: {
    section: () => string | null;
    /** Returns Map<id, set> for 'passives', or array for 'skills' / 'items'. */
    effective: (section?: string) => Map<string, string> | Skill[] | Item[] | null;
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

/** level_slider exposes this so tests + the summary page can inspect
 *  the slider's resolved per-level state without driving the UI. */
export interface PoE2SliderDebugAPI {
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

declare global {
  /** Baked into planner.html by Rust at build time. Available as a top-level
   *  identifier (not on window) inside the planner IIFE. */
  const TREE: TreeData;

  interface Window {
    PoE2Plan?: PoE2PlanAPI;
    // Jewel socketing bridge: pathfind consults this before treating
    // a click on an allocated jewel-socket node as (de)allocation.
    PoE2Jewels?: { handleSocketClick: (nodeId: string, cx: number, cy: number) => boolean };
    PoE2SliderDebug?: PoE2SliderDebugAPI;
    PoE2SliderExit?: () => void;
    PoE2SliderExitRestore?: () => void;
    // Note map published by level_slider.ts so the tree-side note
    // overlay (note_overlay.ts) and the tooltip (hover.ts) can
    // look up author notes by node id without re-walking captures.
    PoE2Notes?: Map<string, { num: number; level: number; text: string }>;
    PoE2Share?: {
      encode: (plan: Plan) => Promise<string>;
      decode: (code: string) => Promise<Plan>;
      buildUrl: (plan: Plan, origin?: string) => Promise<string>;
    };
    POE2_PATCH?: string;
    POE2_SOURCE?: string;
    POE2_GEMS_BY_ID?: Record<string, unknown>;
    // Test/debug surface for export/import flows. Exposed by
    // build_io.ts so Playwright tests + console diagnostics can
    // exercise the pipeline without going through the file dialog.
    PoE2BuildIO?: {
      planToGGGBuild: (plan: Plan, meta?: { name?: string; description?: string }) => GGGBuild;
      validateGGGBuild: (d: unknown) => string | null;
      gggBuildToPlan: (b: GGGBuild) => Plan;
    };
  }
}

export {};
