// ---------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------

import { texCache } from "./image_preload.ts";
import { ASC_EFFECTS, ASC_IN_PLACE, MULTI_CHOICE, canvas, gl, isMcOption, pickedMcOption, state , ascNodeOverride} from "./state.ts";
import { STRIDE_FLOATS, getTex, uClip, uDashMode, uDashPeriod, uDashSolid, uOffsetScale, uPulse, uTranslate, uView, whiteTex } from "./webgl_setup.ts";
import { Tint, pushSprite, pushSpriteRot, pushSpriteUV } from "./vertex_helpers.ts";
import { type AscPanelStatic, ascStatic, mainConnectorBatches, mainEdgeBatch, staticBatches, staticVAO } from "./static_geom.ts";
import { buildClusterGlow, clusterGlowBatches, clusterGlowVAO, rebuildSearchGlow, rebuildSelEdges, searchGlowCount, searchGlowTex, searchGlowVAO, selConnectorAscBatches, selConnectorBatches, selEdgeAscCount, selEdgeMainCount, selEdgeProcAscStart, selEdgeProcMainStart, selEdgeVAO, uploadDyn } from "./overlay.ts";
import { findClassStartHub, previewAscCount, previewConnectorAscBatches, previewConnectorBatches, previewMainCount, previewProcAscStart, previewProcMainStart, previewVAO } from "./pathfind.ts";
import type { TreeNode } from "../../../../types/poe2.d.ts";

export function requestRender(): void {
  if (state.needsRender) return;
  state.needsRender = true;
  requestAnimationFrame(() => { state.needsRender = false; render(); });
}

// Per-frame view matrix (column-major mat3): tree-coord → clip space.
export const viewMat = new Float32Array(9);
export function updateViewMat(): void {
  const w = canvas.width, h = canvas.height;
  const dpr = window.devicePixelRatio || 1;
  const sx =  2 * state.scale * dpr / w;
  const sy = -2 * state.scale * dpr / h;
  const tx =  2 * state.tx * dpr / w - 1;
  const ty = -(2 * state.ty * dpr / h - 1);
  viewMat[0] = sx; viewMat[1] = 0;  viewMat[2] = 0;
  viewMat[3] = 0;  viewMat[4] = sy; viewMat[5] = 0;
  viewMat[6] = tx; viewMat[7] = ty; viewMat[8] = 1;
}

// Width-scale: passed to u_offset_scale to keep line widths constant
// in screen pixels regardless of zoom. Matches the old Canvas2D
// dynamicCssWidth tapering (0.8..2 CSS px for base, 2..4.5 for sel).
export function offsetScale(cssMin: number, cssMax: number, scaleRamp: number): number {
  const t = Math.max(0, Math.min(1, state.scale / scaleRamp));
  const cssHalf = (cssMin + (cssMax - cssMin) * t) * 0.5;
  return cssHalf / state.scale;
}

// Dyn-batch entry — written into a flat array of vertices then flushed
// per (texture, clipIcon) bucket so each batch is one drawArrays call.
export interface DynBatch { tex: WebGLTexture; clipIcon: boolean; start: number; count: number; }
// The texture-id memo we attach to WebGLTexture for cheap Map keys.
// (Set-once side-band: PoB-era code stamped `__id` on the texture
// object itself; we keep it as it's the simplest "is this the same
// texture?" check that survives across renders.)
export type TaggedTex = WebGLTexture & { __id?: number };

export function render(): void {
  const dpr = window.devicePixelRatio || 1;
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (!state.geomReady) return;

  updateViewMat();
  gl.uniformMatrix3fv(uView, false, viewMat);
  gl.uniform2f(uTranslate, 0, 0);
  gl.uniform2f(uOffsetScale, 0, 0);
  gl.uniform1f(uClip, 0);
  gl.activeTexture(gl.TEXTURE0);

  // ============== Dynamic per-frame quads (backgrounds, etc.) ==============
  // We emit them ONCE then issue per-batch draw calls referencing
  // ranges. This keeps draw-call count low while still being dynamic.
  const dyn: number[] = [];
  const dynBatches: DynBatch[] = [];
  function dynBatch(tex: WebGLTexture | null | undefined, clipIcon: boolean, fn: (arr: number[]) => void): void {
    if (!tex) return;
    const s = dyn.length / STRIDE_FLOATS;
    fn(dyn);
    const c = dyn.length / STRIDE_FLOATS - s;
    if (c > 0) dynBatches.push({ tex, clipIcon, start: s, count: c });
  }

  // -------- Background tile --------
  if (TREE.bg_tile && texCache.has(TREE.bg_tile)) {
    // Cover the visible viewport (tree-coord) with a single repeating
    // quad. UVs go world / tileSize; REPEAT wrap on the texture
    // produces the dim stone pattern. Tile size matches Background2's
    // native dimensions (1024×1024 per sprites.tsv).
    const vbX = -state.tx / state.scale;
    const vbY = -state.ty / state.scale;
    const vbW = canvas.clientWidth  / state.scale;
    const vbH = canvas.clientHeight / state.scale;
    const TILE = 1024;
    const x0 = vbX - 800, y0 = vbY - 800;
    const x1 = vbX + vbW + 800, y1 = vbY + vbH + 800;
    const cx = (x0 + x1) * 0.5, cy = (y0 + y1) * 0.5;
    const w = x1 - x0, h = y1 - y0;
    const u0 = x0 / TILE, u1 = x1 / TILE;
    const v0 = y0 / TILE, v1 = y1 / TILE;
    dynBatch(texCache.get(TREE.bg_tile) ?? null, false, (arr) => {
      pushSpriteUV(arr, cx, cy, w, h, u0, v0, u1, v1, [1, 1, 1, 0.45]);
    });
  }

  // -------- Center stack: portrait + BGTreeActive + BGTree --------
  // PoB's PassiveTreeView.lua draws the centre stack in this order:
  // portrait first (deepest), then the rotated active-wedge, then
  // BGTree on top — so the ornate metal frame OVERLAYS the portrait
  // and the user sees the portrait through the quatrefoil opening.
  // When an ascendancy is active we put the asc panel's portrait at
  // the same deepest layer so BGTree frames it the same way. The
  // asc's edges + nodes are drawn later (above BGTree) by
  // drawAscPanel — they're interactive content that belongs on top.
  if (state.klass && !state.asc) {
    const url = TREE.class_portraits[state.klass];
    const tex = getTex(url);
    if (tex) dynBatch(tex, false, (arr) => {
      pushSprite(arr, 0, 0, 3000, 3000, [1, 1, 1, 1], false);
    });
  } else if (state.asc && !ASC_IN_PLACE) {
    // Variant ascendancy shows its OWN portrait over the parent panel.
    const panel = TREE.asc_panels[state.ascVariant ?? state.asc];
    const tex = panel ? getTex(panel.p) : null;
    if (tex && panel) dynBatch(tex, false, (arr) => {
      pushSprite(arr, 0, 0, panel.w, panel.h, [1, 1, 1, 1], false);
    });
  }
  // BGTreeActive: rotated wedge that lights up the sector containing
  // the chosen class's start hub. The sprite has 6 wedge slots baked
  // in — ONE is gold (the active one), the other 5 are near-black
  // (RGB ~11) but fully opaque. Rotating aligns the gold wedge to a
  // specific class's hub.
  //
  // Multi-class lit (Pathfinder alt-start picks) needs additive
  // blending: first wedge draws normally (replaces background with
  // texture), each extra wedge adds its gold on top WITHOUT its dark
  // sectors darkening the previously-lit gold. We stash a list of
  // (texture, rotation) pairs and process them after the primary
  // dynBatches loop, switching blend mode mid-frame.
  interface BgtreeExtra { tex: WebGLTexture; c: number; s: number; }
  const bgtreeActiveExtras: BgtreeExtra[] = [];
  if (TREE.bgtree_active) {
    const tex = getTex(TREE.bgtree_active);
    if (tex) {
      const litClasses: string[] = [];
      if (state.klass) litClasses.push(state.klass);
      for (const [sid] of state.selected) {
        const eff = ASC_EFFECTS[sid];
        if (eff && eff.altStartClass && !litClasses.includes(eff.altStartClass)) {
          litClasses.push(eff.altStartClass);
        }
      }
      litClasses.forEach((klass, idx) => {
        const hub = findClassStartHub(klass);
        if (!hub) return;
        const angle = Math.PI / 2 + Math.atan2(hub.y, hub.x);
        const c = Math.cos(angle), s = Math.sin(angle);
        if (idx === 0) {
          // Primary wedge — normal-blend with the rest of the dyn batch.
          dynBatch(tex, false, (arr) => {
            pushSpriteRot(arr, 0, 0, 4000, 4000, c, s, [1, 1, 1, 1]);
          });
        } else {
          // Alt-start wedges — drawn ADDITIVELY in a post-pass so the
          // sprite's dark non-gold sectors don't overwrite the
          // previously-lit gold from earlier rotations.
          bgtreeActiveExtras.push({ tex, c, s });
        }
      });
    }
  }
  if (TREE.bgtree) {
    const tex = getTex(TREE.bgtree);
    if (tex) dynBatch(tex, false, (arr) => {
      pushSprite(arr, 0, 0, 4000, 4000, [1, 1, 1, 1], false);
    });
  }
  uploadDyn(dyn);
  // uploadDyn binds dynVAO already.
  for (const b of dynBatches) {
    gl.bindTexture(gl.TEXTURE_2D, b.tex);
    gl.uniform1f(uClip, b.clipIcon ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, b.start, b.count);
  }
  // Additional BGTreeActive wedges (alt-start unlocks) drawn with
  // additive blend so each one only contributes its gold-lit pixels,
  // leaving the wedges from earlier draws intact. Streams its own
  // tiny VBO so the dyn buffer doesn't have to round-trip the blend
  // switch around its normal contents.
  if (bgtreeActiveExtras.length > 0) {
    const extraVerts: number[] = [];
    for (const e of bgtreeActiveExtras) {
      pushSpriteRot(extraVerts, 0, 0, 4000, 4000, e.c, e.s, [1, 1, 1, 1]);
    }
    uploadDyn(extraVerts);
    gl.blendFunc(gl.ONE, gl.ONE);                   // additive
    gl.uniform1f(uClip, 0);
    bgtreeActiveExtras.forEach((e, i) => {
      gl.bindTexture(gl.TEXTURE_2D, e.tex);
      gl.drawArrays(gl.TRIANGLES, i * 6, 6);
    });
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // restore default
  }

  // ============== Main edges (static) — UNDER all nodes ==============
  // GGG textured kite-quads when enabled — one drawArrays per orbit
  // sprite. Fall through to the procedural strip tessellation when
  // disabled (state.useGGGConnectors=false) or if no connector
  // batches got built (e.g. textures still loading on first frame).
  if (state.useGGGConnectors && mainConnectorBatches.length > 0) {
    gl.bindVertexArray(staticVAO);
    gl.uniform2f(uOffsetScale, 0, 0);
    gl.uniform1f(uClip, 0);
    for (const b of mainConnectorBatches) {
      gl.bindTexture(gl.TEXTURE_2D, b.tex);
      gl.drawArrays(gl.TRIANGLES, b.start, b.count);
    }
  } else if (mainEdgeBatch) {
    gl.bindVertexArray(staticVAO);
    gl.bindTexture(gl.TEXTURE_2D, whiteTex);
    const oh = offsetScale(0.8, 2.0, 0.5);
    gl.uniform2f(uOffsetScale, oh, oh);
    gl.uniform1f(uClip, 0);
    gl.drawArrays(gl.TRIANGLES, mainEdgeBatch.start, mainEdgeBatch.count);
  }

  // ============== Cluster glow (lit OnlyImage centres) ==============
  // Built each frame from state.selected. Drawn BEFORE main edges so
  // the bright cluster art sits UNDER the connector lines and node
  // sprites — otherwise the glow obscures the nodes it's lighting up.
  buildClusterGlow();
  if (clusterGlowBatches.length > 0) {
    gl.bindVertexArray(clusterGlowVAO);
    gl.uniform2f(uOffsetScale, 0, 0);
    gl.uniform1f(uClip, 0);
    for (const b of clusterGlowBatches) {
      gl.bindTexture(gl.TEXTURE_2D, b.tex);
      gl.drawArrays(gl.TRIANGLES, b.start, b.count);
    }
  }

  // ============== Search-result pulsing glow ==============
  // Cyan halo under each node matching the current Cmd+K search.
  // Pulse via u_pulse uniform driven by time so the matches breathe
  // visibly — easier to scan a 4700-node tree for "minion" clusters.
  if (state.searchHighlight.size > 0 && searchGlowTex) {
    rebuildSearchGlow();
    if (searchGlowCount > 0) {
      const t = performance.now() / 1000;
      // 0.55 .. 1.0 alpha modulation @ ~1.4 Hz
      const pulse = 0.55 + 0.45 * Math.abs(Math.sin(t * 2.2));
      gl.bindVertexArray(searchGlowVAO);
      gl.bindTexture(gl.TEXTURE_2D, searchGlowTex);
      gl.uniform2f(uOffsetScale, 0, 0);
      gl.uniform1f(uClip, 0);
      gl.uniform1f(uPulse, pulse);
      gl.drawArrays(gl.TRIANGLES, 0, searchGlowCount);
      gl.uniform1f(uPulse, 1.0);
    }
  }

  // ============== Selected (allocated) edges (main-tree portion) ==============
  if (state.selDirty) rebuildSelEdges();
  if (state.useGGGConnectors && selConnectorBatches.length > 0) {
    gl.bindVertexArray(selEdgeVAO);
    gl.uniform2f(uOffsetScale, 0, 0);
    gl.uniform1f(uClip, 0);
    for (const b of selConnectorBatches) {
      if (!b.tex) continue;
      gl.bindTexture(gl.TEXTURE_2D, b.tex);
      gl.drawArrays(gl.TRIANGLES, b.start, b.count);
    }
  } else if (selEdgeMainCount > 0) {
    gl.bindVertexArray(selEdgeVAO);
    gl.bindTexture(gl.TEXTURE_2D, whiteTex);
    const oh = offsetScale(2.0, 4.5, 0.5);
    gl.uniform2f(uOffsetScale, oh, oh);
    gl.uniform1f(uClip, 0);
    gl.drawArrays(gl.TRIANGLES, selEdgeProcMainStart, selEdgeMainCount);
  }

  // ============== Preview (hover path) ==============
  if (state.useGGGConnectors && previewConnectorBatches.length > 0) {
    gl.bindVertexArray(previewVAO);
    gl.uniform2f(uOffsetScale, 0, 0);
    gl.uniform1f(uClip, 0);
    for (const b of previewConnectorBatches) {
      gl.bindTexture(gl.TEXTURE_2D, b.tex);
      gl.drawArrays(gl.TRIANGLES, b.start, b.count);
    }
  } else if (previewMainCount > 0) {
    gl.bindVertexArray(previewVAO);
    gl.bindTexture(gl.TEXTURE_2D, whiteTex);
    const oh = offsetScale(2.5, 4.5, 0.5);
    gl.uniform2f(uOffsetScale, oh, oh);
    gl.uniform1f(uClip, 0);
    gl.uniform1f(uDashMode, 1);
    gl.uniform1f(uDashPeriod, 16.0 / state.scale);
    gl.uniform1f(uDashSolid,  9.0 / state.scale);
    gl.drawArrays(gl.TRIANGLES, previewProcMainStart, previewMainCount);
    gl.uniform1f(uDashMode, 0);
  }

  // ============== Main tree nodes (static, sorted by texture) ==============
  gl.bindVertexArray(staticVAO);
  gl.uniform2f(uOffsetScale, 0, 0);
  for (const b of staticBatches) {
    gl.bindTexture(gl.TEXTURE_2D, b.tex);
    gl.uniform1f(uClip, b.clipIcon ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, b.start, b.count);
  }

  // ============== Class start markers (PoE1) ==============
  // ON TOP of edges and nodes so the start-passive spokes terminate
  // at the marker's rim. PoB rule (PassiveTreeView.lua:775): the
  // selected class draws its own center<class> art; every other
  // start shows the generic inactive medallion.
  if (ASC_IN_PLACE && TREE.class_markers) {
    const markers: number[] = [];
    const markerBatches: DynBatch[] = [];
    for (const cn in TREE.class_markers) {
      const m = TREE.class_markers[cn]!;
      const active = cn === state.klass;
      const art = active ? m : TREE.start_inactive;
      if (!art) continue;
      const tex = getTex(art.p);
      if (!tex) continue;
      const s0 = markers.length / STRIDE_FLOATS;
      pushSprite(markers, m.x, m.y, art.w, art.h, [1, 1, 1, 1], false);
      markerBatches.push({ tex, clipIcon: false, start: s0, count: 6 });
    }
    if (markerBatches.length > 0) {
      uploadDyn(markers);
      gl.uniform1f(uClip, 0);
      for (const b of markerBatches) {
        gl.bindTexture(gl.TEXTURE_2D, b.tex);
        gl.drawArrays(gl.TRIANGLES, b.start, b.count);
      }
    }
  }

  // ============== Per-frame overlays (selected frames, popout, etc.) ==============
  drawOverlays();

  // ============== Ascendancy panel (if active) ==============
  if (state.asc || ASC_IN_PLACE) drawAscPanel();
}

// Draw all dynamic overlays in one upload: selected allocated frames
// (with cheap gold halo via double-draw at 1.1× scale), picked-attribute
// icon overrides, hover popout. These rebuild every frame because they
// depend on small state we can re-emit cheaply.
interface OverlayBucket {
  tex: WebGLTexture;
  clipIcon: boolean;
  items: Array<[number, number, number, number, Tint]>;
}
export function drawOverlays(): void {
  const verts: number[] = [];
  const buckets = new Map<string, OverlayBucket>();
  function addBucket(
    tex: WebGLTexture | null | undefined, clipIcon: boolean,
    x: number, y: number, w: number, h: number, tint: Tint,
  ): void {
    if (!tex) return;
    const tagged = tex as TaggedTex;
    const id = tagged.__id ?? (tagged.__id = Math.random());
    const key = id + (clipIcon ? '|c' : '|s');
    let b = buckets.get(key);
    if (!b) { b = { tex, clipIcon, items: [] }; buckets.set(key, b); }
    b.items.push([x, y, w, h, tint]);
  }
  const WHITE: Tint = [1, 1, 1, 1];
  const GOLD_HALO: Tint = [240/255, 199/255, 92/255, 0.45];

  // -------- Selected node icons at FULL brightness --------
  // The static buffer paints every icon with DIM_NODE tint (0.55 RGB)
  // so the unselected tree recedes into the background — matches
  // PoB's LessLuminance() pass for unallocated nodes. We overdraw
  // each selected node's icon at WHITE here to restore full
  // saturation just for the allocations.
  for (const [id] of state.selected) {
    const n = TREE.nodes[id];
    if (!n || n.a) continue;        // asc nodes handled in drawAscPanel
    if (n.k === 'class_start') continue;
    if (n.i && (n.iw ?? 0) > 0) {
      const t = getTex(n.i);
      if (t) addBucket(t, true, n.x, n.y, n.iw!, n.iw!, WHITE);
    }
  }

  // -------- Picked-attribute icon override (main tree only) --------
  // Drawn AFTER the bright-icon overlay so an attribute pick takes
  // precedence (Str/Dex/Int variant overrides the default icon).
  for (const [id, pick] of state.pickedAttrs) {
    const n = TREE.nodes[id];
    if (!n || n.a) continue;
    if (!n.o || (n.iw ?? 0) <= 0) continue;
    const opt = n.o.find(o => o.n === pick);
    if (!opt) continue;
    addBucket(getTex(opt.i), true, n.x, n.y, n.iw!, n.iw!, WHITE);
  }

  // (Cluster glow used to be here, but it needs to render UNDER node
  // sprites — so it now lives in drawClusterGlow(), called from
  // render() before the main-node pass.)

  // -------- Selected allocated frames + halo --------
  // Halo color signals which set the node belongs to:
  //   main → gold, set1 → pink, set2 → green.
  // The frame itself uses WHITE so the textured PNG passes through;
  // the halo underneath provides the colored glow.
  //
  // Layering note: the activation ring is drawn at fw*1.15 — bigger
  // than the dim frame (fw). In the outer band (fw/2 .. fw*1.15/2)
  // the dim frame's texture is already fading toward transparent,
  // so without an opaque underlay the halo's 0.45-0.55 tint alpha
  // lets the edge line behind bleed through that band. Fix: draw
  // the active-frame texture at fw*1.15 with full WHITE FIRST as an
  // opaque occluder, then layer the colored halo on top of it so the
  // colored glow still reads while the line is fully hidden.
  const HALO_SET1: Tint = [255/255,  70/255, 196/255, 0.55];
  const HALO_SET2: Tint = [ 92/255, 240/255, 110/255, 0.55];
  for (const [id, setKind] of state.selected) {
    const n = TREE.nodes[id];
    if (!n || n.a) continue;
    if (n.k === 'class_start') continue;
    if ((n.fw ?? 0) <= 0 || !n.f1) continue;
    // Level-filter: when the slider is below 100, only render the
    // bright-frame overlay for allocations whose level_interval
    // includes that level. Out-of-range allocations stay dim.
    const t = getTex(n.f1);
    if (!t) continue;
    const halo: Tint = setKind === 'set1' ? HALO_SET1
                     : setKind === 'set2' ? HALO_SET2
                     : GOLD_HALO;
    addBucket(t, false, n.x, n.y, n.fw! * 1.15, n.fw! * 1.15, WHITE);
    addBucket(t, false, n.x, n.y, n.fw! * 1.15, n.fw! * 1.15, halo);
    addBucket(t, false, n.x, n.y, n.fw!, n.fw!, WHITE);
  }

  // -------- Click-driven popout (attribute Str/Dex/Int OR multi-choice option) --------
  if (state.popoutId) {
    const n = TREE.nodes[state.popoutId];
    // Asc-panel popouts are rendered by drawAscPanel; here we only
    // handle main-tree popouts (n.a falsy).
    const opts = (n && !n.a) ? popoutOptionsFor(state.popoutId) : null;
    if (opts && n) {
      const frameTex = getTex(n.f0);
      const HALO_BIG: Tint = [240/255, 199/255, 92/255, 0.65];
      const HALO_PICKED: Tint = [255/255, 230/255, 130/255, 0.85];
      const currentPickName = state.pickedAttrs.get(state.popoutId);
      const currentPickedMc = pickedMcOption(state.popoutId);
      opts.forEach((opt, i) => {
        const c = popoutOptionCenter(n, i, opts.length);
        const iconTex = opt.iconUrl ? getTex(opt.iconUrl) : null;
        const isPicked = opt.id != null ? opt.id === currentPickedMc
                                        : opt.name === currentPickName;
        const halo: Tint = isPicked ? HALO_PICKED : HALO_BIG;
        addBucket(iconTex, true, c.x, c.y, POPOUT_ICON_SIZE, POPOUT_ICON_SIZE, WHITE);
        if (frameTex) {
          addBucket(frameTex, false, c.x, c.y, POPOUT_FRAME_SIZE * 1.18, POPOUT_FRAME_SIZE * 1.18, halo);
          addBucket(frameTex, false, c.x, c.y, POPOUT_FRAME_SIZE, POPOUT_FRAME_SIZE, WHITE);
        }
      });
    }
  }

  // -------- Multi-choice picked-option icon overlay on the parent --------
  // When the user has picked (e.g.) Path of the Sorceress, the Path
  // Seeker notable's generic icon is replaced by the picked option's
  // specific icon at the same position. Matches the in-game UX.
  for (const parentId in MULTI_CHOICE) {
    if (!state.selected.has(parentId)) continue;
    const n = TREE.nodes[parentId];
    if (!n || n.a) continue;   // asc parents handled in drawAscPanel
    const picked = pickedMcOption(parentId);
    if (!picked) continue;
    const opt = TREE.nodes[picked];
    if (!opt || !opt.i || (n.iw ?? 0) <= 0) continue;
    addBucket(getTex(opt.i), true, n.x, n.y, n.iw!, n.iw!, WHITE);
  }

  // Bake to verts.
  const batches: DynBatch[] = [];
  for (const b of buckets.values()) {
    const start = verts.length / STRIDE_FLOATS;
    for (const it of b.items) {
      pushSprite(verts, it[0], it[1], it[2], it[3], it[4], b.clipIcon);
    }
    const count = verts.length / STRIDE_FLOATS - start;
    if (count > 0) batches.push({ tex: b.tex, clipIcon: b.clipIcon, start, count });
  }
  if (batches.length === 0) return;
  uploadDyn(verts);
  gl.uniform2f(uOffsetScale, 0, 0);
  for (const b of batches) {
    gl.bindTexture(gl.TEXTURE_2D, b.tex);
    gl.uniform1f(uClip, b.clipIcon ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, b.start, b.count);
  }
}

// One asc's baked static content (backdrop + edges + nodes), no
// selection overlays — the non-selected subtrees in in-place mode.
function drawAscStaticSimple(a: AscPanelStatic): void {
  if (a.portraitBatch) {
    gl.bindTexture(gl.TEXTURE_2D, a.portraitBatch.tex);
    gl.uniform1f(uClip, 0);
    gl.drawArrays(gl.TRIANGLES, a.portraitBatch.start, a.portraitBatch.count);
  }
  if (state.useGGGConnectors && a.connectorBatches.length > 0) {
    gl.uniform1f(uClip, 0);
    for (const b of a.connectorBatches) {
      gl.bindTexture(gl.TEXTURE_2D, b.tex);
      gl.drawArrays(gl.TRIANGLES, b.start, b.count);
    }
  } else if (a.edgeBatch) {
    gl.bindTexture(gl.TEXTURE_2D, whiteTex);
    const oh = offsetScale(0.8, 2.0, 0.5);
    gl.uniform2f(uOffsetScale, oh, oh);
    gl.uniform1f(uClip, 0);
    gl.drawArrays(gl.TRIANGLES, a.edgeBatch.start, a.edgeBatch.count);
    gl.uniform2f(uOffsetScale, 0, 0);
  }
  for (const b of a.batches) {
    gl.bindTexture(gl.TEXTURE_2D, b.tex);
    gl.uniform1f(uClip, b.clipIcon ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, b.start, b.count);
  }
}

export function drawAscPanel(): void {
  if (!state.asc && !ASC_IN_PLACE) return;
  gl.bindVertexArray(staticVAO);
  gl.uniform2f(uOffsetScale, 0, 0);
  gl.uniform2f(uTranslate, 0, 0);
  // In-place mode: EVERY ascendancy subtree is visible at its raw
  // coordinates, backdrops baked at 25% alpha (PoB's non-selected
  // dim). The selected ascendancy is drawn last: full-strength
  // backdrop quad, then its statics + selection overlays on top.
  if (ASC_IN_PLACE) {
    const sel = state.ascVariant ?? state.asc;
    for (const name in ascStatic) {
      if (name === sel) continue;
      const a = ascStatic[name];
      if (a) drawAscStaticSimple(a);
    }
  }
  if (!state.asc) return;
  const selectedKey = state.ascVariant ?? state.asc;
  // Variants have their own baked panel (parent content + overridden
  // node icons + variant portrait).
  const asc = ascStatic[selectedKey];
  if (!asc) return;
  // In-place mode: redraw the selected backdrop at full strength (the
  // baked copy is the dimmed one) before its edges and nodes.
  if (ASC_IN_PLACE) {
    const panelSel = TREE.asc_panels[selectedKey];
    const tex = panelSel ? getTex(panelSel.p) : null;
    if (tex && panelSel) {
      const q: number[] = [];
      pushSprite(q, panelSel.x, panelSel.y, panelSel.w, panelSel.h, [1, 1, 1, 1], false);
      uploadDyn(q);
      gl.uniform1f(uClip, 0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindVertexArray(staticVAO);
    }
  }
  // (Asc portrait was drawn earlier, in the centre-stack dyn pass,
  // so BGTree's frame can overlay it via the quatrefoil opening.
  // Here we only draw the interactive content: edges + nodes.)
  // 1. Edges between asc nodes — drawn ON TOP of the portrait/BGTree
  //    so they're visible, but UNDER the node icons. Prefer GGG's
  //    textured kite-quads when enabled; fall back to the procedural
  //    edge-strip tessellation when the flag is off or the textures
  //    aren't loaded yet.
  if (state.useGGGConnectors && asc.connectorBatches && asc.connectorBatches.length > 0) {
    gl.uniform2f(uOffsetScale, 0, 0);
    gl.uniform1f(uClip, 0);
    for (const b of asc.connectorBatches) {
      gl.bindTexture(gl.TEXTURE_2D, b.tex);
      gl.drawArrays(gl.TRIANGLES, b.start, b.count);
    }
  } else if (asc.edgeBatch) {
    gl.bindTexture(gl.TEXTURE_2D, whiteTex);
    const oh = offsetScale(0.8, 2.0, 0.5);
    gl.uniform2f(uOffsetScale, oh, oh);
    gl.uniform1f(uClip, 0);
    gl.drawArrays(gl.TRIANGLES, asc.edgeBatch.start, asc.edgeBatch.count);
    gl.uniform2f(uOffsetScale, 0, 0);
  }
  // 2b. Selected edges for THIS asc — textured _active sprites when
  //     enabled, procedural strip fallback otherwise.
  if (state.useGGGConnectors && selConnectorAscBatches.length > 0) {
    gl.bindVertexArray(selEdgeVAO);
    gl.uniform2f(uOffsetScale, 0, 0);
    gl.uniform1f(uClip, 0);
    for (const b of selConnectorAscBatches) {
      if (!b.tex) continue;
      gl.bindTexture(gl.TEXTURE_2D, b.tex);
      gl.drawArrays(gl.TRIANGLES, b.start, b.count);
    }
    gl.bindVertexArray(staticVAO);
  } else if (selEdgeAscCount > 0) {
    gl.bindVertexArray(selEdgeVAO);
    gl.bindTexture(gl.TEXTURE_2D, whiteTex);
    const oh = offsetScale(2.0, 4.5, 0.5);
    gl.uniform2f(uOffsetScale, oh, oh);
    gl.uniform1f(uClip, 0);
    gl.drawArrays(gl.TRIANGLES, selEdgeProcAscStart, selEdgeAscCount);
    gl.bindVertexArray(staticVAO);
  }
  // 2c. Hover-preview for the asc portion — textured _intermediate
  //     sprites when enabled, procedural dashes otherwise.
  if (state.useGGGConnectors && previewConnectorAscBatches.length > 0) {
    gl.bindVertexArray(previewVAO);
    gl.uniform2f(uOffsetScale, 0, 0);
    gl.uniform1f(uClip, 0);
    for (const b of previewConnectorAscBatches) {
      gl.bindTexture(gl.TEXTURE_2D, b.tex);
      gl.drawArrays(gl.TRIANGLES, b.start, b.count);
    }
    gl.bindVertexArray(staticVAO);
  } else if (previewAscCount > 0) {
    gl.bindVertexArray(previewVAO);
    gl.bindTexture(gl.TEXTURE_2D, whiteTex);
    const oh = offsetScale(2.5, 4.5, 0.5);
    gl.uniform2f(uOffsetScale, oh, oh);
    gl.uniform1f(uClip, 0);
    gl.uniform1f(uDashMode, 1);
    gl.uniform1f(uDashPeriod, 16.0 / state.scale);
    gl.uniform1f(uDashSolid,  9.0 / state.scale);
    gl.drawArrays(gl.TRIANGLES, previewProcAscStart, previewAscCount);
    gl.uniform1f(uDashMode, 0);
    gl.bindVertexArray(staticVAO);
  }
  // Reset offset scale back to 0 for the sprite passes below.
  gl.uniform2f(uOffsetScale, 0, 0);
  // 3. Asc node sprites (mastery + icon + frame)
  for (const b of asc.batches) {
    gl.bindTexture(gl.TEXTURE_2D, b.tex);
    gl.uniform1f(uClip, b.clipIcon ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, b.start, b.count);
  }
  // 2. Dynamic asc overlays (selected frames, picked icons, popout)
  const panel = TREE.asc_panels[state.asc];
  if (!panel) return;
  const dx = ASC_IN_PLACE ? 0 : -panel.x;
  const dy = ASC_IN_PLACE ? 0 : -panel.y;
  const verts: number[] = [];
  const buckets = new Map<string, OverlayBucket>();
  function addBucket(
    tex: WebGLTexture | null | undefined, clipIcon: boolean,
    x: number, y: number, w: number, h: number, tint: Tint,
  ): void {
    if (!tex) return;
    const tagged = tex as TaggedTex;
    const id = tagged.__id ?? (tagged.__id = Math.random());
    const key = id + (clipIcon ? '|c' : '|s');
    let b = buckets.get(key);
    if (!b) { b = { tex, clipIcon, items: [] }; buckets.set(key, b); }
    b.items.push([x, y, w, h, tint]);
  }
  const WHITE: Tint = [1, 1, 1, 1];
  const GOLD_HALO: Tint = [240/255, 199/255, 92/255, 0.45];
  // Selected asc node icons at full brightness — same dim-then-
  // override pattern as the main tree (drawOverlays). The static
  // asc-batch tints icons at DIM_NODE; this restores WHITE for
  // allocations.
  //
  // Multi-choice OPTIONS (Path of the Sorceress / Warrior, Lucid
  // Dreaming variants, …) live in state.selected too but are NOT
  // shown on the asc panel directly — only via the picked-option
  // overlay drawn on their parent's slot, below. Skipping them
  // here prevents a duplicate "ghost" icon at the option's own
  // hidden coordinates.
  for (const id of state.selected.keys()) {
    const n = TREE.nodes[id];
    if (!n || n.a !== state.asc) continue;
    if (isMcOption(id)) continue;
    // Variant ascendancy: allocated nodes keep their override art.
    const iconUrl = ascNodeOverride(id)?.i ?? n.i;
    if (iconUrl && (n.iw ?? 0) > 0) {
      const t = getTex(iconUrl);
      if (t) addBucket(t, true, n.x + dx, n.y + dy, n.iw!, n.iw!, WHITE);
    }
  }
  // Cluster glow for selected asc nodes (same trick as main tree).
  for (const id of state.selected.keys()) {
    const n = TREE.nodes[id];
    if (!n || n.a !== state.asc) continue;
    if (isMcOption(id)) continue;
    if (!n.me) continue;
    const tex = getTex(n.me);
    if (!tex) continue;
    addBucket(tex, false, n.x + dx, n.y + dy, n.mw ?? 0, n.mh ?? 0, WHITE);
  }
  for (const id of state.selected.keys()) {
    const n = TREE.nodes[id];
    if (!n || n.a !== state.asc) continue;
    if (isMcOption(id)) continue;
    if ((n.fw ?? 0) <= 0 || !n.f1) continue;
    const t = getTex(n.f1);
    if (!t) continue;
    // Opaque WHITE underlay at fw*1.15 occludes the edge line in the
    // halo's outer band — see the matching note in drawOverlays().
    addBucket(t, false, n.x + dx, n.y + dy, n.fw! * 1.15, n.fw! * 1.15, WHITE);
    addBucket(t, false, n.x + dx, n.y + dy, n.fw! * 1.15, n.fw! * 1.15, GOLD_HALO);
    addBucket(t, false, n.x + dx, n.y + dy, n.fw!, n.fw!, WHITE);
  }
  for (const [id, pick] of state.pickedAttrs) {
    const n = TREE.nodes[id];
    if (!n || n.a !== state.asc) continue;
    if (!n.o || (n.iw ?? 0) <= 0) continue;
    const opt = n.o.find(o => o.n === pick);
    if (!opt) continue;
    addBucket(getTex(opt.i), true, n.x + dx, n.y + dy, n.iw!, n.iw!, WHITE);
  }
  // Multi-choice picked-option icon overlay on asc parents.
  for (const parentId in MULTI_CHOICE) {
    if (!state.selected.has(parentId)) continue;
    const n = TREE.nodes[parentId];
    if (!n || n.a !== state.asc) continue;
    const picked = pickedMcOption(parentId);
    if (!picked) continue;
    const opt = TREE.nodes[picked];
    if (!opt || !opt.i || (n.iw ?? 0) <= 0) continue;
    addBucket(getTex(opt.i), true, n.x + dx, n.y + dy, n.iw!, n.iw!, WHITE);
  }
  // Click-driven popout (attribute or multi-choice). Drawn here so it
  // sits ON TOP of the asc panel, not under it.
  if (state.popoutId) {
    const n = TREE.nodes[state.popoutId];
    const opts = (n && n.a === state.asc) ? popoutOptionsFor(state.popoutId) : null;
    if (opts && n) {
      const frameTex = getTex(n.f0);
      const HALO_BIG: Tint = [240/255, 199/255, 92/255, 0.65];
      const HALO_PICKED: Tint = [255/255, 230/255, 130/255, 0.85];
      const currentPickName = state.pickedAttrs.get(state.popoutId);
      const currentPickedMc = pickedMcOption(state.popoutId);
      opts.forEach((opt, i) => {
        const c = popoutOptionCenter(n, i, opts.length);
        const iconTex = opt.iconUrl ? getTex(opt.iconUrl) : null;
        const isPicked = opt.id != null ? opt.id === currentPickedMc
                                        : opt.name === currentPickName;
        const halo: Tint = isPicked ? HALO_PICKED : HALO_BIG;
        addBucket(iconTex, true, c.x, c.y, POPOUT_ICON_SIZE, POPOUT_ICON_SIZE, WHITE);
        if (frameTex) {
          addBucket(frameTex, false, c.x, c.y, POPOUT_FRAME_SIZE * 1.18, POPOUT_FRAME_SIZE * 1.18, halo);
          addBucket(frameTex, false, c.x, c.y, POPOUT_FRAME_SIZE, POPOUT_FRAME_SIZE, WHITE);
        }
      });
    }
  }
  if (buckets.size > 0) {
    const batches: DynBatch[] = [];
    for (const b of buckets.values()) {
      const start = verts.length / STRIDE_FLOATS;
      for (const it of b.items) {
        pushSprite(verts, it[0], it[1], it[2], it[3], it[4], b.clipIcon);
      }
      const count = verts.length / STRIDE_FLOATS - start;
      if (count > 0) batches.push({ tex: b.tex, clipIcon: b.clipIcon, start, count });
    }
    uploadDyn(verts);
    for (const b of batches) {
      gl.bindTexture(gl.TEXTURE_2D, b.tex);
      gl.uniform1f(uClip, b.clipIcon ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, b.start, b.count);
    }
  }
}

// Asc nodes are drawn translated; for popouts we need to apply the
// same offset so the popout lands at the visible (relocated) position.
export function ascOffsetX(n: TreeNode): number {
  if (!n.a || ASC_IN_PLACE) return 0;
  const p = TREE.asc_panels[n.a];
  return p ? -p.x : 0;
}
export function ascOffsetY(n: TreeNode): number {
  if (!n.a || ASC_IN_PLACE) return 0;
  const p = TREE.asc_panels[n.a];
  return p ? -p.y : 0;
}

// Attribute-popout layout — also needed by pickFromPopout for hit-
// tests and by drawOverlays / drawAscPanel for rendering. Keep in
// sync.
export const POPOUT_ICON_SIZE   = 60;
export const POPOUT_FRAME_SIZE  = 90;
export const POPOUT_RING_RADIUS = 105;
// Attributes always have 3 options (Str/Dex/Int) at fixed angles so
// the existing muscle-memory positions stay stable. Multi-choice
// notables can have 2..5 options; we distribute those evenly around
// a circle, starting straight up at -90°.
export const POPOUT_ANGLES_ATTR: readonly number[] = [-90, 30, 150];
export function popoutAngle(i: number, total: number): number {
  if (total === 3) return (POPOUT_ANGLES_ATTR[i] ?? 0) * Math.PI / 180;
  return (-Math.PI / 2) + i * (2 * Math.PI / total);
}
export function popoutOptionCenter(n: TreeNode, i: number, total?: number): { x: number; y: number } {
  const t = total || 3;
  const x = n.x + ascOffsetX(n), y = n.y + ascOffsetY(n);
  const a = popoutAngle(i, t);
  return { x: x + POPOUT_RING_RADIUS * Math.cos(a), y: y + POPOUT_RING_RADIUS * Math.sin(a) };
}
// Returns popout option entries for either an attribute (n.o) or an
// MC notable (MULTI_CHOICE[id]). Each entry: { id, name, iconUrl, kind }.
//
// Attribute options now carry their VARIANT id (separate passive ids
// for Str / Dex / Int — that's what GGG's .build references when the
// node is allocated). MC options carry their own asc-node id. The
// `kind` field tells the pick handler which path to take — they're
// mutually exclusive but the semantics differ (MC swaps parent →
// option in state.selected; attribute keeps parent + tracks variant
// in state.pickedAttrs).
export interface PopoutOptionEntry {
  id: string | null;
  name: string;
  iconUrl: string | null | undefined;
  kind: 'attribute' | 'mc';
}
export function popoutOptionsFor(parentId: string): PopoutOptionEntry[] | null {
  const n = TREE.nodes[parentId];
  if (!n) return null;
  if (n.o && n.o.length) {
    return n.o.slice(0, 3).map(o => ({
      id: o.id != null ? String(o.id) : null,
      name: o.n,
      iconUrl: o.i,
      kind: 'attribute' as const,
    }));
  }
  const mcOpts = MULTI_CHOICE[String(parentId)];
  if (mcOpts) {
    return mcOpts.map(oid => {
      const on = TREE.nodes[oid];
      return {
        id: oid,
        name: on ? (on.n ?? '') : '',
        iconUrl: on ? on.i : null,
        kind: 'mc' as const,
      };
    });
  }
  return null;
}

