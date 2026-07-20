// ---------------------------------------------------------------------
// Ascendancy PRESENTATION — where ascendancy content is drawn
// ---------------------------------------------------------------------
// Two presentations exist:
//   * PoE2 — the selected ascendancy's panel is parked at pocket
//     coordinates and drawn translated to the tree centre.
//   * PoE1 (in-place) — GGG's skilltree.js anchoring: the chosen
//     ascendancy hangs off the class start; its AscendancyButton
//     plaque sits 270 world units out along the outward direction,
//     the circle centre half the art height further, and every group
//     of the subtree relocates by circle − startGroupCentre.
//
// This module owns that geometry, exactly once. ascOffsetX/Y is the
// interface everything hangs on: hit-testing, edge tessellation,
// glow overlays, popouts and cmd+K focus all ask "where is this asc
// node DRAWN" through it — the bug class where a call site translated
// by the wrong presentation's offset lived here before it was
// consolidated (hit-testing 6e10b5a, gold edges 5dc948b).
//
// The poe1-only chrome (class-start medallions, plaque art states,
// attribute totals) also builds here; render.ts just draws the
// returned batches.

import { ASC_IN_PLACE } from "./game.ts";
import { state } from "./state.ts";
import { STRIDE_FLOATS, getTex } from "./webgl_setup.ts";
import { pushSprite, pushSpriteRot } from "./vertex_helpers.ts";
import { attrTotalsSprite } from "./attr_totals.ts";
import type { DynBatch } from "./render.ts";
import type { TreeNode } from "../../../../types/shared.d.ts";

const ASC_BUTTON_DIST = 270;

// GGG's ascendancy anchoring (skilltree.js getAscendancyPositionInfo):
// dir = (0,1) for the centered Scion start, else (x/d, -y/d);
// button = start + 270·(cos a, sin a); circle a further artHeight/2.
export function ascAnchorInfo(): {
  dx: number; dy: number;
  button: { x: number; y: number; c: number; s: number };
} | null {
  if (!state.klass || !state.asc) return null;
  const start = TREE.class_markers?.[state.klass];
  const panel = TREE.asc_panels[state.ascVariant ?? state.asc];
  if (!start || !panel) return null;
  const d = Math.hypot(start.x, start.y);
  const centered = Math.abs(start.x) < 10 && Math.abs(start.y) < 10;
  const dirX = centered ? 0 : start.x / d;
  const dirY = centered ? 1 : -start.y / d;
  const rot = Math.atan2(dirX, dirY);
  const ca = Math.cos(rot + Math.PI / 2), sa = Math.sin(rot + Math.PI / 2);
  const imgDist = ASC_BUTTON_DIST + panel.h / 2;
  return {
    dx: start.x + imgDist * ca - panel.x,
    dy: start.y + imgDist * sa - panel.y,
    button: {
      x: start.x + ASC_BUTTON_DIST * ca,
      y: start.y + ASC_BUTTON_DIST * sa,
      c: Math.cos(rot),
      s: Math.sin(rot),
    },
  };
}

// Plaque point for the SELECTED CLASS — unlike ascAnchorInfo this
// doesn't need an ascendancy chosen (the plaque shows as soon as a
// class is picked, inviting the click). Same outward-direction math.
export function ascButtonPoint(): { x: number; y: number; c: number; s: number } | null {
  if (!state.klass) return null;
  const start = TREE.class_markers?.[state.klass];
  if (!start) return null;
  const d = Math.hypot(start.x, start.y);
  const centered = Math.abs(start.x) < 10 && Math.abs(start.y) < 10;
  const dirX = centered ? 0 : start.x / d;
  const dirY = centered ? 1 : -start.y / d;
  const rot = Math.atan2(dirX, dirY);
  return {
    x: start.x + ASC_BUTTON_DIST * Math.cos(rot + Math.PI / 2),
    y: start.y + ASC_BUTTON_DIST * Math.sin(rot + Math.PI / 2),
    c: Math.cos(rot),
    s: Math.sin(rot),
  };
}

// Is a tree-coord point on the plaque? Circle test with the plaque's
// half-width — generous like GGG's Clickable image bounds, and the
// slack keeps the eye ornament (which pokes past the art box toward
// the medallion) inside the hit area.
export function ascButtonHit(tx: number, ty: number): boolean {
  if (!ASC_IN_PLACE || !TREE.asc_button) return false;
  const pt = ascButtonPoint();
  if (!pt) return false;
  const r = Math.max(TREE.asc_button.w, TREE.asc_button.h) / 2;
  return (tx - pt.x) ** 2 + (ty - pt.y) ** 2 < r * r;
}

// Centre + radius of the OPEN ascendancy circle (in-place mode) — the
// art overlaps main-tree nodes, so hit-testing needs to know the
// occluded disc: skilltree.js foreachClickable skips main nodes
// within classArtRadius of the popup centre.
export function ascCircleInfo(): { x: number; y: number; r: number } | null {
  if (!ASC_IN_PLACE || !state.ascOpen || !state.asc) return null;
  const info = ascAnchorInfo();
  const panel = TREE.asc_panels[state.ascVariant ?? state.asc];
  if (!info || !panel) return null;
  return { x: info.dx + panel.x, y: info.dy + panel.y, r: panel.h / 2 };
}

// Asc nodes are drawn translated; every consumer (hit-testing,
// popouts, edges, glows) applies the same offset so a node is
// interacted with exactly where it is drawn.
export function ascOffsetX(n: TreeNode): number {
  if (!n.a) return 0;
  if (ASC_IN_PLACE) {
    if (n.a !== (state.ascVariant ?? state.asc)) return 0;
    return ascAnchorInfo()?.dx ?? 0;
  }
  const p = TREE.asc_panels[n.a];
  return p ? -p.x : 0;
}
export function ascOffsetY(n: TreeNode): number {
  if (!n.a) return 0;
  if (ASC_IN_PLACE) {
    if (n.a !== (state.ascVariant ?? state.asc)) return 0;
    return ascAnchorInfo()?.dy ?? 0;
  }
  const p = TREE.asc_panels[n.a];
  return p ? -p.y : 0;
}

// ============== Class start markers (PoE1 chrome) ==============
// PoB rule (PassiveTreeView.lua:775): the selected class draws its own
// center<class> art; every other start shows the generic inactive
// medallion. On top: the AscendancyButton plaque (three art states
// like skilltree.js — Pressed while the circle is open, Highlight
// while hovered so the little eye lights up, normal otherwise) and
// the Str/Dex/Int totals over the medallion's coloured rings (GGG
// drawStartNodeBackground: current class only, empty build = 0/0/0).
export function buildInPlaceMarkers(): { verts: number[]; batches: DynBatch[] } {
  const verts: number[] = [];
  const batches: DynBatch[] = [];
  if (!ASC_IN_PLACE || !TREE.class_markers) return { verts, batches };
  for (const cn in TREE.class_markers) {
    const m = TREE.class_markers[cn]!;
    const active = cn === state.klass;
    const art = active ? m : TREE.start_inactive;
    if (!art) continue;
    const tex = getTex(art.p);
    if (!tex) continue;
    const s0 = verts.length / STRIDE_FLOATS;
    pushSprite(verts, m.x, m.y, art.w, art.h, [1, 1, 1, 1], false);
    batches.push({ tex, clipIcon: false, start: s0, count: 6 });
  }
  if (state.klass && TREE.asc_button) {
    const pt = ascButtonPoint();
    const btn = TREE.asc_button;
    const art = state.ascOpen ? (btn.pp ?? btn.p)
              : state.ascBtnHover ? (btn.hp ?? btn.p)
              : btn.p;
    const tex = getTex(art) ?? getTex(btn.p);
    if (pt && tex) {
      const s0 = verts.length / STRIDE_FLOATS;
      pushSpriteRot(verts, pt.x, pt.y, btn.w, btn.h, pt.c, pt.s, [1, 1, 1, 1]);
      batches.push({ tex, clipIcon: false, start: s0, count: 6 });
    }
  }
  // Attribute totals pushed last so the text sits on top.
  if (state.klass) {
    const start = TREE.class_markers[state.klass];
    const at = start ? attrTotalsSprite() : null;
    if (start && at) {
      const s0 = verts.length / STRIDE_FLOATS;
      pushSprite(verts, start.x, start.y, at.w, at.h, [1, 1, 1, 1], false);
      batches.push({ tex: at.tex, clipIcon: false, start: s0, count: 6 });
    }
  }
  return { verts, batches };
}
