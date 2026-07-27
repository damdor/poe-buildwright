// ============================================================================
// === Boot =================================================================
// ============================================================================
// All side effects below run once at module-init time. _main.ts loads
// this file LAST so every dependency module has already evaluated by
// the time `resize()` and friends fire.

import { collectSpriteTiers, preload } from "./image_preload.ts";
import { loadingEl, state } from "./state.ts";
import { fitToView, resize } from "./viewport.ts";
import { uploadAllTextures } from "./webgl_setup.ts";
import { buildStaticGeometry } from "./static_geom.ts";
import { initSearchGlowTexture } from "./overlay.ts";
import { requestRender } from "./render.ts";
import { ensureClassArt, prefetchRemainingClasses, streamSprites } from "./lazy_art.ts";
import { initDefaultClass } from "./sidebar.ts";
import { syncFromWizardStore } from "./wizard_sync.ts";
import { emitStateChange } from "./runtime_contract.ts";

resize();
initDefaultClass();
fitToView();
// Progressive boot: first paint waits ONLY for the tree skeleton
// (frames, connectors, backgrounds — tiers.blocking, a few MB). Node
// icons then stream in with throttled rebuilds, followed by the
// flavor art (mastery patterns, panel art, portraits), followed by
// the other classes' lazy sets. Until the blocking preload+upload
// finishes we render nothing (geomReady gate in render()) and show
// the fade-out loading overlay.
const tiers = collectSpriteTiers();
preload(tiers.blocking).then(() => {
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
  // level_slider.ts routes to currentCharacterLevel (working
  // capture) or active.levelRange[1] (frozen snapshot).
  emitStateChange("boot");
  // The wizard restore above may have switched to a class whose art
  // is deferred (only the default class ships with the boot tiers)
  // — fetch it now. refreshAscOptions also ensures on every change;
  // this covers restore paths that set state.klass directly.
  void ensureClassArt(state.klass);
  // Fill in the rest behind the first paint, most-useful first:
  // node icons pop in over the first seconds, then the flavor art,
  // then the remaining classes warm so a class switch is instant.
  streamSprites(tiers.icons)
    .then(() => streamSprites(tiers.flavor))
    .then(() => prefetchRemainingClasses());
});
