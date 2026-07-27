// Pure version-3 character-state model.
//
// No DOM, localStorage, TREE, or active-game globals are read here. The
// editor can therefore test migration and graph operations before v3
// becomes the live persistence format.

import type {
  ActorLoadoutV3,
  Allocation,
  CharacterStateV3,
  EquippedItemV3,
  InventoryOwnerV3,
  InventoryStateV3,
  Item,
  ItemSpecV3,
  PassiveAllocationV3,
  Plan,
  PlanV3,
  Skill,
  SkillGroupV3,
  SkillLoadoutV3,
} from "../../types/shared.d.ts";

export interface StateTransitionV3 {
  fromStateId: string | null;
  toStateId: string;
  passives: {
    added: string[];
    removed: string[];
    changed: string[];
  };
  skills: {
    added: string[];
    removed: string[];
    changed: string[];
  };
  items: {
    added: string[];
    removed: string[];
    changed: string[];
  };
  actors: {
    added: string[];
    removed: string[];
    changed: string[];
  };
  characterChanged: boolean;
}

export interface ReplayFrameV3 {
  index: number;
  state: CharacterStateV3;
  transition: StateTransitionV3;
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function entity(kind: string, key: string, name?: string) {
  return name ? { kind, key, name } : { kind, key };
}

function slotGroup(slot: string): EquippedItemV3["slot"]["group"] {
  if (/^flask\d+$/i.test(slot)) return "flask";
  if (/^charm\d+$/i.test(slot)) return "charm";
  if (slot === "jewel") return "jewel";
  return "equipment";
}

function stablePart(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return clean || "unknown";
}

function skillGroups(skills: Skill[]): SkillGroupV3[] {
  const occurrences = new Map<string, number>();
  return skills.map((skill) => {
    const identity = [skill.slot || "unslotted", skill.set || "main", skill.id]
      .join("|");
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    const groupId = "skill:" + stablePart(identity) + ":" + occurrence;
    const gems: SkillGroupV3["gems"] = [{
      id: groupId + ":active",
      gem: entity("gem", skill.id),
      role: "active",
      level: skill.level,
      quality: skill.quality ?? 0,
      enabled: true,
    }];
    const supportOccurrences = new Map<string, number>();
    for (const support of skill.supports ?? []) {
      const n = supportOccurrences.get(support.id) ?? 0;
      supportOccurrences.set(support.id, n + 1);
      gems.push({
        id: groupId + ":support:" + stablePart(support.id) + ":" + n,
        gem: entity("gem", support.id),
        role: "support",
        level: support.level,
        quality: support.quality ?? 0,
        enabled: true,
        ...(support.note ? { note: support.note } : {}),
      });
    }
    return {
      id: groupId,
      ...(skill.slot ? { slot: skill.slot } : {}),
      specialization: skill.set || "main",
      enabled: true,
      gems,
      ...(skill.note ? { note: skill.note } : {}),
      ...(skill.level_interval
        ? { availableAt: copy(skill.level_interval) }
        : {}),
    };
  });
}

function itemSpec(item: Item): ItemSpecV3 {
  const spec: ItemSpecV3 = {};
  if (item.base) spec.base = entity("base", item.base, item.base);
  if (item.rarity) spec.rarity = item.rarity;
  if (item.name) spec.name = item.name;
  if (item.uniqueName) {
    spec.unique = {
      ...entity("unique", item.uniqueName, item.uniqueName),
      ...(item.officialUniqueName
        ? { source: "ggg", sourceId: item.officialUniqueName }
        : {}),
    };
  }
  if (item.mods?.length) {
    spec.mods = item.mods.map((text) => ({ kind: "explicit", text }));
  }
  if (item.itemLevel != null) spec.itemLevel = item.itemLevel;
  if (item.quality != null) spec.quality = item.quality;
  if (item.corrupted != null) spec.corrupted = item.corrupted;
  if (item.sockets?.length) spec.sockets = copy(item.sockets);
  if (item.sourceText) spec.sourceText = item.sourceText;
  if (item.socket != null || item.cluster) {
    spec.jewel = {};
    if (item.socket != null) spec.jewel.socketNodeId = String(item.socket);
    if (item.cluster) {
      spec.jewel.cluster = {
        size: item.cluster.size,
        smallPassive: entity("passive", item.cluster.skill, item.cluster.skill),
        passiveCount: item.cluster.nodeCount,
        jewelSocketCount: item.cluster.sockets,
      };
    }
  }
  return spec;
}

function equippedItems(items: Item[]): EquippedItemV3[] {
  const occurrences = new Map<string, number>();
  return items.map((item, index) => {
    const slot = item.slot || item.inventoryId || "unknown";
    const identity = slot === "jewel"
      ? [slot, item.socket ?? "unsocketed", item.name || item.base || index]
        .join("|")
      : [slot, item.set || "main"].join("|");
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return {
      id: item.id || "item:" + stablePart(identity) + ":" + occurrence,
      slot: {
        group: slotGroup(slot),
        id: slot,
        ...(item.set ? { set: item.set } : {}),
        ...(item.slotX != null ? { x: item.slotX } : {}),
        ...(item.slotY != null ? { y: item.slotY } : {}),
        ...(item.inventoryId ? { sourceId: item.inventoryId } : {}),
      },
      item: itemSpec(item),
      ...(item.note ? { note: item.note } : {}),
      ...(item.level != null ? { acquiredAtLevel: item.level } : {}),
      ...(item.level_interval
        ? { availableAt: copy(item.level_interval) }
        : {}),
    };
  });
}

export function migrateItemV2ToV3(item: Item): EquippedItemV3 {
  return equippedItems([item])[0]!;
}

function passiveAllocations(passives: Allocation[]): PassiveAllocationV3[] {
  return passives.map((allocation) => ({
    nodeId: String(allocation.id),
    specialization: allocation.set || "main",
    ...(allocation.attrVariantId ? { optionId: allocation.attrVariantId } : {}),
    ...(allocation.note ? { note: allocation.note } : {}),
    ...(allocation.level != null ? { acquiredAtLevel: allocation.level } : {}),
    ...(allocation.level_interval
      ? { availableAt: copy(allocation.level_interval) }
      : {}),
  }));
}

function inferredStateLevel(
  capture: Plan["captures"][number],
  index: number,
  count: number,
): number {
  if (index < count - 1) return capture.levelRange[1];
  const explicitLevels = [
    ...(capture.passives ?? []).map((item) => item.level),
    ...(capture.skills ?? []).map((item) => item.level_interval?.[0]),
    ...(capture.items ?? []).map((item) =>
      item.level ?? item.level_interval?.[0]
    ),
  ].filter((value): value is number =>
    typeof value === "number" && Number.isFinite(value)
  );
  const mainPoints = (capture.passives ?? [])
    .filter((item) => !item.set || item.set === "main")
    .length;
  return Math.min(
    100,
    Math.max(
      1,
      capture.levelRange[0],
      mainPoints + 1,
      ...explicitLevels,
    ),
  );
}

export function migratePlanV2ToV3(plan: Plan): PlanV3 {
  if (!plan.captures?.length) {
    throw new Error("version-2 plan has no captures");
  }
  const activeIndex =
    plan.activeCapture >= 0 && plan.activeCapture < plan.captures.length
      ? plan.activeCapture
      : plan.captures.length - 1;
  const states: CharacterStateV3[] = plan.captures.map((capture, index) => ({
    id: capture.id,
    parentId: index === 0 ? null : plan.captures[index - 1]!.id,
    order: index,
    name: capture.name || (
      plan.captures.length === 1
        ? "Current build"
        : index === 0
        ? "Starting state"
        : "State " + (index + 1)
    ),
    description: capture.description || "",
    phase: capture.statePhase ?? "leveling",
    characterLevel: capture.characterLevel ??
      inferredStateLevel(capture, index, plan.captures.length),
    recommendedLevelRange: copy(capture.levelRange),
    character: {
      class: capture.class || plan.class || null,
      ascendancy: capture.ascendancy || null,
    },
    passiveTree: { allocations: passiveAllocations(capture.passives || []) },
    skills: { groups: skillGroups(capture.skills || []) },
    inventory: { items: equippedItems(capture.items || []) },
    actors: [],
    ...(capture.gameData ? { gameData: copy(capture.gameData) } : {}),
    provenance: { source: "buildwright-v2", sourceId: capture.id },
  }));
  return {
    format: "buildwright-planner-plan",
    version: 3,
    ...(plan.id ? { id: plan.id } : {}),
    game: plan.game || (plan.patch?.startsWith("poe1.") ? "poe1" : "poe2"),
    patch: plan.patch ?? null,
    ...(plan.savedAt ? { savedAt: plan.savedAt } : {}),
    identity: {
      name: plan.name || "",
      description: plan.description || "",
      ...(plan.author ? { author: plan.author } : {}),
      ...(plan.links?.length ? { links: copy(plan.links) } : {}),
    },
    states,
    rootStateId: states[0]!.id,
    activeStateId: states[activeIndex]!.id,
    defaultLeafId: states[states.length - 1]!.id,
    editor: {
      activeSpecialization: plan.activeSet || "main",
      routeLeafId: states[states.length - 1]!.id,
    },
    ...(plan.guide ? { guide: plan.guide } : {}),
    provenance: [{
      source: "buildwright-v2",
      ...(plan.savedAt ? { importedAt: plan.savedAt } : {}),
      sourceVersion: "2",
    }],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): void {
  if (typeof record[key] !== "string") {
    errors.push(`${path}.${key} must be a string`);
  }
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): void {
  if (record[key] != null && typeof record[key] !== "string") {
    errors.push(`${path}.${key} must be a string when present`);
  }
}

function optionalNumber(
  record: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): void {
  if (record[key] != null && typeof record[key] !== "number") {
    errors.push(`${path}.${key} must be a number when present`);
  }
}

function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): void {
  if (record[key] != null && typeof record[key] !== "boolean") {
    errors.push(`${path}.${key} must be a boolean when present`);
  }
}

function recordArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): Record<string, unknown>[] | null {
  const value = record[key];
  if (!Array.isArray(value)) {
    errors.push(`${path}.${key} must be an array`);
    return null;
  }
  const records: Record<string, unknown>[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      errors.push(`${path}.${key}[${index}] must be an object`);
    } else {
      records.push(entry);
    }
  });
  return records.length === value.length ? records : null;
}

function optionalLevelInterval(
  record: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): void {
  const value = record[key];
  if (
    value != null &&
    (!Array.isArray(value) ||
      value.length !== 2 ||
      value.some((entry) => typeof entry !== "number"))
  ) {
    errors.push(`${path}.${key} must be a two-number array when present`);
  }
}

function validateEntityRefShape(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  requiredString(value, "kind", path, errors);
  requiredString(value, "key", path, errors);
  optionalString(value, "name", path, errors);
  optionalString(value, "source", path, errors);
  optionalString(value, "sourceId", path, errors);
}

function validateSkillLoadoutShape(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  const groups = recordArray(value, "groups", path, errors);
  groups?.forEach((group, groupIndex) => {
    const groupPath = `${path}.groups[${groupIndex}]`;
    requiredString(group, "id", groupPath, errors);
    optionalString(group, "label", groupPath, errors);
    optionalString(group, "slot", groupPath, errors);
    optionalString(group, "specialization", groupPath, errors);
    optionalString(group, "note", groupPath, errors);
    optionalBoolean(group, "enabled", groupPath, errors);
    optionalLevelInterval(group, "availableAt", groupPath, errors);
    const gems = recordArray(group, "gems", groupPath, errors);
    gems?.forEach((gem, gemIndex) => {
      const gemPath = `${groupPath}.gems[${gemIndex}]`;
      requiredString(gem, "id", gemPath, errors);
      requiredString(gem, "role", gemPath, errors);
      optionalString(gem, "variant", gemPath, errors);
      optionalString(gem, "note", gemPath, errors);
      optionalNumber(gem, "level", gemPath, errors);
      optionalNumber(gem, "quality", gemPath, errors);
      optionalBoolean(gem, "enabled", gemPath, errors);
      validateEntityRefShape(gem.gem, `${gemPath}.gem`, errors);
    });
  });
}

function validateInventoryShape(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  const items = recordArray(value, "items", path, errors);
  items?.forEach((equipped, itemIndex) => {
    const itemPath = `${path}.items[${itemIndex}]`;
    requiredString(equipped, "id", itemPath, errors);
    optionalString(equipped, "note", itemPath, errors);
    optionalNumber(equipped, "acquiredAtLevel", itemPath, errors);
    optionalLevelInterval(equipped, "availableAt", itemPath, errors);
    if (!isRecord(equipped.slot)) {
      errors.push(`${itemPath}.slot must be an object`);
    } else {
      requiredString(equipped.slot, "group", `${itemPath}.slot`, errors);
      requiredString(equipped.slot, "id", `${itemPath}.slot`, errors);
      optionalString(equipped.slot, "set", `${itemPath}.slot`, errors);
      optionalString(equipped.slot, "sourceId", `${itemPath}.slot`, errors);
    }
    if (!isRecord(equipped.item)) {
      errors.push(`${itemPath}.item must be an object`);
      return;
    }
    const item = equipped.item;
    optionalString(item, "rarity", `${itemPath}.item`, errors);
    optionalString(item, "name", `${itemPath}.item`, errors);
    optionalString(item, "sourceText", `${itemPath}.item`, errors);
    optionalNumber(item, "itemLevel", `${itemPath}.item`, errors);
    optionalNumber(item, "quality", `${itemPath}.item`, errors);
    optionalBoolean(item, "corrupted", `${itemPath}.item`, errors);
    if (item.base != null) {
      validateEntityRefShape(item.base, `${itemPath}.item.base`, errors);
    }
    if (item.unique != null) {
      validateEntityRefShape(item.unique, `${itemPath}.item.unique`, errors);
    }
    if (item.sockets != null) {
      const sockets = recordArray(item, "sockets", `${itemPath}.item`, errors);
      sockets?.forEach((socket, socketIndex) => {
        if (typeof socket.group !== "number") {
          errors.push(
            `${itemPath}.item.sockets[${socketIndex}].group must be a number`,
          );
        }
        optionalString(
          socket,
          "color",
          `${itemPath}.item.sockets[${socketIndex}]`,
          errors,
        );
        optionalString(
          socket,
          "kind",
          `${itemPath}.item.sockets[${socketIndex}]`,
          errors,
        );
      });
    }
    if (item.mods != null) {
      const mods = recordArray(item, "mods", `${itemPath}.item`, errors);
      mods?.forEach((mod, modIndex) => {
        const modPath = `${itemPath}.item.mods[${modIndex}]`;
        requiredString(mod, "kind", modPath, errors);
        requiredString(mod, "text", modPath, errors);
        if (
          mod.values != null &&
          (!Array.isArray(mod.values) ||
            mod.values.some((entry) => typeof entry !== "number"))
        ) {
          errors.push(`${modPath}.values must be an array of numbers`);
        }
      });
    }
    if (item.jewel != null) {
      if (!isRecord(item.jewel)) {
        errors.push(`${itemPath}.item.jewel must be an object`);
      } else {
        optionalString(
          item.jewel,
          "socketNodeId",
          `${itemPath}.item.jewel`,
          errors,
        );
        optionalString(
          item.jewel,
          "radius",
          `${itemPath}.item.jewel`,
          errors,
        );
        if (item.jewel.cluster != null) {
          if (!isRecord(item.jewel.cluster)) {
            errors.push(`${itemPath}.item.jewel.cluster must be an object`);
          } else {
            const clusterPath = `${itemPath}.item.jewel.cluster`;
            requiredString(item.jewel.cluster, "size", clusterPath, errors);
            optionalNumber(
              item.jewel.cluster,
              "passiveCount",
              clusterPath,
              errors,
            );
            optionalNumber(
              item.jewel.cluster,
              "jewelSocketCount",
              clusterPath,
              errors,
            );
            validateEntityRefShape(
              item.jewel.cluster.smallPassive,
              `${clusterPath}.smallPassive`,
              errors,
            );
            if (item.jewel.cluster.generatedNotables != null) {
              if (!Array.isArray(item.jewel.cluster.generatedNotables)) {
                errors.push(
                  `${clusterPath}.generatedNotables must be an array`,
                );
              } else {
                item.jewel.cluster.generatedNotables.forEach(
                  (notable, notableIndex) =>
                    validateEntityRefShape(
                      notable,
                      `${clusterPath}.generatedNotables[${notableIndex}]`,
                      errors,
                    ),
                );
              }
            }
          }
        }
      }
    }
  });
}

/**
 * Validate the untrusted JSON boundary before semantic code reads the
 * document. TypeScript types disappear at runtime, so storage, browser file
 * imports, and the CLI all call this with values that may be arbitrarily
 * malformed.
 */
function validatePlanV3Shape(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["plan must be a JSON object"];
  requiredString(value, "format", "plan", errors);
  if (typeof value.version !== "number") {
    errors.push("plan.version must be a number");
  }
  requiredString(value, "game", "plan", errors);
  if (value.patch !== null && typeof value.patch !== "string") {
    errors.push("plan.patch must be a string or null");
  }
  requiredString(value, "rootStateId", "plan", errors);
  requiredString(value, "activeStateId", "plan", errors);
  requiredString(value, "defaultLeafId", "plan", errors);
  if (!isRecord(value.identity)) {
    errors.push("plan.identity must be an object");
  } else {
    requiredString(value.identity, "name", "plan.identity", errors);
    requiredString(value.identity, "description", "plan.identity", errors);
    optionalString(value.identity, "author", "plan.identity", errors);
    if (value.identity.links != null) {
      const links = recordArray(
        value.identity,
        "links",
        "plan.identity",
        errors,
      );
      links?.forEach((link, linkIndex) => {
        const linkPath = `plan.identity.links[${linkIndex}]`;
        requiredString(link, "url", linkPath, errors);
        optionalString(link, "label", linkPath, errors);
      });
    }
  }
  optionalString(value, "id", "plan", errors);
  optionalString(value, "savedAt", "plan", errors);
  const states = recordArray(value, "states", "plan", errors);
  states?.forEach((state, stateIndex) => {
    const path = `plan.states[${stateIndex}]`;
    requiredString(state, "id", path, errors);
    if (state.parentId !== null && typeof state.parentId !== "string") {
      errors.push(`${path}.parentId must be a string or null`);
    }
    if (typeof state.order !== "number") {
      errors.push(`${path}.order must be a number`);
    }
    requiredString(state, "name", path, errors);
    requiredString(state, "description", path, errors);
    requiredString(state, "phase", path, errors);
    optionalNumber(state, "characterLevel", path, errors);
    optionalLevelInterval(
      state,
      "recommendedLevelRange",
      path,
      errors,
    );
    if (!isRecord(state.character)) {
      errors.push(`${path}.character must be an object`);
    } else {
      if (
        state.character.class !== null &&
        typeof state.character.class !== "string"
      ) {
        errors.push(`${path}.character.class must be a string or null`);
      }
      if (
        state.character.ascendancy !== null &&
        typeof state.character.ascendancy !== "string"
      ) {
        errors.push(`${path}.character.ascendancy must be a string or null`);
      }
      if (
        state.character.choices != null &&
        !isRecord(state.character.choices)
      ) {
        errors.push(`${path}.character.choices must be an object`);
      }
    }
    if (!isRecord(state.passiveTree)) {
      errors.push(`${path}.passiveTree must be an object`);
    } else {
      const allocations = recordArray(
        state.passiveTree,
        "allocations",
        `${path}.passiveTree`,
        errors,
      );
      allocations?.forEach((allocation, allocationIndex) => {
        const allocationPath =
          `${path}.passiveTree.allocations[${allocationIndex}]`;
        requiredString(allocation, "nodeId", allocationPath, errors);
        optionalString(
          allocation,
          "specialization",
          allocationPath,
          errors,
        );
        optionalString(allocation, "optionId", allocationPath, errors);
        optionalString(allocation, "note", allocationPath, errors);
        optionalNumber(
          allocation,
          "acquiredAtLevel",
          allocationPath,
          errors,
        );
        optionalLevelInterval(
          allocation,
          "availableAt",
          allocationPath,
          errors,
        );
      });
    }
    validateSkillLoadoutShape(state.skills, `${path}.skills`, errors);
    validateInventoryShape(state.inventory, `${path}.inventory`, errors);
    const actors = recordArray(state, "actors", path, errors);
    actors?.forEach((actor, actorIndex) => {
      const actorPath = `${path}.actors[${actorIndex}]`;
      requiredString(actor, "id", actorPath, errors);
      requiredString(actor, "kind", actorPath, errors);
      requiredString(actor, "name", actorPath, errors);
      optionalString(actor, "notes", actorPath, errors);
      if (actor.skills != null) {
        validateSkillLoadoutShape(
          actor.skills,
          `${actorPath}.skills`,
          errors,
        );
      }
      if (actor.inventory != null) {
        validateInventoryShape(
          actor.inventory,
          `${actorPath}.inventory`,
          errors,
        );
      }
    });
    if (state.gameData != null && !isRecord(state.gameData)) {
      errors.push(`${path}.gameData must be an object`);
    }
    if (state.provenance != null) {
      if (!isRecord(state.provenance)) {
        errors.push(`${path}.provenance must be an object`);
      } else {
        requiredString(
          state.provenance,
          "source",
          `${path}.provenance`,
          errors,
        );
        optionalString(
          state.provenance,
          "sourceId",
          `${path}.provenance`,
          errors,
        );
      }
    }
  });
  if (value.editor != null) {
    if (!isRecord(value.editor)) {
      errors.push("plan.editor must be an object");
    } else {
      optionalString(
        value.editor,
        "activeSpecialization",
        "plan.editor",
        errors,
      );
      optionalString(value.editor, "routeLeafId", "plan.editor", errors);
    }
  }
  optionalString(value, "guide", "plan", errors);
  if (value.provenance != null) {
    const provenance = recordArray(value, "provenance", "plan", errors);
    provenance?.forEach((entry, entryIndex) => {
      const path = `plan.provenance[${entryIndex}]`;
      requiredString(entry, "source", path, errors);
      optionalString(entry, "importedAt", path, errors);
      optionalString(entry, "sourceUrl", path, errors);
      optionalString(entry, "sourceVersion", path, errors);
    });
  }
  return [...new Set(errors)];
}

export function validatePlanV3(value: unknown): string[] {
  const shapeErrors = validatePlanV3Shape(value);
  if (shapeErrors.length) return shapeErrors;
  const plan = value as PlanV3;
  const errors: string[] = [];
  const phases = new Set([
    "leveling",
    "early-endgame",
    "endgame",
    "aspirational",
    "custom",
  ]);
  const gemRoles = new Set(["active", "support", "meta", "granted"]);
  const actorKinds = new Set<ActorLoadoutV3["kind"]>([
    "mercenary",
    "animate-guardian",
    "companion",
    "minion",
    "custom",
  ]);
  if (plan.version !== 3 || plan.format !== "buildwright-planner-plan") {
    errors.push("not a Buildwright version-3 plan");
  }
  if (plan.game !== "poe1" && plan.game !== "poe2") {
    errors.push(`unsupported game ${String(plan.game)}`);
  }
  if (!plan.states.length) {
    errors.push("states must contain at least one state");
    return errors;
  }
  const byId = new Map<string, CharacterStateV3>();
  for (const state of plan.states) {
    if (!state.id) errors.push("state id must not be empty");
    if (byId.has(state.id)) errors.push(`duplicate state id ${state.id}`);
    if (!Number.isInteger(state.order) || state.order < 0) {
      errors.push(`state ${state.id} has invalid order`);
    }
    if (!phases.has(state.phase)) {
      errors.push(`state ${state.id} has unknown phase ${state.phase}`);
    }
    if (
      state.characterLevel != null &&
      (!Number.isInteger(state.characterLevel) ||
        state.characterLevel < 1 || state.characterLevel > 100)
    ) {
      errors.push(`state ${state.id} has invalid characterLevel`);
    }
    if (state.recommendedLevelRange) {
      const [from, to] = state.recommendedLevelRange;
      if (
        !Number.isInteger(from) || !Number.isInteger(to) ||
        from < 1 || to > 100 || from > to
      ) {
        errors.push(`state ${state.id} has invalid recommendedLevelRange`);
      }
    }
    const actorIds = new Set<string>();
    const itemOwners = new Map<string, string>();
    const validateInterval = (
      value: [number, number] | undefined,
      path: string,
    ): void => {
      if (!value) return;
      const [from, to] = value;
      if (
        !Number.isInteger(from) || !Number.isInteger(to) ||
        from < 1 || to > 100 || from > to
      ) {
        errors.push(`${path} has invalid availableAt`);
      }
    };
    const allocationKeys = new Set<string>();
    for (const allocation of state.passiveTree.allocations) {
      if (!allocation.nodeId.trim()) {
        errors.push(`state ${state.id} has a passive with an empty nodeId`);
      }
      const key = [
        allocation.nodeId,
        allocation.specialization || "main",
      ].join("|");
      if (allocationKeys.has(key)) {
        errors.push(
          `state ${state.id} repeats passive ${allocation.nodeId} for ` +
            `${allocation.specialization || "main"}`,
        );
      }
      allocationKeys.add(key);
      if (
        allocation.acquiredAtLevel != null &&
        (!Number.isInteger(allocation.acquiredAtLevel) ||
          allocation.acquiredAtLevel < 1 ||
          allocation.acquiredAtLevel > 100)
      ) {
        errors.push(
          `state ${state.id} passive ${allocation.nodeId} has invalid acquiredAtLevel`,
        );
      }
      validateInterval(
        allocation.availableAt,
        `state ${state.id} passive ${allocation.nodeId}`,
      );
    }
    const validateSkills = (
      loadout: SkillLoadoutV3 | undefined,
      owner: string,
    ): void => {
      const groupIds = new Set<string>();
      const gemIds = new Set<string>();
      for (const group of loadout?.groups ?? []) {
        if (!group.id.trim()) {
          errors.push(`state ${state.id} ${owner} has an empty skill-group id`);
        } else if (groupIds.has(group.id)) {
          errors.push(
            `state ${state.id} ${owner} repeats skill group ${group.id}`,
          );
        }
        groupIds.add(group.id);
        validateInterval(
          group.availableAt,
          `state ${state.id} ${owner} skill group ${group.id}`,
        );
        for (const gem of group.gems) {
          if (!gem.id.trim()) {
            errors.push(
              `state ${state.id} ${owner} skill group ${group.id} has an empty gem id`,
            );
          } else if (gemIds.has(gem.id)) {
            errors.push(
              `state ${state.id} ${owner} repeats gem instance ${gem.id}`,
            );
          }
          gemIds.add(gem.id);
          if (!gemRoles.has(gem.role)) {
            errors.push(
              `state ${state.id} gem ${gem.id} has unknown role ${gem.role}`,
            );
          }
          if (!gem.gem.kind.trim() || !gem.gem.key.trim()) {
            errors.push(
              `state ${state.id} gem ${gem.id} has an invalid entity reference`,
            );
          }
          if (
            gem.level != null &&
            (!Number.isInteger(gem.level) || gem.level < 0)
          ) {
            errors.push(`state ${state.id} gem ${gem.id} has invalid level`);
          }
          if (gem.quality != null && !Number.isFinite(gem.quality)) {
            errors.push(`state ${state.id} gem ${gem.id} has invalid quality`);
          }
        }
      }
    };
    validateSkills(state.skills, "player");
    const validateInventory = (
      inventory: InventoryStateV3 | undefined,
      owner: string,
    ): void => {
      const occupiedSlots = new Set<string>();
      for (const equipped of inventory?.items ?? []) {
        if (!equipped.id.trim()) {
          errors.push(`state ${state.id} has an item with an empty id`);
        } else {
          const previousOwner = itemOwners.get(equipped.id);
          if (previousOwner) {
            errors.push(
              `state ${state.id} item ${equipped.id} belongs to both ` +
                `${previousOwner} and ${owner}`,
            );
          } else {
            itemOwners.set(equipped.id, owner);
          }
        }
        if (!equipped.slot.group.trim() || !equipped.slot.id.trim()) {
          errors.push(
            `state ${state.id} item ${
              equipped.id || "(empty)"
            } has an invalid slot`,
          );
        }
        if (equipped.slot.group !== "jewel") {
          const slotKey = [
            equipped.slot.group,
            equipped.slot.id,
            equipped.slot.set || "main",
          ].join("|");
          if (occupiedSlots.has(slotKey)) {
            errors.push(
              `state ${state.id} ${owner} has more than one item in slot ${equipped.slot.id}`,
            );
          } else {
            occupiedSlots.add(slotKey);
          }
        }
        if (
          equipped.acquiredAtLevel != null &&
          (!Number.isInteger(equipped.acquiredAtLevel) ||
            equipped.acquiredAtLevel < 1 || equipped.acquiredAtLevel > 100)
        ) {
          errors.push(
            `state ${state.id} item ${
              equipped.id || "(empty)"
            } has invalid acquiredAtLevel`,
          );
        }
        validateInterval(
          equipped.availableAt,
          `state ${state.id} item ${equipped.id || "(empty)"}`,
        );
        if (
          equipped.item.itemLevel != null &&
          (!Number.isInteger(equipped.item.itemLevel) ||
            equipped.item.itemLevel < 0)
        ) {
          errors.push(
            `state ${state.id} item ${
              equipped.id || "(empty)"
            } has invalid itemLevel`,
          );
        }
        if (
          equipped.item.quality != null &&
          !Number.isFinite(equipped.item.quality)
        ) {
          errors.push(
            `state ${state.id} item ${
              equipped.id || "(empty)"
            } has invalid quality`,
          );
        }
        for (const socket of equipped.item.sockets ?? []) {
          if (!Number.isInteger(socket.group) || socket.group < 0) {
            errors.push(
              `state ${state.id} item ${
                equipped.id || "(empty)"
              } has an invalid socket group`,
            );
          }
          if (socket.color != null && !socket.color.trim()) {
            errors.push(
              `state ${state.id} item ${
                equipped.id || "(empty)"
              } has an empty socket color`,
            );
          }
          if (socket.kind != null && !socket.kind.trim()) {
            errors.push(
              `state ${state.id} item ${
                equipped.id || "(empty)"
              } has an empty socket kind`,
            );
          }
        }
        for (const mod of equipped.item.mods ?? []) {
          if (!mod.text.trim()) {
            errors.push(
              `state ${state.id} item ${
                equipped.id || "(empty)"
              } has a mod with empty text`,
            );
          }
          if (mod.values?.some((value) => !Number.isFinite(value))) {
            errors.push(
              `state ${state.id} item ${
                equipped.id || "(empty)"
              } has non-finite mod values`,
            );
          }
        }
      }
    };
    validateInventory(state.inventory, "player");
    for (const actor of state.actors) {
      if (!actor.id.trim()) {
        errors.push(`state ${state.id} has an actor with an empty id`);
      } else if (actorIds.has(actor.id)) {
        errors.push(`state ${state.id} has duplicate actor id ${actor.id}`);
      } else {
        actorIds.add(actor.id);
      }
      if (!actor.name.trim()) {
        errors.push(
          `state ${state.id} actor ${actor.id || "(empty)"} has an empty name`,
        );
      }
      if (!actorKinds.has(actor.kind)) {
        errors.push(
          `state ${state.id} actor ${
            actor.id || "(empty)"
          } has unknown kind ${actor.kind}`,
        );
      }
      validateSkills(actor.skills, `actor ${actor.id || "(empty)"}`);
      validateInventory(actor.inventory, `actor ${actor.id || "(empty)"}`);
    }
    byId.set(state.id, state);
  }
  const roots = plan.states.filter((state) => state.parentId == null);
  if (roots.length !== 1) {
    errors.push(`expected one root state, found ${roots.length}`);
  }
  if (!byId.has(plan.rootStateId)) errors.push("rootStateId does not exist");
  if (roots[0] && roots[0].id !== plan.rootStateId) {
    errors.push("rootStateId does not name the parentless state");
  }
  if (!byId.has(plan.activeStateId)) {
    errors.push("activeStateId does not exist");
  }
  if (!byId.has(plan.defaultLeafId)) {
    errors.push("defaultLeafId does not exist");
  }
  if (
    byId.has(plan.defaultLeafId) &&
    plan.states.some((state) => state.parentId === plan.defaultLeafId)
  ) {
    errors.push("defaultLeafId must name a leaf state");
  }
  if (plan.editor?.routeLeafId && !byId.has(plan.editor.routeLeafId)) {
    errors.push("editor routeLeafId does not exist");
  }
  for (const state of plan.states) {
    if (state.parentId != null && !byId.has(state.parentId)) {
      errors.push(`state ${state.id} has unknown parent ${state.parentId}`);
    }
    const seen = new Set<string>();
    let current: CharacterStateV3 | undefined = state;
    while (current) {
      if (seen.has(current.id)) {
        errors.push(`state graph contains a cycle through ${current.id}`);
        break;
      }
      seen.add(current.id);
      current = current.parentId == null
        ? undefined
        : byId.get(current.parentId);
    }
  }
  return [...new Set(errors)];
}

export function routeToState(
  plan: PlanV3,
  stateId: string,
): CharacterStateV3[] {
  const byId = new Map(plan.states.map((state) => [state.id, state]));
  const route: CharacterStateV3[] = [];
  const seen = new Set<string>();
  let current = byId.get(stateId);
  if (!current) throw new Error(`unknown state ${stateId}`);
  while (current) {
    if (seen.has(current.id)) {
      throw new Error(`state graph cycle at ${current.id}`);
    }
    seen.add(current.id);
    route.push(current);
    current = current.parentId == null ? undefined : byId.get(current.parentId);
    if (!current && route.at(-1)?.parentId != null) {
      throw new Error(`state route has an unknown parent`);
    }
  }
  route.reverse();
  if (route[0]?.id !== plan.rootStateId) {
    throw new Error(
      `state ${stateId} is not descended from root ${plan.rootStateId}`,
    );
  }
  return route;
}

function stateById(plan: PlanV3, stateId: string): CharacterStateV3 {
  const state = plan.states.find((candidate) => candidate.id === stateId);
  if (!state) throw new Error(`unknown state ${stateId}`);
  return state;
}

function inventoryForOwner(
  state: CharacterStateV3,
  owner: InventoryOwnerV3,
  create: boolean,
): InventoryStateV3 {
  if (owner.kind === "player") return state.inventory;
  const actor = state.actors.find((candidate) =>
    candidate.id === owner.actorId
  );
  if (!actor) {
    throw new Error(`unknown actor ${owner.actorId} in state ${state.id}`);
  }
  if (!actor.inventory) {
    if (!create) throw new Error(`actor ${owner.actorId} has no inventory`);
    actor.inventory = { items: [] };
  }
  return actor.inventory;
}

function ownerLabel(owner: InventoryOwnerV3): string {
  return owner.kind === "player" ? "player" : `actor ${owner.actorId}`;
}

function installValidatedMutation(plan: PlanV3): PlanV3 {
  const errors = validatePlanV3(plan);
  if (errors.length) throw new Error(errors.join("; "));
  return plan;
}

/** Add or replace one actor loadout in a state without sharing mutable data
 * with sibling states. Game-specific actor permissions belong to the
 * selected GameProfile and are checked by the browser API. */
export function upsertActor(
  plan: PlanV3,
  stateId: string,
  actor: ActorLoadoutV3,
): PlanV3 {
  const next = copy(plan);
  const state = stateById(next, stateId);
  const index = state.actors.findIndex((candidate) =>
    candidate.id === actor.id
  );
  if (index >= 0) state.actors[index] = copy(actor);
  else state.actors.push(copy(actor));
  return installValidatedMutation(next);
}

export function removeActor(
  plan: PlanV3,
  stateId: string,
  actorId: string,
): PlanV3 {
  const next = copy(plan);
  const state = stateById(next, stateId);
  const index = state.actors.findIndex((candidate) => candidate.id === actorId);
  if (index < 0) {
    throw new Error(`unknown actor ${actorId} in state ${stateId}`);
  }
  state.actors.splice(index, 1);
  return installValidatedMutation(next);
}

/** Add or replace a stable item instance in exactly one inventory. Reusing
 * its id under another owner is refused instead of silently moving it. */
export function upsertInventoryItem(
  plan: PlanV3,
  stateId: string,
  owner: InventoryOwnerV3,
  equipped: EquippedItemV3,
): PlanV3 {
  const next = copy(plan);
  const state = stateById(next, stateId);
  for (const existing of state.inventory.items) {
    if (existing.id === equipped.id && owner.kind !== "player") {
      throw new Error(`item ${equipped.id} already belongs to player`);
    }
  }
  for (const actor of state.actors) {
    if (
      actor.inventory?.items.some((existing) => existing.id === equipped.id) &&
      (owner.kind !== "actor" || owner.actorId !== actor.id)
    ) {
      throw new Error(
        `item ${equipped.id} already belongs to actor ${actor.id}`,
      );
    }
  }
  const inventory = inventoryForOwner(state, owner, true);
  if (equipped.slot.group !== "jewel") {
    inventory.items = inventory.items.filter((existing) =>
      existing.id === equipped.id ||
      existing.slot.group !== equipped.slot.group ||
      existing.slot.id !== equipped.slot.id ||
      (existing.slot.set || "main") !== (equipped.slot.set || "main")
    );
  }
  const index = inventory.items.findIndex((existing) =>
    existing.id === equipped.id
  );
  if (index >= 0) inventory.items[index] = copy(equipped);
  else inventory.items.push(copy(equipped));
  return installValidatedMutation(next);
}

export function removeInventoryItem(
  plan: PlanV3,
  stateId: string,
  owner: InventoryOwnerV3,
  itemId: string,
): PlanV3 {
  const next = copy(plan);
  const state = stateById(next, stateId);
  const inventory = inventoryForOwner(state, owner, false);
  const index = inventory.items.findIndex((item) => item.id === itemId);
  if (index < 0) {
    throw new Error(
      `unknown item ${itemId} for ${ownerLabel(owner)} in state ${stateId}`,
    );
  }
  inventory.items.splice(index, 1);
  return installValidatedMutation(next);
}

function uniqueStateId(plan: PlanV3, requested: string): string {
  const base = stablePart(requested || "state");
  if (!plan.states.some((state) => state.id === base)) return base;
  let suffix = 2;
  while (plan.states.some((state) => state.id === `${base}-${suffix}`)) {
    suffix++;
  }
  return `${base}-${suffix}`;
}

/** Create a complete child keyframe by deep-copying its parent. */
export function addChildState(
  plan: PlanV3,
  parentId: string,
  input: {
    id?: string;
    name?: string;
    phase?: CharacterStateV3["phase"];
    characterLevel?: number;
    recommendedLevelRange?: [number, number];
    makeDefault?: boolean;
  } = {},
): PlanV3 {
  const next = copy(plan);
  const parent = stateById(next, parentId);
  const siblings = next.states.filter((state) => state.parentId === parentId);
  const id = uniqueStateId(next, input.id || input.name || `${parent.id}-next`);
  const child: CharacterStateV3 = {
    ...copy(parent),
    id,
    parentId,
    order: siblings.reduce((max, state) => Math.max(max, state.order), -1) + 1,
    name: input.name || "New state",
    phase: input.phase || parent.phase,
    ...(input.characterLevel != null
      ? { characterLevel: input.characterLevel }
      : {}),
    ...(input.recommendedLevelRange
      ? { recommendedLevelRange: copy(input.recommendedLevelRange) }
      : {}),
    provenance: { source: "native", sourceId: parent.id },
  };
  next.states.push(child);
  next.activeStateId = id;
  next.editor = { ...(next.editor ?? {}), routeLeafId: id };
  if (input.makeDefault !== false || plan.defaultLeafId === parentId) {
    next.defaultLeafId = id;
  }
  return next;
}

function descendantIds(plan: PlanV3, stateId: string): Set<string> {
  const descendants = new Set<string>();
  const queue = [stateId];
  while (queue.length) {
    const current = queue.shift()!;
    for (
      const child of plan.states.filter((state) => state.parentId === current)
    ) {
      if (descendants.has(child.id)) continue;
      descendants.add(child.id);
      queue.push(child.id);
    }
  }
  return descendants;
}

function preferredLeafFrom(plan: PlanV3, stateId: string): string {
  let current = stateById(plan, stateId);
  for (;;) {
    const children = plan.states
      .filter((state) => state.parentId === current.id)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    if (!children.length) return current.id;
    current = children[0]!;
  }
}

/** Reparent a complete subtree. Cycles and attempts to move the root are
 * rejected before a copy is returned. */
export function reparentState(
  plan: PlanV3,
  stateId: string,
  parentId: string,
): PlanV3 {
  if (stateId === plan.rootStateId) {
    throw new Error("the root state cannot be reparented");
  }
  stateById(plan, parentId);
  const descendants = descendantIds(plan, stateId);
  if (parentId === stateId || descendants.has(parentId)) {
    throw new Error("reparenting would create a state cycle");
  }
  const next = copy(plan);
  const state = stateById(next, stateId);
  state.parentId = parentId;
  const siblings = next.states.filter((candidate) =>
    candidate.parentId === parentId && candidate.id !== stateId
  );
  state.order =
    siblings.reduce((max, candidate) => Math.max(max, candidate.order), -1) + 1;
  const errors = validatePlanV3(next);
  if (errors.length) throw new Error(errors.join("; "));
  return next;
}

/** Delete one non-root state and every descendant. Active/default pointers
 * fall back to the deleted subtree's former parent. */
export function removeStateSubtree(plan: PlanV3, stateId: string): PlanV3 {
  if (stateId === plan.rootStateId) {
    throw new Error("the root state cannot be deleted");
  }
  const target = stateById(plan, stateId);
  const remove = descendantIds(plan, stateId);
  remove.add(stateId);
  const next = copy(plan);
  next.states = next.states.filter((state) => !remove.has(state.id));
  const fallback = target.parentId!;
  const fallbackLeaf = preferredLeafFrom(next, fallback);
  if (remove.has(next.activeStateId)) next.activeStateId = fallback;
  if (remove.has(next.defaultLeafId)) next.defaultLeafId = fallbackLeaf;
  if (next.editor?.routeLeafId && remove.has(next.editor.routeLeafId)) {
    next.editor.routeLeafId = fallbackLeaf;
  }
  const errors = validatePlanV3(next);
  if (errors.length) throw new Error(errors.join("; "));
  return next;
}

/** Stable sibling reordering; graph ancestry and state payloads are
 * unchanged. */
export function reorderState(
  plan: PlanV3,
  stateId: string,
  newIndex: number,
): PlanV3 {
  const next = copy(plan);
  const state = stateById(next, stateId);
  const siblings = next.states
    .filter((candidate) => candidate.parentId === state.parentId)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const oldIndex = siblings.findIndex((candidate) => candidate.id === stateId);
  const bounded = Math.max(
    0,
    Math.min(siblings.length - 1, Math.trunc(newIndex)),
  );
  siblings.splice(oldIndex, 1);
  siblings.splice(bounded, 0, state);
  siblings.forEach((candidate, index) => {
    candidate.order = index;
  });
  return next;
}

function mapDiff<T>(
  before: T[],
  after: T[],
  key: (value: T) => string,
): { added: string[]; removed: string[]; changed: string[] } {
  const a = new Map(before.map((value) => [key(value), canonicalValue(value)]));
  const b = new Map(after.map((value) => [key(value), canonicalValue(value)]));
  const added = [...b.keys()].filter((id) => !a.has(id)).sort();
  const removed = [...a.keys()].filter((id) => !b.has(id)).sort();
  const changed = [...b.keys()]
    .filter((id) => a.has(id) && a.get(id) !== b.get(id))
    .sort();
  return { added, removed, changed };
}

function canonicalValue(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalValue).join(",") + "]";
  }
  if (value && typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => JSON.stringify(key) + ":" + canonicalValue(item))
      .join(",") +
      "}";
  }
  return JSON.stringify(value);
}

function passiveKey(allocation: PassiveAllocationV3): string {
  return [
    allocation.nodeId,
    allocation.specialization || "main",
  ].join("|");
}

function itemKey(item: EquippedItemV3): string {
  return [item.slot.group, item.slot.id, item.slot.set || "main", item.id].join(
    "|",
  );
}

export function transitionBetweenStates(
  from: CharacterStateV3 | null,
  to: CharacterStateV3,
): StateTransitionV3 {
  return {
    fromStateId: from?.id ?? null,
    toStateId: to.id,
    passives: mapDiff(
      from?.passiveTree.allocations ?? [],
      to.passiveTree.allocations,
      passiveKey,
    ),
    skills: mapDiff(
      from?.skills.groups ?? [],
      to.skills.groups,
      (group) => group.id,
    ),
    items: mapDiff(from?.inventory.items ?? [], to.inventory.items, itemKey),
    actors: mapDiff(from?.actors ?? [], to.actors, (actor) => actor.id),
    characterChanged: !from ||
      canonicalValue(from.character) !== canonicalValue(to.character),
  };
}

export function replayFramesForRoute(
  plan: PlanV3,
  leafId = plan.editor?.routeLeafId ?? plan.defaultLeafId,
): ReplayFrameV3[] {
  const route = routeToState(plan, leafId);
  return route.map((state, index) => ({
    index,
    state,
    transition: transitionBetweenStates(
      index > 0 ? route[index - 1]! : null,
      state,
    ),
  }));
}

function allocationV2(allocation: PassiveAllocationV3): Allocation {
  return {
    id: allocation.nodeId,
    set: (allocation.specialization || "main") as Allocation["set"],
    ...(allocation.optionId ? { attrVariantId: allocation.optionId } : {}),
    ...(allocation.note ? { note: allocation.note } : {}),
    ...(allocation.acquiredAtLevel != null
      ? { level: allocation.acquiredAtLevel }
      : {}),
    ...(allocation.availableAt
      ? { level_interval: copy(allocation.availableAt) }
      : {}),
  };
}

function skillsV2(groups: SkillGroupV3[]): Skill[] {
  return groups.flatMap((group) => {
    const active = group.gems.find((gem) => gem.role === "active");
    if (!active) return [];
    return [{
      id: active.gem.key,
      level: active.level ?? 1,
      quality: active.quality ?? 0,
      set: (group.specialization || "main") as Skill["set"],
      ...(group.slot ? { slot: group.slot } : {}),
      ...(group.note ? { note: group.note } : {}),
      supports: group.gems
        .filter((gem) => gem.role === "support")
        .map((gem) => ({
          id: gem.gem.key,
          level: gem.level ?? 1,
          quality: gem.quality ?? 0,
          ...(gem.note ? { note: gem.note } : {}),
        })),
      ...(group.availableAt ? { level_interval: copy(group.availableAt) } : {}),
    }];
  });
}

function itemsV2(items: EquippedItemV3[]): Item[] {
  return items.map((equipped) => {
    const item: Item = {
      id: equipped.id,
      slot: equipped.slot.id,
      ...(equipped.slot.set ? { set: equipped.slot.set as Item["set"] } : {}),
      ...(equipped.note ? { note: equipped.note } : {}),
      ...(equipped.slot.sourceId
        ? { inventoryId: equipped.slot.sourceId }
        : {}),
      ...(equipped.slot.x != null ? { slotX: equipped.slot.x } : {}),
      ...(equipped.slot.y != null ? { slotY: equipped.slot.y } : {}),
      ...(equipped.item.name ? { name: equipped.item.name } : {}),
      ...(equipped.item.base
        ? { base: equipped.item.base.name || equipped.item.base.key }
        : {}),
      ...(equipped.item.rarity ? { rarity: equipped.item.rarity } : {}),
      ...(equipped.item.unique
        ? {
          uniqueName: equipped.item.unique.name || equipped.item.unique.key,
          ...(equipped.item.unique.source === "ggg" &&
              equipped.item.unique.sourceId
            ? { officialUniqueName: equipped.item.unique.sourceId }
            : {}),
        }
        : {}),
      ...(equipped.item.mods?.length
        ? { mods: equipped.item.mods.map((mod) => mod.text) }
        : {}),
      ...(equipped.item.itemLevel != null
        ? { itemLevel: equipped.item.itemLevel }
        : {}),
      ...(equipped.item.quality != null
        ? { quality: equipped.item.quality }
        : {}),
      ...(equipped.item.corrupted != null
        ? { corrupted: equipped.item.corrupted }
        : {}),
      ...(equipped.item.sockets?.length
        ? { sockets: copy(equipped.item.sockets) }
        : {}),
      ...(equipped.item.sourceText
        ? { sourceText: equipped.item.sourceText }
        : {}),
      ...(equipped.acquiredAtLevel != null
        ? { level: equipped.acquiredAtLevel }
        : {}),
      ...(equipped.availableAt
        ? { level_interval: copy(equipped.availableAt) }
        : {}),
    };
    if (equipped.item.jewel?.socketNodeId != null) {
      const numeric = Number(equipped.item.jewel.socketNodeId);
      item.socket = Number.isFinite(numeric) ? numeric : undefined;
    }
    const cluster = equipped.item.jewel?.cluster;
    if (cluster) {
      item.cluster = {
        size: cluster.size,
        skill: cluster.smallPassive.key,
        nodeCount: cluster.passiveCount,
        sockets: cluster.jewelSocketCount,
      };
    }
    return item;
  });
}

export function projectEquippedItemV3ToV2(item: EquippedItemV3): Item {
  return itemsV2([item])[0]!;
}

/** Compatibility view for current capture-based consumers. Only one
 * selected route can be projected; native sibling branches remain in v3. */
export function projectPlanV3ToV2(
  plan: PlanV3,
  leafId = plan.editor?.routeLeafId ?? plan.defaultLeafId,
): Plan {
  const route = routeToState(plan, leafId);
  const activeOnRoute = route.findIndex((state) =>
    state.id === plan.activeStateId
  );
  const captures = route.map((state, index) => {
    const fallbackLevel = Math.min(
      100,
      Math.max(1, state.characterLevel ?? index + 1),
    );
    const range = state.recommendedLevelRange
      ? copy(state.recommendedLevelRange)
      : [fallbackLevel, fallbackLevel] as [number, number];
    return {
      id: state.id,
      levelRange: range,
      name: state.name || null,
      passives: state.passiveTree.allocations.map(allocationV2),
      skills: skillsV2(state.skills.groups),
      items: itemsV2(state.inventory.items),
      ascendancy: state.character.ascendancy,
      description: state.description,
      ...(state.character.class ? { class: state.character.class } : {}),
      characterLevel: state.characterLevel,
      statePhase: state.phase,
      ...(state.gameData ? { gameData: copy(state.gameData) } : {}),
    };
  });
  const active = activeOnRoute >= 0 ? activeOnRoute : captures.length - 1;
  return {
    ...(plan.id ? { id: plan.id } : {}),
    format: "buildwright-planner-plan",
    version: 2,
    ...(plan.savedAt ? { savedAt: plan.savedAt } : {}),
    game: plan.game,
    name: plan.identity.name,
    description: plan.identity.description,
    ...(plan.identity.author ? { author: plan.identity.author } : {}),
    ...(plan.identity.links?.length
      ? { links: copy(plan.identity.links) }
      : {}),
    class: route[active]?.character.class ?? route.at(-1)?.character.class ??
      null,
    patch: plan.patch,
    captures,
    activeCapture: active,
    activeSet: plan.editor?.activeSpecialization || "main",
    ...(plan.guide ? { guide: plan.guide } : {}),
  };
}

function mergeInventoryItem(
  previous: EquippedItemV3 | undefined,
  visible: EquippedItemV3,
): EquippedItemV3 {
  if (!previous) return copy(visible);
  const merged = copy(visible);
  // The v2 compatibility editor cannot represent these native fields.
  // Preserve them while updating every field that editor can actually see.
  for (
    const key of [
      "itemLevel",
      "quality",
      "corrupted",
      "sockets",
      "sourceText",
    ] as const
  ) {
    if (previous.item[key] !== undefined) {
      (merged.item as Record<string, unknown>)[key] = copy(previous.item[key]);
    }
  }
  for (const key of ["base", "unique"] as const) {
    const before = previous.item[key];
    const after = merged.item[key];
    if (!before || !after) continue;
    const sameEntity = before.key === after.key ||
      (!!before.name && before.name === after.name);
    if (!sameEntity) continue;
    if (!after.source && before.source) after.source = before.source;
    if (!after.sourceId && before.sourceId) after.sourceId = before.sourceId;
  }
  if (merged.item.mods?.length && previous.item.mods?.length) {
    const previousByText = new Map<string, typeof previous.item.mods>();
    for (const mod of previous.item.mods) {
      const matches = previousByText.get(mod.text) ?? [];
      matches.push(mod);
      previousByText.set(mod.text, matches);
    }
    merged.item.mods = merged.item.mods.map((mod) => {
      const matches = previousByText.get(mod.text);
      const before = matches?.shift();
      return before ? { ...copy(before), text: mod.text } : mod;
    });
  }
  if (
    previous.item.jewel?.radius &&
    !merged.item.jewel?.radius
  ) {
    merged.item.jewel = {
      ...(merged.item.jewel ?? {}),
      radius: previous.item.jewel.radius,
    };
  }
  return merged;
}

function mergeVisibleState(
  previous: CharacterStateV3,
  visible: CharacterStateV3,
): CharacterStateV3 {
  const previousItems = new Map(
    previous.inventory.items.map((item) => [item.id, item]),
  );
  return {
    ...copy(previous),
    name: visible.name,
    description: visible.description,
    characterLevel: visible.characterLevel,
    recommendedLevelRange: visible.recommendedLevelRange
      ? copy(visible.recommendedLevelRange)
      : undefined,
    character: {
      ...copy(previous.character),
      class: visible.character.class,
      ascendancy: visible.character.ascendancy,
    },
    passiveTree: copy(visible.passiveTree),
    skills: copy(visible.skills),
    inventory: {
      items: visible.inventory.items.map((item) =>
        mergeInventoryItem(previousItems.get(item.id), item)
      ),
    },
    // Actors, phase, gameData, provenance, parent, and order are all
    // native-only facts and intentionally remain owned by v3.
  };
}

function normalizeSiblingOrder(plan: PlanV3): void {
  const parentIds = new Set(plan.states.map((state) => state.parentId));
  for (const parentId of parentIds) {
    plan.states
      .filter((state) => state.parentId === parentId)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .forEach((state, index) => {
        state.order = index;
      });
  }
}

/** Merge edits made through the temporary capture-shaped compatibility view
 * back into the selected native route. Sibling branches and fields the v2 UI
 * cannot express remain untouched. */
export function mergePlanV2RouteIntoV3(
  nativePlan: PlanV3,
  view: Plan,
): PlanV3 {
  const initialErrors = validatePlanV3(nativePlan);
  if (initialErrors.length) {
    throw new Error(
      "cannot merge into invalid native plan: " + initialErrors.join("; "),
    );
  }
  if (view.game && view.game !== nativePlan.game) {
    throw new Error(
      `cannot merge ${view.game} compatibility view into ${nativePlan.game}`,
    );
  }
  if (!view.captures?.length) {
    throw new Error("compatibility view has no states");
  }

  const visiblePlan = migratePlanV2ToV3({
    ...copy(view),
    game: nativePlan.game,
  });
  // Migration from a true v2 file deliberately infers a useful character
  // level. This path is different: `view` is our lossy compatibility
  // projection of an already-native v3 plan. An omitted characterLevel here
  // must stay omitted, otherwise any legacy UI sync silently turns a
  // recommended range such as 68–82 into an exact level 68 milestone.
  visiblePlan.states.forEach((state, index) => {
    if (view.captures[index]?.characterLevel == null) {
      delete state.characterLevel;
    }
  });
  const visibleIds = visiblePlan.states.map((state) => state.id);
  if (new Set(visibleIds).size !== visibleIds.length) {
    throw new Error("compatibility view contains duplicate state ids");
  }
  if (visibleIds[0] !== nativePlan.rootStateId) {
    throw new Error("compatibility view cannot replace the native root");
  }

  const next = copy(nativePlan);
  const previousRouteLeaf = next.editor?.routeLeafId ?? next.defaultLeafId;
  const wasDefaultRoute = previousRouteLeaf === next.defaultLeafId;
  const oldRoute = routeToState(next, previousRouteLeaf);
  const visibleSet = new Set(visibleIds);

  // Removing a legacy capture means removing only that keyframe. Promote its
  // children to its parent so later route states and unrelated alternatives
  // are never discarded by the transitional UI.
  for (const oldState of oldRoute.slice(1).reverse()) {
    if (visibleSet.has(oldState.id)) continue;
    const target = stateById(next, oldState.id);
    for (
      const child of next.states.filter((state) => state.parentId === target.id)
    ) {
      child.parentId = target.parentId;
    }
    next.states = next.states.filter((state) => state.id !== target.id);
  }

  for (let index = 0; index < visiblePlan.states.length; index++) {
    const visible = visiblePlan.states[index]!;
    const expectedParent = index === 0
      ? null
      : visiblePlan.states[index - 1]!.id;
    const existing = next.states.find((state) => state.id === visible.id);
    if (existing) {
      const merged = mergeVisibleState(existing, visible);
      Object.assign(existing, merged);
      existing.parentId = expectedParent;
    } else {
      next.states.push({
        ...copy(visible),
        parentId: expectedParent,
        order: next.states.filter((state) =>
          state.parentId === expectedParent
        ).length,
        phase: index === 0 ? visible.phase : (next.states.find(
          (state) => state.id === expectedParent,
        )?.phase ?? visible.phase),
        provenance: { source: "native", sourceId: expectedParent ?? undefined },
      });
    }
  }

  next.identity.name = view.name || "";
  next.identity.description = view.description || "";
  next.identity.author = view.author || undefined;
  next.identity.links = view.links?.length ? copy(view.links) : undefined;
  next.patch = view.patch ?? next.patch;
  if (view.guide !== undefined) next.guide = view.guide;
  if (view.activeSet) {
    next.editor = {
      ...(next.editor ?? {}),
      activeSpecialization: view.activeSet,
    };
  }
  const nextRouteLeaf = visibleIds.at(-1)!;
  next.editor = { ...(next.editor ?? {}), routeLeafId: nextRouteLeaf };
  if (wasDefaultRoute) next.defaultLeafId = nextRouteLeaf;
  const activeIndex = Math.max(
    0,
    Math.min(
      visibleIds.length - 1,
      Number.isInteger(view.activeCapture)
        ? view.activeCapture
        : visibleIds.length - 1,
    ),
  );
  next.activeStateId = visibleIds[activeIndex]!;
  normalizeSiblingOrder(next);
  const errors = validatePlanV3(next);
  if (errors.length) {
    throw new Error(
      "compatibility merge produced invalid plan: " + errors.join("; "),
    );
  }
  return next;
}
