// ---------------------------------------------------------------------
// Dynamic overlay buffer (rebuilt per-frame)
// ---------------------------------------------------------------------
// Holds: background tile, class portrait, BGTreeActive, BGTree,
// selected gold edges, selected allocated frames, picked-attribute
// icon overrides, hover popout, ascendancy panel asc-translated
// selected edges/frames. At most a few thousand quads, rewritten each
// frame — bandwidth is negligible at that size.

// Tex-bucket shared across all overlay helpers: maps a sprite URL to
// the list of sprites we want stamped from it (with the texture
// resolved up-front so render can skip the cache lookup).

import { texCache } from "./image_preload.ts";
import { ASC_IN_PLACE, gl, state } from "./state.ts";
import { maybeRebuildStaticForLocks } from "./lock_rebuild.ts";
import { STRIDE_FLOATS, getTex, makeVAO } from "./webgl_setup.ts";
import { Tint, pushSprite } from "./vertex_helpers.ts";
import { connectorUrl, edgeFamily, isAllocOrRoot, pushConnectorArc, pushConnectorLine, tessellateSelEdges } from "./edge_tessellate.ts";
import { ascOffsetX, ascOffsetY, render } from "./render.ts";
import { getEdgeMeta } from "./pathfind.ts";
import type { Allocation } from "../../../../types/shared.d.ts";

export interface TexBucket { tex: WebGLTexture | undefined; items: Array<(arr: number[]) => void>; }
export interface TexturedConnectorBatch { tex: WebGLTexture | undefined; start: number; count: number; }
export interface ClusterGlowBatch { tex: WebGLTexture; start: number; count: number; }

export const dynBuf = gl.createBuffer();
if (!dynBuf) throw new Error('gl.createBuffer (dynBuf) returned null');
// VAO for the dynamic-overlay buffer. Declaration + assignment live
// together so the binding stays inside this module — ES module imports
// are readonly, so a consumer can't reassign it from elsewhere.
export let dynVAO: WebGLVertexArrayObject | null = makeVAO(dynBuf);
export function uploadDyn(verts: number[]): void {
  gl.bindVertexArray(dynVAO);
  gl.bindBuffer(gl.ARRAY_BUFFER, dynBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
}
// Separate buffer for the lit cluster-glow overlay. Rebuilt each frame
// (the set is small — a few dozen quads at most) and drawn between
// background and main edges, so it sits UNDER nodes + lines.
export const clusterGlowBuf = gl.createBuffer();
if (!clusterGlowBuf) throw new Error('gl.createBuffer (clusterGlowBuf) returned null');
export const clusterGlowVAO = makeVAO(clusterGlowBuf);
export let clusterGlowBatches: ClusterGlowBatch[] = [];

// Search-highlight pulsing glow. A procedural radial-gradient texture
// stamped behind each matching node, with alpha modulated per-frame
// via the u_pulse shader uniform so it visually breathes.
export const searchGlowBuf = gl.createBuffer();
if (!searchGlowBuf) throw new Error('gl.createBuffer (searchGlowBuf) returned null');
export const searchGlowVAO = makeVAO(searchGlowBuf);
export let searchGlowCount = 0;
export let searchGlowTex: WebGLTexture | null = null;
export function makeSearchGlowTexture(): WebGLTexture {
  const SIZE = 128;
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const ctx2d = c.getContext('2d');
  if (!ctx2d) throw new Error('canvas.getContext("2d") returned null');
  const r = SIZE / 2;
  const grd = ctx2d.createRadialGradient(r, r, 0, r, r, r);
  grd.addColorStop(0.00, 'rgba(140, 220, 255, 0.95)');
  grd.addColorStop(0.35, 'rgba( 80, 180, 255, 0.55)');
  grd.addColorStop(0.75, 'rgba( 40, 140, 255, 0.15)');
  grd.addColorStop(1.00, 'rgba(  0,   0,   0, 0)');
  ctx2d.fillStyle = grd;
  ctx2d.fillRect(0, 0, SIZE, SIZE);
  const tex = gl.createTexture();
  if (!tex) throw new Error('gl.createTexture returned null');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}
// Boot orchestrator (boot.ts) calls this once after the texture
// preload + upload finishes. Setter rather than direct assignment so
// the searchGlowTex binding stays inside 04e — required for ES module
// exports (consumers can't reassign an imported binding).
export function initSearchGlowTexture(): void {
  searchGlowTex = makeSearchGlowTexture();
}
export function rebuildSearchGlow(): void {
  searchGlowCount = 0;
  if (state.searchHighlight.size === 0) return;
  const verts: number[] = [];
  const tint: Tint = [1, 1, 1, 1];
  for (const id of state.searchHighlight) {
    const n = TREE.nodes[id];
    if (!n) continue;
    if (n.a) {
      if (state.asc !== n.a) continue;             // different ascendancy — hidden
      if (ASC_IN_PLACE && !state.ascOpen) continue; // circle closed — invisible
    }
    const x = n.x + ascOffsetX(n), y = n.y + ascOffsetY(n);
    // Glow size scales with the node's frame so notables show a
    // bigger ring than small travel nodes.
    const size = Math.max(n.fw ?? 60, 60) * 2.4;
    pushSprite(verts, x, y, size, size, tint, false);
  }
  searchGlowCount = verts.length / STRIDE_FLOATS;
  if (searchGlowCount === 0) return;
  gl.bindVertexArray(searchGlowVAO);
  gl.bindBuffer(gl.ARRAY_BUFFER, searchGlowBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
}
// Pulse animation: requestAnimationFrame loop active only while there
// are highlighted nodes. Each frame is cheap (one drawArrays pass
// over a small VBO) and stops the moment the highlight clears.
export let pulseActive = false;
export function pulseLoop(): void {
  if (!pulseActive) return;
  state.needsRender = false;
  render();
  requestAnimationFrame(pulseLoop);
}
export function syncPulse(): void {
  const wantPulse = state.searchHighlight.size > 0;
  if (wantPulse && !pulseActive) { pulseActive = true; requestAnimationFrame(pulseLoop); }
  else if (!wantPulse && pulseActive) { pulseActive = false; }
}
// Sel-edge buffer. Holds main-tree edges first, then current-asc
// edges. The split lets us draw the asc portion INSIDE drawAscPanel
// (after the asc portrait, so the gold lines aren't covered by it),
// while the main portion stays in the global render pass.
//
// Each edge is colored by the more-specialised of its two endpoints:
//   * set1 on either side → pink
//   * set2 on either side → green
//   * otherwise → gold (regular passive)
export let selEdgeBuf: WebGLBuffer | null = null;
// VAO for selEdgeBuf — declared next to the buffer, assigned lazily on
// first rebuildSelEdges call. Lives in this module for the same reason
// as dynVAO above (readonly ES module imports).
export let selEdgeVAO: WebGLVertexArrayObject | null = null;
export let selEdgeMainCount = 0;
export let selEdgeAscCount = 0;
// GGG textured _active batches for selected edges. Parallel to the
// procedural strip data in selEdgeBuf — both are uploaded together
// (textured kite-quads first, then procedural strips); the render
// pass picks which slice to draw based on state.useGGGConnectors.
export let selConnectorBatches: TexturedConnectorBatch[] = [];     // main-tree slice
export let selConnectorAscBatches: TexturedConnectorBatch[] = [];  // current-asc slice
// Allocated-edge tint — sampled directly from GGG's BGTreeActive
// sprite (the wedge that lights up the chosen class's sector) so the
// highlighted main path visually agrees with the activation glow GGG
// ships in-game. Brightest stable bin of that sprite is ~rgb(240,
// 224, 160) = #f0e0a0, a warm pale-gold — slightly lighter and less
// orange than the previous #ffd683 we'd guessed.
export const TINT_MAIN: Tint = [240/255, 224/255, 160/255, 1.0];
export const TINT_SET1: Tint = [1.00, 0.40, 0.78, 1.0];      // bright pink
export const TINT_SET2: Tint = [0.36, 0.95, 0.45, 1.0];      // bright green
export function edgeTint(aId: string, bId: string): Tint {
  const sa = state.selected.get(aId);
  const sb = state.selected.get(bId);
  if (sa === 'set1' || sb === 'set1') return TINT_SET1;
  if (sa === 'set2' || sb === 'set2') return TINT_SET2;
  return TINT_MAIN;
}
// Tessellate textured kite-quads for an arbitrary edge list (used for
// selected-edge + preview-path rendering when state.useGGGConnectors
// is on). Looks up each [a,b] pair in edgeMetaByPair so we get the
// pre-computed arc orbit / centre. `tintFor(aId, bId)` returns the
// per-edge tint (or null to skip the edge). `stateName` chooses
// 'active' (selected) vs 'intermediate' (preview).
// Returns { verts, batches } same shape as tessellateConnectorsTextured.
export type EdgeTintFn = (aId: string, bId: string) => Tint | null;
export function tessellateEdgesTexturedFromList(
  edgePairs: Array<[string, string]>, scope: 'main' | 'asc',
  stateName: 'active' | 'intermediate', tintFor: EdgeTintFn,
): { verts: number[]; batches: TexturedConnectorBatch[] } {
  const buckets = new Map<string, TexBucket>();
  function bucket(url: string, fn: (arr: number[]) => void): void {
    if (!texCache.has(url)) return;
    let b = buckets.get(url);
    if (!b) { b = { tex: texCache.get(url), items: [] }; buckets.set(url, b); }
    b.items.push(fn);
  }
  for (const [a, b] of edgePairs) {
    const m = getEdgeMeta(a, b);
    if (!m) continue;
    const asc = m[m.length - 1];
    if (scope === 'main' && asc) continue;
    if (scope === 'asc'  && (!asc || asc !== state.asc)) continue;
    const na = TREE.nodes[String(m[1])], nb = TREE.nodes[String(m[2])];
    if (!na || !nb) continue;
    const tint = tintFor(a, b);
    if (!tint) continue;
    // Draw asc edges where their nodes are drawn (PoE2 side panel or
    // PoE1 in-place anchoring).
    const dx = ascOffsetX(na), dy = ascOffsetY(na);
    const prefix = edgeFamily(na, nb);
    if (m[0] === 'a') {
      const cx = m[3] as number, cy = m[4] as number, orbitNum = m[6] as number;
      const url = connectorUrl(prefix, orbitNum, stateName);
      const a1 = Math.atan2(na.y - cy, na.x - cx);
      const a2 = Math.atan2(nb.y - cy, nb.x - cx);
      let delta = a2 - a1;
      while (delta >  Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      bucket(url, (arr) => pushConnectorArc(arr, cx, cy, a1, delta, orbitNum, prefix, dx, dy, tint));
    } else {
      const url = connectorUrl(prefix, 0, stateName);
      bucket(url, (arr) => pushConnectorLine(arr, na.x, na.y, nb.x, nb.y, dx, dy, tint));
    }
  }
  const verts: number[] = [];
  const batches: TexturedConnectorBatch[] = [];
  for (const b of buckets.values()) {
    const start = verts.length / STRIDE_FLOATS;
    for (const fn of b.items) fn(verts);
    const count = verts.length / STRIDE_FLOATS - start;
    if (count > 0) batches.push({ tex: b.tex, start, count });
  }
  return { verts, batches };
}

export function rebuildSelEdges(): void {
  state.selDirty = false;
  // Allocation toggles can change which Unseen-Path-style locked
  // nodes should appear in the static layer. Re-bake if the lock mask
  // moved.
  maybeRebuildStaticForLocks();
  selEdgeMainCount = 0;
  selEdgeAscCount = 0;
  selConnectorBatches = [];
  selConnectorAscBatches = [];
  if (state.selected.size === 0) return;

  // Collect all (a, b) edge pairs where BOTH endpoints are allocated
  // or count as roots (class hub, asc start). Reused by both the
  // textured _active path and the procedural fallback.
  // Level-filter: also require both endpoints to be in-filter so an
  // out-of-range edge falls back to the dim _normal sprite (drawn
  // from mainConnectorBatches) instead of lighting up gold.
  const selPairs: Array<[string, string]> = [];
  for (const m of TREE.edges_meta) {
    if (!m) continue;
    const a = String(m[1]), b = String(m[2]);
    if (!isAllocOrRoot(a) || !isAllocOrRoot(b)) continue;
    if (state.previewRemove.size > 0 &&
        state.previewRemove.has(a) && state.previewRemove.has(b)) continue;
    selPairs.push([a, b]);
  }

  const verts: number[] = [];

  // (1) Textured GGG _active kite-quads first. Buffered into the same
  //     VBO as the procedural strips so we can swap pass at draw time.
  const mainTex = tessellateEdgesTexturedFromList(selPairs, 'main', 'active',
                                                  (a, b) => edgeTint(a, b));
  const mainTexBase = verts.length / STRIDE_FLOATS;
  for (let i = 0; i < mainTex.verts.length; i++) verts.push(mainTex.verts[i]!);
  for (const b of mainTex.batches) selConnectorBatches.push({ tex: b.tex, start: mainTexBase + b.start, count: b.count });

  if (state.asc) {
    const ascTex = tessellateEdgesTexturedFromList(selPairs, 'asc', 'active',
                                                   (a, b) => edgeTint(a, b));
    const ascTexBase = verts.length / STRIDE_FLOATS;
    for (let i = 0; i < ascTex.verts.length; i++) verts.push(ascTex.verts[i]!);
    for (const b of ascTex.batches) selConnectorAscBatches.push({ tex: b.tex, start: ascTexBase + b.start, count: b.count });
  }

  // (2) Procedural strips (fallback path) — same layout as before.
  const procMainStart = verts.length / STRIDE_FLOATS;
  tessellateSelEdges(verts, null, 'main');
  selEdgeMainCount = verts.length / STRIDE_FLOATS - procMainStart;
  if (state.asc) {
    const procAscStart = verts.length / STRIDE_FLOATS;
    tessellateSelEdges(verts, null, 'asc');
    selEdgeAscCount = verts.length / STRIDE_FLOATS - procAscStart;
  }

  if (verts.length === 0) return;
  if (!selEdgeBuf) {
    selEdgeBuf = gl.createBuffer();
    if (!selEdgeBuf) throw new Error('gl.createBuffer (selEdgeBuf) returned null');
    selEdgeVAO = makeVAO(selEdgeBuf);
  }
  gl.bindVertexArray(selEdgeVAO);
  gl.bindBuffer(gl.ARRAY_BUFFER, selEdgeBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);

  // Cache the procedural slice offsets so the fallback draw call
  // knows where to find its verts after the textured prefix.
  selEdgeProcMainStart = procMainStart;
  selEdgeProcAscStart = procMainStart + selEdgeMainCount;
}
export let selEdgeProcMainStart = 0;
export let selEdgeProcAscStart = 0;

// Build the lit-cluster-glow VBO. The static buffer already holds
// every node's activeEffectImage at α=0.15; this overlay redraws the
// SAME texture at α=1.0 for clusters that have any allocated member,
// anchored on the OnlyImage's position. Drawn before main edges +
// nodes so the connectors and icons sit on top.
export function buildClusterGlow(): void {
  clusterGlowBatches = [];
  if (state.selected.size === 0) return;
  interface Bucket { tex: WebGLTexture; items: Array<[number, number, number, number]>; }
  const buckets = new Map<WebGLTexture, Bucket>();
  const WHITE: Tint = [1, 1, 1, 1];
  function addQuad(tex: WebGLTexture | null, x: number, y: number, w: number, h: number): void {
    if (!tex) return;
    let b = buckets.get(tex);
    if (!b) { b = { tex, items: [] }; buckets.set(tex, b); }
    b.items.push([x, y, w, h]);
  }

  // Mastery lighting — exact structural rule. Each allocated node lists
  // (in `n.lm`) the mastery node ids it lights; a mastery's radial
  // pattern glows when any node in its cluster is allocated. The cluster
  // membership is baked into `lm` at extraction time (group ∪ connection
  // neighbours — see buildwright masteries), so this is precise, not the
  // old "close enough" proximity guess. Asc nodes handled in drawAscPanel.
  const litMasteries = new Set<string>();
  for (const id of state.selected.keys()) {
    const n = TREE.nodes[id];
    if (!n || n.a || !n.lm) continue;
    for (const mid of n.lm) litMasteries.add(String(mid));
  }
  for (const mid of litMasteries) {
    const mn = TREE.nodes[mid];
    if (!mn || !mn.me) continue;
    addQuad(getTex(mn.me), mn.x, mn.y, mn.mw ?? 0, mn.mh ?? 0);
  }

  if (buckets.size === 0) return;
  const verts: number[] = [];
  for (const b of buckets.values()) {
    const start = verts.length / STRIDE_FLOATS;
    for (const it of b.items) {
      pushSprite(verts, it[0], it[1], it[2], it[3], WHITE, false);
    }
    const count = verts.length / STRIDE_FLOATS - start;
    if (count > 0) clusterGlowBatches.push({ tex: b.tex, start, count });
  }
  gl.bindVertexArray(clusterGlowVAO);
  gl.bindBuffer(gl.ARRAY_BUFFER, clusterGlowBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
}
