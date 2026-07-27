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

import { PROFILE, featureOn } from "./game.ts";
import { ASC_EFFECTS, MULTI_CHOICE, MULTI_CHOICE_PARENT, isMcOption } from "./poe2_rules.ts";

export const canvas = document.getElementById('tree') as HTMLCanvasElement;
export const viewport = document.getElementById('viewport') as HTMLElement;
export const tooltip = document.getElementById('tooltip') as HTMLElement;
export const loadingEl = document.getElementById('loading') as HTMLElement;
export const classSel = document.getElementById('class') as HTMLSelectElement;
export const ascSel = document.getElementById('asc') as HTMLSelectElement;
export const allocModeSel = document.getElementById('alloc-mode') as HTMLSelectElement;
export const buildNameInput = document.getElementById('build-name') as HTMLInputElement;
export const buildDescInput = document.getElementById('build-description') as HTMLTextAreaElement;
export const buildAuthorInput = document.getElementById('build-author') as HTMLInputElement;
export const buildLinkInput = document.getElementById('build-link') as HTMLInputElement;
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

// These are independent capabilities. PoE1 has native Buildwright
// sharing but no official GGG .build adapter; neither is inferred from
// the game name.
if (!featureOn("weaponSets")) {
  allocModeSel?.closest("label")?.remove();
  allocModeSel?.remove();
  const seg = countSet1?.closest(".hud-pool");
  if (seg?.previousElementSibling?.classList.contains("mode-sep")) {
    seg.previousElementSibling.remove();
  }
  seg?.remove();
}
if (!PROFILE.integrations.gggBuild) {
  exportBtn?.remove();
  document.getElementById("import")?.remove();
}
if (!PROFILE.integrations.nativeShare) {
  document.getElementById("share")?.remove();
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
  // PoE1 in-place presentation: the ascendancy circle overlaps main
  // nodes, so — like GGG — it only shows while "open". Toggled by
  // clicking the AscendancyButton plaque (or picking an asc in the
  // sidebar); the plaque swaps to its Highlight art while hovered.
  ascOpen: false,
  ascBtnHover: false,
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
// Game gates + budgets are defined in game.ts (the zero-import leaf —
// see the ownership note there); re-exported here because most
// modules already pull their shared constants from state.ts.
export { ASC_IN_PLACE, GAME, MAX_ASC_POINTS, MAX_MAIN_POINTS, MAX_SET_POINTS, featureOn } from "./game.ts";

// PoE2-only rule tables + quest-reward schedules live in
// poe2_rules.ts (empty tables on any other game — poe1 reuses the id
// space, so leaving them populated would silently apply PoE2 rules to
// unrelated poe1 nodes). Re-exported here because most modules pull
// their shared constants from state.ts.
export { ASC_EFFECTS, MULTI_CHOICE, MULTI_CHOICE_PARENT, SPIRIT_REWARDS, WEAPON_SET_REWARDS, isMcOption, isMcParent, spiritCapAt, weaponSetCapAt } from "./poe2_rules.ts";
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
