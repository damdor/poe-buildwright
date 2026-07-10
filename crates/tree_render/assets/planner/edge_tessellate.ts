// ---------------------------------------------------------------------
// Edge tessellation
// ---------------------------------------------------------------------
// edges_meta entries (from build_tree_data in Rust) are either:
//   ["a", a_id, b_id, cx, cy, mid_angle, orbit_num, asc?]
//   ["l", a_id, b_id, mid_x, mid_y, dist, angle_rad, asc?]
// For arcs we re-derive the start/end angles from the node positions
// (cheap; lets us subdivide adaptively).
// Outer radius at which an edge should TERMINATE for a given node.
// Edges run between node centres in the data, but visually they should
// stop at the outer drawn extent of the activated frame — otherwise
// the line bisects the brass ring and reads as "line on top of ring".
// PoB and the in-game tree both trim. We stop the line slightly
// OUTSIDE the frame's nominal outer radius so the line's anti-aliased
// tip doesn't show under the frame's halo (which extends to n.fw *
// 1.15 in drawOverlays).
// Radius at which an edge should TERMINATE for a given node. The
// line's geometric tip lands INSIDE the frame's opaque metal band —
// both the dim unallocated frame and the bright allocated frame are
// drawn on top of the line, so the metal hides the tip and the
// visible portion appears to connect right at the ring's outer edge.
//
// Sampled opaque metal-band positions per frame variant:
//   PSSkillFrame (small/attr):  r=27-54  (fw=108)
//   NotableFrame:               r=40-76  (fw=160)
//   KeystoneFrame:              r=60-120 (fw=240)
//   JewelFrame (skill slot):    r=3-66   (fw=152) — fully opaque
// 0.40 × fw lands inside the metal for all of them and leaves the
// visible portion of the line reaching to the ring's outer edge.

// Edge-tint callback used by tessellateConnectorsTextured / selEdges:
// return null to skip the edge, or a tint to recolor it.

import { texCache } from "./image_preload.ts";
import { ASC_EFFECTS, isLocked, isMcOption, state } from "./state.ts";
import { STRIDE_FLOATS } from "./webgl_setup.ts";
import { Tint, pushArc, pushLineSeg, pushVtx } from "./vertex_helpers.ts";
import { edgeTint } from "./overlay.ts";
import type { TreeNode } from "../../../../types/poe2.d.ts";

export type EdgeFilter = (aId: string, bId: string) => Tint | null;

export function edgeEndRadius(n: TreeNode | undefined): number {
  if (!n) return 0;
  if ((n.fw ?? 0) > 0) return n.fw! * 0.40;
  if ((n.iw ?? 0) > 0) return n.iw! * 0.40;
  return 0;
}
export function pushTrimmedLineSeg(
  outArr: number[], ax: number, ay: number, bx: number, by: number,
  ra: number, rb: number, tint: Tint,
): void {
  const ddx = bx - ax, ddy = by - ay;
  const len = Math.hypot(ddx, ddy);
  if (len < ra + rb + 1) return;  // nodes overlap; nothing visible
  const ux = ddx / len, uy = ddy / len;
  pushLineSeg(outArr,
    ax + ux * ra, ay + uy * ra,
    bx - ux * rb, by - uy * rb,
    tint);
}
export function pushTrimmedArc(
  outArr: number[], cx: number, cy: number, r: number, a1: number, delta: number,
  ra: number, rb: number, dx: number, dy: number, tint: Tint,
): void {
  // Convert each node's outer radius to an angular trim on this orbit.
  // arc length ≈ r * dθ → dθ = node_radius / r.
  if (r <= 0 || Math.abs(delta) < 1e-4) return;
  const sign = delta >= 0 ? 1 : -1;
  const trimA = ra / r;
  const trimB = rb / r;
  const newDelta = delta - sign * (trimA + trimB);
  if (newDelta * sign <= 0) return;  // arc too short to draw after trim
  const newA1 = a1 + sign * trimA;
  pushArc(outArr, cx, cy, r, newA1, newDelta, dx, dy, tint);
}

// ====== GGG textured connector tessellation ==============================
// Orbit-number → sprite-file-suffix mapping, taken from PoB's tree.lua
// `assets` table for the 0_4 (PoE2) data. The file naming is misleading:
// orbit_normal{N}.png is the Nth-largest sprite, NOT the sprite for
// orbit N. The mapping is by radius rank — the sprite for orbit X is
// the file whose pixel size most closely matches that orbit's radius
// (+~5-10% padding for the texture margin).
//
//   orbit  radius   file_idx   file_size
//   ─────  ──────   ────────   ─────────
//     1       82       9         91× 90
//     2      162       8        176×176
//     3      335       6        346×346
//     4      493       5        501×502
//     5      662       4        671×671
//     6      846       3        853×853
//     7      251       7        263×263   (asc-only small orbit)
//     8     1080       2       1090×1091
//     9     1322       1       1333×1333
//     0  (line) →     0  (1435×29 horizontal strip)
//
// Previously we used orbit_normal{N} where {N} == orbit, which made
// orbit 1's kite-quad 1333 units wide (extending 16× past the actual
// node positions). That bug shipped + reverted in eb3265d / 7d96b2a.
export const ORBIT_FILE_IDX: Record<number, number> = { 0: 0, 1: 9, 2: 8, 3: 6, 4: 5, 5: 4, 6: 3, 7: 7, 8: 2, 9: 1 };
// Native sprite width per orbit. Each sprite's arc-curve centerline
// does NOT sit at sprite_w/2 from the BR-corner-orbit-centre; GGG
// baked a small amount of glow/AA padding past the arc that varies
// per sprite. ARC_R_PIX is the centerline-of-opaque measured directly
// from each PNG. We render the kite at size = sprite_w * orbit_r /
// arc_r_pix so the texture's visible arc lands exactly on the actual
// orbit radius (instead of sitting a few units inside). Verified by
// per-orbit alpha sampling of Character_orbit_normal*.png.
export const ORBIT_SPRITE_W: Record<number, number> = { 0: 1435, 1: 1333, 2: 1090, 3: 853, 4: 671, 5: 501, 6: 346, 7: 263, 8: 176, 9: 91 };
export const ARC_R_PIX: Record<number, number>      = {           1:   82, 2:  162.5, 3:  333.5, 4:  487.5, 5:  657, 6:  838.5, 7:  250.5, 8: 1077, 9: 1318 };
export function connectorUrl(prefix: string, orbit: number, state: string): string {
  // GGG's on-disk states are normal / intermediate / intermediateactive —
  // there is no *_orbit_active*.png. Callers use the semantic 'active'
  // (selected edge); map it to the actual filename here.
  const fileState = state === 'active' ? 'intermediateactive' : state;
  const idx = ORBIT_FILE_IDX[orbit] ?? 0;
  return '/assets/sprites/' + prefix + '_orbit_' + fileState + idx + '.png';
}
export function connectorSize(orbit: number): number {
  const spriteW = ORBIT_SPRITE_W[ORBIT_FILE_IDX[orbit] ?? 0] ?? 0;
  const arcR = ARC_R_PIX[orbit] ?? 1;
  const orbitR = TREE.orbit_radii[orbit] ?? 0;
  return spriteW * orbitR / arcR;
}
// Which connection_art family an edge uses. Asc edges always use
// CharacterAscendancy; main edges use Character unless either endpoint
// carries an explicit `ca` override (e.g. CharacterPlanned, 197 nodes).
export function edgeFamily(na: TreeNode, nb: TreeNode): string {
  if (na.a || nb.a) return 'CharacterAscendancy';
  return na.ca || nb.ca || 'Character';
}
// Emit one textured kite-quad (PoB's BuildArc vertex layout). Caller
// passes the START angle in PoB convention, the arcAngle (≤90°), and
// whether this kite is the mirrored second half of a >90° arc. tint
// is multiplied with the texture per-vertex (use [1,1,1,1] for the
// sprite's natural color, or e.g. pink to recolor a brass sprite).
export function pushConnectorKite(
  arr: number[], cx: number, cy: number, startPoB: number, arcAngle: number,
  isMirrored: boolean, orbit: number, dx: number, dy: number, tint: Tint,
): void {
  const clipAngle = Math.PI / 4 - arcAngle / 2;
  const p = 1 - Math.max(Math.tan(clipAngle), 0);
  let anglePoB = startPoB - clipAngle;
  // Mirrored second-half: PoB shifts the kite's start past the first
  // half by adding arcAngle, then later swaps vert3↔vert7 so the
  // texture's arc curve runs in the opposite direction (otherwise the
  // two halves would mirror across each other and leave a V-seam at
  // the join). See PassiveTree.lua:690-712.
  if (isMirrored) anglePoB += arcAngle;
  const size = connectorSize(orbit);
  const sqrt2 = Math.SQRT2;
  const oX = size * sqrt2 *  Math.sin(anglePoB + Math.PI / 4);
  const oY = size * sqrt2 * -Math.cos(anglePoB + Math.PI / 4);
  const v1x = cx,      v1y = cy;
  const v5x = cx + oX, v5y = cy + oY;
  let v3x = v5x + (size *  Math.sin(anglePoB) - oX) * p;
  let v3y = v5y + (size * -Math.cos(anglePoB) - oY) * p;
  let v7x = v5x + (size *  Math.cos(anglePoB) - oX) * p;
  let v7y = v5y + (size *  Math.sin(anglePoB) - oY) * p;
  if (isMirrored) {
    const tx = v3x, ty = v3y;
    v3x = v7x; v3y = v7y;
    v7x = tx;  v7y = ty;
  }
  pushVtx(arr, v1x + dx, v1y + dy, 1, 1, tint, 0, 0, 0, 0);
  pushVtx(arr, v3x + dx, v3y + dy, 0, p, tint, 0, 0, 0, 0);
  pushVtx(arr, v5x + dx, v5y + dy, 0, 0, tint, 0, 0, 0, 0);
  pushVtx(arr, v1x + dx, v1y + dy, 1, 1, tint, 0, 0, 0, 0);
  pushVtx(arr, v5x + dx, v5y + dy, 0, 0, tint, 0, 0, 0, 0);
  pushVtx(arr, v7x + dx, v7y + dy, p, 0, tint, 0, 0, 0, 0);
}
// Tessellate one arc edge as 1 or 2 textured kite-quads. a1 is the
// start-angle (math atan2 convention); delta is the signed sweep. For
// arcs ≤90° we emit a single kite; for 90°–180° we emit two mirrored
// halves (matching PoB's BuildConnector at line 607–620).
export function pushConnectorArc(
  arr: number[], cx: number, cy: number, a1: number, delta: number,
  orbit: number, _prefix: string, dx: number, dy: number, tint: Tint,
): void {
  if (!Math.abs(delta) || orbit < 1 || orbit > 9) return;
  const arcAngle = Math.abs(delta);
  // PoB convention angle (verified): pob_angle = math_angle + π/2.
  // Always sweep from the smaller math endpoint going CCW.
  const startMath = delta >= 0 ? a1 : (a1 + delta);
  const startPoB = startMath + Math.PI / 2;
  if (arcAngle > Math.PI / 2) {
    // Two halves. PoB calls BuildArc twice with arcAngle/2 each: the
    // primary starts at startPoB, the secondary (isMirroredArc=true)
    // starts at startPoB + half-arc-angle.
    const half = arcAngle / 2;
    pushConnectorKite(arr, cx, cy, startPoB, half, false, orbit, dx, dy, tint);
    pushConnectorKite(arr, cx, cy, startPoB, half, true,  orbit, dx, dy, tint);
  } else {
    pushConnectorKite(arr, cx, cy, startPoB, arcAngle, false, orbit, dx, dy, tint);
  }
}
export function pushConnectorLine(
  arr: number[], ax: number, ay: number, bx: number, by: number,
  dx: number, dy: number, tint: Tint,
): void {
  const vX = bx - ax, vY = by - ay;
  const dist = Math.hypot(vX, vY);
  if (dist < 1) return;
  const spriteH = 29, spriteW = 1435;
  const scale = spriteH * 0.5 / dist;
  const nX = vX * scale, nY = vY * scale;
  const endS = dist / spriteW;
  const c1x = ax - nY, c1y = ay + nX, c2x = ax + nY, c2y = ay - nX;
  const c3x = bx + nY, c3y = by - nX, c4x = bx - nY, c4y = by + nX;
  pushVtx(arr, c1x + dx, c1y + dy, 0,    1, tint, 0, 0, 0, 0);
  pushVtx(arr, c2x + dx, c2y + dy, 0,    0, tint, 0, 0, 0, 0);
  pushVtx(arr, c3x + dx, c3y + dy, endS, 0, tint, 0, 0, 0, 0);
  pushVtx(arr, c1x + dx, c1y + dy, 0,    1, tint, 0, 0, 0, 0);
  pushVtx(arr, c3x + dx, c3y + dy, endS, 0, tint, 0, 0, 0, 0);
  pushVtx(arr, c4x + dx, c4y + dy, endS, 1, tint, 0, 0, 0, 0);
}
// Walk edges_meta (or a custom edge list) and bucket textured
// connector quads by texture URL. `state` chooses the sprite-state
// suffix ('normal' | 'active' | 'intermediate'). `edgeFilter` (a, b) →
// tint or null lets callers select a subset (e.g. only allocated
// edges) and per-edge recolor. When edgeFilter is null all edges pass
// with WHITE.
export const TINT_WHITE: Tint = [1, 1, 1, 1];
interface TexturedConnectorBucket { url: string; items: Array<(arr: number[]) => void>; }
interface TexturedConnectorBatch { tex: WebGLTexture | undefined; start: number; count: number; }
export function tessellateConnectorsTextured(
  filterAsc: string | null,
  dx?: number, dy?: number, spriteState?: string, edgeFilter?: EdgeFilter | null,
): { verts: number[]; batches: TexturedConnectorBatch[] } {
  dx = dx || 0; dy = dy || 0;
  spriteState = spriteState || 'normal';
  const meta = TREE.edges_meta;
  const buckets = new Map<string, TexturedConnectorBucket>();
  function bucket(url: string, fn: (arr: number[]) => void): void {
    if (!texCache.has(url)) return;
    let b = buckets.get(url);
    if (!b) { b = { url, items: [] }; buckets.set(url, b); }
    b.items.push(fn);
  }
  for (let i = 0; i < meta.length; i++) {
    const m = meta[i];
    if (!m) continue;
    const asc = m[m.length - 1];
    if (filterAsc !== null) {
      if (asc !== filterAsc) continue;
    } else if (asc) {
      continue;
    }
    const aId = String(m[1]), bId = String(m[2]);
    if (isMcOption(aId) || isMcOption(bId)) continue;
    // Locked endpoints (Unseen Path) — skip the textured connector too.
    if (isLocked(aId) || isLocked(bId)) continue;
    const na = TREE.nodes[aId], nb = TREE.nodes[bId];
    if (!na || !nb) continue;
    let tint: Tint = TINT_WHITE;
    if (edgeFilter) {
      const t = edgeFilter(aId, bId);
      if (!t) continue;
      tint = t;
    }
    const prefix = edgeFamily(na, nb);
    if (m[0] === 'a') {
      const cx = m[3] as number, cy = m[4] as number, orbitNum = m[6] as number;
      const url = connectorUrl(prefix, orbitNum, spriteState);
      const a1 = Math.atan2(na.y - cy, na.x - cx);
      const a2 = Math.atan2(nb.y - cy, nb.x - cx);
      let delta = a2 - a1;
      while (delta >  Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      bucket(url, (arr) => pushConnectorArc(arr, cx, cy, a1, delta, orbitNum, prefix, dx!, dy!, tint));
    } else {
      const url = connectorUrl(prefix, 0, spriteState);
      bucket(url, (arr) => pushConnectorLine(arr, na.x, na.y, nb.x, nb.y, dx!, dy!, tint));
    }
  }
  const verts: number[] = [];
  const batches: TexturedConnectorBatch[] = [];
  for (const b of buckets.values()) {
    const start = verts.length / STRIDE_FLOATS;
    for (const fn of b.items) fn(verts);
    const count = verts.length / STRIDE_FLOATS - start;
    if (count > 0) batches.push({ tex: texCache.get(b.url), start, count });
  }
  return { verts, batches };
}

export function tessellateEdges(
  filterAsc: string | null, dx: number, dy: number, tint: Tint, outArr: number[],
): void {
  dx = dx || 0; dy = dy || 0;
  const orbitR = TREE.orbit_radii;
  const meta = TREE.edges_meta;
  for (let i = 0; i < meta.length; i++) {
    const m = meta[i];
    if (!m) continue;
    const a = String(m[1]), b = String(m[2]);
    if (isMcOption(a) || isMcOption(b)) continue;
    // Skip edges whose endpoint is locked (Unseen Path extras when not
    // unlocked). Otherwise the procedural edge would hover visibly
    // with no node at the end of it.
    if (isLocked(a) || isLocked(b)) continue;
    const na = TREE.nodes[a], nb = TREE.nodes[b];
    if (!na || !nb) continue;
    const asc = m[m.length - 1];
    if (filterAsc !== null) {
      if (asc !== filterAsc) continue;
    } else if (asc) {
      continue; // skip asc edges when rendering main tree
    }
    const ra = edgeEndRadius(na);
    const rb = edgeEndRadius(nb);
    if (m[0] === 'a') {
      const cx = m[3] as number, cy = m[4] as number, orbitNum = m[6] as number;
      const r = orbitR[orbitNum] || 0;
      if (r <= 0) continue;
      const a1 = Math.atan2(na.y - cy, na.x - cx);
      const a2 = Math.atan2(nb.y - cy, nb.x - cx);
      let delta = a2 - a1;
      while (delta >  Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      pushTrimmedArc(outArr, cx, cy, r, a1, delta, ra, rb, dx, dy, tint);
    } else {
      pushTrimmedLineSeg(outArr,
        na.x + dx, na.y + dy, nb.x + dx, nb.y + dy,
        ra, rb, tint);
    }
  }
}

// True if `id` should count as "allocated" for edge-highlight purposes.
// Explicitly selected nodes qualify, but so do the active class hub
// and the active asc_start — they're implicit roots, and the first hop
// out of them should show the gold highlight too (otherwise asc trees
// visually start halfway down the chain).
export function isAllocOrRoot(id: string): boolean {
  if (state.selected.has(id)) return true;
  const n = TREE.nodes[id];
  if (!n) return false;
  if (n.k === 'class_start' && state.klass &&
      (n.kl || '').split('|').includes(state.klass)) return true;
  if (n.k === 'asc_start' && n.a === state.asc) return true;
  // Alt-start class hub counts as a root when the unlocking asc node
  // is allocated — keep visual highlighting consistent with the BFS
  // in pathfindRoots().
  if (n.k === 'class_start') {
    const kls = (n.kl || '').split('|');
    for (const [sid] of state.selected) {
      const eff = ASC_EFFECTS[sid];
      if (eff && eff.altStartClass && kls.includes(eff.altStartClass)) return true;
    }
  }
  return false;
}

export function tessellateSelEdges(outArr: number[], tint: Tint | null, scope: 'main' | 'asc'): void {
  // scope: 'main' (only non-asc edges) or 'asc' (only edges of state.asc)
  const meta = TREE.edges_meta;
  const orbitR = TREE.orbit_radii;
  for (let i = 0; i < meta.length; i++) {
    const m = meta[i];
    if (!m) continue;
    const a = String(m[1]), b = String(m[2]);
    // Skip edges touching hidden MC options — those nodes don't exist
    // on the visible tree even when allocated.
    if (isMcOption(a) || isMcOption(b)) continue;
    if (!isAllocOrRoot(a) || !isAllocOrRoot(b)) continue;
    if (state.previewRemove.size > 0 &&
        state.previewRemove.has(a) && state.previewRemove.has(b)) continue;
    const na = TREE.nodes[a], nb = TREE.nodes[b];
    if (!na || !nb) continue;
    const asc = m[m.length - 1];
    if (scope === 'main' && asc) continue;
    if (scope === 'asc') {
      if (!asc || asc !== state.asc) continue;
    }
    let dx = 0, dy = 0;
    if (asc) {
      const p = TREE.asc_panels[String(asc)];
      if (!p) continue;
      dx = -p.x; dy = -p.y;
    }
    // tint=null means "color per-edge by set membership". Used by
    // rebuildSelEdges so a single buffer can mix gold/pink/green.
    // edgeTint (declared in overlay) returns `number[]`; cast to
    // the strict Tint tuple at the boundary so downstream tessellation
    // calls type-check. 4-channel guaranteed by the function's
    // contract — all return paths produce [r,g,b,a].
    const useTint: Tint = tint !== null ? tint : (edgeTint(a, b) as unknown as Tint);
    const ra = edgeEndRadius(na);
    const rb = edgeEndRadius(nb);
    if (m[0] === 'a') {
      const cx = m[3] as number, cy = m[4] as number, orbitNum = m[6] as number;
      const r = orbitR[orbitNum] || 0;
      if (r <= 0) continue;
      const a1 = Math.atan2(na.y - cy, na.x - cx);
      const a2 = Math.atan2(nb.y - cy, nb.x - cx);
      let delta = a2 - a1;
      while (delta >  Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      pushTrimmedArc(outArr, cx, cy, r, a1, delta, ra, rb, dx, dy, useTint);
    } else {
      pushTrimmedLineSeg(outArr,
        na.x + dx, na.y + dy, nb.x + dx, nb.y + dy,
        ra, rb, useTint);
    }
  }
}
