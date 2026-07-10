// ============================================================================
// === Lock-mask rebuild + cascade prune ====================================
// ============================================================================
//
// This file exists to break a cyclic ESM dependency between state and
// {static_geom, pathfind}. The rebuild logic uses
// buildStaticGeometry (from 04d) and computeDeallocResult (from 06) inside
// its function body — both safe deferred references. But putting it in
// state forced state to `import` from those two files, and 04d /
// 06 already import from state for `gl`, `state`, etc. The bidirectional
// import-at-module-init order can break: esbuild evaluated webgl_setup
// before state had finished initializing `gl`, leaving
// `gl.createProgram()` calling on undefined.
//
// Extracting the rebuild here keeps state cycle-free with the two
// large-graph files. The remaining cycle (this file ↔ pathfind via
// computeDeallocResult ↔ maybeRebuildStaticForLocks) is entirely
// deferred — both directions only reference each other inside function
// bodies, so ES module init runs cleanly.

import { isLocked, state } from "./state.ts";
import { buildStaticGeometry } from "./static_geom.ts";
import { computeDeallocResult } from "./pathfind.ts";

// Set of node ids that GATE locked clusters (i.e. they appear in some
// node's uc.n list). For Oracle that's exactly {"5571"}. Used to
// detect when an allocation toggle changes which nodes are locked, so
// we can rebuild the static geometry buffer (the un-allocated icon /
// frame draws) and stop showing the locked sprites.
export const LOCK_TRIGGER_IDS: Set<string> = new Set();
for (const id in TREE.nodes) {
  const _n = TREE.nodes[id];
  if (_n && _n.uc && _n.uc.n) {
    for (const reqId of _n.uc.n) LOCK_TRIGGER_IDS.add(String(reqId));
  }
}

// Cached "lock mask" — a stable string derived from state.asc plus
// which lock-trigger nodes are currently allocated. When this changes
// the static geometry needs to be re-baked so locked sprites appear
// or disappear in lockstep with the gate condition.
let _lastLockMask: string | null = null;
export function currentLockMask(): string {
  const parts = ['asc:' + (state.asc || '')];
  for (const tid of LOCK_TRIGGER_IDS) {
    if (state.selected.has(tid)) parts.push('+' + tid);
  }
  return parts.sort().join('|');
}

export function maybeRebuildStaticForLocks(): boolean {
  const mask = currentLockMask();
  if (mask === _lastLockMask) return false;
  _lastLockMask = mask;
  // Belt-and-suspenders safety sweep: any node now in state.selected
  // that's currently locked must be removed. computeDeallocResult
  // already handles the explicit "user clicked the gating notable"
  // path, but this catches anything that slips through (load-from-
  // share-link, plan import, ascendancy swap quirks).
  let didMutateSelection = false;
  const lockedDrop: string[] = [];
  for (const id of state.selected.keys()) {
    if (isLocked(id)) lockedDrop.push(id);
  }
  for (const id of lockedDrop) {
    state.selected.delete(id);
    state.pickedAttrs.delete(id);
    state.allocationMeta.delete(id);
    didMutateSelection = true;
  }
  // After dropping locked nodes, cascade-prune anything now orphaned
  // (chains that were only reachable through the just-removed nodes).
  if (didMutateSelection) {
    const orphans = computeDeallocResult('__none__');
    orphans.delete('__none__');
    for (const id of orphans) {
      state.selected.delete(id);
      state.pickedAttrs.delete(id);
      state.allocationMeta.delete(id);
    }
    state.selDirty = true;
  }
  // Only rebuild after the initial buildStaticGeometry has run once;
  // the very first call seeds _lastLockMask and the initial build
  // already includes the right nodes.
  if (state.geomReady) buildStaticGeometry();
  return true;
}
