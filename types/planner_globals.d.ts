// planner_globals.d.ts — ambient declarations for the planner.
//
// Post-Phase-4c, the planner files are proper ES modules — every
// cross-file value AND type reference goes through `import` / `export`.
// The only remaining ambient is `TREE`: the runtime payload that
// planner.html injects as a <script> tag BEFORE planner.js runs, so
// no .ts file declares it.

import type { TreeData as _TreeData } from "./poe2.d.ts";

declare global {
  // Set by the host page (planner.html injects via a <script> tag
  // before planner.js runs).
  const TREE: _TreeData;
}

export {};
