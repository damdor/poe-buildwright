// ============================================================================
// === Sidebar collapse / expand with hover-peek ============================
// ============================================================================
// (Placed AFTER wizard_sync in _main.ts deliberately: the initial
// open/collapsed decision reads state.selected as hydrated from the
// stored plan — this logic historically lived in note_overlay for
// that timing reason, where nobody could find it.)
//
//   * Toggle button (chevron) pins the state for the session.
//   * When collapsed: a 22 px sliver remains, mouse-over re-expands
//     to full width temporarily (".hover-peek"), mouse-leave folds
//     back unless the user has pinned it open.

import { state } from "./state.ts";

{
  const panel = document.getElementById('panel');
  const toggle = document.getElementById('panel-toggle');
  const row = document.querySelector('.planner-row');
  if (panel && toggle && row) {
    // Both #panel and .planner-row carry collapse classes so the CSS
    // can drive the sidebar's width (on #panel) AND the toggle tab's
    // left position (on .planner-row, since the toggle now lives
    // OUTSIDE #panel to avoid being clipped by overflow-x: hidden).
    const collapsed = () => panel.classList.contains('collapsed');
    const apply = (isCollapsed: boolean) => {
      if (isCollapsed) {
        panel.classList.add('collapsed');
        row.classList.add('panel-collapsed');
      } else {
        panel.classList.remove('collapsed');
        panel.classList.remove('hover-peek');
        row.classList.remove('panel-collapsed');
        row.classList.remove('panel-peek');
      }
    };
    // Default: collapsed on page load — the sidebar is a secondary
    // surface (identity edits + stat summary); the canvas is the
    // primary one. Persisting an "open" preference across visits made
    // every reload start with the canvas obscured.
    //
    // EXCEPTION — first run: an EMPTY build (zero allocations after
    // plan hydration, which ran in wizard_sync before this module)
    // starts with the sidebar OPEN. A new user's first job is naming
    // the build and picking a class — both live here, and the old
    // behaviour hid them behind an unlabeled 10px chevron while the
    // class silently defaulted. Pairs with the #firstrun-hint chip.
    //
    // EXCEPTION to the exception — phones/tablets (coarse pointer)
    // and narrow viewports: the open panel covers the whole tree and
    // reads as "stuck" (there's no hover-peek on touch to hint that
    // it collapses). There the tree is always the first surface; the
    // toggle tab still opens the panel for class selection.
    const smallScreen = window.matchMedia('(pointer: coarse), (max-width: 768px)').matches;
    apply(state.selected.size > 0 || smallScreen);
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      apply(!collapsed());
      // Intentionally not persisted — every page load starts
      // collapsed regardless of last session's state.
    });
    // Hover-peek when collapsed. Triggered by mouseenter on EITHER the
    // sidebar's sliver OR the toggle tab itself, so moving the cursor
    // toward the tab also expands the sidebar.
    //
    // Sticky close: peekOff is debounced ~320ms. Without this, the
    // sidebar slammed shut the instant the cursor crossed its edge,
    // and any cursor jitter near the boundary read as a "blink." The
    // delay lets the user move back in (or to the toggle tab) without
    // re-triggering open. Re-entering during the delay cancels the
    // pending close.
    let peekCloseTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelPendingClose = () => {
      if (peekCloseTimer) { clearTimeout(peekCloseTimer); peekCloseTimer = null; }
    };
    const peekOn = () => {
      cancelPendingClose();
      if (collapsed()) {
        panel.classList.add('hover-peek');
        row.classList.add('panel-peek');
      }
    };
    const peekOff = () => {
      cancelPendingClose();
      peekCloseTimer = setTimeout(() => {
        peekCloseTimer = null;
        panel.classList.remove('hover-peek');
        row.classList.remove('panel-peek');
      }, 320);
    };
    panel.addEventListener('mouseenter', peekOn);
    panel.addEventListener('mouseleave', peekOff);
    toggle.addEventListener('mouseenter', peekOn);
    // toggle's mouseleave doesn't fire peekOff — the user might move
    // from toggle INTO the sidebar; let the panel's mouseleave handle
    // the final fold-back.
  }
}
