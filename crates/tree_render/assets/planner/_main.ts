// _main.ts — esbuild entry point for the planner.
//
// esbuild bundles from this single entry: it walks the import graph,
// deduplicates, emits one IIFE. Every file below is imported for its
// SIDE EFFECTS — they register DOM listeners, build module-level
// state, wire up the WebGL pipeline.
//
// THIS LIST IS THE LOAD ORDER. Filenames carry no ordering (they are
// named for what they do); the position in this list — refined by the
// import graph — is the one source of truth for module evaluation.
// The constraints that matter, in order:
//
//   1. state must evaluate before anything that touches `gl` — it
//      throws synchronously when WebGL2 is unavailable, so nothing
//      downstream ever sees a null context.
//   2. The render pipeline (webgl_setup → … → render, lazy_art)
//      evaluates before the interaction modules that import from it.
//   3. sidebar_collapse must evaluate AFTER wizard_sync: its initial
//      open/collapsed decision reads state.selected as hydrated from
//      the stored plan.
//   4. boot stays LAST (see the note above its import).
//
// When adding a module: place it after everything it imports from,
// and before boot. If it has a genuine evaluation-order dependency
// beyond its imports (like sidebar_collapse), document it here AND
// at the top of the module.

import "./image_preload.ts";
import "./state.ts";
import "./lock_rebuild.ts";
import "./viewport.ts";
import "./webgl_setup.ts";
import "./vertex_helpers.ts";
import "./edge_tessellate.ts";
import "./static_geom.ts";
import "./overlay.ts";
import "./render.ts";
import "./lazy_art.ts";
import "./hover.ts";
import "./pathfind.ts";
import "./sidebar.ts";
import "./build_io.ts";
import "./cmdk.ts";
import "./wizard_sync.ts";
import "./sidebar_collapse.ts";
import "./captures_bar.ts";
import "./level_slider.ts";
import "./state_timeline.ts";
import "./note_overlay.ts";
import "./skills_overlay.ts";
import "./gear_overlay.ts";
import "./pob_import.ts";
import "./agent_import.ts";
import "./live_channel.ts";
import "./guide.ts";

// boot is loaded LAST. Its top-level statements run the actual boot
// sequence (resize, initDefaultClass, fitToView, then async preload →
// uploadAllTextures → buildStaticGeometry → init searchGlowTex →
// requestRender). Loading it last guarantees every dependency module
// has fully initialized before boot starts touching them.
import "./boot.ts";
