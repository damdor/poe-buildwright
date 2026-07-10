// Partition tests for the sprite ownership/tier split (deno test).
// A synthetic TREE exercises every classification rule without game
// data: shared chrome, per-class ownership, min-tier precedence,
// variant resolution, and the eager/lazy partition invariant that
// boot correctness depends on.
//
// deno.json keeps the app code browser-only (`types: []`), so the
// Deno test namespace is pulled in per test file:
/// <reference lib="deno.ns" />

import type { TreeData } from "../../../../types/poe2.d.ts";

// TREE is a global the planner IIFE gets from planner.html; tests
// install a fixture BEFORE importing the module under test.
const fixture: TreeData = {
  bounds: { x: 0, y: 0, w: 100, h: 100 },
  orbit_radii: [0, 82],
  edges_main: [],
  edges_asc: [],
  edges_for_sel: [],
  edges_meta: [],
  nodes: {
    // Main-tree node: frame → blocking, icon → icons tier.
    "1": { x: 0, y: 0, k: "small", i: "/assets/sprites/icon_small.png", f0: "/assets/sprites/frame_u.png", f1: "/assets/sprites/frame_a.png" },
    // Mastery node: the glow pattern is flavor even on the main tree.
    "2": { x: 1, y: 0, k: "mastery", me: "/assets/sprites/mastery_glow.png", i: "/assets/sprites/icon_mastery.png" },
    // Attribute node with option icons → icons tier.
    "3": { x: 2, y: 0, k: "attribute", o: [{ n: "Str", i: "/assets/sprites/opt_str.png" }] },
    // Default-class (Alpha) ascendancy node: everything flavor, and
    // the shared frame must STAY blocking via min-tier precedence.
    "10": { x: 3, y: 0, k: "asc_small", a: "AlphaAsc", i: "/assets/sprites/alpha_asc_icon.png", f0: "/assets/sprites/frame_u.png", f1: "/assets/sprites/asc_frame.png" },
    // Other-class (Beta) ascendancy node: lazy under Beta.
    "20": { x: 4, y: 0, k: "asc_small", a: "BetaAsc", i: "/assets/sprites/beta_asc_icon.png", f1: "/assets/sprites/asc_frame.png" },
  },
  bg_tile: "/assets/sprites/bg_tile.png",
  bgtree: "/assets/sprites/bgtree.png",
  class_portraits: {
    Alpha: "/assets/sprites/portrait_alpha.png",
    Beta: "/assets/sprites/portrait_beta.png",
  },
  asc_panels: {
    AlphaAsc: { p: "/assets/sprites/panel_alpha.png", x: 0, y: 0, w: 1, h: 1 },
    BetaAsc: { p: "/assets/sprites/panel_beta.png", x: 0, y: 0, w: 1, h: 1 },
  },
  asc_variants: {
    BetaAscVariant: { parent: "BetaAsc", nodes: { "21": { n: "V", s: "", k: "asc_small", i: "/assets/sprites/beta_variant_icon.png" } } },
  },
  classes: [
    { name: "Beta", asc: ["BetaAsc"] },
    { name: "Alpha", asc: ["AlphaAsc"] }, // Alpha sorts first → default
  ],
};
(globalThis as unknown as { TREE: TreeData }).TREE = fixture;

// Import AFTER the global is installed (module reads TREE at call
// time, but keep the ordering hygienic for future refactors).
const { collectSpriteTiers, lazyClassUrls, defaultClassName } = await import("./01_image_preload.ts");

Deno.test("default class is the alphabetical first", () => {
  if (defaultClassName() !== "Alpha") throw new Error(`got ${defaultClassName()}`);
});

Deno.test("tiers + lazy sets partition the corpus with no overlap", () => {
  const tiers = collectSpriteTiers();
  const lazy = lazyClassUrls();
  const buckets: string[][] = [tiers.blocking, tiers.icons, tiers.flavor, ...lazy.values()];
  const seen = new Set<string>();
  for (const b of buckets) {
    for (const u of b) {
      if (seen.has(u)) throw new Error(`URL in two buckets: ${u}`);
      seen.add(u);
    }
  }
  // Everything referenced by the fixture must land somewhere: 16
  // unique fixture sprites + 90 orbit connectors.
  const expected = 16 + 90;
  if (seen.size !== expected) throw new Error(`partition covers ${seen.size} URLs, expected ${expected}`);
});

Deno.test("tier rules: skeleton blocking, icons streamed, decoration flavor", () => {
  const tiers = collectSpriteTiers();
  const B = new Set(tiers.blocking), I = new Set(tiers.icons), F = new Set(tiers.flavor);
  // Skeleton: frames, backgrounds, connectors.
  for (const u of ["/assets/sprites/frame_u.png", "/assets/sprites/frame_a.png", "/assets/sprites/bg_tile.png", "/assets/sprites/bgtree.png", "/assets/sprites/Character_orbit_normal0.png"]) {
    if (!B.has(u)) throw new Error(`not blocking: ${u}`);
  }
  // Node + option icons stream in.
  for (const u of ["/assets/sprites/icon_small.png", "/assets/sprites/icon_mastery.png", "/assets/sprites/opt_str.png"]) {
    if (!I.has(u)) throw new Error(`not icons tier: ${u}`);
  }
  // Decoration: mastery glow + default class's asc art + portrait.
  for (const u of ["/assets/sprites/mastery_glow.png", "/assets/sprites/alpha_asc_icon.png", "/assets/sprites/asc_frame.png", "/assets/sprites/panel_alpha.png", "/assets/sprites/portrait_alpha.png"]) {
    if (!F.has(u)) throw new Error(`not flavor: ${u}`);
  }
});

Deno.test("min-tier precedence: a frame shared by main tree and asc stays blocking", () => {
  const tiers = collectSpriteTiers();
  if (!tiers.blocking.includes("/assets/sprites/frame_u.png")) {
    throw new Error("shared frame demoted out of the blocking tier");
  }
  if (tiers.flavor.includes("/assets/sprites/frame_u.png")) {
    throw new Error("shared frame duplicated into flavor");
  }
});

Deno.test("non-default class art is lazy under its class, variants resolve through parents", () => {
  const lazy = lazyClassUrls();
  if (lazy.has("Alpha")) throw new Error("default class must not be lazy");
  const beta = new Set(lazy.get("Beta") ?? []);
  for (const u of ["/assets/sprites/portrait_beta.png", "/assets/sprites/panel_beta.png", "/assets/sprites/beta_asc_icon.png", "/assets/sprites/beta_variant_icon.png"]) {
    if (!beta.has(u)) throw new Error(`not in Beta's lazy set: ${u}`);
  }
});
