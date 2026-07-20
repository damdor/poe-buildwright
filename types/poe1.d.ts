// poe1.d.ts — PoE1-only type surface. See shared.d.ts for the
// ownership rule: fields here exist only on pages baked with
// `tree_render --game poe1` (the in-place ascendancy presentation),
// and shared.d.ts's TreeData composes this interface so runtime code
// keeps reading one `TREE` object.

/** TREE fields emit.rs bakes only for PoE1's data-sized pages. All
 *  drive the GGG skilltree.js presentation: the class-start medallions
 *  drawn at real coordinates, and the AscendancyButton plaque that
 *  toggles the in-place ascendancy circle. */
export interface Poe1TreeData {
  /** Class-start marker art at the start node's real coordinates
   *  (selected class only; others use start_inactive). */
  class_markers?: Record<string, { x: number; y: number; p: string; w: number; h: number }>;
  /** Generic inactive start medallion. */
  start_inactive?: { p: string; w: number; h: number };
  /** Ascendancy plaque art at GGG's buttonPoint. Three states, same
   *  as skilltree.js: normal / hp = Highlight (hovered) / pp =
   *  Pressed (circle open). */
  asc_button?: { p: string; hp?: string; pp?: string; w: number; h: number };
}

export {};
