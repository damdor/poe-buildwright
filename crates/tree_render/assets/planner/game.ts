// Active browser profile. tree_render embeds only page/data ownership;
// game_profile.ts supplies every shared UX rule from one typed registry.
// Keep the compatibility exports while consumers migrate from GAME.*
// fields to PROFILE.definition/rules/integrations.

import {
  createGameProfile,
  gameDefinitionFor,
  type GameAssetKey,
  type GearSlotSpec,
  type JewelSocketPolicy,
} from "./game_profile.ts";
export type { GameAssets, GameAssetKey, GearSlotSpec, JewelSocketPolicy } from "./game_profile.ts";

const embedded = globalThis.window?.BuildwrightGame ?? globalThis.window?.PoE2Game;
export const PROFILE = createGameProfile(embedded?.id ?? "poe2", {
  storageNamespace: embedded?.storageNamespace,
  assets: embedded?.assets,
});
const definition = PROFILE.definition;
export const GAME = {
  schema: 2 as const,
  id: definition.id,
  label: definition.label,
  shortLabel: definition.shortLabel,
  plannerPath: definition.plannerPath,
  storageNamespace: definition.storageNamespace,
  budgets: {
    main: definition.budgets.main,
    asc: definition.budgets.ascendancy,
    weaponSet: definition.budgets.weaponSet,
  },
  features: {
    ...definition.features,
    share: definition.integrations.nativeShare,
    officialBuild: definition.integrations.gggBuild,
    ascInPlace: definition.presentation.ascendancy === "in-place",
  },
  socketModel: definition.presentation.socketModel,
  integrations: definition.integrations,
  assets: PROFILE.data.assets,
};

export function assetUrl(key: GameAssetKey): string | null {
  return PROFILE.data.assetUrl(key);
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
export const MAX_SET_POINTS  = featureOn("weaponSets") ? GAME.budgets.weaponSet : 0;
export const MAX_ASC_POINTS  = GAME.budgets?.asc ?? 8;

// Support-count model: "spirit" (PoE2 reservation) or "links" (PoE1
// item-slot sockets). Drives the skills overlay's cap + chip.
export const SOCKET_MODEL: "spirit" | "links" = GAME.socketModel === "links" ? "links" : "spirit";

/** Regular equipment slots. Flasks deliberately live in their own
 * model and visual section even though both surfaces reuse one item
 * editor and one persisted Capture.items array. */
export function gearSlotsFor(gameId: string): GearSlotSpec[] {
  return gameDefinitionFor(gameId).slots.equipment;
}

/** The flask belt is a first-class shared surface: five unrestricted
 * flask/tincture positions in PoE1; two Life/Mana positions in PoE2.
 * PoE2 keeps both positions searchable across both recovery types so
 * Waistgate's "either slot" exception remains representable. */
export function flaskSlotsFor(gameId: string): GearSlotSpec[] {
  return gameDefinitionFor(gameId).slots.flasks;
}

/** PoE2 belts expose up to three Charm sockets. They share the mined
 * flask domain with recovery flasks, but not the equipped-slot model. */
export function charmSlotsFor(gameId: string): GearSlotSpec[] {
  return gameDefinitionFor(gameId).slots.charms;
}

export const GEAR_SLOTS = gearSlotsFor(GAME.id);
export const FLASK_SLOTS = flaskSlotsFor(GAME.id);
export const CHARM_SLOTS = charmSlotsFor(GAME.id);
export const ITEM_SLOTS = [...GEAR_SLOTS, ...FLASK_SLOTS, ...CHARM_SLOTS];

/** Old PoE2 saves used the single key `flask`. Display it in the first
 * slot of the new two-position belt without mutating the save until the
 * player actually edits that item. */
export function plannerSlot(
  slot: string,
  gameId: string = GAME.id,
  baseName = "",
): string {
  return createGameProfile(gameId).rules.plannerSlot(slot, baseName);
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
  return createGameProfile(gameId).rules.baseAllowedForPlannerSlot(slot, itemClass, baseName);
}

/** Grounding data names the first instance of paired/repeated slots.
 * PoE2's existing catalogue contract calls the family `flask`; PoE1's
 * isolated catalogue calls it `flask1`. */
export function groundingSlotFor(gameId: string, slot: string): string {
  return createGameProfile(gameId).rules.groundingSlot(slot);
}

export function groundingSlot(slot: string): string {
  return groundingSlotFor(GAME.id, slot);
}

/** Agent/import vocabulary normalized through the same slot policy the item
 *  editor renders. This is deliberately exported from the profile module so
 *  aliases and repeated-slot behavior cannot drift between surfaces. */
export function normalizeItemSlotFor(
  gameId: string,
  requested: string,
  baseName = "",
): string {
  return createGameProfile(gameId).rules.normalizeItemSlot(requested, baseName);
}

export function nextRepeatedItemSlotFor(gameId: string, slot: string): string | null {
  return createGameProfile(gameId).rules.nextRepeatedItemSlot(slot);
}

/** Official PoE1 cluster-jewel bases. Expansion sockets carry a maximum
 * supported size: outer sockets accept Large/Medium/Small, Large
 * clusters generate Medium sockets, and Medium clusters generate Small
 * sockets. Ordinary jewel sockets reject every cluster size. */
export function isClusterJewelBase(baseName: string): boolean {
  return /^(?:Small|Medium|Large) Cluster Jewel$/i.test(baseName.trim());
}

export function jewelAllowedInSocket(
  gameId: string,
  baseName: string,
  socket: JewelSocketPolicy | undefined,
): boolean {
  return createGameProfile(gameId).rules.jewelAllowedInSocket(baseName, socket);
}

/** PoE1 supplies native socket-fill art in its passive-tree atlas.
 * PoE2 keeps its existing per-base sprites, so null means to use the
 * legacy `Jewel_<base>.png` chain. */
export function jewelSocketArtForBase(gameId: string, baseName: string): string | null {
  return createGameProfile(gameId).rules.jewelSocketArtForBase(baseName);
}

export function jewelRadiusArtFor(gameId: string): string {
  return gameDefinitionFor(gameId).jewels.radiusArt;
}

export function jewelLocateArtFor(gameId: string): string {
  return gameDefinitionFor(gameId).jewels.locateArt;
}
