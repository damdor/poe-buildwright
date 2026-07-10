// ============================================================================
// === Boot =================================================================
// ============================================================================
// All side effects below run once at module-init time. _main.ts loads
// this file LAST so every dependency module has already evaluated by
// the time `resize()` and friends fire.

import { collectSpriteUrls, preload } from "./01_image_preload.ts";
import { loadingEl, state } from "./02_state.ts";
import { fitToView, resize } from "./03_viewport.ts";
import { uploadAllTextures } from "./04a_webgl_setup.ts";
import { buildStaticGeometry } from "./04d_static_geom.ts";
import { initSearchGlowTexture } from "./04e_overlay.ts";
import { requestRender } from "./04f_render.ts";
import { ensureClassArt, prefetchRemainingClasses } from "./04g_lazy_art.ts";
import { initDefaultClass } from "./07_sidebar.ts";
import { syncFromWizardStore } from "./11_wizard_sync.ts";

resize();
initDefaultClass();
fitToView();
// Preload all sprites, upload them to the GPU, build the static
// geometry, then unhide the canvas. Until preload+upload finishes we
// render nothing (geomReady gate in render()). Show a fade-out loading
// overlay during this window.
preload(collectSpriteUrls()).then(() => {
  uploadAllTextures();
  buildStaticGeometry();
  initSearchGlowTexture();
  loadingEl.classList.add("hidden");
  setTimeout(() => loadingEl.remove(), 250);
  // Wizard integration: if the URL or localStorage points us at a
  // saved build, load it into state before the first render. After
  // that, every selection-changing action also saves back. This is
  // what makes the wizard's "Open passive tree editor →" round-trip:
  // the wizard's allocations show up here, and edits flow back into
  // the same plan record.
  syncFromWizardStore();
  requestRender();
  // Synthetic capture-change to wake the slider's snap-to-live-level
  // logic. Without this, the slider stays at value=1 after returning
  // from /Builds → planner, even when the loaded build is at lvl 40
  // with multiple snapshots — the "filled" portion of the bar would
  // be empty while the tree shows a full build. The handler in
  // 13_level_slider.ts routes to currentCharacterLevel (working
  // capture) or active.levelRange[1] (frozen snapshot).
  window.dispatchEvent(new CustomEvent("poe2-capture-change", { detail: { reason: "boot" } }));
  // The wizard restore above may have switched to a class whose art
  // is deferred (only the default class ships with the boot preload)
  // — fetch it now. refreshAscOptions also ensures on every change;
  // this covers restore paths that set state.klass directly.
  void ensureClassArt(state.klass);
  // Warm the remaining classes once the first paint is done and the
  // network is quiet, so a later class switch finds its art resident.
  setTimeout(prefetchRemainingClasses, 1500);
});
