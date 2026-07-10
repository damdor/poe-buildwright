// _main.ts — esbuild entry point for the planner.
//
// esbuild bundles from this single entry: it walks the import graph,
// deduplicates, emits one IIFE. Numeric filenames are preserved for
// chronological readability — the real load order is whatever the
// dependency graph requires, not the lexical sort.
//
// Every file below is imported for its SIDE EFFECTS — they register
// DOM listeners, build module-level state, wire up the WebGL pipeline.
// The 02_state foundation throws synchronously if WebGL2 isn't
// available, so importing it must run before anything else that
// touches `gl`.

import "./01_image_preload.ts";
import "./02_state.ts";
import "./02b_lock_rebuild.ts";
import "./03_viewport.ts";
import "./04a_webgl_setup.ts";
import "./04b_vertex_helpers.ts";
import "./04c_edge_tessellate.ts";
import "./04d_static_geom.ts";
import "./04e_overlay.ts";
import "./04f_render.ts";
import "./04g_lazy_art.ts";
import "./05_hover.ts";
import "./06_pathfind.ts";
import "./07_sidebar.ts";
import "./08_build_io.ts";
import "./09_cmdk.ts";
import "./11_wizard_sync.ts";
import "./12_captures_bar.ts";
import "./13_level_slider.ts";
import "./14_note_overlay.ts";
import "./15_skills_overlay.ts";
import "./16_gear_overlay.ts";
import "./17_agent_import.ts";
import "./18_live_channel.ts";
import "./19_guide.ts";

// 10_boot is loaded LAST. Its top-level statements run the actual boot
// sequence (resize, initDefaultClass, fitToView, then async preload →
// uploadAllTextures → buildStaticGeometry → init searchGlowTex →
// requestRender). Loading it last guarantees every dependency module
// has fully initialized before boot starts touching them.
import "./10_boot.ts";
