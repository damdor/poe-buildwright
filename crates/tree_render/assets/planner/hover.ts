// ============================================================================
// === Hit-test & hover =====================================================
// ============================================================================

import { MAX_ASC_POINTS, MAX_MAIN_POINTS, MAX_SET_POINTS, countSelected, isLocked, isMcOption, isMcParent, pickedMcOption, state, tooltip , ascNodeOverride} from "./state.ts";
import { clientToTree } from "./viewport.ts";
import { POPOUT_FRAME_SIZE, PopoutOptionEntry, popoutOptionCenter, popoutOptionsFor, requestRender } from "./render.ts";
import { isGlobalNode, updatePreview } from "./pathfind.ts";
import { effectiveActiveSet } from "./sidebar.ts";
import { currentCharacterLevel } from "./captures_bar.ts";
import type { Skill } from "../../../../types/poe2.d.ts";

export function findHoverNode(treeX: number, treeY: number): string | null {
  // Brute-force closest node within hit radius. 4700 nodes × distance
  // check ≈ sub-millisecond on any modern CPU.
  let bestId: string | null = null, bestDist = Infinity;
  for (const id in TREE.nodes) {
    const n = TREE.nodes[id];
    if (!n) continue;
    // Skip start hubs — they're visual anchors, not allocatable.
    if (n.k === 'class_start' || n.k === 'asc_start') continue;
    // Skip masteries: zero edges touch them in 0.5 data — they're
    // cluster decoration, not allocatable nodes. Hovering one would
    // only surface its internal name (MasteryGroupAxe…), which is
    // data plumbing, not player-facing content.
    if (n.k === 'mastery') continue;
    // Skip hidden multi-choice options — interaction only via popout.
    if (isMcOption(id)) continue;
    // Skip unlock-constrained nodes (e.g. Oracle's Unseen Path
    // extras) when the active ascendancy doesn't match the
    // constraint.
    if (isLocked(id)) continue;
    if (n.a) {
      if (state.asc !== n.a) continue;
    }
    // For asc nodes, translate query to their native coords
    let qx = treeX, qy = treeY;
    if (n.a) {
      const p = TREE.asc_panels[n.a];
      if (p) { qx = treeX + p.x; qy = treeY + p.y; }
    }
    const dx = n.x - qx, dy = n.y - qy;
    const d2 = dx * dx + dy * dy;
    const r = Math.max((n.fw ?? 0) / 2, (n.iw ?? 0) / 2, 30);
    if (d2 < r * r && d2 < bestDist) {
      bestDist = d2;
      bestId = id;
    }
  }
  return bestId;
}

// When a popout is open, return the option entry (same shape as
// popoutOptionsFor()) under the cursor — or null. Mirrors the hit
// geometry of pickFromPopout so a click and a hover see the same
// option. Used so multi-choice options inside the popout (Path of
// the Sorceress, Path of the Warrior, Lucid Dreaming variants, …)
// still show their stat tooltip — they're hidden from the regular
// findHoverNode pass.
export function hoverFromPopout(cx: number, cy: number): PopoutOptionEntry | null {
  if (!state.popoutId) return null;
  const n = TREE.nodes[state.popoutId];
  if (!n) return null;
  const opts = popoutOptionsFor(state.popoutId);
  if (!opts) return null;
  const t = clientToTree(cx, cy);
  // Mirror pickFromPopout's inflated hit radius so hover-tooltip and
  // click pick the same option at every zoom level.
  const MIN_HIT_PX = 28;
  const visualHit  = POPOUT_FRAME_SIZE / 2;
  const minHitTree = (state.scale ? MIN_HIT_PX / state.scale : visualHit);
  const hit = Math.max(visualHit, minHitTree);
  let best = -1, bestD2 = Infinity;
  for (let i = 0; i < opts.length; i++) {
    const c = popoutOptionCenter(n, i, opts.length);
    const dx = t.x - c.x, dy = t.y - c.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < hit * hit && d2 < bestD2) { bestD2 = d2; best = i; }
  }
  return best >= 0 ? (opts[best] ?? null) : null;
}
export function handleHover(cx: number, cy: number): void {
  // Popout open → hover an option icon first. Without this, MC
  // options (Path of the Sorceress / Warrior, etc.) have no tooltip
  // because findHoverNode skips them (isMcOption check).
  if (state.popoutId) {
    const opt = hoverFromPopout(cx, cy);
    if (opt) {
      if (opt.id != null) {
        const optIdStr = String(opt.id);
        // Multi-choice option — its node carries the real stat text.
        if (optIdStr !== state.hoverId) {
          state.hoverId = optIdStr;
          updatePreview();
          requestRender();
        }
        showTooltip(optIdStr, cx, cy);
      } else {
        // Attribute popout (Str/Dex/Int) — no stat data in tree.json
        // for the per-attribute variant; show just the name.
        if (state.hoverId !== null) {
          state.hoverId = null;
          updatePreview();
          requestRender();
        }
        showOptionNameTooltip(opt.name ?? '', cx, cy);
      }
      return;
    }
  }
  const t = clientToTree(cx, cy);
  const id = findHoverNode(t.x, t.y);
  if (id !== state.hoverId) {
    state.hoverId = id;
    // Recompute the dashed allocate/deallocate preview overlay
    // (returns silently if popoutId is open or hoverId is null).
    // Then request a render so the new dashed edges appear.
    updatePreview();
    requestRender();
  }
  if (id) showTooltip(id, cx, cy);
  else hideTooltip();
}

export function showOptionNameTooltip(name: string, cx: number, cy: number): void {
  tooltip.innerHTML = '<div class="tt-head"><div class="tt-name">' + esc(name) + '</div></div>';
  tooltip.classList.add('show');
  const tr = tooltip.getBoundingClientRect();
  const padding = 14;
  let x = cx + padding, y = cy + padding;
  if (x + tr.width > window.innerWidth) x = cx - tr.width - padding;
  if (y + tr.height > window.innerHeight) y = cy - tr.height - padding;
  tooltip.style.left = Math.max(4, x) + 'px';
  tooltip.style.top = Math.max(4, y) + 'px';
  tooltipPos = null;
}

// Sum up the stats picked up by allocating the previewed path. Used
// in the tooltip's "Path total" section so the user can compare two
// alternates side-by-side (right-click rotates between them and the
// accumulated stats refresh in place).
//
// For each stat line we replace every numeric value with a "#"
// placeholder; lines that match the same template sum their values.
// Multi-number lines ("1% chance to ignite per 5 Strength") and
// numberless lines ("Gain Tailwind on Skill use") fall through to a
// verbatim count.
export interface AccumBucket { template: string; sign: string; total: number; }
export function computePathAccumulation(
  primaryEdges: Iterable<[string, string]>, targetId: string,
): string[] {
  const ids = new Set<string>([String(targetId)]);
  for (const [, child] of primaryEdges) ids.add(String(child));
  // template (with '#') → { signs[], total }
  const buckets = new Map<string, AccumBucket>();
  const verbatim = new Map<string, number>();
  for (const id of ids) {
    const n = TREE.nodes[id];
    if (!n || !n.s) continue;
    for (const raw of n.s.split(/;\s*/)) {
      const line = raw.trim();
      if (!line) continue;
      const signs: string[] = [];
      const nums: number[] = [];
      const template = line.replace(/([+-]?)(\d+(?:\.\d+)?)/g, (_m, sign: string, num: string) => {
        signs.push(sign);
        nums.push(parseFloat(sign + num));
        return '#';
      });
      if (nums.length === 1) {
        let b = buckets.get(template);
        if (!b) { b = { template, sign: signs[0] ?? '', total: 0 }; buckets.set(template, b); }
        b.total += nums[0]!;
      } else {
        verbatim.set(line, (verbatim.get(line) || 0) + 1);
      }
    }
  }
  const out: string[] = [];
  for (const b of buckets.values()) {
    let fmt;
    if (Number.isInteger(b.total)) fmt = String(Math.abs(b.total));
    else fmt = Math.abs(b.total).toFixed(2).replace(/\.?0+$/, '');
    if (b.total < 0) fmt = '-' + fmt;
    else if (b.sign === '+') fmt = '+' + fmt;
    out.push(b.template.replace('#', fmt));
  }
  for (const [line, count] of verbatim) {
    out.push(count > 1 ? line + ' (×' + count + ')' : line);
  }
  return out;
}

// Last tooltip position so updatePreview / handleRightClick can
// re-render the tooltip in place when the previewed path rotates.
export let tooltipPos: { id: string; cx: number; cy: number } | null = null;
export function showTooltip(id: string, cx: number, cy: number): void {
  const n = TREE.nodes[id];
  if (!n) return;
  // Variant ascendancy (Abyssal Lich): same panel node, swapped content.
  const ov = ascNodeOverride(id);
  const dispName = ov ? ov.n : n.n;
  const dispStats = ov ? ov.s : n.s;
  let html = '<div class="tt-head"><div class="tt-name">' + esc(dispName || '(unnamed)') + '</div>';
  html += '<div class="tt-tags"><span class="tt-tag">' + esc(n.k) + '</span>';
  if (n.a) html += '<span class="tt-tag">' + esc(n.a) + '</span>';
  html += '</div></div>';
  if (dispStats) {
    html += '<div class="tt-stats">';
    for (const line of dispStats.split(/;\s*/)) if (line.trim()) html += '<div class="tt-stat">' + esc(line) + '</div>';
    html += '</div>';
  }
  // Granted skills — resolved to name + description at build time (see
  // tree_render main.rs). Shown inline so the reader sees what an
  // ascendancy-granted skill actually does without leaving the planner
  // (more helpful than GGG's click-to-expand). One card per grant.
  if (n.gs && n.gs.length) {
    for (const g of n.gs) {
      html += '<div class="tt-skill-section">' +
                '<div class="tt-skill-head">' + esc(g.n) + '</div>' +
                '<div class="tt-skill-desc">' + esc(g.d) + '</div>' +
              '</div>';
    }
  }
  // Multi-choice parent with a picked option — show the option's
  // name + stats below the parent's. Without this the tooltip on
  // (e.g.) Path Seeker is just "Path Seeker" with no indication of
  // which path the build actually took.
  if (isMcParent(id) && !state.popoutId) {
    const pickedId = pickedMcOption(id);
    if (pickedId) {
      const opt = TREE.nodes[pickedId];
      if (opt) {
        html += '<div class="tt-accum-head">Picked: ' + esc(opt.n || '') + '</div>';
        if (opt.s) {
          html += '<div class="tt-stats">';
          for (const line of opt.s.split(/;\s*/)) {
            if (line.trim()) html += '<div class="tt-stat tt-accum">' + esc(line) + '</div>';
          }
          html += '</div>';
        }
      }
    }
  }
  // Author note (if any) — surfaced inline so the user reads stats
  // and recommendation as one card. Same number as the matching
  // slider tick + tree badge, so the three surfaces cross-reference
  // by index without the user having to chase the text in two
  // tooltips. Timeline-aware: PoE2Notes carries entries from every
  // capture, but we only show the note section when the node is
  // ACTUALLY allocated at the current view (active capture in
  // editing, slider level in replay) — a respec'd node's stale
  // note shouldn't surface on tooltip hover.
  if (window.PoE2Notes && state.selected.has(String(id))) {
    const noteInfo = window.PoE2Notes.get(String(id));
    if (noteInfo) {
      html += '<div class="tt-note-section">' +
                '<div class="tt-note-head">Note ' + noteInfo.num + ' · Lv ' + noteInfo.level + '</div>' +
                '<div class="tt-note-text">' + esc(noteInfo.text) + '</div>' +
              '</div>';
    }
  }
  // Jewel sockets: show WHAT sits in them (name + mod lines + any
  // pathing rule), or the socket's state — gear_overlay owns the
  // jewel model and serves it over the PoE2Jewels bridge.
  if (n.k === 'keystone') {
    const conv = window.PoE2Jewels?.conversionForKeystone?.(String(id));
    if (conv) {
      html += '<div class="tt-note-section"><div class="tt-note-head">' + esc(conv.title) + '</div>';
      for (const line of conv.lines) html += '<div class="tt-mod">' + esc(line) + '</div>';
      html += '</div>';
    }
  }
  if (n.k === 'jewel') {
    const info = window.PoE2Jewels?.infoForSocket?.(String(id));
    if (info) {
      html += '<div class="tt-note-section"><div class="tt-note-head">' + esc(info.title) + '</div>';
      for (const line of info.lines) html += '<div class="tt-mod">' + esc(line) + '</div>';
      html += '</div>';
    }
  }
  // Warn when hovering a global node (keystone / jewel socket) while
  // a weapon-set mode is active — explains why the click is refused.
  // Uses the effective mode so the warning lights up the moment the
  // user holds Ctrl/Shift, not only when the dropdown is changed.
  if (isGlobalNode(n) && !state.selected.has(id) &&
      (effectiveActiveSet() === 'set1' || effectiveActiveSet() === 'set2')) {
    const label = n.k === 'keystone' ? 'Keystone' : 'Jewel socket';
    html += '<div class="tt-warn">' + label +
            ' can’t be allocated in weapon-set mode — switch to main.</div>';
  }
  // Path-total summary: only shown for an allocate-preview (hovering
  // an unselected reachable node with no open popout). For the
  // dealloc preview the "would-be-removed cluster" stats are the
  // selection's own — not a separate informational add.
  if (state.previewAccumulated && !state.selected.has(id) && !state.popoutId) {
    const acc = state.previewAccumulated;
    const cost = acc.cost || 0;
    // Level transition: current → projected. Helps the author plan
    // "I want a snapshot at exactly Lv 35" by hovering paths until
    // the projected lvl lines up. Only main-tree allocations shift
    // the character level; asc + weapon-set are off-curve.
    let lvlBadge = '';
    if (typeof acc.levelNeeded === 'number' && typeof currentCharacterLevel === 'function') {
      const cur = currentCharacterLevel();
      if (acc.levelNeeded !== cur) {
        lvlBadge = ' · <span class="tt-lvl">Lv ' + cur + ' → <strong>Lv ' + acc.levelNeeded + '</strong></span>';
      } else {
        lvlBadge = ' · <span class="tt-lvl">Lv ' + cur + '</span>';
      }
    }
    const altCount = acc.altCount ?? 0;
    const mainAdd = acc.mainAdd ?? 0;
    const setAdd  = acc.setAdd  ?? 0;
    const ascAdd  = acc.ascAdd  ?? 0;
    html += '<div class="tt-accum-head">Path total · ' + cost + ' point' + (cost === 1 ? '' : 's')
          + lvlBadge
          + (altCount > 0
              ? ' · ' + (altCount + 1) + ' alternates (right-click to cycle)'
              : '')
          + '</div>';
    // Budget-deficit warning. If committing the path would push any
    // category past its (possibly asc-bonused) cap, show by how much
    // so the user understands why left-click is being refused —
    // previously the click silently no-op'd with no explanation.
    const cur = countSelected();
    const mainCap = MAX_MAIN_POINTS + cur.mainPointGrant;
    const setCap  = MAX_SET_POINTS  + cur.weaponSetGrant;
    const mainOver = mainAdd > 0 ? (cur.main + mainAdd) - mainCap : 0;
    const setOver  = setAdd  > 0 ? (cur.sets + setAdd)  - setCap  : 0;
    const ascOver  = ascAdd  > 0 ? (cur.asc  + ascAdd)  - MAX_ASC_POINTS : 0;
    const overParts: string[] = [];
    if (mainOver > 0) overParts.push(mainOver + ' main');
    if (setOver  > 0) overParts.push(setOver  + ' weapon-set');
    if (ascOver  > 0) overParts.push(ascOver  + ' asc');
    if (overParts.length > 0) {
      html += '<div class="tt-warn">Over budget by ' + overParts.join(' + ') +
              ' point' + (mainOver + setOver + ascOver === 1 ? '' : 's') +
              ' — click will be refused.</div>';
      // Level-needed hint: only meaningful when the over-budget points
      // are main-tree (asc + weapon-set are off-curve, no level-up
      // path to "afford" them — they need the asc / quest reward).
      if (mainOver > 0 && typeof acc.levelNeeded === 'number') {
        if (acc.levelNeeded <= 100) {
          html += '<div class="tt-hint">Need <strong>Lv ' + acc.levelNeeded + '</strong> to afford this path.</div>';
        } else {
          html += '<div class="tt-hint">Unreachable at any level (would need Lv ' + acc.levelNeeded + ', cap is 100).</div>';
        }
      }
    }
    if (acc.length > 0) {
      html += '<div class="tt-stats">';
      for (const line of acc) {
        html += '<div class="tt-stat tt-accum">' + esc(line) + '</div>';
      }
      html += '</div>';
    }
  }
  tooltip.innerHTML = html;
  tooltip.classList.add('show');
  positionTooltip(tooltip, cx, cy);
  tooltipPos = { id, cx, cy };
}

// Smart tooltip placement: never clipped, never sitting on the
// hovered node, never crammed under the sidebar / slider / HUD.
// Picks the BEST of 8 candidate anchors (4 corners + 4 cardinal)
// based on (1) does it fit fully inside the safe area, and (2) does
// it avoid a small exclusion box around the cursor. First candidate
// that passes both wins. If none fit, the fallback minimises overlap
// with the exclusion box so the user can still SEE the hovered node.
//
// Why 8 candidates instead of "always to the right, flip if overflow":
// a tooltip pinned right gets shoved under the slider when the cursor
// is near the top-right; pinned below gets shoved over the HUD when
// the cursor is near the bottom-left. The 4-cardinal candidates pick
// up those L-shaped gaps the corner anchors can't reach.
interface PlacementRect { x: number; y: number; w: number; h: number; }
interface PlacementCandidate { x: number; y: number; name: string; }
export function positionTooltip(el: HTMLElement, cx: number, cy: number): void {
  const tr = el.getBoundingClientRect();
  const tw = tr.width, th = tr.height;
  const vw = window.innerWidth, vh = window.innerHeight;

  // Safe area: viewport minus the chrome elements that the tooltip
  // shouldn't disappear behind. Re-read every call — slider / HUD
  // visibility can change between hovers.
  const sidebar = document.getElementById('panel');
  const slider  = document.getElementById('level-slider');
  const hud     = document.getElementById('mode-badge');
  const wizard  = document.getElementById('wizard-chrome');
  let leftEdge = 8, topEdge = 8, rightEdge = vw - 8, bottomEdge = vh - 8;
  if (sidebar) leftEdge = Math.max(leftEdge, sidebar.getBoundingClientRect().right + 8);
  if (wizard)  topEdge  = Math.max(topEdge,  wizard.getBoundingClientRect().bottom + 6);
  if (slider && !slider.classList.contains('hidden')) {
    topEdge = Math.max(topEdge, slider.getBoundingClientRect().bottom + 6);
  }
  // HUD lives at the bottom-left of the viewport; we treat it as a
  // FORBIDDEN BOX (not a shaved edge) so the tooltip can still use
  // the bottom-right area when needed.
  let hudBox: PlacementRect | null = null;
  if (hud && (hud as HTMLElement).offsetParent !== null) {
    const hb = hud.getBoundingClientRect();
    hudBox = { x: hb.left - 6, y: hb.top - 6, w: hb.width + 12, h: hb.height + 12 };
  }

  // Cursor exclusion: keep the tooltip clear of a small box around
  // the cursor so the hovered node stays visible. Sized to comfortably
  // clear a hovered notable (~50 px) at typical zoom — at extreme
  // zoom the visible node is bigger but the cursor is on top of it.
  const CUR_PAD = 22;
  const cursorBox = { x: cx - CUR_PAD, y: cy - CUR_PAD, w: CUR_PAD * 2, h: CUR_PAD * 2 };

  // GAP slightly LARGER than CUR_PAD so corner placements (SE/NE/SW/
  // NW) sit just outside the exclusion box rather than nicking its
  // corner with an 8 px overlap — visually that overlap reads as
  // "tooltip covers the dot I was about to read."
  const GAP = CUR_PAD + 4;
  // 8 candidate top-left positions, ordered by preference. Default
  // SE matches the legacy placement (familiarity); the rest are
  // fallbacks for screen edges + obstructed areas. When a HUD is
  // visible, the "shift past HUD" candidates rescue the lower-left
  // dead-zone where the standard 8 anchors all hit the HUD pill.
  const candidates: PlacementCandidate[] = [
    { x: cx + GAP,        y: cy + GAP,        name: 'SE' },
    { x: cx + GAP,        y: cy - GAP - th,   name: 'NE' },
    { x: cx - GAP - tw,   y: cy + GAP,        name: 'SW' },
    { x: cx - GAP - tw,   y: cy - GAP - th,   name: 'NW' },
    { x: cx - tw / 2,     y: cy + GAP,        name: 'S'  },
    { x: cx - tw / 2,     y: cy - GAP - th,   name: 'N'  },
    { x: cx + GAP,        y: cy - th / 2,     name: 'E'  },
    { x: cx - GAP - tw,   y: cy - th / 2,     name: 'W'  },
  ];
  if (hudBox) {
    // Land the tooltip strictly east-of-HUD when the cursor is in
    // its vicinity. Two y variants so we can pair "above cursor" or
    // "below cursor" depending on which has room.
    const eastX = hudBox.x + hudBox.w + 4;
    candidates.push(
      { x: eastX, y: cy - GAP - th, name: 'E-of-HUD-N' },
      { x: eastX, y: cy + GAP,      name: 'E-of-HUD-S' },
      { x: eastX, y: hudBox.y - th - 4, name: 'above-HUD-right' },
    );
  }

  function rectsOverlap(a: PlacementRect, b: PlacementRect): boolean {
    return !(a.x + a.w <= b.x || b.x + b.w <= a.x ||
             a.y + a.h <= b.y || b.y + b.h <= a.y);
  }
  function fits(c: PlacementCandidate): boolean {
    if (c.x < leftEdge || c.y < topEdge
        || c.x + tw > rightEdge || c.y + th > bottomEdge) return false;
    // HUD avoidance is part of fitting, not just the fallback — most
    // placements DO have a clean spot once HUD is excluded, and
    // promoting hud-avoidance into fits() means the strict pass picks
    // them instead of falling through to the score-the-overlap mode.
    if (hudBox && rectsOverlap({ x: c.x, y: c.y, w: tw, h: th }, hudBox)) return false;
    return true;
  }

  let chosen: PlacementCandidate | null = null;
  for (const c of candidates) {
    const rect = { x: c.x, y: c.y, w: tw, h: th };
    if (!fits(c)) continue;
    if (rectsOverlap(rect, cursorBox)) continue;
    if (hudBox && rectsOverlap(rect, hudBox)) continue;
    chosen = c; break;
  }

  // Fallback: clamp each candidate into safe area, score by
  // (cursor-overlap area + hud-overlap area). Lowest wins. Guarantees
  // we always render something visible even when the tooltip is too
  // large for any clean anchor.
  if (!chosen) {
    function overlapArea(a: PlacementRect, b: PlacementRect): number {
      const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
      const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      return ix * iy;
    }
    let bestScore = Infinity;
    for (const c of candidates) {
      const x = Math.max(leftEdge, Math.min(c.x, rightEdge - tw));
      const y = Math.max(topEdge,  Math.min(c.y, bottomEdge - th));
      const rect = { x, y, w: tw, h: th };
      let score = overlapArea(rect, cursorBox);
      if (hudBox) score += overlapArea(rect, hudBox);
      // Light preference for keeping name's index order (SE first)
      // when scores tie — keeps "default placement" stable across
      // frames if the cursor is in a dead-zone.
      if (score < bestScore) { bestScore = score; chosen = { x, y, name: c.name }; }
    }
  } else {
    // Clamp the chosen position too — fits() guarantees it's already
    // inside the safe area, but a sub-pixel rounding can drift it 1 px
    // past the edge. Cheap and defensive.
    chosen.x = Math.max(leftEdge, Math.min(chosen.x, rightEdge - tw));
    chosen.y = Math.max(topEdge,  Math.min(chosen.y, bottomEdge - th));
  }

  // Convert from CLIENT (browser-window) coords to the tooltip's
  // containing-block coords. `main#viewport` has `contain: strict`,
  // which promotes it to a containing block for position: fixed
  // descendants — so el.style.left is measured from #viewport's left,
  // not from the browser left edge. Without this translation the
  // tooltip would shift by the sidebar's width and clip off the
  // right (which is exactly the bug the legacy positioner had).
  const cb = (el.offsetParent as HTMLElement | null) || document.getElementById('viewport');
  const cbRect = cb ? cb.getBoundingClientRect() : { left: 0, top: 0 };
  // chosen is non-null by here (either the fits() pass set it, or the
  // scoring fallback above did).
  el.style.left = (chosen!.x - cbRect.left) + 'px';
  el.style.top  = (chosen!.y - cbRect.top)  + 'px';
}
export function hideTooltip(): void { tooltip.classList.remove('show'); tooltipPos = null; }
export function refreshTooltip(): void {
  if (tooltipPos && tooltipPos.id === state.hoverId) {
    showTooltip(tooltipPos.id, tooltipPos.cx, tooltipPos.cy);
  }
}
export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c
  ));
}

