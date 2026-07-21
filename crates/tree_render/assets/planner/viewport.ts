// ============================================================================
// === Canvas sizing & pan/zoom ============================================
// ============================================================================
// Resize splits into TWO passes: a cheap per-frame CSS resize, and an
// expensive debounced pixel-buffer realloc.
//
// The expensive part is `canvas.width = ...` — that drops the GPU
// backing store and allocates a fresh one (the canvas blanks for one
// frame). Doing that on every tick of the sidebar's 220ms width
// transition causes a visible flicker as the canvas blanks 14+ times in
// succession. The CSS dimension change is essentially free: the
// browser scales the existing buffer to the new box.
//
// So during a transition we only touch CSS (smooth, no blink), and
// schedule the pixel-buffer realloc for after the resize storm settles
// (80ms of quiet = transition done, do the proper resize).

import { canvas, state, viewport, zoomfitBtn } from "./state.ts";
import { requestRender } from "./render.ts";
import { handleHover } from "./hover.ts";
import { handleClick, handleRightClick } from "./pathfind.ts";
import type { Capture } from "../../../../types/shared.d.ts";

let bufRealloc: ReturnType<typeof setTimeout> | null = null;
export function resize(): void {
  const rect = viewport.getBoundingClientRect();
  canvas.style.width  = rect.width + "px";
  canvas.style.height = rect.height + "px";
  requestRender();
  if (bufRealloc) clearTimeout(bufRealloc);
  bufRealloc = setTimeout(() => {
    bufRealloc = null;
    const r = viewport.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = Math.round(r.width  * dpr);
    canvas.height = Math.round(r.height * dpr);
    requestRender();
  }, 80);
}
// Initial pixel-buffer size — boot needs the buffer right away. Setting
// it once here means the first frame renders crisp; the CSS-only path
// above takes over for subsequent resizes.
(function initialBuf(): void {
  const rect = viewport.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = Math.round(rect.width  * dpr);
  canvas.height = Math.round(rect.height * dpr);
  canvas.style.width  = rect.width + "px";
  canvas.style.height = rect.height + "px";
})();
window.addEventListener("resize", resize);
// ResizeObserver catches layout shifts the window event misses —
// primarily the sidebar collapse/expand (which changes viewport width
// without firing a window resize). Without this, the canvas gets sized
// to whatever the viewport was at boot and stays there, leaving a dark
// strip on the side that just resized.
if (typeof ResizeObserver === "function") {
  new ResizeObserver(resize).observe(viewport);
}

export function fitToView(): void {
  // Compute scale so the whole canvas bounds fit in the viewport with
  // a 5% margin, then translate so it's centered.
  const rect = viewport.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  state.scale = fitScale();
  state.tx = rect.width  / 2 - (TREE.bounds.x + TREE.bounds.w / 2) * state.scale;
  state.ty = rect.height / 2 - (TREE.bounds.y + TREE.bounds.h / 2) * state.scale;
  requestRender();
}

/** Scale at which the whole tree fits the viewport (5% margin). Also
 *  the wheel-zoom floor: zooming out lands exactly at the full-tree
 *  view instead of stranding above it — the old fixed 0.05 floor sat
 *  ABOVE the fit scale, making zoom-out a one-way trip. */
export function fitScale(): number {
  const rect = viewport.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return 0.05;
  return Math.min(
    (rect.width  * 0.95) / TREE.bounds.w,
    (rect.height * 0.95) / TREE.bounds.h,
  );
}

// Smoothly pan/zoom so tree-coord (x, y) lands at the viewport centre
// at `targetScale`. Used when the base class changes: the user should
// land on their start emblem without losing spatial context — the
// short ease keeps the movement legible as travel, not a teleport.
let focusAnim: number | null = null;
export function focusTree(x: number, y: number, targetScale: number, ms = 450): void {
  const rect = viewport.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const s1 = Math.max(fitScale(), Math.min(1.0, targetScale));
  const tx1 = rect.width  / 2 - x * s1;
  const ty1 = rect.height / 2 - y * s1;
  const s0 = state.scale, tx0 = state.tx, ty0 = state.ty;
  if (focusAnim !== null) cancelAnimationFrame(focusAnim);
  const t0 = performance.now();
  const step = (now: number): void => {
    const t = Math.min(1, (now - t0) / ms);
    const e = 1 - Math.pow(1 - t, 3);         // ease-out cubic
    state.scale = s0 + (s1 - s0) * e;
    state.tx = tx0 + (tx1 - tx0) * e;
    state.ty = ty0 + (ty1 - ty0) * e;
    requestRender();
    focusAnim = t < 1 ? requestAnimationFrame(step) : null;
  };
  focusAnim = requestAnimationFrame(step);
}

export function clientToTree(cx: number, cy: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (cx - rect.left - state.tx) / state.scale,
    y: (cy - rect.top  - state.ty) / state.scale,
  };
}

export function zoomAt(cx: number, cy: number, factor: number): void {
  // Floor: the full-tree fit (wheel-out always gets back to overview).
  // Ceiling: 1.0 — past ~0.6 (the cmd+K focus zoom) detail stops adding
  // information; the old ×40 ceiling was a disorienting void.
  const newScale = Math.max(fitScale(), Math.min(1.0, state.scale * factor));
  const eff = newScale / state.scale;
  if (eff === 1) return;
  const rect = canvas.getBoundingClientRect();
  const lx = cx - rect.left, ly = cy - rect.top;
  state.tx = lx - (lx - state.tx) * eff;
  state.ty = ly - (ly - state.ty) * eff;
  state.scale = newScale;
  requestRender();
}

viewport.addEventListener("wheel", e => {
  // The skill/gear popover and command palette live INSIDE #viewport,
  // so their wheel events bubble here. Don't hijack them for zoom —
  // bail (no preventDefault) so the overlay's own overflow containers
  // scroll natively.
  if ((e.target as HTMLElement | null)?.closest('[role="dialog"], #cmdk')) return;
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1 / 1.18 : 1.18);
}, { passive: false });

// Suppress the browser context menu when the right-click target is
// inside the planner viewport so our "swap-path / cascade-deallocate"
// gestures work cleanly. Firefox in particular sometimes still popped
// the menu when the listener was only on the viewport element —
// registering on capture at document level + on the canvas itself is
// belt-and-suspenders that covers every event path.
viewport.addEventListener("contextmenu", e => e.preventDefault());
canvas.addEventListener("contextmenu", e => e.preventDefault());
document.addEventListener("contextmenu", e => {
  if (e.target instanceof Node && viewport.contains(e.target)) e.preventDefault();
}, true);

interface PanState {
  sx: number; sy: number; tx: number; ty: number; moved: boolean;
  ctrl: boolean; shift: boolean;
}
let panning: PanState | null = null;
viewport.addEventListener("mousedown", e => {
  if (e.button === 2) {
    e.preventDefault();
    handleRightClick(e.clientX, e.clientY);
    return;
  }
  if (e.button !== 0) return;
  // Capture modifier keys at mouse-down so the eventual click can
  // override the active allocation set: Ctrl+click → set1, Shift+click
  // → set2, plain click → state.activeSet (sidebar value). We don't
  // change the sidebar dropdown; this is a per-click hint. (Alt
  // avoided — Firefox opens its menu bar on Alt-release.)
  panning = {
    sx: e.clientX, sy: e.clientY, tx: state.tx, ty: state.ty, moved: false,
    ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey,
  };
  viewport.classList.add("panning");
});
window.addEventListener("mousemove", e => {
  if (panning) {
    const dx = e.clientX - panning.sx;
    const dy = e.clientY - panning.sy;
    if (Math.abs(dx) + Math.abs(dy) > 2) panning.moved = true;
    state.tx = panning.tx + dx;
    state.ty = panning.ty + dy;
    requestRender();
  } else {
    // Hover handling (also triggers tooltip)
    handleHover(e.clientX, e.clientY);
  }
});
window.addEventListener("mouseup", e => {
  if (!panning) return;
  const wasMoved = panning.moved;
  const mods = { ctrl: panning.ctrl, shift: panning.shift };
  panning = null;
  viewport.classList.remove("panning");
  if (!wasMoved) handleClick(e.clientX, e.clientY, mods);
});

// Touch: single-finger pan, two-finger pinch zoom.
type TouchState =
  | { mode: "pan";   sx: number; sy: number; tx: number; ty: number }
  | { mode: "pinch"; dist: number; cx: number; cy: number };
let touch: TouchState | null = null;
viewport.addEventListener("touchstart", e => {
  if (e.touches.length === 1) {
    const t = e.touches[0]!;
    touch = { mode: "pan", sx: t.clientX, sy: t.clientY, tx: state.tx, ty: state.ty };
  } else if (e.touches.length === 2) {
    const a = e.touches[0]!, b = e.touches[1]!;
    touch = { mode: "pinch",
              dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
              cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2 };
  }
});
viewport.addEventListener("touchmove", e => {
  if (!touch) return;
  e.preventDefault();
  if (touch.mode === "pan" && e.touches.length === 1) {
    const t = e.touches[0]!;
    state.tx = touch.tx + (t.clientX - touch.sx);
    state.ty = touch.ty + (t.clientY - touch.sy);
    requestRender();
  } else if (touch.mode === "pinch" && e.touches.length === 2) {
    const a = e.touches[0]!, b = e.touches[1]!;
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    zoomAt(touch.cx, touch.cy, dist / touch.dist);
    touch.dist = dist;
  }
}, { passive: false });
viewport.addEventListener("touchend", () => { touch = null; });

if (zoomfitBtn) zoomfitBtn.addEventListener("click", fitToView);
