// ============================================================================
// === Level slider (replay mode) ============================================
// ============================================================================
// Top-of-viewport slider that scrubs the build from level 1 → max
// authored level. Shows the cumulative tree state at any given
// level: main-tree mains revealed one-per-level inside each capture
// (using the capture's main-subset array order, since the captures
// model preserves final-state order at snapshot time); asc + weapon-
// set allocations appear all-at-once at the start of the capture
// they're first seen in (PoE2 grants those points off-curve, so we
// don't pretend to know which level inside a range they were taken).
//
// Cap-boundary respec: when the slider crosses from capture i's hi
// to capture i+1's lo, allocations dropped between them fade out;
// new ones appear. Same visual vocabulary as live editing.
//
// The slider runs in a separate state from live authoring — entering
// replay mode snapshots state.selected so we can restore on exit.
// Drag-reorder, allocate-on-tree-click etc. are disabled while
// replay is active (the user shouldn't accidentally mutate the
// active capture mid-slide).


import { ASC_EFFECTS, ascSel, state , resolveAscName} from "./state.ts";
import { requestRender } from "./render.ts";
import { esc } from "./hover.ts";
import { adj, updatePreview } from "./pathfind.ts";
import { applyAsc, updateSelectionUI } from "./sidebar.ts";
import { flushPersistNow, syncFromWizardStore } from "./wizard_sync.ts";
import {
  emitNotesUpdated, emitReplayScrub, PLANNER_EVENTS,
} from "./runtime_contract.ts";
import type { Capture, Skill } from "../../../../types/shared.d.ts";

const lsEl       = document.getElementById('level-slider') as HTMLElement | null;
const lsInput    = document.getElementById('ls-input')     as HTMLInputElement | null;
const lsLevelEl  = document.getElementById('ls-level')     as HTMLElement | null;
const lsMaxEl    = document.getElementById('ls-max')       as HTMLElement | null;
const lsCapEl    = document.getElementById('ls-cap-name')  as HTMLElement | null;
const lsTicksEl  = document.getElementById('ls-ticks')     as HTMLElement | null;
const lsTooltipEl = document.getElementById('ls-tooltip') as HTMLElement | null;
const lsModeEditBtn   = document.getElementById('ls-mode-edit')   as HTMLElement | null;
const lsModeReplayBtn = document.getElementById('ls-mode-replay') as HTMLElement | null;

// Replay mode flag. CRITICAL: must also live on `state` so the
// autosave RAF tick in wizard_sync.ts can gate itself off —
// otherwise sliding the level slider would constantly mutate
// state.selected and the autosave would faithfully PERSIST that
// mutation into the active capture, destroying authored data.
state.replayActive = false;
let savedSelected: Map<string, string> | null = null;
let savedPickedAttrs: Map<string, string> | null = null;
let savedAllocMeta: Map<string, { notes?: string; level?: number }> | null = null;

// Shapes for the per-capture cache. Each entry holds the capture
// itself plus the three allocation kinds split out, with `grants`
// (the count of main-passive points granted by asc nodes in this
// capture — Pathfinder's Path of X, Oracle's Passive Point, etc.).
export interface SliderAlloc {
  id: string | number;
  set?: 'main' | 'set1' | 'set2';
  note?: string;
  attrVariantId?: string;
  level?: number;
}
export interface CapCacheEntry {
  capture: Capture;
  mains: SliderAlloc[];
  ascs:  SliderAlloc[];
  sets:  SliderAlloc[];
  grants: number;
}
// Cached per-capture index of main-tree allocations (in the order
// they appear in capture.passives). Rebuilt whenever the captures
// change.
let _capCache: CapCacheEntry[] | null = null;

export function rebuildCapCache(): CapCacheEntry[] | null {
  if (!window.BuildwrightPlan) { _capCache = null; return null; }
  const captures = window.BuildwrightPlan.captures.list();
  _capCache = captures.map((c): CapCacheEntry => {
    const mains: SliderAlloc[] = [];
    const ascs:  SliderAlloc[] = [];
    const sets:  SliderAlloc[] = [];
    let grants = 0;
    for (const a of c.passives) {
      const n = TREE.nodes[String(a.id)];
      if (!n) continue;
      if (n.a) {
        // Asc allocation. Grants on certain asc nodes raise the
        // effective main-passive ceiling (Pathfinder's Path of X,
        // Oracle's Passive Point, Witchhunter's Weapon Master).
        ascs.push(a as SliderAlloc);
        const eff = ASC_EFFECTS[String(a.id)];
        if (eff && eff.grantsPoints) grants += eff.grantsPoints;
      } else if (a.set === 'set1' || a.set === 'set2') {
        sets.push(a as SliderAlloc);
      } else {
        mains.push(a as SliderAlloc);
      }
    }
    return { capture: c, mains: orderMainsByConnectivity(mains, c, ascs), ascs, sets, grants };
  });
  return _capCache;
}

// Reorder a capture's main-tree allocations into BFS-from-class-start
// order, so the level slider reveals them in connectivity order:
// each new reveal sits adjacent to an already-revealed node (or to
// the class start hub). Without this, the slider walks the array in
// captures-store order, which can put deep-tree notables on screen
// before the prefix path that connects them — orphan dots that look
// like the build is unrolling in reverse.
//
// Asc allocations in this capture seed alt-start hubs when they
// grant one (Pathfinder's Path of the Sorceress / Warrior). They
// are NOT BFS transit nodes themselves — asc + main live in
// disjoint subgraphs.
//
// Tie-break inside a BFS layer: keep the original capture.passives
// order, so the visible sequence is deterministic AND mirrors the
// author's intent for "which sister node to take first."
//
// Disconnected mains (shouldn't happen in valid builds, but
// defensive) are appended at the end in original order — better
// than dropping them and silently losing a level off the slider.
export function orderMainsByConnectivity(
  mainAllocs: SliderAlloc[], capture: Capture, ascAllocs: SliderAlloc[],
): SliderAlloc[] {
  if (mainAllocs.length <= 1) return mainAllocs.slice();
  const mainsSet = new Set(mainAllocs.map(a => String(a.id)));
  const allocById = new Map(mainAllocs.map(a => [String(a.id), a] as const));
  const posOf = new Map<string, number>();
  mainAllocs.forEach((a, i) => posOf.set(String(a.id), i));
  const roots = new Set<string>();
  const klass = capture.class || state.klass;
  if (klass) {
    for (const id in TREE.nodes) {
      const n = TREE.nodes[id];
      if (!n || n.k !== 'class_start') continue;
      if ((n.kl || '').split('|').includes(klass)) { roots.add(id); break; }
    }
  }
  // Alt-start hubs unlocked by asc MC-option picks IN THIS CAPTURE
  // (Pathfinder's Path of the Sorceress / Warrior). Without this,
  // Sorceress-side mains look "disconnected from the Ranger hub"
  // and fall into the defensive append-at-end path.
  for (const a of (ascAllocs || [])) {
    const eff = ASC_EFFECTS[String(a.id)];
    if (!eff || !eff.altStartClass) continue;
    for (const id in TREE.nodes) {
      const n = TREE.nodes[id];
      if (!n || n.k !== 'class_start') continue;
      if ((n.kl || '').split('|').includes(eff.altStartClass)) { roots.add(id); break; }
    }
  }
  if (roots.size === 0) return mainAllocs.slice();
  const ordered: SliderAlloc[] = [];
  const visited = new Set<string>();
  let frontier = [...roots];
  while (frontier.length) {
    const nextLayer = new Set<string>();
    for (const cur of frontier) {
      const nbrs = adj.get(cur);
      if (!nbrs) continue;
      for (const nb of nbrs) {
        if (visited.has(nb)) continue;
        if (!mainsSet.has(nb)) continue;
        nextLayer.add(nb);
      }
    }
    if (nextLayer.size === 0) break;
    const layerSorted = [...nextLayer].sort((a, b) =>
      (posOf.get(a) ?? Infinity) - (posOf.get(b) ?? Infinity));
    for (const id of layerSorted) {
      visited.add(id);
      const a = allocById.get(id);
      if (a) ordered.push(a);
    }
    frontier = layerSorted;
  }
  for (const a of mainAllocs) {
    if (!visited.has(String(a.id))) ordered.push(a);
  }
  return ordered;
}

// Build the (level → state) map. At level L, find the capture
// containing L, then take all asc+set entries of that capture PLUS
// the first (L - 1 + grants) main entries (using the capture's main
// subset array order). Returns:
//   { selected: Map<id, set>, pickedAttrs: Map<id, name>, capture, capIdx }
export interface SliderState {
  selected: Map<string, string>;
  pickedAttrs: Map<string, string>;
  allocMeta: Map<string, { notes?: string; level?: number }>;
  capture: Capture;
  capIdx: number;
}
export function stateAtLevel(L: number): SliderState | null {
  if (!_capCache || _capCache.length === 0) return null;
  let idx = -1;
  for (let i = 0; i < _capCache.length; i++) {
    const c = _capCache[i]!.capture;
    if (L >= c.levelRange[0] && L <= c.levelRange[1]) { idx = i; break; }
  }
  if (idx < 0) return null;
  const entry = _capCache[idx]!;
  const targetMainCount = Math.max(0, L - 1 + entry.grants);
  const visibleMains = entry.mains.slice(0, targetMainCount);
  const selected    = new Map<string, string>();
  const pickedAttrs = new Map<string, string>();
  const allocMeta   = new Map<string, { notes?: string; level?: number }>();
  for (const a of visibleMains) {
    selected.set(String(a.id), a.set || 'main');
    if (a.attrVariantId) {
      const parent = TREE.nodes[String(a.id)];
      if (parent && parent.o) {
        const opt = parent.o.find(o => String(o.id) === String(a.attrVariantId));
        if (opt) pickedAttrs.set(String(a.id), opt.n);
      }
    }
    if (a.note) allocMeta.set(String(a.id), { notes: a.note });
  }
  // Asc + weapon-set: each entry has an explicit authoring level
  // (stamped on allocate; falls back to capture's lo for legacy
  // entries that pre-date the per-level field). Filter by L so the
  // slider reveals each off-curve allocation at exactly the level
  // the author took it.
  const fallbackLvl = entry.capture.levelRange[0];
  for (const a of entry.ascs) {
    const lvl = typeof a.level === 'number' ? a.level : fallbackLvl;
    if (L < lvl) continue;
    selected.set(String(a.id), a.set || 'main');
    if (a.note) allocMeta.set(String(a.id), { notes: a.note });
  }
  for (const a of entry.sets) {
    const lvl = typeof a.level === 'number' ? a.level : fallbackLvl;
    if (L < lvl) continue;
    selected.set(String(a.id), a.set ?? 'main');
    if (a.note) allocMeta.set(String(a.id), { notes: a.note });
  }
  return {
    selected, pickedAttrs, allocMeta,
    capture: entry.capture, capIdx: idx,
  };
}

export function stateAtRouteIndex(position: number): SliderState | null {
  if (!_capCache?.length) return null;
  const idx = Math.max(0, Math.min(_capCache.length - 1, Math.trunc(position)));
  const entry = _capCache[idx]!;
  const selected = new Map<string, string>();
  const pickedAttrs = new Map<string, string>();
  const allocMeta = new Map<string, { notes?: string; level?: number }>();
  for (const allocation of entry.capture.passives) {
    const id = String(allocation.id);
    selected.set(id, allocation.set || "main");
    if (allocation.attrVariantId) {
      const option = TREE.nodes[id]?.o?.find(candidate =>
        String(candidate.id) === String(allocation.attrVariantId));
      if (option) pickedAttrs.set(id, option.n);
    }
    if (allocation.note || allocation.level != null) {
      allocMeta.set(id, {
        ...(allocation.note ? { notes: allocation.note } : {}),
        ...(allocation.level != null ? { level: allocation.level } : {}),
      });
    }
  }
  return { selected, pickedAttrs, allocMeta, capture: entry.capture, capIdx: idx };
}

// Apply a slider-derived state to the live render. Doesn't touch the
// persisted plan — replay is read-only by design; exiting restores
// the pre-replay snapshot.
export function applyReplayState(position: number): void {
  const s = stateAtRouteIndex(position);
  if (!s) return;
  state.selected       = s.selected;
  state.pickedAttrs    = s.pickedAttrs;
  state.allocationMeta = s.allocMeta;
  // Time-travel the whole HUD: when the scrub crosses into a different
  // capture, tell the skills/gear strips to render THAT capture's
  // loadout (snapshots carry skills + items, not just the tree).
  if (state.replayCapIdx !== s.capIdx) {
    state.replayCapIdx = s.capIdx;
    emitReplayScrub(s.capIdx);
  }
  state.popoutId       = null;
  state.pathSwapTarget = null;
  state.pathSwapIndex  = 0;
  state.selDirty       = true;
  const routeState = window.BuildwrightPlan?.native.route()[s.capIdx];
  if (lsLevelEl) {
    lsLevelEl.textContent = routeState?.characterLevel != null
      ? String(routeState.characterLevel)
      : String(s.capIdx + 1);
  }
  if (lsCapEl) {
    lsCapEl.textContent = routeState?.name ?? "State " + (s.capIdx + 1);
  }
  // Sync the asc panel to whichever asc the active capture has.
  if (s.capture.ascendancy && s.capture.ascendancy !== state.asc) {
    {
      const r = resolveAscName(s.capture.ascendancy);
      state.asc = r.panel;
      state.ascVariant = r.variant;
    }
    if (ascSel) ascSel.value = s.capture.ascendancy;
    applyAsc();
  } else if (!s.capture.ascendancy && state.asc) {
    state.asc = null;
    state.ascVariant = null;
    if (ascSel) ascSel.value = '';
    applyAsc();
  }
  // Slider fill — for the gradient ::-webkit-slider-runnable-track.
  if (!lsInput) return;
  const min = +lsInput.min, max = +lsInput.max;
  const pct = max > min ? ((position - min) / (max - min)) * 100 : 0;
  lsInput.style.setProperty('--ls-fill', pct + '%');
  // Level bubble riding the thumb (inset-corrected like the ticks so
  // it stays dead-centre over the thumb at both extremes).
  const bubble = document.getElementById('ls-thumb-label');
  if (bubble) {
    const THUMB_HALF = 10;
    const w = lsInput.offsetWidth || 1;
    const inset = (THUMB_HALF / w) * 100;
    const usable = Math.max(0, 1 - 2 * (THUMB_HALF / w));
    bubble.style.left = (inset + (max > min ? (position - min) / (max - min) : 0) * 100 * usable) + '%';
    bubble.textContent = (s.capIdx + 1) + " · " + (routeState?.name ?? "State");
    bubble.classList.remove('hidden');
  }
  updatePreview();
  requestRender();
  updateSelectionUI();
}

export function renderTicks(): void {
  if (!lsTicksEl || !_capCache || !lsInput) return;
  lsTicksEl.innerHTML = '';
  const min = +lsInput.min, max = +lsInput.max;
  if (max <= min) return;
  // HTML range inputs inset the thumb's center by half its width on
  // each side of the track. A naive pct = (L-min)/(max-min)*100
  // places ticks at the EDGE of the input box, not at the thumb's
  // actual position for that value — they're aligned only in the
  // exact middle. Correct for the inset so a tick at L sits dead-
  // centre under the thumb when the slider reads L. Matches the
  // thumb dimensions from #ls-input::-webkit-slider-thumb.
  const THUMB_HALF = 9;
  const trackW = lsInput.offsetWidth || 1;
  const insetPct = (THUMB_HALF / trackW) * 100;
  const usableFrac = Math.max(0, 1 - 2 * (THUMB_HALF / trackW));
  const pctOf = (L: number): number =>
    insetPct + ((L - min) / (max - min)) * 100 * usableFrac;

  const route = window.BuildwrightPlan?.native.route() ?? [];
  for (let index = 0; index < route.length; index++) {
    const routeState = route[index]!;
    const tick = document.createElement("div");
    tick.className = "ls-tick cap";
    tick.style.left = pctOf(index) + "%";
    tick.dataset.kind = "state";
    tick.dataset.level = String(index);
    tick.dataset.stateName = routeState.name;
    tick.dataset.statePhase = routeState.phase;
    tick.dataset.characterLevel = routeState.characterLevel != null
      ? String(routeState.characterLevel)
      : "";
    tick.title = routeState.name;
    lsTicksEl.appendChild(tick);
  }
  if (window.BuildwrightNotes?.size) {
    window.BuildwrightNotes = new Map();
    window.PoE2Notes = window.BuildwrightNotes;
    emitNotesUpdated();
  }
}

export function showTickTooltip(tickEl: HTMLElement | null): void {
  if (!lsTooltipEl || !tickEl || !lsEl) return;
  const level = tickEl.dataset.level;
  const kind = tickEl.dataset.kind;
  let html;
  if (kind === "state") {
    const characterLevel = tickEl.dataset.characterLevel
      ? " · Lv " + esc(tickEl.dataset.characterLevel)
      : "";
    html = '<div class="ls-tt-head">' + esc(tickEl.dataset.stateName) +
      characterLevel + '</div>' +
      '<div class="ls-tt-note">' + esc(tickEl.dataset.statePhase) + '</div>';
  } else if (kind === 'note' && tickEl.dataset.cluster) {
    // Cluster pill → a notes index: every note inside, with its
    // sequence number (color-coded passive/skill), reveal level,
    // anchor name, and the note text. Rows are ordered by reveal
    // level (the timeline's own axis), earliest at the top — the
    // order the author placed them, not DOM/insertion accidents.
    interface Ci { num: number; level: number; name: string; text: string; type: string }
    let items: Ci[] = [];
    try { items = JSON.parse(tickEl.dataset.cluster) as Ci[]; } catch { /* leave empty */ }
    items.sort((a, b) => a.level - b.level || a.num - b.num);
    html = '<div class="ls-tt-head">' + items.length + ' notes</div>' +
      items.map(it =>
        '<div class="ls-tt-row">' +
          '<span class="ls-tt-num ' + esc(it.type) + '">' + esc(String(it.num)) + '</span>' +
          '<span class="ls-tt-lvl">lvl ' + esc(String(it.level)) + '</span>' +
          '<span class="ls-tt-name">' + esc(it.name) + '</span>' +
          '<div class="ls-tt-note">' + esc(it.text.length > 130 ? it.text.slice(0, 127) + '…' : it.text) + '</div>' +
        '</div>').join('');
  } else if (kind === 'note') {
    // Solo note: a slim header (number · level · anchor) with the
    // message itself as the easiest thing to read.
    html = '<div class="ls-tt-head">№' + esc(tickEl.dataset.noteNum) +
      ' · lvl ' + esc(level) + ' · ' + esc(tickEl.dataset.nodeName) + '</div>' +
      '<div class="ls-tt-note">' + esc(tickEl.dataset.note) + '</div>';
  } else {
    html = '<div class="ls-tt-head">Snapshot boundary · Lv ' + esc(level) + '</div>';
  }
  lsTooltipEl.innerHTML = html;
  lsTooltipEl.classList.remove('hidden');
  const rect = tickEl.getBoundingClientRect();
  const parent = lsEl.getBoundingClientRect();
  lsTooltipEl.style.left = (rect.left - parent.left) + 'px';
  lsTooltipEl.style.top  = (rect.bottom - parent.top + 8) + 'px';
}
export function hideTickTooltip(): void {
  if (lsTooltipEl) lsTooltipEl.classList.add('hidden');
}

export function setModeToggle(mode: 'editing' | 'replay'): void {
  if (lsModeEditBtn) {
    const isEdit = mode === 'editing';
    lsModeEditBtn.classList.toggle('is-active', isEdit);
    lsModeEditBtn.setAttribute('aria-selected', String(isEdit));
  }
  if (lsModeReplayBtn) {
    const isReplay = mode === 'replay';
    lsModeReplayBtn.classList.toggle('is-active', isReplay);
    lsModeReplayBtn.setAttribute('aria-selected', String(isReplay));
  }
}

export function enterReplay() {
  if (state.replayActive) return;
  // Save the live state so we can restore it on exit.
  savedSelected    = new Map(state.selected);
  savedPickedAttrs = new Map(state.pickedAttrs);
  savedAllocMeta   = new Map(state.allocationMeta);
  state.replayActive = true;
  setModeToggle('replay');
}
export function exitReplay(opts?: { skipRestore?: boolean }): void {
  if (!state.replayActive) return;
  state.replayActive = false;
  state.replayCapIdx = -1;
  emitReplayScrub(-1);
  document.getElementById('ls-thumb-label')?.classList.add('hidden');
  if (opts && opts.skipRestore) {
    // Caller is about to swap the active capture (e.g. chip click).
    // Don't restore the saved pre-replay state — it belongs to the
    // OLD active capture and would clobber the new one. Just drop
    // the snapshot.
    savedSelected = savedPickedAttrs = savedAllocMeta = null;
  } else {
    state.selected       = savedSelected || new Map();
    state.pickedAttrs    = savedPickedAttrs || new Map();
    state.allocationMeta = savedAllocMeta || new Map();
    state.selDirty       = true;
    savedSelected = savedPickedAttrs = savedAllocMeta = null;
    // Commit the restored state to the active capture BEFORE
    // syncFromWizardStore re-hydrates state.selected from it
    // below. Without this, any edits the autosave RAF tick hadn't
    // yet flushed when the user entered replay (e.g., clicked a
    // node then immediately scrubbed) live ONLY in savedSelected,
    // and the sync would re-hydrate from a stale active.passives,
    // silently dropping them — visible to the user as a snapshot
    // that froze the wrong state.
    if (typeof flushPersistNow === 'function') flushPersistNow();
  }
  setModeToggle('editing');
  // Re-sync from the chrome's active capture so the asc panel etc.
  // come back to the editing state.
  if (typeof syncFromWizardStore === 'function') syncFromWizardStore();
}
// Exposed for the captures-bar (and any other surface) to call when
// a capture-context switch happens during replay. skipRestore is
// important because the saved snapshot is from a different capture
// and re-applying it would corrupt the new active one.
window.BuildwrightReplayExit = () => exitReplay({ skipRestore: true });
// Use this variant when the caller stays on the SAME active capture
// and wants the user's pre-replay editing state recovered (e.g.
// snapshot — author meant to freeze what they were editing, not the
// scrub view). The skipRestore variant drops savedSelected, which is
// the only source of truth for unflushed edits (the autosave RAF
// tick hasn't necessarily run between the last node click and the
// slider scrub). Without restore, those edits are silently lost.
window.BuildwrightReplayExitRestore = () => exitReplay();
// Read-only inspection for tests / external tooling. Returns the
// BFS-ordered mains list per capture and the slider's level-to-state
// resolution. Does not mutate live state.
window.BuildwrightReplayDebug = {
  capCache: () => (_capCache || []).map(e => ({
    levelRange: e.capture.levelRange,
    grants: e.grants,
    mains: e.mains.map(a => String(a.id)),
    ascs:  e.ascs.map(a => String(a.id)),
    sets:  e.sets.map(a => String(a.id)),
  })),
  stateAt: (L: number) => {
    const s = stateAtRouteIndex(L);
    return s ? { selected: [...s.selected.keys()], capIdx: s.capIdx } : null;
  },
  rebuild: () => rebuildCapCache(),
  state: () => ({
    replayActive: state.replayActive,
    replayCapIdx: state.replayCapIdx,
    selectedCount: state.selected.size,
    allocationMeta: [...state.allocationMeta.entries()].map(([id, m]) => ({ id, m })),
    pickedAttrs: [...state.pickedAttrs.entries()],
    klass: state.klass,
    asc: state.asc,
    activeSet: state.activeSet,
  }),
  flushNow: () => { if (typeof flushPersistNow === 'function') flushPersistNow(); },
};
window.PoE2SliderExit = window.BuildwrightReplayExit;
window.PoE2SliderExitRestore = window.BuildwrightReplayExitRestore;
window.PoE2SliderDebug = window.BuildwrightReplayDebug;

export function refreshSlider(): void {
  if (!lsEl || !window.BuildwrightPlan) return;
  rebuildCapCache();
  const captures = (_capCache || []).map(e => e.capture);
  // One keyframe has nothing to replay. Two or more states use a discrete
  // root-to-leaf route axis; character level is metadata, not ordering.
  if (captures.length <= 1) {
    lsEl.classList.add('hidden');
    if (state.replayActive) exitReplay();
    // Clear the published note map too so the tree-side overlay drops
    // any stale badges. Without this, "Clear all" (which empties
    // captures) would leave the badge layer holding references to the
    // previous build's noted nodes and the badges would linger.
    if (window.BuildwrightNotes && window.BuildwrightNotes.size) {
      window.BuildwrightNotes = new Map();
      window.PoE2Notes = window.BuildwrightNotes;
      emitNotesUpdated();
    }
    return;
  }
  lsEl.classList.remove('hidden');
  const max = captures.length - 1;
  if (lsInput) {
    lsInput.min = '0';
    lsInput.max = String(max);
    const active = window.BuildwrightPlan.captures.activeIndex();
    const cur = state.replayActive
      ? Math.min(Math.max(+lsInput.value || 0, 0), max)
      : Math.min(Math.max(active, 0), max);
    lsInput.value = String(cur);
  }
  if (lsMaxEl) lsMaxEl.textContent = String(max);
  renderTicks();
  // If we're already in replay, refresh the rendered state to match
  // the (possibly changed) captures.
  if (state.replayActive && lsInput) applyReplayState(+lsInput.value);
}

// Stop pointer events bubbling to the viewport's pan handler — the
// slider sits ON TOP of the canvas, and without this, dragging the
// thumb would also drag the tree. Block all the events that the
// viewport uses for pan / zoom.
if (lsEl) {
  const stop = (e: Event) => e.stopPropagation();
  for (const evt of ['mousedown', 'mousemove', 'mouseup', 'mouseleave',
                     'touchstart', 'touchmove', 'touchend',
                     'pointerdown', 'pointermove', 'pointerup',
                     'wheel', 'click', 'dblclick', 'contextmenu']) {
    lsEl.addEventListener(evt, stop);
  }
}

// Compute the deepest level the author has actually planned to. The
// slider's visual extent stays 1–100 (so empty headroom reads as
// "you haven't planned this far yet"), but the THUMB clamps here:
// there's nothing past it to view, so dragging into the headroom
// would just be a no-op that confuses the user. Uses _capCache so
// it's stable across replay mode (replay doesn't mutate captures).
export function computeAuthoredMax(): number {
  return Math.max(0, (_capCache?.length ?? 1) - 1);
}

// Wire interactions.
if (lsInput) {
  lsInput.addEventListener('input', () => {
    if (!state.replayActive) enterReplay();
    // Clamp to the authored max — let the user reach every level
    // they've planned, but no further. The thumb snaps back if they
    // drag into the headroom.
    const cap = computeAuthoredMax();
    if (+lsInput.value > cap) lsInput.value = String(cap);
    applyReplayState(+lsInput.value);
  });
}
// Wheel-scrub: hovering the slider lets the user scrub with the
// mouse wheel without needing to click + drag the thumb. Both axes
// map to slider direction (forward wheel / down / right = +1 level);
// step uses Math.sign so trackpad inertia doesn't fly past the build.
// preventDefault stops the OS from also page-scrolling.
if (lsEl && lsInput) {
  lsEl.addEventListener('wheel', (e) => {
    const delta = e.deltaX || e.deltaY;
    if (!delta) return;
    e.preventDefault();
    const step = delta > 0 ? 1 : -1;
    const cap = computeAuthoredMax();
    const cur = +lsInput.value || 0;
    const lo = +lsInput.min, hi = Math.min(+lsInput.max, cap);
    const next = Math.min(Math.max(cur + step, lo), hi);
    if (next === cur) return;
    lsInput.value = String(next);
    lsInput.dispatchEvent(new Event('input', { bubbles: true }));
  }, { passive: false });
}
// Mode toggle: clicking the inactive segment swaps modes. Active
// segment is a no-op (clean affordance — no "click did nothing" feel).
if (lsModeEditBtn) {
  lsModeEditBtn.addEventListener('click', () => {
    if (state.replayActive) exitReplay();
  });
}
if (lsModeReplayBtn) {
  lsModeReplayBtn.addEventListener('click', () => {
    if (!state.replayActive) enterReplay();
    if (lsInput) applyReplayState(+lsInput.value);
  });
}
if (lsTicksEl) {
  lsTicksEl.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement | null)?.closest<HTMLElement>('.ls-tick');
    if (!t || !lsInput) return;
    if (!state.replayActive) enterReplay();
    const cap = computeAuthoredMax();
    const L = Math.min(+(t.dataset.level ?? '0'), cap);
    lsInput.value = String(L);
    applyReplayState(L);
  });
  lsTicksEl.addEventListener('mouseover', (e) => {
    const t = (e.target as HTMLElement | null)?.closest<HTMLElement>('.ls-tick');
    if (t) showTickTooltip(t);
  });
  lsTicksEl.addEventListener('mouseout', (e) => {
    const t = (e.target as HTMLElement | null)?.closest<HTMLElement>('.ls-tick');
    if (t) hideTickTooltip();
  });
}

// Capture changes (snapshot, switchActive, remove) → refresh slider
// AND snap the slider position to the new active capture's upper
// bound (so the slider reflects "you're now editing this capture's
// final state" rather than dangling at a stale level from before).
window.addEventListener(PLANNER_EVENTS.stateChange, () => {
  refreshSlider();
  if (!lsInput || !window.BuildwrightPlan) return;
  if (state.replayActive) return;  // only snap when NOT in replay
  const active = window.BuildwrightPlan.captures.active();
  if (!active) return;
  const target = window.BuildwrightPlan.captures.activeIndex();
  lsInput.value = String(target);
  if (lsLevelEl) lsLevelEl.textContent = String(target);
  const min = +lsInput.min, max = +lsInput.max;
  const pct = max > min ? ((target - min) / (max - min)) * 100 : 0;
  lsInput.style.setProperty('--ls-fill', pct + '%');
});

// Initial render + per-frame keep-the-bounds-honest. Like the
// captures-bar tick, this is cheap (a string concat) and only
// redraws when the underlying capture set, count, OR any
// annotated note changes — the last is what makes note ticks
// show up live as the author types.
let _lastCapSig = '';
function captureSig() {
  if (!window.BuildwrightPlan) return '';
  return window.BuildwrightPlan.captures.list().map(c => {
    const noteSig = c.passives.filter(a => a.note).map(a => a.id + ':' + a.note).join(',');
    return [
      c.id,
      c.name ?? '',
      c.statePhase ?? '',
      c.characterLevel ?? '',
      c.levelRange.join('-'),
      c.passives.length,
    ].join(':') + '#' + noteSig;
  }).join('|');
}
(function tickSlider() {
  const sig = captureSig();
  if (sig !== _lastCapSig) {
    _lastCapSig = sig;
    refreshSlider();
  }
  requestAnimationFrame(tickSlider);
})();
requestAnimationFrame(refreshSlider);
// Re-render ticks on viewport resize so the thumb-inset correction
// tracks the new slider width. Debounced to one trailing frame so
// a drag-resize doesn't fire renderTicks per pixel.
let _resizeRaf = 0;
window.addEventListener('resize', () => {
  if (_resizeRaf) return;
  _resizeRaf = requestAnimationFrame(() => {
    _resizeRaf = 0;
    if (lsEl && !lsEl.classList.contains('hidden')) renderTicks();
  });
});
