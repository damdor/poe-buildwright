// ---------------------------------------------------------------------
// PoE2-only rule tables
// ---------------------------------------------------------------------
// Everything here encodes PoE2 game rules keyed by RAW node ids or
// PoE2 quest schedules: ascendancy nodes that bend tree-level rules,
// multi-choice notables, weapon-set and spirit reward curves. PoE1
// reuses the node-id space, so the id-keyed tables are EMPTY on any
// other game (GAME.id gate) — populating them there would silently
// apply PoE2 ascendancy rules to unrelated poe1 nodes.
//
// Ownership rule (mirrors types/{shared,poe1,poe2}.d.ts): a new rule
// table goes here if it's PoE2-only, game.ts if it's a gate, state.ts
// only if it's genuinely shared runtime state.

import { GAME } from "./game.ts";

// Hardcoded table of ascendancy nodes that change tree-level rules
// when allocated. Six "+passive point" nodes (Pathfinder + Oracle),
// two "Path of X" alt-start unlocks (Pathfinder), and Witchhunter's
// Weapon Master conversion.
//
//   grantsPoints    → bonus main-tree passive points (raises main cap).
//   altStartClass   → unlocks that class's start hub as an extra BFS
//                     root (Path of the Sorceress on a Ranger lets
//                     them allocate Sorceress's starting cluster
//                     without crossing the tree).
//   weaponSetGrant  → bonus weapon-set passive points (raises set cap).
//                     PoB's PassivePointsToWeaponSetPoints adds 100
//                     to maxWeaponSets when Weapon Master is taken.
// Weapon-set passive points are quest rewards, not free-from-start.
// Source: data/pob2/src/Data/QuestRewards.lua aggregated by AreaLevel
// (the minimum character level required to do each quest). Each
// reward grants +2 points; some levels carry two coincident quests
// (51, 62) collapsed into +4 here. Total 24 at Lv 64+ — matches
// PoB2's self.maxWeaponSets = acts[maxActs].questPoints derivation.
// weaponSetCapAt(level) returns the BASE cap (before Witchhunter's
// +100 Weapon Master grant, which is layered on top).
export const WEAPON_SET_REWARDS = [
  { lvl: 10, pts: 2 }, { lvl: 12, pts: 2 },
  { lvl: 25, pts: 2 }, { lvl: 28, pts: 2 },
  { lvl: 34, pts: 2 }, { lvl: 44, pts: 2 },
  { lvl: 51, pts: 4 },
  { lvl: 61, pts: 2 }, { lvl: 62, pts: 4 }, { lvl: 64, pts: 2 },
];
export function weaponSetCapAt(level: number): number {
  let cap = 0;
  for (const r of WEAPON_SET_REWARDS) {
    if (r.lvl <= level) cap += r.pts;
    else break;
  }
  return cap;
}

// Base Spirit is quest-earned: +30 (Act 1, King in the Mists), +30
// (Act 3, Ignagduk), +40 (post-Act-4 interlude, Lythara) = 100. The
// level mapping is DELIBERATELY CONSERVATIVE (latest plausible level
// per boss) so the UI never promises spirit the player might not
// have. KEEP IN SYNC with scripts/gen_agent_meta.mjs SPIRIT_REWARDS.
export const SPIRIT_REWARDS = [
  { lvl: 18, pts: 30 },
  { lvl: 36, pts: 30 },
  { lvl: 50, pts: 40 },
];
export function spiritCapAt(level: number): number {
  let cap = 0;
  for (const r of SPIRIT_REWARDS) {
    if (r.lvl <= level) cap += r.pts;
    else break;
  }
  return cap;
}

// Each entry MAY carry grantsPoints, weaponSetGrant, or altStartClass —
// any combination, or none (in which case the entry would simply not
// exist in this table). Typed with all-optional fields so the indexed
// lookup ASC_EFFECTS[id] returns the right union of possible effects.
interface AscEffect {
  grantsPoints?: number;
  weaponSetGrant?: number;
  altStartClass?: string;
}
// Keyed by RAW node ids — poe1 reuses the id space, so these PoE2
// rule tables are empty on any other game.
export const ASC_EFFECTS: Record<string, AscEffect> = GAME.id !== "poe2" ? {} : {
  '11335': { grantsPoints: 1 },                               // Oracle - Passive Point
  '12183': { grantsPoints: 1 },                               // Pathfinder - Passive Points
  '12795': { grantsPoints: 4, altStartClass: 'Sorceress' },   // Pathfinder - Path of the Sorceress
  '36676': { grantsPoints: 1 },                               // Pathfinder - Passive Points
  '47190': { grantsPoints: 1 },                               // Oracle - Passive Point
  '57253': { grantsPoints: 4, altStartClass: 'Warrior' },     // Pathfinder - Path of the Warrior
  '8272':  { weaponSetGrant: 100 },                           // Witchhunter - Weapon Master
};

// Multi-choice notables. GGG tree.json carries isMultipleChoice +
// isMultipleChoiceOption flags on the parent and its options; we
// hardcode the mapping since the set is small (5 notables across
// 4 ascendancies) and unlikely to grow often.
//
// Behavior per PoB (PassiveSpec.lua:944-948 + line 985):
//   * Parent notable costs the usual 1 asc point.
//   * Picking an option costs 0 additional asc points (the option's
//     asc allocation is "free" — the parent's slot covers it).
//   * Picking an option deallocates any previously-picked sibling
//     option of the same parent (mutex).
//   * Option nodes are hidden from tree rendering / pathfinding —
//     the user only ever interacts with them through the parent's
//     popout (same UX as attribute Str/Dex/Int picker).
export const MULTI_CHOICE: Record<string, string[]> = GAME.id !== "poe2" ? {} : {
  '16433': ['12795', '57253'],                                // Pathfinder - Path Seeker
  '57141': ['9710', '18940', '38004', '56618', '58379'],      // Pathfinder - Brew Concoction
  '42416': ['41875', '59542'],                                // Deadeye - Projectile Proximity Specialisation
  '52395': ['56331', '26283', '664'],                         // Acolyte of Chayula - Lucid Dreaming
  '60287': ['37397', '32952', '63259'],                       // Gemling Legionnaire - Implanted Gems
};
export const MULTI_CHOICE_PARENT: Record<string, string> = {};   // option_id → parent_id
for (const parent in MULTI_CHOICE) {
  for (const opt of (MULTI_CHOICE[parent] ?? [])) MULTI_CHOICE_PARENT[opt] = parent;
}
export function isMcOption(id: string | number): boolean { return MULTI_CHOICE_PARENT[String(id)] != null; }
export function isMcParent(id: string | number): boolean { return MULTI_CHOICE[String(id)] != null; }
