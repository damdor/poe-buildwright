// ---------------------------------------------------------------------
// Static geometry builder
// ---------------------------------------------------------------------
//
// We emit ALL non-asc, non-class_start nodes' unallocated state into a
// single VBO, plus all main-tree edges. Sprites are bucketed by texture
// URL so each unique texture turns into one drawArrays call.
//
// For asc nodes (per ascendancy) we build a small per-asc batch keyed
// by asc-name so the renderer can pick the active one without scanning.
//
// Returns nothing; populates module-level state:
//   staticBuf:       WebGLBuffer with vertex data
//   staticBatches:   [{ tex, count, start, clipIcon }, ...]    (main tree)
//   ascStatic:       { asc_name: { count, start, batches: [...], edgeBatch: {start, count} } }
//   mainEdgeBatch:   { start, count }                          (main tree edges)


import { texCache } from "./image_preload.ts";
import { ASC_IN_PLACE, gl, isLocked, isMcOption, state } from "./state.ts";
import { STRIDE_FLOATS, makeVAO } from "./webgl_setup.ts";
import { pushSprite } from "./vertex_helpers.ts";
import { tessellateConnectorsTextured, tessellateEdges } from "./edge_tessellate.ts";

export interface SpriteBatch { tex: WebGLTexture; start: number; count: number; clipIcon: boolean; }
export interface EdgeBatch { start: number; count: number; }
export interface ConnectorBatch { tex: WebGLTexture; start: number; count: number; }
export interface AscPanelStatic {
  portraitBatch: SpriteBatch | null;
  edgeBatch: EdgeBatch | null;
  batches: SpriteBatch[];
  connectorBatches: ConnectorBatch[];
}

export let staticBuf: WebGLBuffer | null = null;
// VAO for the static geometry buffer. Created on first geometry build
// and reused for every subsequent frame's draw. Declared next to its
// single reassignment so ES module live-bindings work — readonly
// imports from webgl_setup wouldn't let buildStaticGeometry
// assign it.
export let staticVAO: WebGLVertexArrayObject | null = null;
export let staticBatches: SpriteBatch[] = [];
export let ascStatic: Record<string, AscPanelStatic> = {};
export let mainEdgeBatch: EdgeBatch | null = null;
// GGG textured connector batches — one drawArrays per orbit sprite.
// Populated by buildStaticGeometry; consumed in render() when the
// useGGGConnectors flag is on.
export let mainConnectorBatches: ConnectorBatch[] = [];
export const mainEdgeCSSWidthMin = 0.8;
export const mainEdgeCSSWidthMax = 2.0;
// Base edge tint — kept faint so unselected connectors recede into the
// background (matches PoB / the in-game look where allocations
// visually dominate). Selected-edge gold stays at full saturation via
// a separate VBO + tint, so the pop is preserved.
export const EDGE_TINT: readonly [number, number, number, number] =
  [94/255 * 0.55, 88/255 * 0.55, 70/255 * 0.55, 0.7];

export function buildStaticGeometry(): void {
  const verts: number[] = [];

  // Bucket: texture → array of {x, y, w, h, tint, clipIcon}
  interface BucketItem { x: number; y: number; w: number; h: number; tint: readonly [number, number, number, number]; }
  interface Bucket { tex: WebGLTexture; clipIcon: boolean; items: BucketItem[]; }
  const buckets = new Map<string, Bucket>();
  function add(
    texUrl: string | null | undefined, x: number, y: number, w: number, h: number,
    tint: readonly [number, number, number, number], clipIcon: boolean,
  ): void {
    if (!texUrl || !texCache.has(texUrl)) return;
    const key = texUrl + (clipIcon ? '|c' : '|s');
    let b = buckets.get(key);
    if (!b) {
      const tex = texCache.get(texUrl)!;
      b = { tex, clipIcon, items: [] };
      buckets.set(key, b);
    }
    b.items.push({ x, y, w, h, tint });
  }
  const WHITE: readonly [number, number, number, number] = [1, 1, 1, 1];
  // PoB's PassiveTreeView.lua draws each node's activeEffectImage (the
  // cluster-glow art around notables / mastery centres) at α=0.15
  // unallocated and α=1.0 when the node is taken. We keep the dim
  // version in the static buffer; drawOverlays redraws a full-alpha
  // copy over each selected node so its cluster lights up.
  const DIM: readonly [number, number, number, number] = [0.15, 0.15, 0.15, 0.15];
  // Unselected nodes are tinted DOWN so the user's allocation pops
  // visually against the rest of the tree. Mirrors PoB's
  // LessLuminance() pass (PassiveTreeView.lua:1018-1019). Selected
  // nodes get a brightness overlay in drawOverlays that redraws each
  // allocated icon at full WHITE on top.
  const DIM_NODE: readonly [number, number, number, number] = [0.55, 0.55, 0.55, 1.0];

  // ---- Main tree nodes (unallocated state) ----
  // Three explicit passes so the bucket-flush order is mastery → icons
  // → frames. Without this, a notable whose icon sprite is encountered
  // AFTER a frame sprite was already bucketed would end up drawing its
  // icon ON TOP of the brass ring (notables clip the frame because
  // frame ⊃ icon in extent for non-keystone nodes).
  for (const id in TREE.nodes) {
    const n = TREE.nodes[id];
    if (!n || n.a || n.k === 'class_start') continue;
    // Locked nodes (Oracle's Unseen Path extras when not unlocked) are
    // completely excluded from the visual tree — they reappear
    // automatically when the user allocates the gating notable, via a
    // maybeRebuildStaticForLocks() trigger that re-bakes this VBO.
    if (isLocked(id)) continue;
    if (n.me) add(n.me, n.x, n.y, n.mw ?? 0, n.mh ?? 0, DIM, false);
  }
  for (const id in TREE.nodes) {
    const n = TREE.nodes[id];
    if (!n || n.a || n.k === 'class_start') continue;
    if (isLocked(id)) continue;
    if (n.i && (n.iw ?? 0) > 0) add(n.i, n.x, n.y, n.iw!, n.iw!, DIM_NODE, true);
  }
  for (const id in TREE.nodes) {
    const n = TREE.nodes[id];
    if (!n || n.a || n.k === 'class_start') continue;
    if (isLocked(id)) continue;
    if (n.f0 && (n.fw ?? 0) > 0) add(n.f0, n.x, n.y, n.fw!, n.fw!, DIM_NODE, false);
  }
  // Emit verts grouped by texture. Each texture becomes one batch.
  staticBatches = [];
  for (const b of buckets.values()) {
    const start = verts.length / STRIDE_FLOATS;
    for (const it of b.items) {
      pushSprite(verts, it.x, it.y, it.w, it.h, it.tint, b.clipIcon);
    }
    const count = verts.length / STRIDE_FLOATS - start;
    if (count > 0) staticBatches.push({ tex: b.tex, start, count, clipIcon: b.clipIcon });
  }
  buckets.clear();

  // ---- Main tree edges (procedural fallback) ----
  const meStart = verts.length / STRIDE_FLOATS;
  tessellateEdges(null, 0, 0, EDGE_TINT, verts);
  const meCount = verts.length / STRIDE_FLOATS - meStart;
  mainEdgeBatch = meCount > 0 ? { start: meStart, count: meCount } : null;

  // ---- Main tree edges (GGG textured connectors) ----
  // Bucketed per-orbit-sprite so each orbit issues one drawArrays.
  // Vert offsets within the static buffer are tracked per-batch so we
  // can draw them with a single VAO bind. If the textures aren't
  // loaded yet, tessellateConnectorsTextured skips the missing buckets
  // and we fall through to the procedural buffer naturally.
  mainConnectorBatches = [];
  {
    const { verts: conV, batches: conB } = tessellateConnectorsTextured(null, 0, 0);
    const base = verts.length / STRIDE_FLOATS;
    for (let i = 0; i < conV.length; i++) verts.push(conV[i]!);
    for (const b of conB) {
      // tessellateConnectorsTextured already bucketed by texUrl that
      // texCache.has() — the bucket can't exist with an undefined tex.
      if (b.tex) mainConnectorBatches.push({ tex: b.tex, start: base + b.start, count: b.count });
    }
  }

  // ---- Per-asc panels ----
  // Layer order in the asc panel: portrait (bottom) → edges → nodes
  // (top). The portrait is a big opaque sprite, so if we lump it into
  // the same batch list as the node icons the edges drawn AFTER would
  // not appear (they sit underneath the portrait). We split into
  // three explicit slots so drawAscPanel can interleave them.
  ascStatic = {};
  for (const ascName in TREE.asc_panels) {
    const p = TREE.asc_panels[ascName];
    if (!p) continue;
    // Variant ascendancy (Abyssal Lich): bake the PARENT panel's nodes
    // and edges (variants own no graph nodes) with per-node icon
    // overrides; only the portrait texture is the variant's own.
    const variant = TREE.asc_variants?.[ascName];
    const srcAsc = variant ? variant.parent : ascName;
    const geomP = (variant ? TREE.asc_panels[variant.parent] : null) ?? p;
    // In-place mode (PoE1) bakes asc content at its raw GGG
    // coordinates (Duelist's below the tree, Witch's above, etc.);
    // PoE2 translates the selected panel to the tree centre.
    const dx = ASC_IN_PLACE ? 0 : -geomP.x, dy = ASC_IN_PLACE ? 0 : -geomP.y;

    // 1. Portrait (one quad, one texture)
    const portStart = verts.length / STRIDE_FLOATS;
    if (texCache.has(p.p)) {
      // In-place mode bakes every backdrop dimmed (PoB draws
      // non-selected ascendancies at 25% alpha); the selected one is
      // redrawn at full strength by drawAscPanel.
      const tint = ASC_IN_PLACE ? ([1, 1, 1, 0.25] as const) : WHITE;
      pushSprite(verts, geomP.x + dx, geomP.y + dy, p.w, p.h, tint, false);
    }
    const portCount = verts.length / STRIDE_FLOATS - portStart;
    const portraitTex = texCache.get(p.p);
    const portraitBatch: SpriteBatch | null = (portCount > 0 && portraitTex)
      ? { tex: portraitTex, start: portStart, count: portCount, clipIcon: false }
      : null;

    // 2. Edges between asc nodes (sit between portrait and nodes).
    //    Procedural fallback first…
    const aeStart = verts.length / STRIDE_FLOATS;
    tessellateEdges(srcAsc, dx, dy, EDGE_TINT, verts);
    const aeCount = verts.length / STRIDE_FLOATS - aeStart;
    const edgeBatch: EdgeBatch | null = aeCount > 0 ? { start: aeStart, count: aeCount } : null;

    // …then GGG textured kite-quads for this asc, bucketed per sprite-
    // URL (CharacterAscendancy_orbit_normalN). drawAscPanel prefers
    // these when state.useGGGConnectors is on.
    const ascConnectorBatches: ConnectorBatch[] = [];
    {
      const { verts: conV, batches: conB } = tessellateConnectorsTextured(srcAsc, dx, dy);
      const base = verts.length / STRIDE_FLOATS;
      for (let i = 0; i < conV.length; i++) verts.push(conV[i]!);
      for (const b of conB) {
        if (b.tex) ascConnectorBatches.push({ tex: b.tex, start: base + b.start, count: b.count });
      }
    }

    // 3. Asc node sprites (mastery + icon + unalloc frame), grouped by
    //    texture so we can issue one drawArrays per texture.
    const nodeBuck = new Map<string, Bucket>();
    function addN(
      texUrl: string | null | undefined, x: number, y: number, w: number, h: number,
      tint: readonly [number, number, number, number], clipIcon: boolean,
    ): void {
      if (!texUrl || !texCache.has(texUrl)) return;
      const key = texUrl + (clipIcon ? '|c' : '|s');
      let b = nodeBuck.get(key);
      if (!b) {
        const tex = texCache.get(texUrl)!;
        b = { tex, clipIcon, items: [] };
        nodeBuck.set(key, b);
      }
      b.items.push({ x, y, w, h, tint });
    }
    // Same 3-pass layering as the main tree above — keeps frames
    // strictly on top of icons regardless of sprite-discovery order.
    // Multi-choice options are hidden — only the parent notable shows
    // on the tree; the options live inside its popout.
    for (const id in TREE.nodes) {
      const n = TREE.nodes[id];
      if (!n || n.a !== srcAsc) continue;
      if (isMcOption(id)) continue;
      if (n.me) addN(n.me, n.x + dx, n.y + dy, n.mw ?? 0, n.mh ?? 0, DIM, false);
    }
    for (const id in TREE.nodes) {
      const n = TREE.nodes[id];
      if (!n || n.a !== srcAsc) continue;
      if (isMcOption(id)) continue;
      const iconUrl = variant?.nodes[id]?.i ?? n.i;
      if (iconUrl && (n.iw ?? 0) > 0) addN(iconUrl, n.x + dx, n.y + dy, n.iw!, n.iw!, DIM_NODE, true);
    }
    for (const id in TREE.nodes) {
      const n = TREE.nodes[id];
      if (!n || n.a !== srcAsc) continue;
      if (isMcOption(id)) continue;
      if (n.f0 && (n.fw ?? 0) > 0) addN(n.f0, n.x + dx, n.y + dy, n.fw!, n.fw!, DIM_NODE, false);
    }
    const batches: SpriteBatch[] = [];
    for (const b of nodeBuck.values()) {
      const start = verts.length / STRIDE_FLOATS;
      for (const it of b.items) {
        pushSprite(verts, it.x, it.y, it.w, it.h, it.tint, b.clipIcon);
      }
      const count = verts.length / STRIDE_FLOATS - start;
      if (count > 0) batches.push({ tex: b.tex, start, count, clipIcon: b.clipIcon });
    }

    ascStatic[ascName] = { portraitBatch, edgeBatch, batches, connectorBatches: ascConnectorBatches };
  }

  // Upload to GPU. Use STATIC_DRAW since this buffer never changes
  // after this point. Pair it with a VAO so per-frame draws don't re-
  // issue the 5 vertexAttribPointer calls.
  staticBuf = gl.createBuffer();
  if (!staticBuf) throw new Error('gl.createBuffer returned null');
  gl.bindBuffer(gl.ARRAY_BUFFER, staticBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
  staticVAO = makeVAO(staticBuf);
  state.geomReady = true;
}
