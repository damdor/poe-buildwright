// ============================================================================
// === DOM handles & state ==================================================
// ============================================================================
// Type-narrow at the source. `document.getElementById` returns
// `HTMLElement | null`; the planner can't boot without these
// elements present in planner.html, so an `as` cast documents the
// invariant + lets consumers (viewport, 04*, etc.) use them
// without null guards. If a fresh emit.rs ever drops one of these
// ids the planner will hard-fail at boot — preferable to silent
// misbehaviour later.

export const canvas = document.getElementById('tree') as HTMLCanvasElement;
export const viewport = document.getElementById('viewport') as HTMLElement;
export const tooltip = document.getElementById('tooltip') as HTMLElement;
export const loadingEl = document.getElementById('loading') as HTMLElement;
export const classSel = document.getElementById('class') as HTMLSelectElement;
export const ascSel = document.getElementById('asc') as HTMLSelectElement;
export const allocModeSel = document.getElementById('alloc-mode') as HTMLSelectElement;
export const buildNameInput = document.getElementById('build-name') as HTMLInputElement;
export const buildDescInput = document.getElementById('build-description') as HTMLTextAreaElement;
export const countMain = document.getElementById('count-main') as HTMLElement;
export const countSet1 = document.getElementById('count-set1') as HTMLElement;
export const countSet2 = document.getElementById('count-set2') as HTMLElement;
export const countSets = document.getElementById('count-sets') as HTMLElement;
export const countAsc  = document.getElementById('count-asc') as HTMLElement;
export const selCount = document.getElementById('sel-count') as HTMLElement;
export const selList = document.getElementById('sel-list') as HTMLElement;
export const info = document.getElementById('info') as HTMLElement;
export const resetBtn = document.getElementById('reset') as HTMLElement;
export const exportBtn = document.getElementById('export') as HTMLElement;
export const zoomfitBtn = document.getElementById('zoomfit') as HTMLElement;

// Chrome that only makes sense for PoE2 (weapon-set allocation modes,
// the PoE2 share/export codec) is removed outright on other games.
if (window.PoE2Game && window.PoE2Game.id !== "poe2") {
  if (window.PoE2Game.features?.weaponSets === false) {
    allocModeSel?.closest("label")?.remove();
    allocModeSel?.remove();
  }
  if (window.PoE2Game.features?.share === false) {
    exportBtn?.remove();
    document.getElementById("share")?.remove();
    document.getElementById("import")?.remove();
  }
}

// WebGL2 context. We disable the default alpha channel (treat the
// backbuffer as fully opaque, much cheaper) and use premultiplied
// alpha blending for correct compositing of icons with transparent
// edges (PoB's PNGs are straight alpha, but we premultiply at upload
// time via UNPACK_PREMULTIPLY_ALPHA_WEBGL).
// Cast to non-null so cross-file consumers (04* render code) don't
// get `WebGL2RenderingContext | null` everywhere. The null guard
// immediately below makes the cast honest: any runtime null path
// throws before any other code touches gl.
export const gl = canvas.getContext('webgl2', {
  antialias: true,
  alpha: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
}) as WebGL2RenderingContext;
if (!gl) {
  loadingEl.textContent = 'WebGL2 not available — use a recent browser';
  loadingEl.classList.remove('hidden');
  // Throws from module-init: esbuild's IIFE wrapper around _main.ts
  // catches this and surfaces it to window.onerror with a real stack
  // trace, which is friendlier than a silent return.
  throw new Error('WebGL2 not available');
}

// Transform state: tree-coord (X,Y) → canvas-CSS-px = X*scale+tx, Y*scale+ty.
// selDirty signals the selected-edge buffer needs regeneration before
// the next frame. popoutId is the attribute node whose Str/Dex/Int
// picker is currently open (click-driven: opens on click of the
// attribute, stays open until the user picks an option or clicks
// outside it).
// Cross-file consumers expect the wider runtime shape (klass/asc are
// mutated to strings post-boot; replayActive flips during slider use;
// etc.). The object-literal would infer narrow `null` / `'main'` /
// bool-false types from these initial values, which fight every
// downstream assignment — so widen at the source via `as` casts on
// the fields whose runtime range is broader than their seed value.
export const state = {
  scale: 1, tx: 0, ty: 0,
  klass: null as string | null,
  asc:   null as string | null,           // engine/panel ascendancy (always a PARENT panel name)
  ascVariant: null as string | null,      // chosen variant (e.g. 'Abyssal Lich') when asc is its parent
  // GGG's authored per-orbit kite-quad connector sprites for the
  // unallocated main-tree edges. Default ON; flip to false in the
  // console (and call requestRender()) to fall back to the procedural
  // arc+line tessellator if the textured connectors ever desync from
  // a new patch's sprite set.
  useGGGConnectors: true,
  // selected is now a Map: id → set membership ('main'|'set1'|'set2').
  // PoE2 weapon-set passive points let a single allocation be active
  // only in one weapon swap. Each "mode" (main only / main+set1 /
  // main+set2) is a mutually-exclusive overlay, so connectivity is
  // computed PER MODE: a set1 node can never bridge between two main
  // allocations (because the main-only graph wouldn't see it), and
  // set1 + set2 never participate in each other's reachability. See
  // ALLOWED_SETS_FOR_MODE and pathfindRoots() below.
  selected: new Map<string, string>(),
  activeSet: 'main' as 'main' | 'set1' | 'set2',
  // Per-allocation metadata that GGG's .build format carries on every
  // element type — currently the levelInterval and a future notes
  // hook. Lives separately from state.selected so the common case
  // (allocate a node, no metadata) stays a tiny Map<id, set> entry.
  // Reads / writes only happen during authoring of leveling guides.
  allocationMeta: new Map(),   // id → { notes?: string }
  pickedAttrs: new Map<string, string>(),
  hoverId:  null as string | null,
  popoutId: null as string | null,
  previewAdd: new Set<string>(),
  previewAddOver: new Set<string>(),     // subset of previewAdd: nodes past the budget cap
  previewRemove: new Set<string>(),
  // Search-highlight set: nodes that match the current Cmd+K search
  // query. Rendered as a pulsing cyan glow under each match so the
  // user can see where matches cluster on the tree.
  searchHighlight: new Set<string>(),
  // Per-target rotation among equal-length shortest paths. When the
  // user hovers a node, shortestPathEdges enumerates up to N distinct
  // shortest paths and uses pathSwapIndex (modulo path count) to pick
  // which one is "primary" (gold) — the rest combine into "alternate"
  // (blue). Right-click on the hovered target increments the index,
  // letting the user cycle through every option.
  pathSwapTarget: null as string | null,
  pathSwapIndex: 0,
  needsRender: false,
  selDirty: true,
  geomReady: false,
  // Accumulated stats + cost + level-needed for the currently-hovered
  // allocate-preview path. Populated by pathfind's hover handler,
  // consumed by hover's tooltip. Hybrid shape: an array of stat
  // lines (returned from computePathAccumulation) with named fields
  // tacked on. Null when no preview is open or the hovered node is
  // unreachable.
  previewAccumulated: null as null | (string[] & {
    cost?: number;
    altCount?: number;
    mainAdd?: number;
    setAdd?: number;
    ascAdd?: number;
    setMode?: boolean;
    levelNeeded?: number;
  }),
  // replayActive flips true while the level slider is scrubbing the
  // build through past snapshots — guards the autosave RAF tick in
  // wizard_sync.ts from overwriting authored data with the
  // derived view. Seeded false here so consumers can read it
  // unconditionally (the autosave fires on every frame, would
  // otherwise NaN-trip the equality check on undefined).
  replayActive: false,
  // Which capture the slider is currently scrubbing INSIDE (-1 when
  // not replaying). The skills/gear strips read it so the whole HUD —
  // tree, gems, items — time-travels together.
  replayCapIdx: -1,
  // Transient allocation-mode override set by Ctrl/Shift in
  // sidebar. Null when no modifier is held; effectiveActiveSet
  // reads through this to layer over state.activeSet. Null at boot
  // so the initial render uses activeSet directly.
  modOverride: null as null | 'main' | 'set1' | 'set2',
};

// Point budgets (PoB Build.lua:837):
//   * 99 main points from levels 2..100
//   * up to 24 "weapon set" points from Act 1-3 + Cruel quest rewards.
//     These appear on the tree as set-1 / set-2 specific allocations
//     (pink and green respectively); each weapon-set point lets you
//     allocate ONE node that's only active when that weapon set is
//     equipped. set1 + set2 used together ≤ 24.
//   * 8 ascendancy points from labyrinth trials.
// Budgets come from the page's game descriptor when present (PoE1
// pages embed 123/8); the literals are the PoE2 defaults.
export const GAME = window.PoE2Game ?? { id: "poe2" };
// PoE1 draws every ascendancy subtree at its real tree coordinates,
// all at once (selected one interactive) — PoE2 pins the selected
// panel to the tree center instead.
export const ASC_IN_PLACE = window.PoE2Game?.features?.ascInPlace === true;
export function featureOn(name: string): boolean {
  return GAME.features?.[name] !== false;
}
export const MAX_MAIN_POINTS = GAME.budgets?.main ?? 99;
export const MAX_SET_POINTS  = featureOn("weaponSets") ? 24 : 0;
export const MAX_ASC_POINTS  = GAME.budgets?.asc ?? 8;

// Hardcoded table of ascendancy nodes that change tree-level rules
// when allocated. Six "+passive point" nodes (Pathfinder + Oracle),
// two "Path of X" alt-start unlocks (Pathfinder), and Witchhunter's
// Weapon Master conversion.
//
//   grantsPoints    → bonus main-tree passive points (raises main cap).
//   altStartClass   → unlocks that class's start hub as an extra BFS
//                     root (Path of the Sorceress on a Ranger lets
//                     them allocate Sorceress's starting cluster
//                     without crossing the tree).
//   weaponSetGrant  → bonus weapon-set passive points (raises set cap).
//                     PoB's PassivePointsToWeaponSetPoints adds 100
//                     to maxWeaponSets when Weapon Master is taken.
// Weapon-set passive points are quest rewards, not free-from-start.
// Source: data/pob2/src/Data/QuestRewards.lua aggregated by AreaLevel
// (the minimum character level required to do each quest). Each
// reward grants +2 points; some levels carry two coincident quests
// (51, 62) collapsed into +4 here. Total 24 at Lv 64+ — matches
// PoB2's self.maxWeaponSets = acts[maxActs].questPoints derivation.
// weaponSetCapAt(level) returns the BASE cap (before Witchhunter's
// +100 Weapon Master grant, which is layered on top).
export const WEAPON_SET_REWARDS = [
  { lvl: 10, pts: 2 }, { lvl: 12, pts: 2 },
  { lvl: 25, pts: 2 }, { lvl: 28, pts: 2 },
  { lvl: 34, pts: 2 }, { lvl: 44, pts: 2 },
  { lvl: 51, pts: 4 },
  { lvl: 61, pts: 2 }, { lvl: 62, pts: 4 }, { lvl: 64, pts: 2 },
];
export function weaponSetCapAt(level: number): number {
  let cap = 0;
  for (const r of WEAPON_SET_REWARDS) {
    if (r.lvl <= level) cap += r.pts;
    else break;
  }
  return cap;
}

// Base Spirit is quest-earned: +30 (Act 1, King in the Mists), +30
// (Act 3, Ignagduk), +40 (post-Act-4 interlude, Lythara) = 100. The
// level mapping is DELIBERATELY CONSERVATIVE (latest plausible level
// per boss) so the UI never promises spirit the player might not
// have. KEEP IN SYNC with scripts/gen_agent_meta.mjs SPIRIT_REWARDS.
export const SPIRIT_REWARDS = [
  { lvl: 18, pts: 30 },
  { lvl: 36, pts: 30 },
  { lvl: 50, pts: 40 },
];
export function spiritCapAt(level: number): number {
  let cap = 0;
  for (const r of SPIRIT_REWARDS) {
    if (r.lvl <= level) cap += r.pts;
    else break;
  }
  return cap;
}

// Each entry MAY carry grantsPoints, weaponSetGrant, or altStartClass —
// any combination, or none (in which case the entry would simply not
// exist in this table). Typed with all-optional fields so the indexed
// lookup ASC_EFFECTS[id] returns the right union of possible effects.
interface AscEffect {
  grantsPoints?: number;
  weaponSetGrant?: number;
  altStartClass?: string;
}
export const ASC_EFFECTS: Record<string, AscEffect> = {
  '11335': { grantsPoints: 1 },                               // Oracle - Passive Point
  '12183': { grantsPoints: 1 },                               // Pathfinder - Passive Points
  '12795': { grantsPoints: 4, altStartClass: 'Sorceress' },   // Pathfinder - Path of the Sorceress
  '36676': { grantsPoints: 1 },                               // Pathfinder - Passive Points
  '47190': { grantsPoints: 1 },                               // Oracle - Passive Point
  '57253': { grantsPoints: 4, altStartClass: 'Warrior' },     // Pathfinder - Path of the Warrior
  '8272':  { weaponSetGrant: 100 },                           // Witchhunter - Weapon Master
};

// Multi-choice notables. GGG tree.json carries isMultipleChoice +
// isMultipleChoiceOption flags on the parent and its options; we
// hardcode the mapping since the set is small (5 notables across
// 4 ascendancies) and unlikely to grow often.
//
// Behavior per PoB (PassiveSpec.lua:944-948 + line 985):
//   * Parent notable costs the usual 1 asc point.
//   * Picking an option costs 0 additional asc points (the option's
//     asc allocation is "free" — the parent's slot covers it).
//   * Picking an option deallocates any previously-picked sibling
//     option of the same parent (mutex).
//   * Option nodes are hidden from tree rendering / pathfinding —
//     the user only ever interacts with them through the parent's
//     popout (same UX as attribute Str/Dex/Int picker).
export const MULTI_CHOICE: Record<string, string[]> = {
  '16433': ['12795', '57253'],                                // Pathfinder - Path Seeker
  '57141': ['9710', '18940', '38004', '56618', '58379'],      // Pathfinder - Brew Concoction
  '42416': ['41875', '59542'],                                // Deadeye - Projectile Proximity Specialisation
  '52395': ['56331', '26283', '664'],                         // Acolyte of Chayula - Lucid Dreaming
  '60287': ['37397', '32952', '63259'],                       // Gemling Legionnaire - Implanted Gems
};
export const MULTI_CHOICE_PARENT: Record<string, string> = {};   // option_id → parent_id
for (const parent in MULTI_CHOICE) {
  for (const opt of (MULTI_CHOICE[parent] ?? [])) MULTI_CHOICE_PARENT[opt] = parent;
}
export function isMcOption(id: string | number): boolean { return MULTI_CHOICE_PARENT[String(id)] != null; }
export function isMcParent(id: string | number): boolean { return MULTI_CHOICE[String(id)] != null; }
// Unlock-constrained nodes (PoE2 `unlockConstraint`). Currently only
// Oracle's "The Unseen Path" (node 5571) gates ~197 main-tree extras.
// For any character whose active ascendancy doesn't match uc.a these
// nodes are completely hidden — no render, no hover, no search hit,
// no path-finding traversal. Treated as if they don't exist.
//
// For an Oracle character they're shown unconditionally (we don't yet
// require the `uc.n` notable to be allocated before letting them be
// taken — that's a secondary gate matching in-game allocation order
// and is acceptable to leave open while authoring a guide).
export function isLocked(id: string | number): boolean {
  const n = TREE.nodes[String(id)];
  if (!n || !n.uc) return false;
  // Wrong ascendancy → locked. Oracle's Unseen Path extras only exist
  // when Oracle is the active ascendancy on the build.
  if (n.uc.a !== state.asc) return true;
  // Right asc, but the gating notable(s) must also be allocated.
  // For Oracle this is exactly node 5571 ("The Unseen Path"): the
  // extra cluster is unreachable until the player has taken that
  // notable — search and tree visibility follow the same rule.
  if (n.uc.n && n.uc.n.length) {
    for (const reqId of n.uc.n) {
      if (!state.selected.has(String(reqId))) return true;
    }
  }
  return false;
}
// LOCK_TRIGGER_IDS / currentLockMask / maybeRebuildStaticForLocks live in
// lock_rebuild.ts — they pull in buildStaticGeometry (04d) and
// computeDeallocResult (pathfind), which would create a cyclic ESM
// import with state otherwise.

// The picked option for an MC parent is derivable: walk state.selected
// looking for any id whose MULTI_CHOICE_PARENT equals the parent.
export function pickedMcOption(parentId: string | number): string | null {
  const opts = MULTI_CHOICE[String(parentId)];
  if (!opts) return null;
  for (const oid of opts) if (state.selected.has(oid)) return oid;
  return null;
}

export interface SelectedCounts {
  main: number; asc: number; set1: number; set2: number;
  sets: number; mainPointGrant: number; weaponSetGrant: number;
}
export function countSelected(): SelectedCounts {
  let main = 0, asc = 0, set1 = 0, set2 = 0;
  let mainPointGrant = 0, weaponSetGrant = 0;
  for (const [id, setKind] of state.selected) {
    const n = TREE.nodes[id];
    if (!n) continue;
    if (n.a) {
      // Multi-choice options are FREE picks (PoB PassiveSpec.lua:985)
      // — the parent notable's asc point covers them, and their
      // grants still apply.
      if (!isMcOption(id)) asc++;
      const eff = ASC_EFFECTS[id];
      if (eff) {
        if (eff.grantsPoints)   mainPointGrant   += eff.grantsPoints;
        if (eff.weaponSetGrant) weaponSetGrant   += eff.weaponSetGrant;
      }
      continue;
    }
    if (setKind === 'set1') set1++;
    else if (setKind === 'set2') set2++;
    else main++;
  }
  return { main, asc, set1, set2, sets: set1 + set2, mainPointGrant, weaponSetGrant };
}



// Variant ascendancies (Abyssal Lich): the game reuses the parent panel
// and swaps node CONTENT (TREE.asc_variants, from GGG's
// AscendancyPassiveSkillOverrides). Engine state (state.asc) always
// holds the PARENT; the variant name lives in state.ascVariant and is
// what captures persist/export.
export const ASC_VARIANT_PARENT: Record<string, string> = {};
for (const v in (TREE.asc_variants ?? {})) {
  ASC_VARIANT_PARENT[v] = TREE.asc_variants![v]!.parent;
}
/** Split a stored/selected ascendancy name into engine panel + variant. */
export function resolveAscName(name: string | null | undefined): { panel: string | null; variant: string | null } {
  if (!name) return { panel: null, variant: null };
  const parent = ASC_VARIANT_PARENT[name];
  return parent ? { panel: parent, variant: name } : { panel: name, variant: null };
}
/** The ascendancy name to persist/export (variant wins over parent). */
export function ascDisplayName(): string | null {
  return state.ascVariant ?? state.asc;
}
/** Content override for a node under the active variant, if any. */
export function ascNodeOverride(id: string): { n: string; s: string; k: string; i?: string } | null {
  if (!state.ascVariant) return null;
  return TREE.asc_variants?.[state.ascVariant]?.nodes[id] ?? null;
}
