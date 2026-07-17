// ============================================================================
// === Click → pathfinding selection =======================================
// ============================================================================
// Adjacency built once from TREE.edges_for_sel for BFS. Edges that
// touch a hidden multi-choice option are excluded so the path-finder
// never traverses through one — option nodes don't exist in the
// visual tree, only as picker entries on their parent's popout.

import { ASC_EFFECTS, MAX_ASC_POINTS, MAX_MAIN_POINTS, MAX_SET_POINTS, MULTI_CHOICE, MULTI_CHOICE_PARENT, countSelected, gl, isLocked, isMcOption, isMcParent, state } from "./state.ts";
import { maybeRebuildStaticForLocks } from "./lock_rebuild.ts";
import { clientToTree } from "./viewport.ts";
import { STRIDE_FLOATS, makeVAO } from "./webgl_setup.ts";
import { Tint, pushArcD, pushLineSegD } from "./vertex_helpers.ts";
import { tessellateEdgesTexturedFromList } from "./overlay.ts";
import { POPOUT_FRAME_SIZE, popoutOptionCenter, popoutOptionsFor, requestRender } from "./render.ts";
import { computePathAccumulation, findHoverNode, refreshTooltip } from "./hover.ts";
import { effectiveActiveSet, updateSelectionUI } from "./sidebar.ts";
import { currentCharacterLevel } from "./captures_bar.ts";
import type { TreeNode } from "../../../../types/poe2.d.ts";

export const adj: Map<string, Set<string>> = new Map();
for (const [a, b] of TREE.edges_for_sel) {
  const sa = String(a), sb = String(b);
  if (isMcOption(sa) || isMcOption(sb)) continue;
  if (!adj.has(sa)) adj.set(sa, new Set());
  if (!adj.has(sb)) adj.set(sb, new Set());
  adj.get(sa)!.add(sb);
  adj.get(sb)!.add(sa);
}

// Mastery lighting is driven by the exact per-node map `n.lm` (mastery
// node ids a node lights when allocated), emitted from tree/masteries.tsv
// — see `buildwright masteries`. That mapping is structural (a mastery's
// cluster = its group ∪ its connection-graph neighbours), so it replaced
// the old visual-group + nearest-orphan proximity heuristic that used to
// live here and over-lit masteries you were merely near. overlay
// consumes `n.lm` directly; no precomputed group→pattern map is needed.

// Quick lookup from an unordered (a, b) pair to the edges_meta entry
// (which holds the arc center, radius, etc.). Used by preview-edge
// tessellation to draw individual edges along a BFS path.
type EdgeMeta = (string | number)[];
export const edgeMetaByPair = new Map<string, EdgeMeta>();
for (const m of TREE.edges_meta) {
  edgeMetaByPair.set(m[1] + '|' + m[2], m);
}
export function getEdgeMeta(a: string, b: string): EdgeMeta | undefined {
  return edgeMetaByPair.get(a + '|' + b) || edgeMetaByPair.get(b + '|' + a);
}

// Weapon-set connectivity rule (matches GGG's in-game planner):
//   * "main" mode  — only nodes labelled 'main' participate
//   * "set1" mode  — nodes labelled 'main' OR 'set1' participate
//                    (set1 is an OVERLAY on the main tree)
//   * "set2" mode  — symmetric: 'main' OR 'set2'
// So a set1 node can never bridge between two main allocations
// (in main-only mode that bridge is invisible, orphaning anything
// past it), and set1 + set2 never extend each other.
type SetMode = 'main' | 'set1' | 'set2';
export const ALLOWED_SETS_FOR_MODE: Record<SetMode, Set<string>> = {
  main: new Set(['main']),
  set1: new Set(['main', 'set1']),
  set2: new Set(['main', 'set2']),
};

// Roots from which a valid tree is grown. The class start hub is the
// only true seed for the main tree; once nodes are allocated they
// become additional roots so BFS can extend the tree from any
// allocated node — but ONLY allocations that participate in the
// requested mode count (see ALLOWED_SETS_FOR_MODE). Asc allocations
// are always roots: they live in a disjoint subgraph and don't
// belong to a weapon set.
// Jewel-granted pathing rules — gear_overlay computes these from the
// ACTIVE capture's socketed jewels (see window.PoE2JewelRules):
//   starts:    class-start names ("Warrior", "Shadow"…) usable as
//              extra pathing roots (Split Personality's rolled start)
//   freeAlloc: node ids allocatable WITHOUT connection (Controlled
//              Metamorphosis's ring). Intuitive-Leap semantics: such
//              nodes never act as connection points for anything else.
function jewelRules(): { starts: string[]; freeAlloc: Set<string> } {
  const r = window.PoE2JewelRules;
  return { starts: r?.starts ?? [], freeAlloc: new Set(r?.freeAlloc ?? []) };
}

export function pathfindRoots(activeSet?: SetMode): Set<string> {
  const mode: SetMode = activeSet || state.activeSet || 'main';
  const allowed = ALLOWED_SETS_FOR_MODE[mode];
  const roots = new Set<string>();
  if (state.klass) {
    for (const id in TREE.nodes) {
      const n = TREE.nodes[id];
      if (!n || n.k !== 'class_start') continue;
      if ((n.kl || '').split('|').includes(state.klass)) { roots.add(id); break; }
    }
  }
  if (state.asc) {
    for (const id in TREE.nodes) {
      const n = TREE.nodes[id];
      if (!n) continue;
      if (n.k === 'asc_start' && n.a === state.asc) { roots.add(id); break; }
    }
  }
  // Alt-start hubs: any allocated asc node with `altStartClass` in
  // ASC_EFFECTS adds that class's start hub as an additional root.
  // Path of the Sorceress on Pathfinder lets the user allocate from
  // Sorceress's starting cluster without crossing the entire tree.
  for (const [sid] of state.selected) {
    const eff = ASC_EFFECTS[sid];
    if (!eff || !eff.altStartClass) continue;
    for (const id in TREE.nodes) {
      const n = TREE.nodes[id];
      if (!n || n.k !== 'class_start') continue;
      if ((n.kl || '').split('|').includes(eff.altStartClass)) { roots.add(id); break; }
    }
  }
  // Jewel alt-starts (Split Personality's rolled class start).
  for (const nm of jewelRules().starts) {
    for (const id in TREE.nodes) {
      const n = TREE.nodes[id];
      if (!n || n.k !== 'class_start') continue;
      if ((n.kl || '').split('|').includes(nm)) { roots.add(id); break; }
    }
  }
  for (const [id, setKind] of state.selected) {
    const n = TREE.nodes[id];
    if (!n) continue;
    if (n.a) { roots.add(id); continue; }
    if (allowed.has(setKind)) roots.add(id);
  }
  return roots;
}

// A selected node from a DIFFERENT mode must act as a hard wall
// for path-finding in the current mode. It's not a root (we don't
// get to start from it), AND it's not a transit node (the path
// can't step through it on the way to the target). Without this,
// a set2-allocated node would silently bridge a set1 chain through
// itself — exactly the chaining bug we're trying to prevent.
export function isBlockedForMode(id: string, allowed: Set<string>): boolean {
  if (!state.selected.has(id)) return false;
  const n = TREE.nodes[id];
  if (!n || n.a) return false;  // asc nodes are mode-agnostic
  return !allowed.has(state.selected.get(id)!);
}

// Keystones + jewel sockets are "global" nodes — they don't belong
// to a weapon set, so they can never be allocated under set1 / set2.
// Mirrors PoB2 (PassiveTreeView.lua:365-379 + 1891-1893): allocation
// refused with a tooltip warning when in weapon-set mode.
export function isGlobalNode(n: TreeNode | null | undefined): boolean {
  return !!n && (n.k === 'keystone' || n.k === 'jewel');
}

// Shortest path from any root to target, as a list of unselected
// intermediate node ids ending in target. Returns [] if target is
// already a root, null if target is unreachable (disconnected from
// the player's start hub). activeSet controls which existing
// allocations count as roots AND which selected nodes are walls —
// see pathfindRoots() and isBlockedForMode().
export function shortestPath(target: string, activeSet?: SetMode): string[] | null {
  const mode: SetMode = activeSet || state.activeSet || 'main';
  const allowed = ALLOWED_SETS_FOR_MODE[mode];
  const roots = pathfindRoots(mode);
  if (roots.size === 0) return null;
  if (roots.has(target)) return [];
  // Controlled Metamorphosis: in-ring passives allocate directly,
  // no path — and never serve as a path for anything else.
  if (jewelRules().freeAlloc.has(target) && !state.selected.has(target)) {
    return [target];
  }
  const visited = new Set<string>(roots);
  const parent = new Map<string, string>();
  let frontier = [...roots];
  while (frontier.length) {
    const next: string[] = [];
    for (const cur of frontier) {
      const nbrs = adj.get(cur);
      if (!nbrs) continue;
      for (const nx of nbrs) {
        if (visited.has(nx)) continue;
        // Locked nodes (unlockConstraint mismatch — e.g. Oracle's
        // Unseen Path extras on a non-Oracle build) don't exist for
        // pathfinding. Can't be target, can't be transit.
        if (isLocked(nx)) continue;
        if (isBlockedForMode(nx, allowed) && nx !== target) continue;
        visited.add(nx);
        parent.set(nx, cur);
        if (nx === target) {
          const path: string[] = [];
          let p: string | undefined = nx;
          while (p && parent.has(p) && !roots.has(p)) { path.unshift(p); p = parent.get(p); }
          return path;
        }
        next.push(nx);
      }
    }
    frontier = next;
  }
  return null;
}

// Find ALL edges that lie on some shortest path from any root to
// `target`, split into a "primary" path (one specific choice) and
// the "alternate" edges (the other equal-length options). Returns
// { primary: [[a,b],...], alternate: [[a,b],...] } or null if
// target unreachable.
//
// Algorithm:
//   1. Forward BFS from roots, recording for each visited node the
//      set of predecessors at distance d-1. A node may have multiple
//      such predecessors → that's where the path branches.
//   2. Walk BACKWARDS from target through the predecessor relation
//      to collect every edge in the shortest-path DAG.
//   3. Pick a primary path by always taking the first predecessor;
//      the remaining DAG edges become "alternate".
type EdgePair = [string, string];
export interface ShortestPathResult {
  primary: EdgePair[];
  alternate: EdgePair[];
  pathCount?: number;
}
export function shortestPathEdges(target: string, activeSet?: SetMode): ShortestPathResult | null {
  const mode: SetMode = activeSet || state.activeSet || 'main';
  const allowed = ALLOWED_SETS_FOR_MODE[mode];
  const roots = pathfindRoots(mode);
  if (roots.size === 0 || roots.has(target)) {
    return { primary: [], alternate: [] };
  }
  if (jewelRules().freeAlloc.has(target) && !state.selected.has(target)) {
    return { primary: [], alternate: [] };   // direct alloc: no edges to light
  }
  const dist = new Map<string, number>();
  const preds = new Map<string, Set<string>>();
  for (const r of roots) { dist.set(r, 0); preds.set(r, new Set()); }
  let frontier = [...roots];
  let targetDist = -1;
  while (frontier.length && targetDist < 0) {
    const next: string[] = [];
    for (const cur of frontier) {
      const nbrs = adj.get(cur);
      if (!nbrs) continue;
      const cd = dist.get(cur);
      if (cd === undefined) continue;
      for (const nx of nbrs) {
        // Locked nodes (unlockConstraint mismatch) don't participate.
        if (isLocked(nx)) continue;
        // Treat wrong-mode selected nodes as walls — they belong to
        // a different overlay and can't be used as transit (except
        // when they ARE the target, which can't happen in practice
        // since clicking a selected node hits the dealloc path).
        if (isBlockedForMode(nx, allowed) && nx !== target) continue;
        if (!dist.has(nx)) {
          dist.set(nx, cd + 1);
          preds.set(nx, new Set([cur]));
          next.push(nx);
          if (nx === target) targetDist = cd + 1;
        } else if (dist.get(nx) === cd + 1) {
          preds.get(nx)!.add(cur);
        }
      }
    }
    frontier = next;
  }
  if (targetDist < 0) return null;
  // After we stopped at target's level, some same-level edges
  // arriving at target might still be unrecorded (BFS exited
  // mid-level). Sweep once more over the current frontier to pick
  // up any extra predecessors of target.
  for (const cur of frontier) {
    const nbrs = adj.get(cur);
    if (!nbrs) continue;
    const cd = dist.get(cur);
    if (cd === undefined) continue;
    for (const nx of nbrs) {
      if (isBlockedForMode(nx, allowed) && nx !== target) continue;
      if (dist.get(nx) === cd + 1 && preds.has(nx)) preds.get(nx)!.add(cur);
    }
  }
  // Collect ALL shortest-path edges via backwards walk.
  const allEdges = new Set<string>();
  const seen = new Set<string>([target]);
  const queue: string[] = [target];
  while (queue.length) {
    const cur = queue.shift()!;
    const ps = preds.get(cur);
    if (!ps) continue;
    for (const p of ps) {
      allEdges.add(p + '|' + cur);
      if (!seen.has(p)) { seen.add(p); queue.push(p); }
    }
  }
  // Enumerate up to N distinct shortest paths via DFS through preds.
  // Each path is one full walk from target back to a root. We cap
  // the count so heavily-branching DAGs don't blow up
  // combinatorially.
  const PATH_CAP = 16;
  const rawPaths: EdgePair[][] = [];
  (function dfs(node: string, edges: EdgePair[]): void {
    if (rawPaths.length >= PATH_CAP) return;
    const ps = preds.get(node);
    if (!ps || ps.size === 0) { rawPaths.push([...edges]); return; }
    for (const par of ps) {
      if (rawPaths.length >= PATH_CAP) return;
      edges.push([par, node]);
      dfs(par, edges);
      edges.pop();
    }
  })(target, []);
  if (rawPaths.length === 0) return null;

  // Dedupe by NODE SET: a path that visits the same set of nodes as
  // an earlier path produces the same allocation, so showing both
  // as "alternates" is misleading (the user would commit identical
  // selections either way). Two paths only count as distinct if
  // they touch at least one different intermediate node.
  const seenSets = new Set<string>();
  const allPaths: EdgePair[][] = [];
  for (const p of rawPaths) {
    const ns = new Set<string>();
    for (const [a, b] of p) { ns.add(a); ns.add(b); }
    const key = [...ns].sort().join(',');
    if (seenSets.has(key)) continue;
    seenSets.add(key);
    allPaths.push(p);
  }

  // Pick which path is "primary" via the rotation index. The index
  // is updated by handleRightClick; updatePreview resets it whenever
  // the hover target changes.
  let idx = 0;
  if (state.pathSwapTarget === target && state.pathSwapIndex < allPaths.length) {
    idx = state.pathSwapIndex;
  }
  const primary = allPaths[idx] ?? [];
  const primaryKeys = new Set(primary.map(e => e[0] + '|' + e[1]));

  const alternate: EdgePair[] = [];
  for (const k of allEdges) {
    if (!primaryKeys.has(k)) {
      const [a, b] = k.split('|');
      if (a && b) alternate.push([a, b]);
    }
  }
  return { primary, alternate, pathCount: allPaths.length };
}

// If the user clicks/deselects `target`, which other currently-
// allocated nodes lose their connection back to the class start
// (or asc start)?
//
// We run THREE separate BFS passes — one per mode (main / set1 /
// set2) — because each mode forms its own connected subgraph
// (see ALLOWED_SETS_FOR_MODE). A selected node is orphaned iff it
// can't be reached in ITS OWN mode after the target is removed.
// This means removing a set1 bridge only orphans set1 nodes that
// depended on it, not the main allocations beyond — and conversely
// catches cases where a set1 node was wrongly bridging main nodes.
export function computeDeallocResult(targetId: string): Set<string> {
  const removed = new Set<string>([targetId]);
  const startHubs = new Set<string>();
  function addClassHub(klass: string | null | undefined): void {
    if (!klass) return;
    for (const id in TREE.nodes) {
      const n = TREE.nodes[id];
      if (!n || n.k !== 'class_start') continue;
      if ((n.kl || '').split('|').includes(klass)) {
        if (id !== targetId) startHubs.add(id);
        return;
      }
    }
  }
  addClassHub(state.klass);
  if (state.asc) {
    for (const id in TREE.nodes) {
      const n = TREE.nodes[id];
      if (!n) continue;
      if (n.k === 'asc_start' && n.a === state.asc) {
        if (id !== targetId) startHubs.add(id);
      }
    }
  }
  // Alt-start hubs unlocked by allocated MC options (Path of the
  // Sorceress / Warrior on Pathfinder). Without this, every
  // Sorceress-side allocation looks "unreachable from the Ranger
  // hub" the moment any single node is removed, and
  // computeDeallocResult cascade-prunes the whole alt-start branch.
  for (const [sid] of state.selected) {
    if (sid === targetId) continue;
    const eff = ASC_EFFECTS[sid];
    if (eff && eff.altStartClass) addClassHub(eff.altStartClass);
  }
  // Jewel alt-starts survive the cascade like MC alt-starts do.
  for (const nm of jewelRules().starts) addClassHub(nm);
  // Locked AFTER the target is removed: same as isLocked, but also
  // treats the targetId as if it's already gone from state.selected.
  // Catches the Unseen Path case where deallocating node 5571 makes
  // the 197 dependent main-tree nodes locked even though they were
  // reachable through normal edges while 5571 was held.
  function isLockedAfterTarget(id: string): boolean {
    const n = TREE.nodes[id];
    if (!n || !n.uc) return false;
    if (n.uc.a !== state.asc) return true;
    if (n.uc.n && n.uc.n.length) {
      for (const reqId of n.uc.n) {
        const sid = String(reqId);
        if (!state.selected.has(sid)) return true;
        if (sid === targetId) return true;
      }
    }
    return false;
  }
  function reachableInMode(allowed: Set<string>): Set<string> {
    const visited = new Set<string>(startHubs);
    const stack: string[] = [...startHubs];
    // Metamorphosis-ring allocations are self-rooted: they SURVIVE
    // (added to visited) but never expand (not pushed) — a
    // disconnected island can't keep normal allocations alive.
    for (const fid of jewelRules().freeAlloc) {
      if (fid !== targetId && state.selected.has(fid)) visited.add(fid);
    }
    while (stack.length) {
      const cur = stack.pop();
      if (!cur) continue;
      const nbrs = adj.get(cur);
      if (!nbrs) continue;
      for (const nx of nbrs) {
        if (visited.has(nx)) continue;
        if (nx === targetId) continue;
        if (!state.selected.has(nx)) continue;
        // Locked-after-target acts as a wall — selection touching a
        // node whose unlock gate just broke must cascade-orphan.
        if (isLockedAfterTarget(nx)) continue;
        const n = TREE.nodes[nx];
        if (!n) continue;
        const setKind = state.selected.get(nx) ?? 'main';
        // Asc nodes are always traversable — they participate in
        // every mode through their own subgraph.
        if (!n.a && !allowed.has(setKind)) continue;
        visited.add(nx);
        stack.push(nx);
      }
    }
    return visited;
  }
  const reachMain = reachableInMode(ALLOWED_SETS_FOR_MODE.main);
  const reachSet1 = reachableInMode(ALLOWED_SETS_FOR_MODE.set1);
  const reachSet2 = reachableInMode(ALLOWED_SETS_FOR_MODE.set2);
  for (const [id, setKind] of state.selected) {
    if (id === targetId) continue;
    const n = TREE.nodes[id];
    if (!n) continue;
    // Multi-choice options are hidden from the adjacency graph
    // (they never appear on the tree spatially) so the BFS above
    // doesn't visit them — but they aren't orphans, they live on
    // their parent notable. Their reachability follows the
    // parent's. If the parent itself is the targetId (being
    // deallocated), the option falls out by cascade; otherwise as
    // long as the parent survives, the option survives too.
    const mcParent = MULTI_CHOICE_PARENT[id];
    if (mcParent) {
      if (mcParent === targetId) { removed.add(id); continue; }
      if (!state.selected.has(mcParent)) { removed.add(id); continue; }
      const pn = TREE.nodes[mcParent];
      const parentOk = pn && pn.a
        ? (reachMain.has(mcParent) || reachSet1.has(mcParent) || reachSet2.has(mcParent))
        : reachMain.has(mcParent);
      if (!parentOk) removed.add(id);
      continue;
    }
    let ok: boolean;
    if (n.a) {
      ok = reachMain.has(id) || reachSet1.has(id) || reachSet2.has(id);
    } else if (setKind === 'set1') {
      ok = reachSet1.has(id);
    } else if (setKind === 'set2') {
      ok = reachSet2.has(id);
    } else {
      ok = reachMain.has(id);
    }
    if (!ok) removed.add(id);
  }
  return removed;
}

// Tessellate a list of [a, b] edge pairs into the dashed-line VBO.
// The fragment shader's u_dash_mode renders these with a screen-px
// dash pattern. Each edge resets the dash phase (startDist=0) so
// they look consistent regardless of pre-edge length.
export function tessellatePreviewEdges(edgePairs: EdgePair[], tint: Tint, outArr: number[]): void {
  const orbitR = TREE.orbit_radii;
  for (const [a, b] of edgePairs) {
    const m = getEdgeMeta(a, b);
    if (!m) continue;
    const na = TREE.nodes[String(m[1])];
    const nb = TREE.nodes[String(m[2])];
    if (!na || !nb) continue;
    const asc = m[m.length - 1];
    let dx = 0, dy = 0;
    if (asc) {
      const p = TREE.asc_panels[String(asc)];
      if (!p || state.asc !== asc) continue;
      dx = -p.x; dy = -p.y;
    }
    if (m[0] === 'a') {
      const cx = m[3] as number, cy = m[4] as number, orbitNum = m[6] as number;
      const r = orbitR[orbitNum] || 0;
      if (r <= 0) continue;
      const a1 = Math.atan2(na.y - cy, na.x - cx);
      const a2 = Math.atan2(nb.y - cy, nb.x - cx);
      let delta = a2 - a1;
      while (delta >  Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      pushArcD(outArr, cx, cy, r, a1, delta, dx, dy, tint, 0);
    } else {
      pushLineSegD(outArr, na.x + dx, na.y + dy, nb.x + dx, nb.y + dy, tint, 0);
    }
  }
}

// ---------------------------------------------------------------------
// Preview overlay (allocate / deallocate hover)
// ---------------------------------------------------------------------
// Rebuilt only when state.hoverId changes (not per mousemove). Shows
// either the path that would be allocated (gold dashes) on hover of
// an unselected node, or the set that would be deallocated (red
// dashes) on hover of an allocated one.
// Type-narrowed declarations so cross-file consumers (render)
// get the right shape — the implicit-null inference these would
// have without annotations isn't useful past file boundaries.
export let previewBuf: WebGLBuffer | null = null;
export let previewVAO: WebGLVertexArrayObject | null = null;
export let previewMainCount = 0;
export let previewAscCount = 0;
// GGG _intermediate textured batches (same VBO as procedural strips
// when useGGGConnectors is on). Procedural offsets shift accordingly.
export let previewConnectorBatches: Array<{ tex: WebGLTexture; start: number; count: number }> = [];
export let previewConnectorAscBatches: Array<{ tex: WebGLTexture; start: number; count: number }> = [];
export let previewProcMainStart = 0;
export let previewProcAscStart = 0;
// Per-mode primary-path tint. Matches the sidebar legend dots
// (#ff66c4 set1, #5cf26f set2) so the preview line tells the user
// at a glance which mode they're currently committing to.
export const PREVIEW_TINT_ADD_MAIN: Tint = [240/255, 224/255, 160/255, 1.00]; // GGG wedge gold
export const PREVIEW_TINT_ADD_SET1: Tint = [1.00, 0.40, 0.77, 1.00];  // pink
export const PREVIEW_TINT_ADD_SET2: Tint = [0.36, 0.95, 0.44, 1.00];  // green
export function previewTintAddFor(mode: SetMode): Tint {
  return mode === 'set1' ? PREVIEW_TINT_ADD_SET1
       : mode === 'set2' ? PREVIEW_TINT_ADD_SET2
       : PREVIEW_TINT_ADD_MAIN;
}
export const PREVIEW_TINT_ALT: Tint = [0.58, 0.66, 0.95, 0.95];    // alternate path (blue)
export const PREVIEW_TINT_REMOVE: Tint = [1.0, 0.32, 0.28, 1.0];   // dealloc cascade (red)

// Split a list of [a,b] pairs by whether the edge belongs to the
// currently visible ascendancy panel or the main tree. Edges in
// OTHER asc panels (not state.asc) are discarded — they aren't
// visible right now.
export function partitionEdgesByAsc(pairs: EdgePair[], mainOut: EdgePair[], ascOut: EdgePair[]): void {
  for (const [a, b] of pairs) {
    const m = getEdgeMeta(a, b);
    if (!m) continue;
    const ascName = m[m.length - 1];
    if (ascName) {
      if (state.asc === ascName) ascOut.push([a, b]);
    } else {
      mainOut.push([a, b]);
    }
  }
}

export function updatePreview(): void {
  const prevRemoveSize = state.previewRemove.size;
  state.previewAdd = new Set();
  state.previewAddOver = new Set();
  state.previewRemove = new Set();
  state.previewAccumulated = null;
  previewMainCount = 0;
  previewAscCount = 0;

  // Reset the rotation index when the hover target changes — the
  // index is meaningful only for the node currently being previewed.
  if (state.pathSwapTarget !== state.hoverId) {
    state.pathSwapTarget = state.hoverId;
    state.pathSwapIndex = 0;
  }

  let primaryEdges: EdgePair[] | null = null;
  let alternateEdges: EdgePair[] | null = null;
  let removedEdges: EdgePair[] | null = null;

  if (state.hoverId && !state.popoutId) {
    const n = TREE.nodes[state.hoverId];
    if (n && n.k !== 'class_start' && n.k !== 'asc_start') {
      if (state.selected.has(state.hoverId)) {
        // Selected multi-choice parents do NOT deallocate on click —
        // they reopen the picker popout so the user can switch
        // option. Showing the dealloc-preview dashes (red lines to
        // the option's hidden coords) is misleading. Skip the preview.
        if (isMcParent(state.hoverId)) {
          // no-op: no path / no dealloc preview
        } else {
          const removed = computeDeallocResult(state.hoverId);
          state.previewRemove = removed;
          removedEdges = [];
          for (const m of TREE.edges_meta) {
            const a = String(m[1]), b = String(m[2]);
            if (removed.has(a) && removed.has(b)) removedEdges.push([a, b]);
          }
        }
      } else if (isGlobalNode(n) &&
                 (effectiveActiveSet() === 'set1' || effectiveActiveSet() === 'set2')) {
        // Global node in a weapon-set mode → click will be refused.
        // Skip the path preview so we don't tease an allocation that
        // can't actually land. The tooltip carries the warning.
      } else {
        // BFS uses the effective active set so the previewed path
        // matches what the current modifier state would commit to.
        const paths = shortestPathEdges(state.hoverId, effectiveActiveSet());
        if (paths) {
          primaryEdges = paths.primary;
          alternateEdges = paths.alternate;
          for (const [, child] of paths.primary) state.previewAdd.add(String(child));
          // computePathAccumulation returns a string[] of stat lines;
          // we tack on the named fields the tooltip reads. Cast widens
          // the hybrid shape declared in state.previewAccumulated.
          const accum = computePathAccumulation(paths.primary, state.hoverId) as
            string[] & { cost?: number; altCount?: number; mainAdd?: number;
                         setAdd?: number; ascAdd?: number; setMode?: boolean;
                         levelNeeded?: number };
          accum.cost = paths.primary.length;
          accum.altCount = paths.pathCount && paths.pathCount > 1 ? paths.pathCount - 1 : 0;
          // Per-category cost breakdown — the same partition the click
          // gate uses, so the tooltip can warn when committing this
          // path would exceed one of the dynamic caps. Also detects
          // WHICH nodes in the path sequence cross the budget cap so
          // we can paint their edges in the dealloc-red colour: the
          // user sees the affordable prefix in gold and the unreachable
          // tail in red without reading the tooltip.
          const eff = effectiveActiveSet();
          const isSetMode = eff === 'set1' || eff === 'set2';
          const cur = countSelected();
          const mainCap = MAX_MAIN_POINTS + cur.mainPointGrant;
          const setCap  = MAX_SET_POINTS  + cur.weaponSetGrant;
          let mainAdd = 0, setAdd = 0, ascAdd = 0;
          let runM = cur.main, runS = cur.sets, runA = cur.asc;
          // shortestPathEdges builds primary in TARGET-first order
          // (DFS that pushes the deepest edge first). For the
          // budget-walk we want ROOT-first so the affordable prefix
          // closest to the player's current allocations stays gold
          // and the unreachable tail near the target goes red — that
          // matches the player's mental model: "I can take these
          // first, then I run out." Iterate paths.primary in reverse.
          for (let i = paths.primary.length - 1; i >= 0; i--) {
            const edge = paths.primary[i];
            if (!edge) continue;
            const child = edge[1];
            const cId = String(child);
            if (state.selected.has(cId)) continue;
            const pn = TREE.nodes[cId];
            if (!pn) continue;
            const isAsc = !!pn.a;
            if (isAsc) ascAdd++;
            else if (isSetMode) setAdd++;
            else mainAdd++;
            if (isAsc) runA++;
            else if (isSetMode) runS++;
            else runM++;
            const over = runM > mainCap || runS > setCap || runA > MAX_ASC_POINTS;
            if (over) state.previewAddOver.add(cId);
          }
          accum.mainAdd = mainAdd;
          accum.setAdd  = setAdd;
          accum.ascAdd  = ascAdd;
          accum.setMode = isSetMode;
          // Level you would need to be at to actually allocate this
          // full path (mains only — asc + set are off-curve and don't
          // ladder with character level). Used by the tooltip's "need
          // Lv X" line; computed even when not over-budget so the
          // author can preview "this notable lands at Lv 73".
          if (typeof currentCharacterLevel === 'function') {
            accum.levelNeeded = currentCharacterLevel() + mainAdd;
          }
          state.previewAccumulated = accum;
        }
      }
    }
  }

  // Partition each set into main-tree vs current-asc edges so the
  // asc portion can be drawn INSIDE drawAscPanel (above its portrait,
  // below its nodes). Without the split, the asc portrait would
  // cover the preview overlay. Primary edges get a second split by
  // budget: edges whose new-node end is past the point cap go in the
  // *Po (over-budget) buckets, tinted red — the rest stay gold/pink/
  // green like normal adds.
  const overSet = state.previewAddOver;
  const primaryIn: EdgePair[] = [], primaryOver: EdgePair[] = [];
  if (primaryEdges) {
    for (const e of primaryEdges) {
      if (overSet.has(String(e[1]))) primaryOver.push(e);
      else primaryIn.push(e);
    }
  }
  const mA: EdgePair[] = [], aA: EdgePair[] = [];
  const mP: EdgePair[] = [], aP: EdgePair[] = [];
  const mPo: EdgePair[] = [], aPo: EdgePair[] = [];
  const mR: EdgePair[] = [], aR: EdgePair[] = [];
  if (alternateEdges) partitionEdgesByAsc(alternateEdges, mA, aA);
  if (primaryIn.length)   partitionEdgesByAsc(primaryIn,   mP, aP);
  if (primaryOver.length) partitionEdgesByAsc(primaryOver, mPo, aPo);
  if (removedEdges)   partitionEdgesByAsc(removedEdges,   mR, aR);

  const verts: number[] = [];
  const addTint = previewTintAddFor(effectiveActiveSet());
  previewConnectorBatches = [];
  previewConnectorAscBatches = [];

  // (1) GGG _intermediate textured kite-quads for the preview path.
  //     Same VBO as procedural strips so we can switch passes via
  //     state.useGGGConnectors. Alternate (blue) drawn first so the
  //     primary (gold/pink/green) lands on top at the intersection.
  function buildPreviewTexturedSlice(
    pairs: EdgePair[], scope: 'main' | 'asc', tint: Tint,
    outBatches: Array<{ tex: WebGLTexture; start: number; count: number }>,
  ): void {
    const slice = tessellateEdgesTexturedFromList(pairs, scope, 'intermediate', () => tint);
    const base = verts.length / STRIDE_FLOATS;
    for (let i = 0; i < slice.verts.length; i++) verts.push(slice.verts[i]!);
    for (const b of slice.batches) {
      if (b.tex) outBatches.push({ tex: b.tex, start: base + b.start, count: b.count });
    }
  }
  if (mA.length)  buildPreviewTexturedSlice(mA,  'main', PREVIEW_TINT_ALT,    previewConnectorBatches);
  if (mP.length)  buildPreviewTexturedSlice(mP,  'main', addTint,             previewConnectorBatches);
  if (mPo.length) buildPreviewTexturedSlice(mPo, 'main', PREVIEW_TINT_REMOVE, previewConnectorBatches);
  if (mR.length)  buildPreviewTexturedSlice(mR,  'main', PREVIEW_TINT_REMOVE, previewConnectorBatches);
  if (state.asc) {
    if (aA.length)  buildPreviewTexturedSlice(aA,  'asc', PREVIEW_TINT_ALT,    previewConnectorAscBatches);
    if (aP.length)  buildPreviewTexturedSlice(aP,  'asc', addTint,             previewConnectorAscBatches);
    if (aPo.length) buildPreviewTexturedSlice(aPo, 'asc', PREVIEW_TINT_REMOVE, previewConnectorAscBatches);
    if (aR.length)  buildPreviewTexturedSlice(aR,  'asc', PREVIEW_TINT_REMOVE, previewConnectorAscBatches);
  }

  // (2) Procedural dashed strips (fallback path). Layout unchanged
  //     for back-compat with the existing render-pass draw calls.
  previewProcMainStart = verts.length / STRIDE_FLOATS;
  if (mA.length)  tessellatePreviewEdges(mA,  PREVIEW_TINT_ALT, verts);
  if (mP.length)  tessellatePreviewEdges(mP,  addTint, verts);
  if (mPo.length) tessellatePreviewEdges(mPo, PREVIEW_TINT_REMOVE, verts);
  if (mR.length)  tessellatePreviewEdges(mR,  PREVIEW_TINT_REMOVE, verts);
  previewMainCount = verts.length / STRIDE_FLOATS - previewProcMainStart;
  previewProcAscStart = verts.length / STRIDE_FLOATS;
  if (aA.length)  tessellatePreviewEdges(aA,  PREVIEW_TINT_ALT, verts);
  if (aP.length)  tessellatePreviewEdges(aP,  addTint, verts);
  if (aPo.length) tessellatePreviewEdges(aPo, PREVIEW_TINT_REMOVE, verts);
  if (aR.length)  tessellatePreviewEdges(aR,  PREVIEW_TINT_REMOVE, verts);
  previewAscCount = verts.length / STRIDE_FLOATS - previewProcAscStart;

  // Gold sel-edge buffer needs rebuilding when the dealloc-mask
  // changes, so the red dashes don't sit on top of gold gaps.
  if (state.previewRemove.size > 0 || prevRemoveSize > 0) {
    state.selDirty = true;
  }
  if (verts.length > 0) {
    if (!previewBuf) {
      previewBuf = gl.createBuffer();
      if (!previewBuf) throw new Error('gl.createBuffer (previewBuf) returned null');
      previewVAO = makeVAO(previewBuf);
    }
    gl.bindVertexArray(previewVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, previewBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
  }
  // The tooltip's "Path total" depends on the rotated primary path,
  // so it must refresh whenever the preview rebuilds — otherwise
  // right-click would update the dashes on screen but leave stale
  // accumulated stats in the tooltip.
  refreshTooltip();
}

// Click handling has two phases:
//   1. If a popout is currently open, the click resolves it:
//        - On a popout option → commit pick, close popout
//        - On the popout's parent attribute → close popout (toggle)
//        - Anywhere else → close popout AND fall through to phase 2
//          so the click can still hit whatever node is under it
//   2. Standard select/deselect for the clicked target. If that
//      target is an unselected attribute (or a selected attribute
//      whose popout we just closed), we open its popout — so a single
//      click both selects and opens the picker. Until the user picks
//      Str/Dex/Int (or clicks elsewhere) the attribute renders with
//      its generic "any" icon.
export function handleClick(cx: number, cy: number, mods?: { shift?: boolean; alt?: boolean; meta?: boolean; ctrl?: boolean }): void {
  mods = mods || {};
  const t = clientToTree(cx, cy);
  const id = findHoverNode(t.x, t.y);

  // Early-out for clicks that won't mutate the tree at all. Without
  // this, the auto-switch-to-working below would fire on EVERY
  // mouseup — including clicks on UI overlays that sit inside
  // #viewport (the slider chip rail, snapshot button, etc.) because
  // the pan/click detector in viewport.js listens at the
  // viewport level. A chip's own click handler would correctly
  // setActive(clicked idx), then handleClick's auto-switch would
  // immediately overwrite that with working — making chip-to-chip
  // navigation impossible.
  if (!id && !state.popoutId) return;

  // Allocated jewel sockets open the jewel picker (gear_overlay) —
  // the in-game interaction — instead of toggling allocation. The
  // socket is deallocated from inside the picker if wanted.
  if (id && !state.popoutId) {
    const jn = TREE.nodes[id];
    // The bridge returns false for sockets that aren't active (not
    // allocated, sinister without Voices) — then the click falls
    // through to normal allocation handling.
    if (jn && jn.k === 'jewel'
        && window.PoE2Jewels?.handleSocketClick(id, cx, cy)) {
      return;
    }
  }

  // Auto-switch to the WORKING cap before processing a mutating
  // click. If the user is on a frozen snapshot (clicked a chip to
  // inspect) and then clicks a tree node, the mutation should land
  // on their LIVE editing state — not silently change a historical
  // snapshot. setActive fires capture-change synchronously, which
  // re-hydrates state.selected from the working cap before the
  // rest of this handler runs.
  if (window.PoE2Plan && window.PoE2Plan.captures) {
    const caps = window.PoE2Plan.captures;
    if (!caps.isWorking()) {
      const lastIdx = caps.count() - 1;
      caps.setActive(lastIdx);
      if (window.PoE2Plan.flash) {
        window.PoE2Plan.flash('Switched to current snapshot — allocations land here');
      }
    }
  }

  // Phase 1 — resolve open popout
  if (state.popoutId) {
    const pick = pickFromPopout(cx, cy);
    if (pick) {
      if (pick.kind === 'mc') {
        // Multi-choice option pick: allocate the option as an asc
        // node (free — countSelected skips it from the asc total),
        // and deallocate any sibling option of the same parent.
        const parentId = state.popoutId;
        const siblings = MULTI_CHOICE[parentId];
        if (siblings) {
          for (const sibId of siblings) {
            if (sibId !== pick.id) state.selected.delete(sibId);
          }
        }
        if (pick.id) state.selected.set(pick.id, 'main');
        state.selDirty = true;
        // Switching which MC option is picked can invalidate
        // dependents — most importantly Pathfinder's "Path of the
        // Sorceress / Warrior" pair, where the old option's
        // altStartClass was rooting a whole branch of the main tree.
        // Cascade-prune anything that's no longer reachable from a
        // current start hub.
        {
          const orphans = computeDeallocResult('__none__');
          orphans.delete('__none__');
          for (const rid of orphans) {
            state.selected.delete(rid);
            state.pickedAttrs.delete(rid);
            state.allocationMeta.delete(rid);
          }
        }
        maybeRebuildStaticForLocks();
      } else {
        // Attribute pick (Str/Dex/Int). state.pickedAttrs stores
        // the name for UI; flushPersistNow resolves it to the
        // variant id when committing into the active capture.
        state.pickedAttrs.set(state.popoutId, pick.name);
        state.selDirty = true;
      }
      state.popoutId = null;
      updatePreview();
      requestRender();
      updateSelectionUI();
      return;
    }
    const previous = state.popoutId;
    state.popoutId = null;
    // Click on empty space, OR click on the same attribute that just
    // had its popout open → just close and stop.
    if (!id || id === previous) {
      updatePreview();
      requestRender();
      return;
    }
    // Click landed on a different node — fall through.
  }

  // Phase 2 — normal click on a node
  if (!id) return;
  const n = TREE.nodes[id];
  if (!n) return;
  // Class/asc start hubs are anchors, not allocatable.
  if (n.k === 'class_start' || n.k === 'asc_start') return;

  if (state.selected.has(id)) {
    // Selected attribute → reopen its popout for refinement. Use
    // right-click (or sidebar X) for cascade-deallocate of attributes.
    if (n.k === 'attribute' && n.o) {
      state.popoutId = id;
      updatePreview();
      requestRender();
      return;
    }
    // Selected multi-choice notable → reopen its popout so the
    // user can switch the picked option (or pick one for the first
    // time, if they allocated the parent without choosing yet).
    if (isMcParent(id)) {
      state.popoutId = id;
      updatePreview();
      requestRender();
      return;
    }
    const removed = computeDeallocResult(id);
    for (const rid of removed) {
      state.selected.delete(rid);
      state.pickedAttrs.delete(rid);
      state.allocationMeta.delete(rid);
      // When the parent of a multi-choice notable is deallocated,
      // cascade the picked option (if any) so we don't leave an
      // orphan asc option in state.selected.
      if (isMcParent(rid)) {
        const opts = MULTI_CHOICE[rid];
        if (opts) for (const oid of opts) state.selected.delete(oid);
      }
    }
  } else {
    // Per-click set override via modifier keys (does NOT change the
    // sidebar dropdown — sticky mode stays the same):
    //   Ctrl/Cmd+click  → set 1
    //   Shift+click     → set 2
    //   plain click     → whatever state.activeSet says
    // The active set ALSO chooses which connectivity graph the path
    // travels through (main-only / main+set1 / main+set2) so the
    // path can never bridge through a forbidden set.
    const activeSet = mods.ctrl ? 'set1' : mods.shift ? 'set2' : state.activeSet;
    const isSetMode = activeSet === 'set1' || activeSet === 'set2';
    // Global nodes (keystones, jewel sockets) are main-only. Refuse
    // the click outright when the user is in a weapon-set mode —
    // they have to drop back to main to allocate one. Mirrors PoB2.
    if (isSetMode && isGlobalNode(n)) return;
    // Use the SAME rotation-aware primary path that the preview is
    // currently showing — otherwise left-click would commit the
    // default-index path while the user is staring at a different
    // highlighted alternate.
    const paths = shortestPathEdges(id, activeSet);
    if (!paths) return;
    const pathNodes = paths.primary.map(e => String(e[1]));
    let mainAdd = 0, ascAdd = 0, setAdd = 0;
    for (const p of pathNodes) {
      if (state.selected.has(p)) continue;
      const pn = TREE.nodes[p];
      if (!pn) continue;
      if (pn.a) ascAdd++;
      else if (isSetMode) setAdd++;
      else mainAdd++;
    }
    const cur = countSelected();
    if (cur.main + mainAdd > MAX_MAIN_POINTS + cur.mainPointGrant) return;
    if (cur.sets + setAdd  > MAX_SET_POINTS  + cur.weaponSetGrant) return;
    if (cur.asc  + ascAdd  > MAX_ASC_POINTS)  return;
    // Track which nodes are newly added so we can tag asc + weapon-
    // set allocations with the authoring level (mains derive level
    // from position in the cumulative-snapshot array — explicit
    // level only needed for off-curve allocations).
    const newlyAdded = [];
    for (const p of pathNodes) {
      // Defensive: never relabel a node that's ALREADY selected.
      // Pathfinding only returns brand-new nodes (existing
      // selections are BFS roots), but in rare race conditions a
      // re-entrant call could re-emit an existing id — and we don't
      // want a fresh Ctrl+click to silently flip an old main node
      // into set 1 or vice-versa.
      if (state.selected.has(p)) continue;
      const pn = TREE.nodes[p];
      const setKind = (pn && pn.a) ? 'main'   // asc nodes don't have a weapon set
                     : isSetMode    ? activeSet
                     : 'main';
      state.selected.set(p, setKind);
      newlyAdded.push({ id: p, set: setKind, isAsc: !!(pn && pn.a) });
    }
    // Stamp the authoring level on asc + weapon-set allocations.
    // Mains don't need explicit level — their position in the
    // capture's main subset implicitly encodes their level. Asc +
    // set are off-curve (PoE2 grants them via trial / quest, not
    // by levelling), so without an explicit level the slider would
    // have to approximate "appears at capture start" which loses
    // guide fidelity once a capture spans 20-30 levels.
    if (newlyAdded.length > 0) {
      const allocLevel = currentCharacterLevel();
      for (const e of newlyAdded) {
        if (!e.isAsc && e.set !== 'set1' && e.set !== 'set2') continue;
        const meta = state.allocationMeta.get(e.id) || {};
        meta.level = allocLevel;
        state.allocationMeta.set(e.id, meta);
      }
    }
    if (n.k === 'attribute' && n.o) state.popoutId = id;
    // First-time allocation of a multi-choice notable opens its
    // option picker right away, same UX as attributes.
    if (isMcParent(id)) state.popoutId = id;
  }
  // Commit fully resolves whichever path the user was previewing;
  // forget any rotation so future previews start at index 0. The
  // search-highlight set is intentionally kept — the user explicitly
  // asked for it to persist after they close the palette so they
  // can scan the tree visually while planning their build.
  state.pathSwapTarget = null;
  state.pathSwapIndex = 0;
  state.selDirty = true;
  updatePreview();
  requestRender();
  updateSelectionUI();
}

// Right-click has two meanings depending on what you're over:
//   * Selected node  → deallocate with cascade (skip the popout).
//     This is the only way to remove a selected ATTRIBUTE, since
//     left-click on it reopens the Str/Dex/Int picker instead.
//   * Unselected node with multiple shortest paths → rotate to the
//     next enumerated path. Repeated right-clicks cycle through every
//     equal-length option; the currently-rotated path is the one a
//     left-click would commit.
export function handleRightClick(cx: number, cy: number): void {
  const t = clientToTree(cx, cy);
  const id = findHoverNode(t.x, t.y);
  if (!id) return;
  const n = TREE.nodes[id];
  if (!n) return;
  if (n.k === 'class_start' || n.k === 'asc_start') return;

  if (state.selected.has(id)) {
    const removed = computeDeallocResult(id);
    for (const rid of removed) {
      state.selected.delete(rid);
      state.pickedAttrs.delete(rid);
      state.allocationMeta.delete(rid);
    }
    if (state.popoutId && removed.has(state.popoutId)) state.popoutId = null;
    state.pathSwapTarget = null;
    state.pathSwapIndex = 0;
    state.selDirty = true;
    updatePreview();
    requestRender();
    updateSelectionUI();
    return;
  }
  const info = shortestPathEdges(id, state.activeSet);
  if (!info || (info.pathCount || 0) <= 1) return;
  // Increment the rotation index (modulo total paths) so the next
  // shortestPathEdges call picks the next enumerated path as primary.
  if (state.pathSwapTarget !== id) state.pathSwapIndex = 0;
  state.pathSwapTarget = id;
  state.pathSwapIndex = (state.pathSwapIndex + 1) % (info.pathCount || 1);
  updatePreview();
  requestRender();
}

// Returns the picked option entry { id, name, iconUrl } if the click
// landed inside any popout option's frame radius, or null otherwise.
// Caller dispatches on `id != null` to tell attribute vs MC pick.
//
// Hit-test radius enforces a minimum SCREEN-PIXEL size so the option
// stays clickable when the tree is zoomed out — the visual icon
// stays its authored 45-tree-unit radius (so we don't blow up the
// popout aesthetic when zoomed in), but anywhere within ~28 px on
// screen still picks the option. Without this, a zoomed-out attribute
// popout becomes a precision-tap target you can barely hit.
export function pickFromPopout(cx: number, cy: number): { id: string | null; name: string; iconUrl: string | null | undefined; kind: string } | null {
  if (!state.popoutId) return null;
  const n = TREE.nodes[state.popoutId];
  if (!n) return null;
  const opts = popoutOptionsFor(state.popoutId);
  if (!opts) return null;
  const t = clientToTree(cx, cy);
  const MIN_HIT_PX = 28;       // minimum screen-px click radius per option
  const visualHit  = POPOUT_FRAME_SIZE / 2;
  const minHitTree = (state.scale ? MIN_HIT_PX / state.scale : visualHit);
  const hit = Math.max(visualHit, minHitTree);
  let best = -1, bestD2 = Infinity;
  for (let i = 0; i < opts.length; i++) {
    const c = popoutOptionCenter(n, i, opts.length);
    const dx = t.x - c.x, dy = t.y - c.y;
    const d2 = dx * dx + dy * dy;
    // Voronoi-style: pick the NEAREST option within the inflated
    // radius. Inflated hit circles can overlap at low zoom; without
    // tie-breaking the iteration order silently decides between
    // Str/Dex/Int which feels random to the user.
    if (d2 < hit * hit && d2 < bestD2) { bestD2 = d2; best = i; }
  }
  return best >= 0 ? (opts[best] ?? null) : null;
}

export function findClassStartHub(klass: string): TreeNode | null {
  for (const id in TREE.nodes) {
    const n = TREE.nodes[id];
    if (!n || n.k !== 'class_start') continue;
    if ((n.kl || '').split('|').includes(klass)) return n;
  }
  return null;
}

