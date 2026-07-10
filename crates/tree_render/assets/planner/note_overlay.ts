// ============================================================================
// === Tree-side overlays =====================================================
// ============================================================================
// Two HTML overlays anchored on top of the WebGL canvas:
//
//   1. Inline note editor — opens on `N` while hovering an allocated
//      node. A small floating card pinned next to the node with a
//      textarea (autosaves on every keystroke) and a trash icon
//      (deletes the note entirely). Esc / outside-click closes it;
//      work never lost because every keystroke goes through the same
//      persistToWizardStore path the sidebar input uses.
//
//   2. Help badge / cheat-sheet popover in the bottom-right.
//
// Earlier versions of this module also rendered numbered tree badges
// and a pulse halo for slider→tree linking. Both were removed at the
// user's request — the only differentiator for a noted node is now
// the tooltip's note section. The note map (window.PoE2Notes) still
// gets published by the slider so the tooltip can look up notes by
// node id without re-walking captures.


import { state } from "./state.ts";
import { ascOffsetX, ascOffsetY } from "./render.ts";
import { persistToWizardStore } from "./wizard_sync.ts";
import type { Plan } from "../../../../types/poe2.d.ts";

const noteOverlayEl = document.getElementById('note-overlay') as HTMLElement | null;

// -------------------------------------------------------------------
// Numbered tree badges — render a small gold pill with the note's
// number on top of every noted node. Number matches the slider tick
// so the user can cross-reference "note 3 on the slider" with the
// tree node it lives on at a glance. Tooltip integration on the
// node itself surfaces the note text (no hover affordance on the
// badge — pointer-events: none keeps it click-through so the node
// beneath stays fully interactive).
// -------------------------------------------------------------------
if (noteOverlayEl) {
  const badgeEls = new Map<string, HTMLElement>();
  function syncBadgeElements(): void {
    const notes: Map<string, { num: number }> =
      (window.PoE2Notes as Map<string, { num: number }>) || new Map();
    const seen = new Set<string>();
    for (const [sid, info] of notes) {
      seen.add(sid);
      let el = badgeEls.get(sid);
      if (!el) {
        el = document.createElement('div');
        el.className = 'note-badge';
        el.dataset.nodeId = sid;
        noteOverlayEl!.appendChild(el);  // guarded by the outer `if (noteOverlayEl)`
        badgeEls.set(sid, el);
      }
      if (el.textContent !== String(info.num)) el.textContent = String(info.num);
    }
    for (const [sid, el] of badgeEls) {
      if (!seen.has(sid)) { el.remove(); badgeEls.delete(sid); }
    }
  }
  function syncBadgePositions(): void {
    if (badgeEls.size === 0) return;
    const s = state.scale, tx = state.tx, ty = state.ty;
    for (const [sid, el] of badgeEls) {
      const n = TREE.nodes[sid];
      if (!n) { el.style.display = 'none'; continue; }
      if (n.a && n.a !== state.asc) { el.style.display = 'none'; continue; }
      // Timeline-aware: only show the badge when the node is allocated
      // RIGHT NOW (in the active capture, or at the slider's current
      // level during replay). The PoE2Notes map carries entries from
      // every capture; a respec'd node would otherwise keep a stale
      // badge on the tree even at levels/captures where it's gone.
      if (!state.selected.has(sid)) { el.style.display = 'none'; continue; }
      el.style.display = '';
      const ax = typeof ascOffsetX === 'function' ? ascOffsetX(n) : 0;
      const ay = typeof ascOffsetY === 'function' ? ascOffsetY(n) : 0;
      const sx = (n.x + ax) * s + tx;
      const sy = (n.y + ay) * s + ty;
      el.style.transform = 'translate3d(' + sx + 'px, ' + sy + 'px, 0) translate(-50%, -50%)';
    }
  }
  (function tickBadges(): void {
    syncBadgePositions();
    requestAnimationFrame(tickBadges);
  })();
  window.addEventListener('poe2-notes-updated', syncBadgeElements);
  syncBadgeElements();
}

// -------------------------------------------------------------------
// Inline note editor — N-key shortcut.
// -------------------------------------------------------------------
const notePop      = document.getElementById('note-popover')       as HTMLElement | null;
const notePopName  = document.getElementById('note-popover-name')  as HTMLElement | null;
const notePopText  = document.getElementById('note-popover-text')  as HTMLTextAreaElement | null;
const notePopTrash = document.getElementById('note-popover-trash') as HTMLElement | null;
let notePopNodeId: string | null = null;

function openNotePopover(nodeId: string): void {
  if (!notePop || !notePopText || !nodeId) return;
  if (!state.selected.has(nodeId)) return;
  const n = TREE.nodes[nodeId];
  if (!n) return;
  notePopNodeId = nodeId;
  if (notePopName) notePopName.textContent = n.n || '(unnamed node)';
  const meta = state.allocationMeta.get(nodeId) || {};
  notePopText.value = meta.notes || '';
  notePop.classList.remove('hidden');
  positionNotePopover();
  // Slight delay so the focus doesn't get clobbered by the same
  // keystroke that triggered it (the 'N' would otherwise land in
  // the textarea as the first character).
  requestAnimationFrame(() => { notePopText.focus(); notePopText.select(); });
}
function closeNotePopover(): void {
  if (!notePop) return;
  notePop.classList.add('hidden');
  notePopNodeId = null;
}
function positionNotePopover(): void {
  if (!notePop || !notePopNodeId || notePop.classList.contains('hidden')) return;
  const n = TREE.nodes[notePopNodeId];
  if (!n) return;
  if (n.a && n.a !== state.asc) { closeNotePopover(); return; }
  const ax = typeof ascOffsetX === 'function' ? ascOffsetX(n) : 0;
  const ay = typeof ascOffsetY === 'function' ? ascOffsetY(n) : 0;
  // Tree → screen via state.scale + state.tx/ty. Offset +40 px right
  // of the node centre so the popover doesn't sit on the artwork.
  const sx = (n.x + ax) * state.scale + state.tx + 40;
  const sy = (n.y + ay) * state.scale + state.ty - 60;
  notePop.style.transform = 'translate3d(' + sx + 'px, ' + sy + 'px, 0)';
}

if (notePopText) {
  // Autosave: every keystroke writes to state.allocationMeta and
  // fires persistToWizardStore — same flow the sidebar's note
  // textarea uses, so the chrome's commit + auto-propagate logic
  // catches changes regardless of which surface the user typed in.
  notePopText.addEventListener('input', () => {
    if (!notePopNodeId) return;
    if (state.replayActive) {
      if (window.PoE2Plan && window.PoE2Plan.flash) {
        window.PoE2Plan.flash('Exit replay mode to edit notes', true);
      }
      const prev = state.allocationMeta.get(notePopNodeId) || {};
      notePopText!.value = prev.notes || '';
      return;
    }
    const text = notePopText!.value || '';
    const prev = state.allocationMeta.get(notePopNodeId) || {};
    if (text.trim()) {
      state.allocationMeta.set(notePopNodeId, Object.assign({}, prev, { notes: text }));
    } else {
      const copy = Object.assign({}, prev);
      delete copy.notes;
      if (Object.keys(copy).length === 0) state.allocationMeta.delete(notePopNodeId);
      else state.allocationMeta.set(notePopNodeId, copy);
    }
    state.selDirty = true;
    if (typeof persistToWizardStore === 'function') persistToWizardStore();
  });
  // Esc closes from inside the textarea (the document-level listener
  // skips when focus is inside an input).
  notePopText.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeNotePopover(); }
  });
}
if (notePopTrash) {
  notePopTrash.addEventListener('click', () => {
    if (!notePopNodeId) return;
    // Local state: drop the note from allocationMeta.
    const prev = state.allocationMeta.get(notePopNodeId) || {};
    const copy = Object.assign({}, prev);
    delete copy.notes;
    if (Object.keys(copy).length === 0) state.allocationMeta.delete(notePopNodeId);
    else state.allocationMeta.set(notePopNodeId, copy);
    // Plan-wide: explicit sweep across every capture, since the
    // commit path no longer implicitly clears notes on other captures
    // (that was deleting data on re-allocation). The active capture
    // gets cleared too by the upcoming persistToWizardStore commit.
    if (window.PoE2Plan && typeof window.PoE2Plan.clearNoteEverywhere === 'function') {
      window.PoE2Plan.clearNoteEverywhere(notePopNodeId);
    }
    if (notePopText) notePopText.value = '';
    state.selDirty = true;
    if (typeof persistToWizardStore === 'function') persistToWizardStore();
    closeNotePopover();
  });
}

// Global keydown shortcuts. Both skip when focus is in any input
// (so typing the letter in a textarea works normally) and when
// modifier keys are held (so Ctrl+N / Cmd+S aren't hijacked).
//   N — opens the inline note editor for the currently hovered
//       allocated node
//   S — clicks the sidebar's "Snapshot here" button (if enabled),
//       which freezes current state as a new capture
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (e.key === 'n' || e.key === 'N') {
    if (!state.hoverId) return;
    e.preventDefault();
    const hovered = state.hoverId;
    // If the user scrubbed the slider into replay mode and pressed N
    // on a node visible at that scrub level, they want to annotate
    // the snapshot they're viewing — not the working capture they
    // happened to be editing before scrubbing. Exit replay AND
    // switch the active capture to the one covering the scrub level
    // so the note saves to the right snapshot. The Edit/View toggle
    // used to give an explicit way out of replay; with that gone,
    // this auto-switch is the only path to "annotate while viewing
    // an old snapshot via slider scrub."
    if (state.replayActive && window.PoE2SliderDebug && window.PoE2SliderExit) {
      const lsInput = document.getElementById('ls-input') as HTMLInputElement | null;
      const L = lsInput ? +lsInput.value : null;
      const s = L != null ? window.PoE2SliderDebug.stateAt(L) : null;
      window.PoE2SliderExit();  // skipRestore — we're about to setActive
      if (s && window.PoE2Plan && window.PoE2Plan.captures) {
        window.PoE2Plan.captures.setActive(s.capIdx);
      }
      // capture-change re-hydrates state.selected next frame; wait
      // for that before opening the popover so the allocated-check
      // sees the new active's passives.
      requestAnimationFrame(() => {
        if (state.selected.has(hovered)) {
          openNotePopover(hovered);
        } else if (window.PoE2Plan && window.PoE2Plan.flash) {
          window.PoE2Plan.flash('Allocate the node first to attach a note', true);
        }
      });
      return;
    }
    if (!state.selected.has(hovered)) {
      if (window.PoE2Plan && window.PoE2Plan.flash) {
        window.PoE2Plan.flash('Allocate the node first to attach a note', true);
      }
      return;
    }
    openNotePopover(hovered);
  } else if (e.key === 's' || e.key === 'S') {
    const btn = document.getElementById('cap-snapshot') as HTMLButtonElement | null;
    if (!btn || btn.disabled) return;
    e.preventDefault();
    btn.click();
  }
});

// Esc / outside-click closes the popover. The trash inside the
// popover already handles its own click; the textarea swallows
// pointer events so clicking IT shouldn't close.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && notePop && !notePop.classList.contains('hidden')) {
    closeNotePopover();
  }
});
document.addEventListener('mousedown', (e) => {
  if (!notePop || notePop.classList.contains('hidden')) return;
  if (e.target instanceof Node && notePop.contains(e.target)) return;
  closeNotePopover();
});

// Per-frame position sync so the popover follows pan/zoom while open.
(function tick() {
  positionNotePopover();
  requestAnimationFrame(tick);
})();

// (Sidebar collapse/hover-peek moved to sidebar_collapse.ts —
// it was only here for evaluation-order reasons.)

// -------------------------------------------------------------------
// Help badge — bottom-right cheat-sheet popover.
// -------------------------------------------------------------------
{
  const helpBtn = document.getElementById('help-badge');
  const helpPop = document.getElementById('help-popover');
  const helpClose = document.getElementById('help-popover-close');
  if (helpBtn && helpPop) {
    const close = () => helpPop.classList.add('hidden');
    helpBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      helpPop.classList.toggle('hidden');
    });
    if (helpClose) helpClose.addEventListener('click', close);
    document.addEventListener('click', (e) => {
      if (helpPop.classList.contains('hidden')) return;
      if (e.target instanceof Node && (helpPop.contains(e.target) || helpBtn.contains(e.target))) return;
      close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !helpPop.classList.contains('hidden')) close();
    });
  }
}
