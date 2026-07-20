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
import { currentCharacterLevel } from "./captures_bar.ts";
import type { Capture, Skill } from "../../../../types/shared.d.ts";

const lsEl       = document.getElementById('level-slider') as HTMLElement | null;
const lsInput    = document.getElementById('ls-input')     as HTMLInputElement | null;
const lsLevelEl  = document.getElementById('ls-level')     as HTMLElement | null;
const lsMaxEl    = document.getElementById('ls-max')       as HTMLElement | null;
const lsCapEl    = document.getElementById('ls-cap-name')  as HTMLElement | null;
const lsTicksEl  = document.getElementById('ls-ticks')     as HTMLElement | null;
const capChipListEl = document.getElementById('cap-chip-list') as HTMLElement | null;
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
  if (!window.PoE2Plan) { _capCache = null; return null; }
  const captures = window.PoE2Plan.captures.list();
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

// Apply a slider-derived state to the live render. Doesn't touch the
// persisted plan — replay is read-only by design; exiting restores
// the pre-replay snapshot.
export function applyReplayState(L: number): void {
  const s = stateAtLevel(L);
  if (!s) return;
  state.selected       = s.selected;
  state.pickedAttrs    = s.pickedAttrs;
  state.allocationMeta = s.allocMeta;
  // Time-travel the whole HUD: when the scrub crosses into a different
  // capture, tell the skills/gear strips to render THAT capture's
  // loadout (snapshots carry skills + items, not just the tree).
  if (state.replayCapIdx !== s.capIdx) {
    state.replayCapIdx = s.capIdx;
    window.dispatchEvent(new CustomEvent('poe2-replay-scrub', { detail: { capIdx: s.capIdx } }));
  }
  state.popoutId       = null;
  state.pathSwapTarget = null;
  state.pathSwapIndex  = 0;
  state.selDirty       = true;
  if (lsLevelEl) lsLevelEl.textContent = String(L);
  if (lsCapEl) {
    const c = s.capture;
    const rng = c.levelRange[0] === c.levelRange[1]
      ? String(c.levelRange[0])
      : c.levelRange[0] + '–' + c.levelRange[1];
    lsCapEl.textContent = 'capture ' + (s.capIdx + 1) + ' · ' + rng;
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
  const pct = max > min ? ((L - min) / (max - min)) * 100 : 0;
  lsInput.style.setProperty('--ls-fill', pct + '%');
  // Level bubble riding the thumb (inset-corrected like the ticks so
  // it stays dead-centre over the thumb at both extremes).
  const bubble = document.getElementById('ls-thumb-label');
  if (bubble) {
    const THUMB_HALF = 10;
    const w = lsInput.offsetWidth || 1;
    const inset = (THUMB_HALF / w) * 100;
    const usable = Math.max(0, 1 - 2 * (THUMB_HALF / w));
    bubble.style.left = (inset + (max > min ? (L - min) / (max - min) : 0) * 100 * usable) + '%';
    bubble.textContent = String(L);
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

  // Snapshot transitions: one mark per snapshot, anchored at the
  // FROZEN capture's hi level — the same level the note ticks land
  // on when a note is attached to an end-of-capture node.
  for (let i = 0; i < _capCache.length - 1; i++) {
    const L = _capCache[i]!.capture.levelRange[1];
    if (L === min || L === max) continue;
    const t = document.createElement('div');
    t.className = 'ls-tick cap';
    t.style.left = pctOf(L) + '%';
    t.dataset.kind = 'cap';
    t.dataset.level = String(L);
    lsTicksEl.appendChild(t);
  }

  // Capture chip rail — one chip per FROZEN snapshot. The working
  // (last) capture is the user's current draft and intentionally
  // gets no chip: it's always implicitly active the moment they
  // change anything, and labelling it "current" was visual clutter
  // that read as a fifth snapshot. Click switches the active
  // capture; the active chip gets the gold border accent.
  if (capChipListEl) {
    capChipListEl.innerHTML = '';
    const activeIdx = window.PoE2Plan ? window.PoE2Plan.captures.activeIndex() : -1;
    const lastIdx   = _capCache.length - 1;
    for (let i = 0; i < lastIdx; i++) {
      const cap = _capCache[i]!.capture;
      const lo = cap.levelRange[0];
      const hi = cap.levelRange[1];
      const chip = document.createElement('li');
      chip.className = 'cap-chip' + (i === activeIdx ? ' active' : '');
      chip.dataset.capIdx = String(i);
      const label = document.createElement('span');
      label.className = 'cap-chip-label';
      label.textContent = (lo === hi ? String(lo) : (lo + '–' + hi));
      chip.appendChild(label);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'cap-chip-del';
      del.textContent = '×';
      del.dataset.capIdx = String(i);
      del.title = 'Delete this snapshot — its level range merges into the previous snapshot';
      del.setAttribute('aria-label', 'Delete snapshot ' + (lo + '–' + hi));
      chip.appendChild(del);
      chip.title = 'Snapshot · click to switch to this capture for editing';
      capChipListEl.appendChild(chip);
    }
    // "Current" chip for the WORKING capture (always last). Without
    // it the user has no UI to navigate BACK to the working cap
    // after clicking a frozen chip — they were stuck silently
    // editing a frozen snapshot. The chip stays visible alongside
    // the frozen ones so the navigation is symmetric.
    if (lastIdx >= 0) {
      const workingChip = document.createElement('li');
      workingChip.className = 'cap-chip cap-chip-current' +
        (lastIdx === activeIdx ? ' active' : '');
      workingChip.dataset.capIdx = String(lastIdx);
      const label = document.createElement('span');
      label.className = 'cap-chip-label';
      label.textContent = 'current';
      workingChip.appendChild(label);
      workingChip.title = 'Current (working) snapshot · live editing lands here';
      capChipListEl.appendChild(workingChip);
    }
  }

  // Note ticks (numbered gold pills). Each annotated allocation
  // becomes a milestone. We collect them across all captures first
  // so we can number them sequentially by level — author-meaningful
  // order ("Note 3 fires at lvl 48 — take Unseen Path here").
  //
  // De-duplication: snapshot creation copies the active capture's
  // passives (notes included) into the new capture, so a note added
  // once will appear in EVERY capture that inherits the node. We
  // collapse those instances to a single tick at the EARLIEST level
  // the note applies — otherwise authoring one note materialises 2-5
  // ticks on the slider, each numbered sequentially, which reads as
  // "you wrote 5 notes" instead of "you wrote 1." Dedup key is
  // (id, note text) so genuinely different notes on the same node
  // (rare but possible across respec) still each get a tick.
  // Anchor each note at the LEVEL THE NODE IS REVEALED AT — the
  // same level the slider's stateAtLevel exposes it. For main
  // passives, this is the node's BFS index in its capture's mains
  // list (j-th main is revealed at lvl j + 2 - grants — matches
  // the slider's `targetMainCount = L - 1 + grants` formula). For
  // asc + weapon-set entries, the explicit `level` stamp from
  // allocation time is the authoritative reveal level.
  //
  // Earlier this anchored to the capture's END level so every note
  // in a capture clumped at the snapshot boundary. That hid the
  // ordering author meant when scrubbing — "this hint applies at
  // lvl 14" became "this hint applies at the lvl-30 snapshot
  // boundary." The per-node reveal level matches author intent and
  // mirrors what the slider itself shows when the player scrubs to
  // that level.
  interface NoteEntry {
    L: number;
    a: { id: string | number; note?: string; level?: number };
    capIdx: number;
    noteType: 'passive' | 'skill';
  }
  const noteByKey = new Map<string, NoteEntry>();
  for (let i = 0; i < _capCache.length; i++) {
    const entry = _capCache[i];
    if (!entry) continue;
    const c = entry.capture;
    for (let j = 0; j < entry.mains.length; j++) {
      const a = entry.mains[j];
      if (!a || !a.note) continue;
      // BFS index j → reveal level. Clamp to the capture's range
      // so the note never anchors below the capture's lo (matters
      // for captures that inherit prefix passives) or above max.
      let L = j + 2 - entry.grants;
      L = Math.max(c.levelRange[0], L);
      L = Math.min(max, L);
      const key = 'p|' + String(a.id) + '|' + a.note;
      const prev = noteByKey.get(key);
      if (!prev || L < prev.L) noteByKey.set(key, { L, a, capIdx: i, noteType: 'passive' });
    }
    for (const a of [...entry.ascs, ...entry.sets]) {
      if (!a.note) continue;
      const L = typeof a.level === 'number' ? a.level : c.levelRange[0];
      if (L > max) continue;
      const key = 'p|' + String(a.id) + '|' + a.note;
      const prev = noteByKey.get(key);
      if (!prev || L < prev.L) noteByKey.set(key, { L, a, capIdx: i, noteType: 'passive' });
    }
    // Skill + support notes: anchor at the cap's lo (when this
    // skill first becomes "active" in this snapshot's timeline).
    // Iterates the original capture.skills (skills don't get a BFS
    // pre-processing pass like passives — they're just a list).
    // Dedup key prefixed with 's|' so a passive and a skill that
    // happen to share an id don't collide.
    for (const sk of (c.skills || [])) {
      if (!sk || !sk.id) continue;
      const L = Math.max(c.levelRange[0], 1);
      if (L > max) continue;
      if (sk.note) {
        const key = 's|' + String(sk.id) + '|' + sk.note;
        const prev = noteByKey.get(key);
        if (!prev || L < prev.L) noteByKey.set(key, { L, a: sk, capIdx: i, noteType: 'skill' });
      }
      for (const sup of (sk.supports || [])) {
        if (sup && sup.note) {
          const key = 's|sup|' + String(sup.id) + '|' + sup.note;
          const prev = noteByKey.get(key);
          if (!prev || L < prev.L) noteByKey.set(key, { L, a: sup, capIdx: i, noteType: 'skill' });
        }
      }
    }
  }
  const notes = [...noteByKey.values()];
  // Stable sort: primary by level, secondary by capture index so
  // notes at the same level emit in author order.
  notes.sort((x, y) => x.L - y.L || x.capIdx - y.capIdx);
  // Publish a public map keyed by node id so the tree-side overlay
  // (numbered badges, pulse highlight on tick hover, tooltip note
  // section) can look up "does node X have a note? what number?"
  // without re-walking captures. Same dedup + level + numbering as
  // the slider so the badge number always matches the tick number.
  const notesByNode = new Map<string, { num: number; level: number; text: string }>();
  for (let n = 0; n < notes.length; n++) {
    const entry = notes[n];
    if (!entry) continue;
    const { L, a } = entry;
    const sid = String(a.id);
    const prev = notesByNode.get(sid);
    if (!prev || L < prev.level) {
      notesByNode.set(sid, { num: n + 1, level: L, text: a.note ?? '' });
    }
  }
  window.PoE2Notes = notesByNode;
  window.dispatchEvent(new CustomEvent('poe2-notes-updated'));

  // Capture-span shading: alternate faint gold zones on the track
  // backdrop, one per capture, so the snapshot structure reads at a
  // glance (the blue boundary lines mark the exact transition levels).
  const segEl = document.getElementById('ls-segments');
  if (segEl) {
    segEl.innerHTML = '';
    for (let i = 0; i < _capCache.length; i++) {
      const c = _capCache[i]!.capture;
      const lo = Math.max(min, c.levelRange[0]);
      const hi = Math.min(max, c.levelRange[1]);
      if (hi <= lo) continue;
      const d = document.createElement('div');
      d.className = 'ls-seg' + (i % 2 ? ' odd' : '');
      const a = pctOf(lo), b = pctOf(hi);
      d.style.left = a + '%';
      d.style.width = Math.max(0, b - a) + '%';
      segEl.appendChild(d);
    }
  }

  // Name resolver for a note's anchor (passive node vs gem).
  const nameOf = (e: NoteEntry): string => {
    if (e.noteType === 'skill') {
      const cat = window.POE2_GEMS_BY_ID as Map<string, { name?: string }> | undefined;
      const g = cat && cat.get ? cat.get(String(e.a.id)) : null;
      return (g && g.name) || String(e.a.id);
    }
    const node = TREE.nodes[String(e.a.id)];
    return (node && node.n) || String(e.a.id);
  };

  // Agent-authored builds carry MANY notes; vertical stacking towers
  // read as clutter. Instead, notes near each other collapse into a
  // single CLUSTER pill showing the count — hover lists every note
  // inside (number, level, anchor, text) ordered by reveal level,
  // click scrubs to the cluster's first level. Solo notes keep their
  // sequence-number pill. Gold = passive, purple = skill, split =
  // mixed cluster.
  //
  // Clustering is GAP-chained: a note joins the cluster when it is
  // within CLUSTER_PX of the cluster's LAST member. The previous
  // first-member anchor let a train of pills — each ~26 px from its
  // neighbor, visually touching — render as separate overlapping
  // solos (the exact clutter a dense 5-snapshot agent build showed).
  const trackWpx = lsInput.getBoundingClientRect().width || lsInput.offsetWidth || 600;
  const pxOf = (L: number): number => (pctOf(L) / 100) * trackWpx;
  const CLUSTER_PX = 28; // pill is 18 px wide; neighbors closer than this read as one blob
  interface ClusterItem { num: number; e: NoteEntry }
  const clusters: ClusterItem[][] = [];
  for (let n = 0; n < notes.length; n++) {
    const e = notes[n];
    if (!e) continue;
    const cur = clusters[clusters.length - 1];
    if (cur && pxOf(e.L) - pxOf(cur[cur.length - 1]!.e.L) < CLUSTER_PX) cur.push({ num: n + 1, e });
    else clusters.push([{ num: n + 1, e }]);
  }
  for (const cl of clusters) {
    const first = cl[0]!;
    const last = cl[cl.length - 1]!;
    const multi = cl.length > 1;
    const types = new Set(cl.map(x => x.e.noteType || 'passive'));
    const t = document.createElement('div');
    t.className = 'ls-tick note' + (multi ? ' cluster' : '');
    // A cluster pill sits at the visual midpoint of its span; the
    // click-scrub level stays at the FIRST member so scrubbing lands
    // where the earliest note reveals.
    t.style.left = ((pctOf(first.e.L) + pctOf(last.e.L)) / 2) + '%';
    t.dataset.kind = 'note';
    t.dataset.noteType = types.size > 1 ? 'mixed' : (first.e.noteType || 'passive');
    t.dataset.level = String(first.e.L);
    if (multi) {
      t.dataset.cluster = JSON.stringify(cl.map(x => ({
        num: x.num,
        level: x.e.L,
        name: nameOf(x.e),
        text: x.e.a.note ?? '',
        type: x.e.noteType || 'passive',
      })));
      t.textContent = String(cl.length);
    } else {
      t.dataset.note = first.e.a.note;
      t.dataset.noteNum = String(first.num);
      t.dataset.nodeId = String(first.e.a.id);
      t.dataset.nodeName = nameOf(first.e);
      t.textContent = String(first.num);
    }
    lsTicksEl.appendChild(t);
  }
}

export function showTickTooltip(tickEl: HTMLElement | null): void {
  if (!lsTooltipEl || !tickEl || !lsEl) return;
  const level = tickEl.dataset.level;
  const kind = tickEl.dataset.kind;
  let html;
  if (kind === 'note' && tickEl.dataset.cluster) {
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
  window.dispatchEvent(new CustomEvent('poe2-replay-scrub', { detail: { capIdx: -1 } }));
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
window.PoE2SliderExit = () => exitReplay({ skipRestore: true });
// Use this variant when the caller stays on the SAME active capture
// and wants the user's pre-replay editing state recovered (e.g.
// snapshot — author meant to freeze what they were editing, not the
// scrub view). The skipRestore variant drops savedSelected, which is
// the only source of truth for unflushed edits (the autosave RAF
// tick hasn't necessarily run between the last node click and the
// slider scrub). Without restore, those edits are silently lost.
window.PoE2SliderExitRestore = () => exitReplay();
// Read-only inspection for tests / external tooling. Returns the
// BFS-ordered mains list per capture and the slider's level-to-state
// resolution. Does not mutate live state.
window.PoE2SliderDebug = {
  capCache: () => (_capCache || []).map(e => ({
    levelRange: e.capture.levelRange,
    grants: e.grants,
    mains: e.mains.map(a => String(a.id)),
    ascs:  e.ascs.map(a => String(a.id)),
    sets:  e.sets.map(a => String(a.id)),
  })),
  stateAt: (L: number) => {
    const s = stateAtLevel(L);
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

export function refreshSlider(): void {
  if (!lsEl || !window.PoE2Plan) return;
  rebuildCapCache();
  const captures = (_capCache || []).map(e => e.capture);
  // Hide the slider entirely until the author has taken at least one
  // explicit snapshot (per the captures-bar convention, captures.length
  // <= 1 means "no snapshots yet" and replay would be pointless).
  if (captures.length <= 1) {
    lsEl.classList.add('hidden');
    if (state.replayActive) exitReplay();
    // Clear the published note map too so the tree-side overlay drops
    // any stale badges. Without this, "Clear all" (which empties
    // captures) would leave the badge layer holding references to the
    // previous build's noted nodes and the badges would linger.
    if (window.PoE2Notes && window.PoE2Notes.size) {
      window.PoE2Notes = new Map();
      window.dispatchEvent(new CustomEvent('poe2-notes-updated'));
    }
    return;
  }
  lsEl.classList.remove('hidden');
  // Slider extent is always 1–100 — the unallocated portion of the
  // bar is meaningful ("you haven't planned this far yet"). Earlier
  // I tried clipping to the furthest authored level on the theory
  // it was more "truthful," but it hid the planning room and made
  // a single snapshot at lvl 16 fill the whole bar (misleading in
  // the other direction). 1–100 wins both visually + semantically.
  const max = 100;
  if (lsInput) {
    lsInput.min = '1';
    lsInput.max = String(max);
    const cur = Math.min(Math.max(+lsInput.value || 1, 1), max);
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
  if (!_capCache || _capCache.length === 0) return 1;
  let m = 1;
  for (let i = 0; i < _capCache.length; i++) {
    const e = _capCache[i];
    if (!e) continue;
    const isLast = (i === _capCache.length - 1);
    const L = isLast
      ? Math.max(1, e.mains.length - e.grants + 1)
      : e.capture.levelRange[1];
    if (L > m) m = L;
  }
  return m;
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
    const cur = +lsInput.value || 1;
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
    const L = Math.min(+(t.dataset.level ?? '1'), cap);
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
window.addEventListener('poe2-capture-change', () => {
  refreshSlider();
  if (!lsInput || !window.PoE2Plan) return;
  if (state.replayActive) return;  // only snap when NOT in replay
  const active = window.PoE2Plan.captures.active();
  if (!active) return;
  // Snap target: for the WORKING (last) capture, use the live derived
  // character level — its range[1] defaults to 100, which would dump
  // the slider thumb at the right edge even when the player is at
  // Lv 13. For earlier snapshots, range[1] IS the authored snapshot
  // level so we trust it.
  const list = window.PoE2Plan.captures.list();
  const isLast = window.PoE2Plan.captures.activeIndex() === list.length - 1;
  const target = (isLast && typeof currentCharacterLevel === 'function')
    ? currentCharacterLevel()
    : active.levelRange[1];
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
  if (!window.PoE2Plan) return '';
  return window.PoE2Plan.captures.list().map(c => {
    const noteSig = c.passives.filter(a => a.note).map(a => a.id + ':' + a.note).join(',');
    return c.id + ':' + c.levelRange.join('-') + ':' + c.passives.length + '#' + noteSig;
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

// Click a capture chip → switch the active capture. Mirrors the
// captures-bar chip handler (captures_bar.js): exit replay first,
// flush pending edits into the OLD active, then setActive.
// Delete (×) button intercepts before the chip's click → confirm →
// captures.remove(idx). normalizeCapturesRanges in the chrome
// absorbs the removed range into the previous cap automatically.
if (capChipListEl) {
  // Stop mousedown/mouseup from reaching #viewport's pan handler.
  // The chip rail sits inside .hud-row (not inside #level-slider),
  // so the slider's stopPropagation doesn't cover it — without this
  // the viewport panning detector would set panning=true on chip
  // mousedown, then window.mouseup → handleClick fires on the chip
  // click coords. Then handleClick's auto-switch-to-working would
  // overwrite the chip's setActive(idx) call. handleClick itself
  // also bails on no-node-hovered clicks, but blocking propagation
  // here is the cleaner contract: "chip rail interactions don't
  // bleed to the canvas." Defense in depth.
  const stop = (e: Event) => e.stopPropagation();
  for (const evt of ['mousedown', 'mouseup', 'click']) {
    capChipListEl.addEventListener(evt, stop);
  }
  capChipListEl.addEventListener('click', (e) => {
    // Delete button — handled before the parent chip click so the
    // chip's setActive doesn't also fire.
    const target = e.target as HTMLElement | null;
    const delBtn = target?.closest<HTMLElement>('.cap-chip-del');
    if (delBtn && window.PoE2Plan) {
      e.stopPropagation();
      const idx = parseInt(delBtn.dataset.capIdx ?? '', 10);
      if (!Number.isFinite(idx)) return;
      const cap = window.PoE2Plan.captures.list()[idx];
      if (!cap) return;
      const rng = cap.levelRange[0] + '–' + cap.levelRange[1];
      const prev = idx > 0 ? window.PoE2Plan.captures.list()[idx - 1] : null;
      const mergeMsg = prev
        ? '\n\nIts level range (' + rng + ') will merge into the previous snapshot ' +
          '(' + prev.levelRange[0] + '–' + prev.levelRange[1] + ' → ' +
          prev.levelRange[0] + '–' + cap.levelRange[1] + '). ' +
          'The previous snapshot keeps its own passives/skills/items.'
        : '\n\nThe next snapshot will absorb the lvl 1 start.';
      if (!confirm('Delete snapshot ' + rng + '?' + mergeMsg)) return;
      if (state.replayActive && typeof window.PoE2SliderExit === 'function') {
        window.PoE2SliderExit();
      }
      window.PoE2Plan.captures.remove(idx);
      return;
    }
    const chip = target?.closest<HTMLElement>('.cap-chip');
    if (!chip || !window.PoE2Plan) return;
    const idx = parseInt(chip.dataset.capIdx ?? '', 10);
    if (!Number.isFinite(idx)) return;
    const cur = window.PoE2Plan.captures.activeIndex();
    if (idx === cur) return;
    if (state.replayActive && typeof window.PoE2SliderExit === 'function') {
      window.PoE2SliderExit();
    }
    if (typeof flushPersistNow === 'function') flushPersistNow();
    window.PoE2Plan.captures.setActive(idx);
  });
}
