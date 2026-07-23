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

import type { GameId } from "../../../../types/shared.d.ts";

export interface GameAssets {
  skillCatalogue: string;
  skillStats: string | null;
  itemCatalogue: string;
  bases: string;
  mods: string;
  grantedSkills: string | null;
  jewels: string | null;
  spirit: string | null;
  buildMeta: string;
  nodes: string;
  graph: string;
  supportCompat: string | null;
  capabilities: string | null;
}
export type GameAssetKey = keyof GameAssets;

// Compatibility default for unit tests and an old PoE2 HTML shell. Newly
// rendered pages always embed the complete descriptor, including every
// feature and asset entry.
const POE2_DEFAULT = {
  schema: 1 as const,
  id: "poe2" as GameId,
  storageNamespace: "poe2-planner",
  budgets: { main: 99, asc: 8 },
  features: {
    gear: true, skills: true, jewels: true, spirit: true,
    weaponSets: true, share: true, ascInPlace: false,
  },
  socketModel: "spirit" as const,
  assets: {
    skillCatalogue: "/assets/skill_catalogue.json",
    skillStats: "/assets/skill_stats.json",
    itemCatalogue: "/assets/item_catalogue.json",
    bases: "/assets/agent/bases.json",
    mods: "/assets/agent/mods.json",
    grantedSkills: "/assets/agent/granted_skills.json",
    jewels: "/assets/agent/jewels.json",
    spirit: "/assets/agent/spirit.json",
    buildMeta: "/assets/build_meta.json",
    nodes: "/assets/agent/nodes.json",
    graph: "/assets/agent/graph.json",
    supportCompat: "/assets/agent/support_compat.json",
    capabilities: "/assets/agent/capabilities.json",
  } satisfies GameAssets,
};

const embedded = globalThis.window?.PoE2Game;
export const GAME = embedded
  ? { ...POE2_DEFAULT, ...embedded, assets: { ...POE2_DEFAULT.assets, ...embedded.assets } }
  : POE2_DEFAULT;

export function assetUrl(key: GameAssetKey): string | null {
  return GAME.assets[key] ?? null;
}

/** Feature gates default ON — a missing features map (classic PoE2
 *  page) enables everything; games opt OUT via `features: {x: false}`. */
export function featureOn(name: string): boolean {
  return (GAME.features as Record<string, boolean> | undefined)?.[name] !== false;
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

// Support-count model: "spirit" (PoE2 reservation) or "links" (PoE1
// item-slot sockets). Drives the skills overlay's cap + chip.
export const SOCKET_MODEL: "spirit" | "links" = GAME.socketModel === "links" ? "links" : "spirit";

export interface GearSlotSpec {
  key: string;
  label: string;
  /** PoB unique source-file categories accepted as a legacy fallback
   *  when an entry predates the data-layer `allowed_slots` field. */
  cat: string[];
}

const ALL_WEAPONS = [
  "axe", "bow", "claw", "crossbow", "dagger", "fishing", "mace",
  "sceptre", "spear", "staff", "sword", "wand",
];
const ONE_HAND_WEAPONS = ["axe", "claw", "dagger", "mace", "sceptre", "sword", "wand"];

/** Regular equipment slots. Flasks deliberately live in their own
 * model and visual section even though both surfaces reuse one item
 * editor and one persisted Capture.items array. */
export function gearSlotsFor(gameId: string): GearSlotSpec[] {
  return gameId === "poe1" ? [
    { key: "weapon1",  label: "Weapon 1",    cat: ALL_WEAPONS },
    { key: "offhand1", label: "Offhand 1",   cat: ["shield", "quiver", ...ONE_HAND_WEAPONS] },
    { key: "weapon2",  label: "Weapon 2",    cat: ALL_WEAPONS },
    { key: "offhand2", label: "Offhand 2",   cat: ["shield", "quiver", ...ONE_HAND_WEAPONS] },
    { key: "helmet",   label: "Helmet",      cat: ["helmet"] },
    { key: "body",     label: "Body Armour", cat: ["body"] },
    { key: "gloves",   label: "Gloves",      cat: ["gloves"] },
    { key: "boots",    label: "Boots",       cat: ["boots"] },
    { key: "amulet",   label: "Amulet",      cat: ["amulet", "talisman"] },
    { key: "ring1",    label: "Ring 1",      cat: ["ring"] },
    { key: "ring2",    label: "Ring 2",      cat: ["ring"] },
    { key: "belt",     label: "Belt",        cat: ["belt"] },
    { key: "jewel",    label: "Jewel",       cat: ["jewel"] },
  ] : [
    { key: "weapon1",  label: "Weapon 1",    cat: ["bow", "crossbow", "mace", "sceptre", "spear", "staff", "wand"] },
    { key: "offhand1", label: "Offhand 1",   cat: ["shield", "focus", "quiver"] },
    { key: "weapon2",  label: "Weapon 2",    cat: ["bow", "crossbow", "mace", "sceptre", "spear", "staff", "wand"] },
    { key: "offhand2", label: "Offhand 2",   cat: ["shield", "focus", "quiver"] },
    { key: "helmet",   label: "Helmet",      cat: ["helmet"] },
    { key: "body",     label: "Body Armour", cat: ["body"] },
    { key: "gloves",   label: "Gloves",      cat: ["gloves"] },
    { key: "boots",    label: "Boots",       cat: ["boots"] },
    { key: "amulet",   label: "Amulet",      cat: ["amulet", "talisman"] },
    { key: "ring1",    label: "Ring 1",      cat: ["ring"] },
    { key: "ring2",    label: "Ring 2",      cat: ["ring"] },
    { key: "belt",     label: "Belt",        cat: ["belt"] },
    { key: "jewel",    label: "Jewel",       cat: ["jewel"] },
  ];
}

/** The flask belt is a first-class shared surface: five unrestricted
 * flask/tincture positions in PoE1; two Life/Mana positions in PoE2.
 * PoE2 keeps both positions searchable across both recovery types so
 * Waistgate's "either slot" exception remains representable. */
export function flaskSlotsFor(gameId: string): GearSlotSpec[] {
  const count = gameId === "poe1" ? 5 : 2;
  const cat = gameId === "poe1" ? ["flask", "tincture"] : ["flask"];
  return Array.from({ length: count }, (_, i) => ({
    key: "flask" + (i + 1),
    label: "Flask " + (i + 1),
    cat,
  }));
}

/** PoE2 belts expose up to three Charm sockets. They share the mined
 * flask domain with recovery flasks, but not the equipped-slot model. */
export function charmSlotsFor(gameId: string): GearSlotSpec[] {
  if (gameId !== "poe2") return [];
  return Array.from({ length: 3 }, (_, i) => ({
    key: "charm" + (i + 1),
    label: "Charm " + (i + 1),
    cat: ["flask"],
  }));
}

export const GEAR_SLOTS = gearSlotsFor(GAME.id);
export const FLASK_SLOTS = flaskSlotsFor(GAME.id);
export const CHARM_SLOTS = charmSlotsFor(GAME.id);
export const ITEM_SLOTS = [...GEAR_SLOTS, ...FLASK_SLOTS, ...CHARM_SLOTS];

/** Old PoE2 saves used the single key `flask`. Display it in the first
 * slot of the new two-position belt without mutating the save until the
 * player actually edits that item. */
export function plannerSlot(slot: string, gameId: string = GAME.id): string {
  return gameId === "poe2" && slot === "flask" ? "flask1" : slot;
}

/** Mining keeps PoE2 Charms in the broad `flask` item domain, but the
 * character's two flask positions accept recovery flasks only. Keep
 * that source taxonomy out of the UX model without changing the mined
 * catalogue contract used by agents and mod-domain filtering. */
export function baseAllowedForPlannerSlot(
  gameId: string,
  slot: string,
  itemClass: string | undefined,
  baseName = "",
): boolean {
  if (gameId !== "poe2") return true;
  const key = plannerSlot(slot, gameId);
  if (/^flask[1-2]$/.test(key)) {
    if (itemClass) return itemClass === "LifeFlask" || itemClass === "ManaFlask";
    return /(?:Life|Mana) Flask$/i.test(baseName);
  }
  if (/^charm[1-3]$/.test(key)) {
    if (itemClass) return itemClass === "UtilityFlask";
    return /Charm$/i.test(baseName);
  }
  return true;
}

/** Grounding data names the first instance of paired/repeated slots.
 * PoE2's existing catalogue contract calls the family `flask`; PoE1's
 * isolated catalogue calls it `flask1`. */
export function groundingSlotFor(gameId: string, slot: string): string {
  if (slot === "weapon2") return "weapon1";
  if (slot === "offhand2") return "offhand1";
  if (slot === "ring2") return "ring1";
  if (/^flask[1-5]$/.test(slot)) return gameId === "poe1" ? "flask1" : "flask";
  if (/^charm[1-3]$/.test(slot)) return "flask";
  return slot;
}

export function groundingSlot(slot: string): string {
  return groundingSlotFor(GAME.id, slot);
}

/** Agent/import vocabulary normalized through the same slot policy the item
 *  editor renders. This is deliberately exported from the profile module so
 *  aliases and repeated-slot behavior cannot drift between surfaces. */
const SLOT_ALIASES: Record<string, string> = {
  axe: "weapon1", bow: "weapon1", claw: "weapon1", crossbow: "weapon1",
  dagger: "weapon1", fishing: "weapon1", mace: "weapon1", sceptre: "weapon1",
  spear: "weapon1", staff: "weapon1", sword: "weapon1", wand: "weapon1",
  talisman: "amulet", tincture: "flask1",
  shield: "offhand1", focus: "offhand1", quiver: "offhand1",
  ring: "ring1", weapon: "weapon1", offhand: "offhand1",
  flask: "flask1", life_flask: "flask1", mana_flask: "flask1",
};

export function normalizeItemSlotFor(
  gameId: string,
  requested: string,
  baseName = "",
): string {
  const raw = requested.toLowerCase().trim();
  if (gameId === "poe2" && /Charm$/i.test(baseName)) return "charm1";
  if (raw === "utility_flask") return gameId === "poe2" ? "charm1" : "flask1";
  if (raw === "charm") return "charm1";
  return SLOT_ALIASES[raw] ?? raw;
}

export function nextRepeatedItemSlotFor(gameId: string, slot: string): string | null {
  const common: Record<string, string> = {
    weapon1: "weapon2", offhand1: "offhand2", ring1: "ring2", flask1: "flask2",
  };
  if (common[slot]) return common[slot]!;
  if (gameId === "poe1") {
    return ({ flask2: "flask3", flask3: "flask4", flask4: "flask5" } as Record<string, string>)[slot] ?? null;
  }
  return ({ charm1: "charm2", charm2: "charm3" } as Record<string, string>)[slot] ?? null;
}

/** Official PoE1 cluster-jewel bases. Expansion sockets carry a maximum
 * supported size: outer sockets accept Large/Medium/Small, Large
 * clusters generate Medium sockets, and Medium clusters generate Small
 * sockets. Ordinary jewel sockets reject every cluster size. */
export function isClusterJewelBase(baseName: string): boolean {
  return /^(?:Small|Medium|Large) Cluster Jewel$/i.test(baseName.trim());
}

export interface JewelSocketPolicy {
  cluster_size?: number;
  cluster_outer?: boolean;
}

export function jewelAllowedInSocket(
  gameId: string,
  baseName: string,
  socket: JewelSocketPolicy | undefined,
): boolean {
  if (gameId !== "poe1" || !isClusterJewelBase(baseName)) return true;
  const size = /^(Small|Medium|Large)/i.exec(baseName.trim())?.[1]?.toLowerCase();
  const sizeIndex = size === "large" ? 2 : size === "medium" ? 1 : 0;
  return socket?.cluster_size != null && socket.cluster_size >= sizeIndex;
}

/** PoE1 supplies native socket-fill art in its passive-tree atlas.
 * PoE2 keeps its existing per-base sprites, so null means to use the
 * legacy `Jewel_<base>.png` chain. */
export function jewelSocketArtForBase(gameId: string, baseName: string): string | null {
  if (gameId !== "poe1") return null;
  const b = baseName.trim();
  if (/^Large Cluster Jewel$/i.test(b)) return "/assets/sprites/poe1_JewelSocketActiveAltPurple.png";
  if (/^Medium Cluster Jewel$/i.test(b)) return "/assets/sprites/poe1_JewelSocketActiveAltBlue.png";
  if (/^Small Cluster Jewel$/i.test(b)) return "/assets/sprites/poe1_JewelSocketActiveAltRed.png";
  if (/^(?:Searching Eye|Murderous Eye|Hypnotic Eye|Ghastly Eye) Jewel$/i.test(b)) {
    return "/assets/sprites/poe1_JewelSocketActiveAbyss.png";
  }
  if (/Timeless Jewel$/i.test(b)) return "/assets/sprites/poe1_JewelSocketActiveLegion.png";
  if (/Crimson Jewel$/i.test(b)) return "/assets/sprites/poe1_JewelSocketActiveRed.png";
  if (/Viridian Jewel$/i.test(b)) return "/assets/sprites/poe1_JewelSocketActiveGreen.png";
  if (/Cobalt Jewel$/i.test(b)) return "/assets/sprites/poe1_JewelSocketActiveBlue.png";
  if (/Prismatic Jewel$/i.test(b)) return "/assets/sprites/poe1_JewelSocketActivePrismatic.png";
  return null;
}

export function jewelRadiusArtFor(gameId: string): string {
  return gameId === "poe1"
    ? "/assets/sprites/poe1_JewelCircle1.png"
    : "/assets/sprites/Jewel_ring.png";
}

export function jewelLocateArtFor(gameId: string): string {
  return gameId === "poe1"
    ? "/assets/sprites/poe1_JewelSocketAltCanAllocate.png"
    : "/assets/sprites/Jewel_glow.png";
}
