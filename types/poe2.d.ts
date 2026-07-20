// poe2.d.ts — PoE2-only type surface. See shared.d.ts for the
// ownership rule. What lives here:
//   • The GGG .build interop format (PoE2's in-game Build Planner —
//     PoE1 pages have export/share disabled and never touch these).
//   • PoE2-only TREE fields (variant ascendancies).
//   • PoE2-only window bridges: jewels, gem data, share links,
//     .build import/export.

import type { Plan } from "./shared.d.ts";

// ===========================================================================
// GGG .build format (patch 0.5+, interop boundary)
// ===========================================================================
//
// The in-game Build Planner's JSON shape. Used by build_io.ts both
// as an export target (planToGGGBuild) and an import source
// (gggBuildToPlan). Fields here mirror the spec at
// <https://www.pathofexile.com/developer/docs/game> and the
// docs/build_planner_format.md notes. Strict on TYPES we know; lenient
// on UNKNOWN fields (GGG can add forward-compatible properties without
// breaking our import).

/** Level applicability per GGG's schema: an inclusive [lo, hi] pair,
 *  a single-element [lo] array, or a bare uint — the docs write it as
 *  "(array of uint, or uint)". The short forms have no documented
 *  upper bound; our importer reads them as "from lo onward"
 *  (normalizeInterval in build_io). Our exporter always emits the
 *  two-element form. */
export type GGGLevelInterval = number | number[];

/** A passive entry in a GGG .build. Bare string/number form means
 *  "always present" (no level_interval). Object form carries the
 *  optional metadata. */
export type GGGPassive = string | number | GGGPassiveEntry;

export interface GGGPassiveEntry {
  id: string | number;                     // passive node id (or attr-variant id)
  weapon_set?: 1 | 2;                      // unset = main tree
  level_interval?: GGGLevelInterval;
  additional_text?: string;                // author note + auto-pivot annotations
}

/** A skill entry. Mirrors GGG's BuildSkill (id, level_interval,
 *  additional_text, support_skills). `level`, `quality`, and
 *  `weapon_set` are OUR extensions — not in GGG's schema; the client
 *  ignores unknown fields, and our re-import round-trips them. */
export interface GGGSkill {
  id: string;
  level?: number;
  quality?: number;
  weapon_set?: 1 | 2;
  level_interval?: GGGLevelInterval;
  additional_text?: string;
  support_skills?: Array<string | GGGSupport>; // GGG allows bare id strings
}

/** A support gem inside a GGGSkill.support_skills. Mirrors GGG's
 *  BuildSupport (id, level_interval, additional_text); `level` and
 *  `quality` are our extensions. */
export interface GGGSupport {
  id: string;
  level?: number;
  quality?: number;
  level_interval?: GGGLevelInterval;
  additional_text?: string;
}

/** An equipped item entry. Mirrors GGG's InventorySlot: the official
 *  positional fields are `slot_x`/`slot_y` (default 0). `x`/`y` are
 *  accepted on import for files our exporter wrote before the
 *  2026-07-10 spec audit. */
export interface GGGItem {
  inventory_id: string;
  slot_x?: number;
  slot_y?: number;
  /** @deprecated pre-audit alias of slot_x — import-only */
  x?: number;
  /** @deprecated pre-audit alias of slot_y — import-only */
  y?: number;
  unique_name?: string;
  level_interval?: GGGLevelInterval;
  additional_text?: string;
}

/** Top-level .build JSON (GGG schema "Version 1 (Experimental)").
 *  `name` is the one field GGG marks required — our exporter always
 *  emits it. `patch` is OUR extension (client ignores it; other tools
 *  and our re-import can use it). */
export interface GGGBuild {
  name?: string;                           // required by the client; optional here so import can degrade gracefully
  author?: string;
  link?: string;                           // 0.5.3+: renders a button in the client (whitelisted domains only)
  description?: string;
  ascendancy?: string;                     // GGG internal id (TreeData.asc_internal[name].internal)
  patch?: string;                          // our extension: game patch the build was authored against
  passives?: GGGPassive[];
  skills?: GGGSkill[];
  inventory_slots?: GGGItem[];             // official field name
  /** @deprecated pre-audit exports used `items` — import-only */
  items?: GGGItem[];
}

// ===========================================================================
// PoE2-only TREE fields (composed into shared.d.ts's TreeData)
// ===========================================================================

export interface Poe2TreeData {
  /** Variant ascendancies (Abyssal Lich): parent panel + node content
   *  overrides. */
  asc_variants?: Record<string, { parent: string; nodes: Record<string, { n: string; s: string; k: string; i?: string }> }>;
}

// ===========================================================================
// PoE2-only window bridges
// ===========================================================================

declare global {
  interface Window {
    // Jewel socketing bridge: pathfind consults this before treating
    // a click on an allocated jewel-socket node as (de)allocation.
    PoE2Jewels?: {
      handleSocketClick: (nodeId: string, cx: number, cy: number) => boolean;
      /** Tooltip payload for a jewel-socket node: the socketed jewel's
       *  name/mods/rule, or the socket's state (empty / sinister). */
      infoForSocket?: (nodeId: string) => { title: string; lines: string[] } | null;
      /** Timeless conversion for a keystone node inside a socketed
       *  timeless jewel's radius ("becomes X"), or null. */
      conversionForKeystone?: (nodeId: string) => { title: string; lines: string[] } | null;
    };
    // Jewel-granted pathing rules for the ACTIVE capture, published
    // by gear_overlay and consumed by pathfind: extra class-start
    // roots (Split Personality) and connection-free allocatable node
    // ids (Controlled Metamorphosis ring).
    PoE2JewelRules?: {
      starts: string[];
      freeAlloc: string[];
      /** freeAlloc grouped by the granting jewel's socket node id —
       *  ring allocations live and die with their socket. */
      freeAllocBySocket: Record<string, string[]>;
      voicesActive: boolean;
    };
    PoE2Share?: {
      encode: (plan: Plan) => Promise<string>;
      decode: (code: string) => Promise<Plan>;
      buildUrl: (plan: Plan, origin?: string) => Promise<string>;
    };
    POE2_GEMS_BY_ID?: Record<string, unknown>;
    // Test/debug surface for export/import flows. Exposed by
    // build_io.ts so Playwright tests + console diagnostics can
    // exercise the pipeline without going through the file dialog.
    PoE2BuildIO?: {
      planToGGGBuild: (plan: Plan, meta?: { name?: string; description?: string }) => GGGBuild;
      validateGGGBuild: (d: unknown) => string | null;
      gggBuildToPlan: (b: GGGBuild) => Plan;
    };
  }
}

export {};
