// ---------------------------------------------------------------------
// Browser game profiles — declarative facts + generic rule engine
// ---------------------------------------------------------------------
//
// This module has no DOM/window dependency. It is the one browser-side
// registry for facts that differ between PoE1 and PoE2: visible slot
// groups, catalogue families, progression budgets, jewel presentation,
// planner paths, and external integrations.
//
// Shared UI modules consume a GameProfile or the compatibility exports in
// game.ts. They must not reconstruct these facts with `gameId === ...`.

import type {
  ActorLoadoutV3,
  EquippedItemV3,
  GameId,
  PlanV3,
} from "../../../../types/shared.d.ts";
import { validatePlanV3 } from "../../../../viewer/assets/plan_v3.ts";

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

export interface GearSlotSpec {
  key: string;
  label: string;
  /** Normalized item catalogue categories accepted by this slot. */
  cat: string[];
  /** Catalogue family used for agent/mod grounding. */
  groundingKey?: string;
  /** Optional exact mined item classes. */
  itemClasses?: string[];
  /** Fallback matcher for records that predate the class field. */
  baseNamePattern?: string;
}

export interface JewelSocketPolicy {
  cluster_size?: number;
  cluster_outer?: boolean;
}

export interface JewelArtRule {
  baseNamePattern: string;
  art: string;
}

export interface OfficialInventorySlot {
  inventoryId: string;
  slotX?: number;
  slotY?: number;
  /**
   * Most targets are exact `Inventories.Id` rows and are checked against
   * the selected patch catalogue. A few Build Planner-only targets (the
   * second PoE2 flask and charm positions) are public format vocabulary
   * without ordinary table rows, so their separate ownership is explicit.
   */
  idSource?: "inventories" | "build-planner";
}

export interface OfficialBuildDefinition {
  /** GGG's public Build Planner schema version, not our adapter revision. */
  schemaVersion: 1;
  /** Native planner slot → verified `Inventories.Id` target. */
  inventorySlots: Record<string, OfficialInventorySlot>;
}

export interface PathOfBuildingDefinition {
  /** User-facing source name; PoE2 deliberately distinguishes PoB2. */
  label: string;
  /**
   * PoB targetVersion is not a Buildwright patch. The prefix is only a
   * cross-game safety signal, never a data-source selector.
   */
  targetVersionPrefix: string;
  /** Exact external inventory name → native planner slot. */
  itemSlots: Record<string, string>;
  /** Numbered external families with game-owned capacity. */
  numberedItemSlots: Array<{
    sourcePrefix: string;
    targetPrefix: string;
    count: number;
  }>;
}

export interface GameDefinition {
  id: GameId;
  label: string;
  shortLabel: string;
  plannerPath: string;
  /** What a planner page does when opened without a build id. */
  entryWithoutBuild: "mint" | "landing";
  storageNamespace: string;
  /** Prefix used by persisted patch stamps; null means the default realm. */
  patchNamespace: string | null;
  /** Source label considered stable for the navbar preview badge. */
  stableDataSource: string | null;
  budgets: {
    main: number;
    ascendancy: number;
    weaponSet: number;
  };
  features: {
    gear: boolean;
    skills: boolean;
    jewels: boolean;
    spirit: boolean;
    weaponSets: boolean;
  };
  presentation: {
    ascendancy: "in-place" | "center-panel";
    socketModel: "spirit" | "links";
  };
  integrations: {
    nativeShare: boolean;
    gggBuild: boolean;
    pobImport: "unavailable" | "planned" | "enabled";
  };
  /** Actor loadouts the game profile can validate and eventually expose
   * through the shared actor editor. */
  actorKinds: Array<{
    kind: ActorLoadoutV3["kind"];
    label: string;
    /** Exact concrete equipment positions exposed for this actor. */
    inventorySlots: string[];
  }>;
  /** External-format facts. Null is an explicit unsupported capability. */
  officialBuild: OfficialBuildDefinition | null;
  /** Path of Building vocabulary owned by this game profile. */
  pathOfBuilding: PathOfBuildingDefinition;
  slots: {
    equipment: GearSlotSpec[];
    flasks: GearSlotSpec[];
    charms: GearSlotSpec[];
  };
  /** Old persisted slot → current planner slot. */
  legacySlots: Record<string, string>;
  /** Agent/import vocabulary → first concrete planner slot. */
  slotAliases: Record<string, string>;
  /** Ordered families used when an import equips repeated slots. */
  repeatedSlotGroups: string[][];
  /** Base-name routing overrides source taxonomy (notably PoE2 Charms). */
  baseNameRoutes: Array<{ pattern: string; slot: string }>;
  jewels: {
    clusterExpansion: boolean;
    radiusArt: string;
    locateArt: string;
    nativeSocketArt: boolean;
    socketArt: JewelArtRule[];
  };
  assets: GameAssets;
}

export interface GameDataProvider {
  assets: GameAssets;
  assetUrl: (key: GameAssetKey) => string | null;
}

export interface GameRules {
  plannerSlot: (slot: string, baseName?: string) => string;
  normalizeItemSlot: (requested: string, baseName?: string) => string;
  nextRepeatedItemSlot: (slot: string) => string | null;
  groundingSlot: (slot: string) => string;
  baseAllowedForPlannerSlot: (
    slot: string,
    itemClass: string | undefined,
    baseName?: string,
  ) => boolean;
  jewelAllowedInSocket: (
    baseName: string,
    socket: JewelSocketPolicy | undefined,
  ) => boolean;
  jewelSocketArtForBase: (baseName: string) => string | null;
  actorKindAllowed: (kind: ActorLoadoutV3["kind"]) => boolean;
  actorInventorySlots: (kind: ActorLoadoutV3["kind"]) => GearSlotSpec[];
}

export interface GameProfile {
  definition: GameDefinition;
  data: GameDataProvider;
  rules: GameRules;
  integrations: GameDefinition["integrations"];
}

const ALL_WEAPONS = [
  "axe",
  "bow",
  "claw",
  "crossbow",
  "dagger",
  "fishing",
  "mace",
  "sceptre",
  "spear",
  "staff",
  "sword",
  "wand",
];
const ONE_HAND_WEAPONS = [
  "axe",
  "claw",
  "dagger",
  "mace",
  "sceptre",
  "sword",
  "wand",
];
const COMMON_SLOT_ALIASES: Record<string, string> = {
  axe: "weapon1",
  bow: "weapon1",
  claw: "weapon1",
  crossbow: "weapon1",
  dagger: "weapon1",
  fishing: "weapon1",
  mace: "weapon1",
  sceptre: "weapon1",
  spear: "weapon1",
  staff: "weapon1",
  sword: "weapon1",
  wand: "weapon1",
  talisman: "amulet",
  tincture: "flask1",
  shield: "offhand1",
  focus: "offhand1",
  quiver: "offhand1",
  ring: "ring1",
  weapon: "weapon1",
  offhand: "offhand1",
  flask: "flask1",
  life_flask: "flask1",
  mana_flask: "flask1",
};

const COMMON_POB_ITEM_SLOTS: Record<string, string> = {
  "Weapon 1": "weapon1",
  "Weapon 2": "offhand1",
  "Weapon 1 Swap": "weapon2",
  "Weapon 2 Swap": "offhand2",
  "Helmet": "helmet",
  "Body Armour": "body",
  "Gloves": "gloves",
  "Boots": "boots",
  "Amulet": "amulet",
  "Ring 1": "ring1",
  "Ring 2": "ring2",
  "Belt": "belt",
};

function equipmentSlots(offhands: string[], weapons: string[]): GearSlotSpec[] {
  return [
    { key: "weapon1", label: "Weapon 1", cat: weapons },
    { key: "offhand1", label: "Offhand 1", cat: offhands },
    {
      key: "weapon2",
      label: "Weapon 2",
      cat: weapons,
      groundingKey: "weapon1",
    },
    {
      key: "offhand2",
      label: "Offhand 2",
      cat: offhands,
      groundingKey: "offhand1",
    },
    { key: "helmet", label: "Helmet", cat: ["helmet"] },
    { key: "body", label: "Body Armour", cat: ["body"] },
    { key: "gloves", label: "Gloves", cat: ["gloves"] },
    { key: "boots", label: "Boots", cat: ["boots"] },
    { key: "amulet", label: "Amulet", cat: ["amulet", "talisman"] },
    { key: "ring1", label: "Ring 1", cat: ["ring"] },
    { key: "ring2", label: "Ring 2", cat: ["ring"], groundingKey: "ring1" },
    { key: "belt", label: "Belt", cat: ["belt"] },
    { key: "jewel", label: "Jewel", cat: ["jewel"] },
  ];
}

function repeatedSlots(
  prefix: string,
  count: number,
  cat: string[],
  groundingKey: string,
  restrictions?: Pick<GearSlotSpec, "itemClasses" | "baseNamePattern">,
): GearSlotSpec[] {
  return Array.from({ length: count }, (_, i) => ({
    key: prefix + (i + 1),
    label: prefix === "charm" ? "Charm " + (i + 1) : "Flask " + (i + 1),
    cat,
    groundingKey,
    ...restrictions,
  }));
}

const POE1: GameDefinition = {
  id: "poe1",
  label: "Path of Exile",
  shortLabel: "PoE1",
  plannerPath: "/planner-poe1.html",
  entryWithoutBuild: "mint",
  storageNamespace: "poe1-planner",
  patchNamespace: "poe1.",
  stableDataSource: null,
  budgets: { main: 123, ascendancy: 8, weaponSet: 0 },
  features: {
    gear: true,
    skills: true,
    jewels: true,
    spirit: false,
    weaponSets: false,
  },
  presentation: {
    ascendancy: "in-place",
    socketModel: "links",
  },
  integrations: {
    nativeShare: true,
    gggBuild: false,
    pobImport: "enabled",
  },
  officialBuild: null,
  pathOfBuilding: {
    label: "Path of Building",
    targetVersionPrefix: "3_",
    itemSlots: { ...COMMON_POB_ITEM_SLOTS },
    numberedItemSlots: [
      { sourcePrefix: "Flask", targetPrefix: "flask", count: 5 },
    ],
  },
  actorKinds: [
    {
      kind: "animate-guardian",
      label: "Animate Guardian",
      inventorySlots: [
        "weapon1",
        "offhand1",
        "helmet",
        "body",
        "gloves",
        "boots",
      ],
    },
    {
      kind: "mercenary",
      label: "Mercenary",
      inventorySlots: [
        "weapon1",
        "offhand1",
        "helmet",
        "body",
        "gloves",
        "boots",
        "amulet",
        "ring1",
        "ring2",
        "belt",
      ],
    },
    { kind: "minion", label: "Other minion", inventorySlots: [] },
    {
      kind: "custom",
      label: "Custom actor",
      inventorySlots: [
        "weapon1",
        "offhand1",
        "helmet",
        "body",
        "gloves",
        "boots",
        "amulet",
        "ring1",
        "ring2",
        "belt",
      ],
    },
  ],
  slots: {
    equipment: equipmentSlots(
      ["shield", "quiver", ...ONE_HAND_WEAPONS],
      ALL_WEAPONS,
    ),
    flasks: repeatedSlots("flask", 5, ["flask", "tincture"], "flask1"),
    charms: [],
  },
  legacySlots: {},
  slotAliases: {
    ...COMMON_SLOT_ALIASES,
    utility_flask: "flask1",
    charm: "charm1",
  },
  repeatedSlotGroups: [
    ["weapon1", "weapon2"],
    ["offhand1", "offhand2"],
    ["ring1", "ring2"],
    ["flask1", "flask2", "flask3", "flask4", "flask5"],
  ],
  baseNameRoutes: [],
  jewels: {
    clusterExpansion: true,
    radiusArt: "/assets/sprites/poe1_JewelCircle1.png",
    locateArt: "/assets/sprites/poe1_JewelSocketAltCanAllocate.png",
    nativeSocketArt: true,
    socketArt: [
      {
        baseNamePattern: "^Large Cluster Jewel$",
        art: "/assets/sprites/poe1_JewelSocketActiveAltPurple.png",
      },
      {
        baseNamePattern: "^Medium Cluster Jewel$",
        art: "/assets/sprites/poe1_JewelSocketActiveAltBlue.png",
      },
      {
        baseNamePattern: "^Small Cluster Jewel$",
        art: "/assets/sprites/poe1_JewelSocketActiveAltRed.png",
      },
      {
        baseNamePattern:
          "^(Searching Eye|Murderous Eye|Hypnotic Eye|Ghastly Eye) Jewel$",
        art: "/assets/sprites/poe1_JewelSocketActiveAbyss.png",
      },
      {
        baseNamePattern: "Timeless Jewel$",
        art: "/assets/sprites/poe1_JewelSocketActiveLegion.png",
      },
      {
        baseNamePattern: "^Crimson Jewel$",
        art: "/assets/sprites/poe1_JewelSocketActiveRed.png",
      },
      {
        baseNamePattern: "^Viridian Jewel$",
        art: "/assets/sprites/poe1_JewelSocketActiveGreen.png",
      },
      {
        baseNamePattern: "^Cobalt Jewel$",
        art: "/assets/sprites/poe1_JewelSocketActiveBlue.png",
      },
      {
        baseNamePattern: "^Prismatic Jewel$",
        art: "/assets/sprites/poe1_JewelSocketActivePrismatic.png",
      },
    ],
  },
  assets: {
    skillCatalogue: "/assets/poe1-agent/skill_catalogue.json",
    skillStats: "/assets/poe1-agent/skill_stats.json",
    itemCatalogue: "/assets/poe1-agent/item_catalogue.json",
    bases: "/assets/poe1-agent/bases.json",
    mods: "/assets/poe1-agent/mods.json",
    grantedSkills: null,
    jewels: "/assets/poe1-agent/jewels.json",
    spirit: null,
    buildMeta: "/assets/poe1-agent/build_meta.json",
    nodes: "/assets/poe1-agent/nodes.json",
    graph: "/assets/poe1-agent/graph.json",
    supportCompat: "/assets/poe1-agent/support_compat.json",
    capabilities: "/assets/poe1-agent/capabilities.json",
  },
};

const POE2: GameDefinition = {
  id: "poe2",
  label: "Path of Exile 2",
  shortLabel: "PoE2",
  plannerPath: "/planner.html",
  entryWithoutBuild: "landing",
  storageNamespace: "poe2-planner",
  patchNamespace: null,
  stableDataSource: "first-party",
  budgets: { main: 99, ascendancy: 8, weaponSet: 24 },
  features: {
    gear: true,
    skills: true,
    jewels: true,
    spirit: true,
    weaponSets: true,
  },
  presentation: {
    ascendancy: "center-panel",
    socketModel: "spirit",
  },
  integrations: {
    nativeShare: true,
    gggBuild: true,
    pobImport: "enabled",
  },
  officialBuild: {
    schemaVersion: 1,
    inventorySlots: {
      weapon1: { inventoryId: "Weapon1" },
      offhand1: { inventoryId: "Offhand1" },
      weapon2: { inventoryId: "Weapon2" },
      offhand2: { inventoryId: "Offhand2" },
      helmet: { inventoryId: "Helm1" },
      body: { inventoryId: "BodyArmour1" },
      gloves: { inventoryId: "Gloves1" },
      boots: { inventoryId: "Boots1" },
      amulet: { inventoryId: "Amulet1" },
      ring1: { inventoryId: "Ring1" },
      ring2: { inventoryId: "Ring2" },
      belt: { inventoryId: "Belt1" },
      flask1: { inventoryId: "Flask1" },
      flask2: { inventoryId: "Flask2", idSource: "build-planner" },
      charm1: { inventoryId: "Charm1", idSource: "build-planner" },
      charm2: { inventoryId: "Charm2", idSource: "build-planner" },
      charm3: { inventoryId: "Charm3", idSource: "build-planner" },
    },
  },
  pathOfBuilding: {
    label: "Path of Building 2",
    targetVersionPrefix: "0_",
    itemSlots: {
      ...COMMON_POB_ITEM_SLOTS,
      "Charm 1": "charm1",
      "Charm 2": "charm2",
      "Charm 3": "charm3",
    },
    numberedItemSlots: [
      { sourcePrefix: "Flask", targetPrefix: "flask", count: 2 },
    ],
  },
  actorKinds: [
    { kind: "companion", label: "Companion", inventorySlots: [] },
    { kind: "minion", label: "Other minion", inventorySlots: [] },
    {
      kind: "custom",
      label: "Custom actor",
      inventorySlots: [
        "weapon1",
        "offhand1",
        "helmet",
        "body",
        "gloves",
        "boots",
        "amulet",
        "ring1",
        "ring2",
        "belt",
      ],
    },
  ],
  slots: {
    equipment: equipmentSlots(
      ["shield", "focus", "quiver"],
      ["bow", "crossbow", "mace", "sceptre", "spear", "staff", "wand"],
    ),
    flasks: repeatedSlots(
      "flask",
      2,
      ["flask"],
      "flask",
      {
        itemClasses: ["LifeFlask", "ManaFlask"],
        baseNamePattern: "(Life|Mana) Flask$",
      },
    ),
    charms: repeatedSlots(
      "charm",
      3,
      ["flask"],
      "flask",
      {
        itemClasses: ["UtilityFlask"],
        baseNamePattern: "Charm$",
      },
    ),
  },
  legacySlots: { flask: "flask1" },
  slotAliases: {
    ...COMMON_SLOT_ALIASES,
    utility_flask: "charm1",
    charm: "charm1",
  },
  repeatedSlotGroups: [
    ["weapon1", "weapon2"],
    ["offhand1", "offhand2"],
    ["ring1", "ring2"],
    ["flask1", "flask2"],
    ["charm1", "charm2", "charm3"],
  ],
  baseNameRoutes: [{ pattern: "Charm$", slot: "charm1" }],
  jewels: {
    clusterExpansion: false,
    radiusArt: "/assets/sprites/Jewel_ring.png",
    locateArt: "/assets/sprites/Jewel_glow.png",
    nativeSocketArt: false,
    socketArt: [],
  },
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
  },
};

export const GAME_DEFINITIONS: Readonly<Record<GameId, GameDefinition>> = {
  poe1: POE1,
  poe2: POE2,
};

export function gameDefinitionFor(gameId: string): GameDefinition {
  const definition = GAME_DEFINITIONS[gameId as GameId];
  if (!definition) {
    throw new Error(
      `unsupported game ${JSON.stringify(gameId)}; expected poe1 or poe2`,
    );
  }
  return definition;
}

/** Resolve legacy plans that predate the explicit `game` field without
 * spreading patch-prefix inference across landing, share, and import code. */
export function gameDefinitionForPlan(
  plan: { game?: string; patch?: string | null },
): GameDefinition {
  if (plan.game) return gameDefinitionFor(plan.game);
  return gameDefinitionFor(
    typeof plan.patch === "string" &&
      plan.patch.startsWith(GAME_DEFINITIONS.poe1.patchNamespace!)
      ? "poe1"
      : "poe2",
  );
}

export function patchBelongsToGame(
  definition: GameDefinition,
  patch: string,
): boolean {
  if (definition.patchNamespace) {
    return patch.startsWith(definition.patchNamespace);
  }
  return !Object.values(GAME_DEFINITIONS).some((other) =>
    other.id !== definition.id &&
    !!other.patchNamespace &&
    patch.startsWith(other.patchNamespace)
  );
}

function expectedSlotGroup(
  slot: string,
): EquippedItemV3["slot"]["group"] {
  if (/^flask\d+$/.test(slot)) return "flask";
  if (/^charm\d+$/.test(slot)) return "charm";
  if (slot === "jewel") return "jewel";
  return "equipment";
}

/**
 * Validate a native document against one selected game's declarative
 * rules. `validatePlanV3` owns game-neutral shape/graph invariants; this
 * companion owns facts that must never leak between PoE1 and PoE2.
 *
 * The boundary is intentionally free of DOM/runtime globals so storage,
 * browser imports, and the Rust-owned interoperability CLI can enforce the
 * exact same rules.
 */
export function validatePlanForGameProfile(
  plan: PlanV3,
  profile: GameProfile,
): string[] {
  const issues: string[] = [];
  const definition = profile.definition;
  if (plan.game !== definition.id) {
    issues.push(`plan belongs to ${plan.game}, expected ${definition.id}`);
  }
  if (plan.patch && !patchBelongsToGame(definition, plan.patch)) {
    issues.push(
      `plan patch ${plan.patch} does not belong to ${definition.id}`,
    );
  }

  const playerSlotKeys = new Set(
    [
      ...definition.slots.equipment,
      ...definition.slots.flasks,
      ...definition.slots.charms,
    ].map((slot) => slot.key),
  );

  const validateItem = (
    stateId: string,
    owner: string,
    equipped: EquippedItemV3,
    allowedSlots: ReadonlySet<string>,
  ): void => {
    const slot = equipped.slot.id;
    if (!allowedSlots.has(slot)) {
      issues.push(
        `state ${stateId} ${owner} uses unsupported slot ${slot}`,
      );
      return;
    }
    const expectedGroup = expectedSlotGroup(slot);
    if (equipped.slot.group !== expectedGroup) {
      issues.push(
        `state ${stateId} ${owner} slot ${slot} is grouped as ` +
          `${equipped.slot.group}, expected ${expectedGroup}`,
      );
    }
    if (
      equipped.item.jewel?.cluster &&
      !definition.jewels.clusterExpansion
    ) {
      issues.push(
        `state ${stateId} ${owner} contains a cluster jewel, which ` +
          `${definition.shortLabel} does not support`,
      );
    }
    const baseName = equipped.item.base?.name ??
      equipped.item.base?.key ??
      equipped.item.name ??
      "";
    if (
      owner === "player" &&
      baseName &&
      !profile.rules.baseAllowedForPlannerSlot(slot, undefined, baseName)
    ) {
      issues.push(
        `state ${stateId} item ${equipped.id} base ${
          baseName || "(unknown)"
        } ` +
          `is not valid for ${definition.shortLabel} slot ${slot}`,
      );
    }
  };

  for (const state of plan.states) {
    for (const allocation of state.passiveTree.allocations) {
      if (
        !definition.features.weaponSets &&
        (allocation.specialization === "set1" ||
          allocation.specialization === "set2")
      ) {
        issues.push(
          `state ${state.id} passive ${allocation.nodeId} uses a ` +
            `${allocation.specialization} specialization unsupported by ` +
            definition.shortLabel,
        );
      }
    }
    for (const item of state.inventory.items) {
      validateItem(state.id, "player", item, playerSlotKeys);
    }
    for (const actor of state.actors) {
      if (!profile.rules.actorKindAllowed(actor.kind)) {
        issues.push(
          `state ${state.id} actor ${actor.id} uses unsupported ${actor.kind}`,
        );
        continue;
      }
      const actorSlots = new Set(
        profile.rules.actorInventorySlots(actor.kind).map((slot) => slot.key),
      );
      for (const item of actor.inventory?.items ?? []) {
        validateItem(
          state.id,
          `actor ${actor.id}`,
          item,
          actorSlots,
        );
      }
    }
  }
  return [...new Set(issues)];
}

/**
 * The single trust boundary for native documents. Structural validation must
 * succeed before game-specific code is allowed to dereference the document.
 */
export function validatePlanForSelectedGame(
  value: unknown,
  profile: GameProfile,
): string[] {
  const structural = validatePlanV3(value);
  if (structural.length) return structural;
  return validatePlanForGameProfile(value as PlanV3, profile);
}

function slotMap(definition: GameDefinition): Map<string, GearSlotSpec> {
  const slots = [
    ...definition.slots.equipment,
    ...definition.slots.flasks,
    ...definition.slots.charms,
  ];
  return new Map(slots.map((slot) => [slot.key, slot]));
}

function patternMatches(pattern: string | undefined, value: string): boolean {
  return !!pattern && new RegExp(pattern, "i").test(value);
}

export function createGameProfile(
  gameId: string,
  overrides?: {
    storageNamespace?: string;
    assets?: Partial<GameAssets>;
  },
): GameProfile {
  const definition = gameDefinitionFor(gameId);
  const assets = { ...definition.assets, ...(overrides?.assets ?? {}) };
  const slots = slotMap(definition);

  const plannerSlot = (slot: string, baseName = ""): string => {
    // Base-name routing only disambiguates a legacy/source-taxonomy
    // slot. A concrete slot is an explicit user choice and must never
    // be rerouted because the selected base would be invalid there.
    if (!slots.has(slot)) {
      for (const route of definition.baseNameRoutes) {
        if (patternMatches(route.pattern, baseName)) return route.slot;
      }
    }
    return definition.legacySlots[slot] ?? slot;
  };

  const rules: GameRules = {
    plannerSlot,
    normalizeItemSlot(requested: string, baseName = ""): string {
      for (const route of definition.baseNameRoutes) {
        if (patternMatches(route.pattern, baseName)) return route.slot;
      }
      const raw = requested.toLowerCase().trim();
      return definition.slotAliases[raw] ?? raw;
    },
    nextRepeatedItemSlot(slot: string): string | null {
      for (const group of definition.repeatedSlotGroups) {
        const i = group.indexOf(slot);
        if (i >= 0) return group[i + 1] ?? null;
      }
      return null;
    },
    groundingSlot(slot: string): string {
      const concrete = slots.get(plannerSlot(slot));
      return concrete?.groundingKey ?? concrete?.key ?? slot;
    },
    baseAllowedForPlannerSlot(
      slot: string,
      itemClass: string | undefined,
      baseName = "",
    ): boolean {
      const concrete = slots.get(plannerSlot(slot, baseName));
      if (!concrete) return true;
      if (itemClass && concrete.itemClasses) {
        return concrete.itemClasses.includes(itemClass);
      }
      if (concrete.baseNamePattern) {
        return patternMatches(concrete.baseNamePattern, baseName);
      }
      return true;
    },
    jewelAllowedInSocket(
      baseName: string,
      socket: JewelSocketPolicy | undefined,
    ): boolean {
      if (
        !definition.jewels.clusterExpansion ||
        !/^(Small|Medium|Large) Cluster Jewel$/i.test(baseName.trim())
      ) {
        return true;
      }
      const size = /^(Small|Medium|Large)/i.exec(baseName.trim())?.[1]
        ?.toLowerCase();
      const sizeIndex = size === "large" ? 2 : size === "medium" ? 1 : 0;
      return socket?.cluster_size != null && socket.cluster_size >= sizeIndex;
    },
    jewelSocketArtForBase(baseName: string): string | null {
      for (const rule of definition.jewels.socketArt) {
        if (patternMatches(rule.baseNamePattern, baseName.trim())) {
          return rule.art;
        }
      }
      return null;
    },
    actorKindAllowed(kind: ActorLoadoutV3["kind"]): boolean {
      return definition.actorKinds.some((candidate) => candidate.kind === kind);
    },
    actorInventorySlots(kind: ActorLoadoutV3["kind"]): GearSlotSpec[] {
      const actor = definition.actorKinds.find((candidate) =>
        candidate.kind === kind
      );
      if (!actor) return [];
      const byKey = new Map(
        definition.slots.equipment.map((slot) => [slot.key, slot]),
      );
      return actor.inventorySlots.flatMap((key) => {
        const slot = byKey.get(key);
        return slot ? [slot] : [];
      });
    },
  };

  return {
    definition: {
      ...definition,
      storageNamespace: overrides?.storageNamespace ??
        definition.storageNamespace,
      assets,
    },
    data: {
      assets,
      assetUrl(key: GameAssetKey): string | null {
        return assets[key] ?? null;
      },
    },
    rules,
    integrations: definition.integrations,
  };
}
