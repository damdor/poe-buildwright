// ---------------------------------------------------------------------
// Per-game page descriptor — THE single source for game gates
// ---------------------------------------------------------------------
// tree_render --game embeds window.PoE2Game before planner.js runs;
// absent descriptor = classic PoE2 page. This module is a ZERO-IMPORT
// leaf so anything can read the gates — including image_preload.ts,
// which loads before state.ts and previously had to re-derive its own
// copy of the in-place flag.
//
// The rule: every game/feature check in the planner goes through
// these exports. No module reads window.PoE2Game directly (wizard
// chrome is its own bundle and keeps its own reads).
//
// globalThis.window (not bare `window`): leaf modules get imported by
// unit tests under deno 2, where the window global doesn't exist.

export const GAME = globalThis.window?.PoE2Game ?? { id: "poe2" };

/** Feature gates default ON — a missing features map (classic PoE2
 *  page) enables everything; games opt OUT via `features: {x: false}`. */
export function featureOn(name: string): boolean {
  return GAME.features?.[name] !== false;
}

// PoE1 draws every ascendancy subtree at its real tree coordinates,
// hung off the class start (selected one interactive) — PoE2 pins the
// selected panel to the tree center instead.
export const ASC_IN_PLACE = GAME.features?.ascInPlace === true;

// Point budgets: descriptor-driven (poe1 pages embed 123/8); the
// literals are the PoE2 defaults.
export const MAX_MAIN_POINTS = GAME.budgets?.main ?? 99;
export const MAX_SET_POINTS  = featureOn("weaponSets") ? 24 : 0;
export const MAX_ASC_POINTS  = GAME.budgets?.asc ?? 8;
