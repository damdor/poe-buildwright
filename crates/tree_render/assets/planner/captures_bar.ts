// ============================================================================
// === Captures bar (chip rail + snapshot button) ===========================
// ============================================================================
// Top-of-sidebar UI for creating / switching / deleting captures. The
// data model lives in wizard_chrome.ts (window.PoE2Plan.captures);
// this module is the planner-page surface that exposes it.
//
// Authoring flow:
//   * Build the tree in the active capture.
//   * Click "+ Snapshot here" → prompted for a level (defaults to the
//     level you'd be at given your current point count). Active
//     capture's upper bound snaps to that level; a new capture is
//     appended with a COPY of the current passives/skills/items so
//     the author keeps building from where they are.
//   * Click an older chip → tree state hydrates from that capture's
//     contents; edits write back into that capture.
//   * Click ✕ on a chip → that capture is removed; its level range
//     merges into the previous capture (or the next, if it was first).
//
// Tree state and chip rail both re-render on 'poe2-capture-change'.


import { countSelected, state } from "./state.ts";
import { flushPersistNow, syncFromWizardStore } from "./wizard_sync.ts";

const capListEl      = document.getElementById('cap-list')      as HTMLElement | null;
const capCountEl     = document.getElementById('cap-count')     as HTMLElement | null;
const capSnapshotBtn = document.getElementById('cap-snapshot')  as HTMLButtonElement | null;
const capLevelEl     = document.getElementById('cap-level')     as HTMLElement | null;

// Character level from the build's current spend, matching PoE2's
// rules (and PoB's calc): each character level grants 1 main passive
// from L2 onward, and some asc nodes (Path of Sorceress, Oracle's +1
// Passive Point, etc.) grant additional main points outside that
// curve. So:
//
//   level = (main_tree_allocations - extra_main_from_asc_grants) + 1
//
// Asc allocations themselves are NOT in the level pool — they come
// from an 8-point asc budget unlocked at trial completion.
// countSelected already does this partitioning correctly (main
// excludes asc nodes, mainPointGrant sums the grants), so we just
// consume the totals.
export function currentCharacterLevel(): number {
  const c = countSelected();
  return Math.max(1, c.main - c.mainPointGrant + 1);
}

export function renderCaptureBar(): void {
  if (!capListEl || !window.PoE2Plan) return;
  const list = window.PoE2Plan.captures.list();
  const activeIdx = window.PoE2Plan.captures.activeIndex();
  const snapshotCount = Math.max(0, list.length - 1);
  if (capCountEl) capCountEl.textContent = String(snapshotCount);
  const pluralEl = document.getElementById('cap-count-plural');
  if (pluralEl) pluralEl.textContent = snapshotCount === 1 ? '' : 's';

  // Live character level — main-tree allocations minus asc grants,
  // plus 1. Surface it prominently so the author always knows where
  // they are; the snapshot button doesn't need to repeat it.
  const lvl = currentCharacterLevel();
  if (capLevelEl) capLevelEl.textContent = String(lvl);

  if (capSnapshotBtn) {
    const active = window.PoE2Plan.captures.active();
    const onWorkingCap = window.PoE2Plan.captures.isWorking();
    let snapLvl = lvl;
    if (state.replayActive) {
      const lsInput = document.getElementById('ls-input') as HTMLInputElement | null;
      if (lsInput) snapLvl = Math.max(1, +lsInput.value | 0);
    }
    // Three gates (in order — first failure wins the tooltip):
    //   1. Must be editing the WORKING cap. Snapping from a frozen
    //      chip historically caused the [21-100]/[21-100] duplicate
    //      bug because snapshotAt always pushes the new cap at the
    //      END of the captures array. With the API now refusing,
    //      this disables the button too so the user sees WHY.
    //   2. Snap level must be above the active cap's lo (something
    //      new to capture).
    //   3. Snap level must be < 100 (need room for the next cap).
    let canSnapshot = false;
    let title = '';
    if (!active) {
      title = 'No active capture.';
    } else if (!onWorkingCap) {
      title = 'Switch to the current (working) snapshot to take a new one — click the "current" chip on the slider.';
    } else if (snapLvl >= 100) {
      title = 'Snap level must be 99 or lower.';
    } else if (snapLvl <= active.levelRange[0]) {
      title = 'Allocate at least one passive first before snapshotting.';
    } else {
      canSnapshot = true;
      title = 'Freeze the current tree as a snapshot at level ' + snapLvl + '.';
    }
    capSnapshotBtn.disabled = !canSnapshot;
    capSnapshotBtn.title = title;
  }

  capListEl.innerHTML = '';
  if (list.length <= 1) {
    const hint = document.createElement('li');
    hint.className = 'cap-empty';
    hint.textContent = 'No snapshots yet. Build the tree, then click snapshot to mark a leveling stage.';
    capListEl.appendChild(hint);
    return;
  }
  // The LAST capture is the "current draft" — what new edits land in
  // by default. The earlier captures are the frozen snapshots the
  // author committed via the snapshot button. We render them all so
  // the author can jump back to any one, but the current draft is
  // visually distinct (no level-range label, "current" instead).
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (!c) continue;
    const isCurrent = (i === list.length - 1);
    const li = document.createElement('li');
    li.className = 'cap-chip' +
      (i === activeIdx ? ' active' : '') +
      (isCurrent ? ' current' : '');
    li.dataset.idx = String(i);
    const lo = c.levelRange[0], hi = c.levelRange[1];
    const range = (lo === hi) ? String(lo) : (lo + '–' + hi);
    // Frozen snapshots get a delete button; the current draft can't
    // be deleted (removing it would leave nothing to keep editing).
    const delBtn = !isCurrent
      ? '<button class="cap-chip-del" data-idx="' + i +
        '" title="Delete this snapshot (range merges into neighbor)">✕</button>'
      : '';
    const label = isCurrent
      ? '<span class="cap-chip-label">current</span>'
      : '<span class="cap-chip-num">' + (i + 1) + '</span>' +
        '<span class="cap-chip-range">' + range + '</span>';
    li.innerHTML = label + delBtn;
    capListEl.appendChild(li);
  }
}

export function snapshotHere(): void {
  if (!window.PoE2Plan) return;
  const active = window.PoE2Plan.captures.active();
  if (!active) return;
  // TRANSACTIONAL: snapshot exit-replay + flush BOTH mutate
  // active.passives. If the level check then refuses, roll back so a
  // failed snapshot is observationally a no-op.
  const backupPassives = JSON.parse(JSON.stringify(active.passives));
  const backupRange: [number, number] = [active.levelRange[0], active.levelRange[1]];
  const backupAsc = active.ascendancy;
  const rollback = (): void => {
    active.passives    = backupPassives;
    active.levelRange  = backupRange;
    active.ascendancy  = backupAsc;
    if (typeof syncFromWizardStore === 'function') syncFromWizardStore();
  };

  // SNAP LEVEL = the level the SNAPSHOT MARKER lands at on the
  // slider. The user's mental model is "freeze at what I'm looking at
  // right now," which means:
  //
  //   - NOT in replay: the live character level (state.selected
  //     reflects the real edit state, currentCharacterLevel() works).
  //   - IN replay: the SLIDER's scrub position (what HUD displays,
  //     what the visible tree shows). If we used currentCharacterLevel
  //     here we'd silently use the pre-replay state's level instead
  //     (after exitReplay-restore inflates state.selected back to
  //     savedSelected), and the snap would freeze at the user's MAX
  //     lvl instead of the slider position — producing weird ranges
  //     like "63-100" when the user thought they were snapping at 90.
  //
  // Pin snapLvl BEFORE exit-replay-restore so the slider's value is
  // captured while it still reflects the user's intent.
  const wasInReplay = state.replayActive;
  let snapLvl = 1;
  if (wasInReplay) {
    const lsInput = document.getElementById('ls-input') as HTMLInputElement | null;
    snapLvl = lsInput ? Math.max(1, +lsInput.value | 0) : 1;
  }

  // Exit replay (restore the user's pre-replay editing state so any
  // unflushed edits land in the new working cap's inheritance).
  if (state.replayActive && typeof window.PoE2SliderExitRestore === 'function') {
    window.PoE2SliderExitRestore();
  }
  if (typeof persistToWizardStore === 'function') persistToWizardStore();
  if (typeof flushPersistNow === 'function')      flushPersistNow();

  if (!wasInReplay) {
    snapLvl = currentCharacterLevel();
  }

  if (snapLvl <= active.levelRange[0]) {
    rollback();
    window.PoE2Plan.flash('Nothing new to snapshot — allocate at least one passive first', true);
    return;
  }
  // Max snap level is 99: snapshotAt sets new cap range to [snapLvl+1,
  // 100], so snapping at 100 would produce [101, 100] (lo > hi), an
  // unusable cap. lvl 99 is the highest meaningful snap point —
  // leaves room for a single "lvl 100" entry in the next cap.
  if (snapLvl >= 100) {
    rollback();
    window.PoE2Plan.flash('Snap level must be 99 or lower (lvl 100 leaves no room for the next capture).', true);
    return;
  }
  window.PoE2Plan.captures.snapshotAt(snapLvl);
  window.PoE2Plan.flash('Snapshotted at level ' + snapLvl);
}

export function deleteCapture(idx: number): void {
  if (!window.PoE2Plan) return;
  const list = window.PoE2Plan.captures.list();
  if (list.length <= 1) {
    alert('Can\'t delete the only capture — every plan needs at least one.');
    return;
  }
  const c = list[idx];
  if (!c) return;
  const range = c.levelRange[0] + '–' + c.levelRange[1];
  if (!confirm('Delete capture ' + (idx + 1) + ' (levels ' + range + ')?\n\n' +
               'Its level range will merge into the previous capture.')) return;
  window.PoE2Plan.captures.remove(idx);
}

// Declare persistToWizardStore for the snapshotHere typeof check. The
// function lives in wizard_sync.ts which doesn't export it on the
// global; the planner_globals.d.ts surfaces it for cross-file calls.
declare function persistToWizardStore(): void;

if (capSnapshotBtn) capSnapshotBtn.addEventListener('click', snapshotHere);

if (capListEl) {
  capListEl.addEventListener('click', e => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const del = target.closest<HTMLElement>('.cap-chip-del');
    if (del) {
      e.stopPropagation();
      deleteCapture(parseInt(del.dataset.idx || '', 10));
      return;
    }
    const chip = target.closest<HTMLElement>('.cap-chip');
    if (!chip || !window.PoE2Plan) return;
    const idx = parseInt(chip.dataset.idx || '', 10);
    const cur = window.PoE2Plan.captures.activeIndex();
    if (idx === cur) return;
    // If we're in replay mode, exit it FIRST so the in-memory state
    // restored from the saved snapshot doesn't trample the capture
    // we're about to switch into. Also signals "user wants to edit a
    // different capture" — replay was just a viewing mode.
    if (state.replayActive && typeof window.PoE2SliderExit === 'function') {
      window.PoE2SliderExit();
    }
    // Persist any in-flight edits so they land in the OLD active
    // capture before we switch. flushPersistNow now guards itself
    // against running during replay, so this is a no-op if we were
    // just in replay mode (state was already restored above).
    if (typeof flushPersistNow === 'function') flushPersistNow();
    window.PoE2Plan.captures.setActive(idx);
  });
}

// React to ANY capture-state change (snapshot, delete, switch). The
// wizard chrome dispatches this event; we re-render the chip rail
// and ask the planner to re-hydrate the visible tree from whatever
// is now the active capture.
window.addEventListener('poe2-capture-change', () => {
  renderCaptureBar();
  if (typeof syncFromWizardStore === 'function') syncFromWizardStore();
});

// Initial render — boot path populates window.PoE2Plan via
// wizard_chrome.ts before the planner script tag runs, but the chip
// rail wants to read it AFTER the planner has hydrated state.
// requestAnimationFrame defers one frame past initial render.
requestAnimationFrame(renderCaptureBar);

// Per-frame poll on state.selected.size so the snapshot button's
// "Snapshot at level N" label tracks live as the author allocates /
// deallocates. Cheap (one int compare); skips the DOM update unless
// the count actually changed.
let _lastSelSize = -1;
(function tickCaptureBar(): void {
  if (state.selected.size !== _lastSelSize) {
    _lastSelSize = state.selected.size;
    renderCaptureBar();
  }
  requestAnimationFrame(tickCaptureBar);
})();
