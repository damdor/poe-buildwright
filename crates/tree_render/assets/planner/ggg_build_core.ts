// Pure PoE2 Build Planner adapter primitives.
//
// This module deliberately has no DOM, window, active-game, or TREE
// dependency. Runtime code supplies the selected PoE2 profile and the
// patch-specific ID maps; tests can exercise the exact same boundary.

import type {
  Capture, CharacterStateV3, Item, Plan, PlanV3,
} from "../../../../types/shared.d.ts";
import type {
  OfficialBuildDefinition, OfficialInventorySlot,
} from "./game_profile.ts";
import type { GGGBuild } from "../../../../types/poe2.d.ts";

export interface PassiveInteropIds {
  graphToBuild: Record<string, string>;
  buildToGraph: Record<string, string>;
}

export interface OfficialItemLocation {
  inventoryId: string;
  slotX: number;
  slotY: number;
}

export interface OfficialBuildCatalogueData {
  activeSkillIds: ReadonlySet<string>;
  supportSkillIds: ReadonlySet<string>;
  metaSkillIds: ReadonlySet<string>;
  uniqueNames: ReadonlySet<string>;
  authoredUniqueNames: ReadonlyMap<string, string>;
  inventoryIds: ReadonlySet<string>;
}

export interface OfficialSkillCatalogueEnvelope {
  source?: string;
  gems?: Array<{
    id: string;
    gem_type?: string;
    skill_types?: string[];
  }>;
}

export interface OfficialItemCatalogueEnvelope {
  official_build?: {
    source?: string;
    inventory_ids?: string[];
  };
  uniques?: Array<{
    name: string;
    official_name?: string;
  }>;
}

export interface OfficialBuildIdentifierInspection {
  unknownActiveSkillIds: string[];
  metaSkillIds: string[];
  unknownSupportSkillIds: string[];
  unknownUniqueNames: string[];
  invalidInventoryIds: string[];
  uneditableInventoryIds: string[];
}

/** Convert patch-owned catalogue envelopes into the exact identifier sets
 * accepted by the official adapter. No UI state participates. */
export function buildOfficialCatalogueData(
  skills: OfficialSkillCatalogueEnvelope | null,
  items: OfficialItemCatalogueEnvelope | null,
): OfficialBuildCatalogueData {
  if (!skills || skills.source !== "ggg" || !Array.isArray(skills.gems)) {
    throw new Error("The selected game has no verified GGG skill catalogue.");
  }
  const activeSkillIds = new Set<string>();
  const supportSkillIds = new Set<string>();
  const metaSkillIds = new Set<string>();
  for (const gem of skills.gems) {
    if (!gem.id) continue;
    if (gem.gem_type === "Support") supportSkillIds.add(gem.id);
    else activeSkillIds.add(gem.id);
    if (gem.skill_types?.includes("Meta")) metaSkillIds.add(gem.id);
  }
  const uniqueNames = new Set<string>();
  const authoredUniqueNames = new Map<string, string>();
  for (const unique of items?.uniques ?? []) {
    if (!unique.name || !unique.official_name) continue;
    uniqueNames.add(unique.official_name);
    authoredUniqueNames.set(unique.name.toLocaleLowerCase(), unique.official_name);
  }
  if (items?.official_build?.source !== "ggg" ||
      !Array.isArray(items.official_build.inventory_ids)) {
    throw new Error(
      "The selected patch has no verified GGG Inventories.Id catalogue.",
    );
  }
  const inventoryIds = new Set(
    items.official_build.inventory_ids.filter(Boolean),
  );
  return {
    activeSkillIds,
    supportSkillIds,
    metaSkillIds,
    uniqueNames,
    authoredUniqueNames,
    inventoryIds,
  };
}

/** Find profile mappings whose claimed table ownership is not true for the
 * selected patch. Build Planner-only targets are deliberately excluded:
 * they are schema vocabulary rather than ordinary `Inventories` rows. */
export function officialInventoryDefinitionIssues(
  definition: OfficialBuildDefinition | null,
  inventoryIds: ReadonlySet<string>,
): Array<{ slot: string; inventoryId: string }> {
  if (!definition) return [];
  return Object.entries(definition.inventorySlots)
    .filter(([, target]) =>
      (target.idSource ?? "inventories") === "inventories" &&
      !inventoryIds.has(target.inventoryId)
    )
    .map(([slot, target]) => ({ slot, inventoryId: target.inventoryId }));
}

/** Whether an inventory id can be emitted from either current first-party
 * table data or the profile's explicit Build Planner-only vocabulary. */
export function officialInventoryIdSupported(
  inventoryId: string,
  definition: OfficialBuildDefinition | null,
  inventoryIds: ReadonlySet<string>,
): boolean {
  if (inventoryIds.has(inventoryId)) return true;
  return Object.values(definition?.inventorySlots ?? {}).some(target =>
    target.inventoryId === inventoryId &&
    target.idSource === "build-planner"
  );
}

/** Inspect source-owned identifiers before an official file is allowed to
 * mutate a native plan. Schema validation proves shapes; this proves that
 * the referenced patch entities are current and tells the UI what can only
 * be preserved as opaque source data. */
export function inspectOfficialBuildIdentifiers(
  build: GGGBuild,
  catalogue: OfficialBuildCatalogueData,
  definition: OfficialBuildDefinition | null,
): OfficialBuildIdentifierInspection {
  const unknownActiveSkillIds = new Set<string>();
  const metaSkillIds = new Set<string>();
  const unknownSupportSkillIds = new Set<string>();
  const unknownUniqueNames = new Set<string>();
  const invalidInventoryIds = new Set<string>();
  const uneditableInventoryIds = new Set<string>();

  for (const rawSkill of build.skills ?? []) {
    const skill = typeof rawSkill === "string" ? { id: rawSkill } : rawSkill;
    if (!catalogue.activeSkillIds.has(skill.id)) {
      unknownActiveSkillIds.add(skill.id);
    } else if (catalogue.metaSkillIds.has(skill.id)) {
      metaSkillIds.add(skill.id);
    }
    for (const rawSupport of skill.support_skills ?? []) {
      const supportId = typeof rawSupport === "string"
        ? rawSupport
        : rawSupport.id;
      if (!catalogue.supportSkillIds.has(supportId)) {
        unknownSupportSkillIds.add(supportId);
      }
    }
  }

  for (const item of build.inventory_slots ?? build.items ?? []) {
    if (!officialInventoryIdSupported(
      item.inventory_id,
      definition,
      catalogue.inventoryIds,
    )) {
      invalidInventoryIds.add(item.inventory_id);
    } else if (!resolvePlannerSlot(
      item.inventory_id,
      item.slot_x ?? item.x ?? 0,
      item.slot_y ?? item.y ?? 0,
      definition,
    )) {
      uneditableInventoryIds.add(item.inventory_id);
    }
    if (item.unique_name && !catalogue.uniqueNames.has(item.unique_name)) {
      unknownUniqueNames.add(item.unique_name);
    }
  }

  const sorted = (values: Set<string>): string[] => [...values].sort();
  return {
    unknownActiveSkillIds: sorted(unknownActiveSkillIds),
    metaSkillIds: sorted(metaSkillIds),
    unknownSupportSkillIds: sorted(unknownSupportSkillIds),
    unknownUniqueNames: sorted(unknownUniqueNames),
    invalidInventoryIds: sorted(invalidInventoryIds),
    uneditableInventoryIds: sorted(uneditableInventoryIds),
  };
}

/** Fill only source-owned identifiers that can be proven by the current
 * patch. The native plan is cloned; authored display text remains intact. */
export function enrichPlanWithOfficialCatalogue(
  plan: Plan,
  catalogue: OfficialBuildCatalogueData,
): Plan {
  const next = structuredClone(plan);
  for (const capture of next.captures) {
    for (const item of capture.items) {
      if (!item.uniqueName || item.officialUniqueName) continue;
      item.officialUniqueName =
        catalogue.authoredUniqueNames.get(item.uniqueName.toLocaleLowerCase());
    }
  }
  return next;
}

export function graphIdToOfficial(
  graphId: string | number,
  ids: PassiveInteropIds | null | undefined,
): string | null {
  return ids?.graphToBuild[String(graphId)] ?? null;
}

export function officialIdToGraph(
  buildId: string | number,
  ids: PassiveInteropIds | null | undefined,
  legacyGraphIds: ReadonlySet<string> = new Set(),
): { graphId: string | null; legacy: boolean } {
  const raw = String(buildId);
  const mapped = ids?.buildToGraph[raw];
  if (mapped) return { graphId: mapped, legacy: false };
  return legacyGraphIds.has(raw)
    ? { graphId: raw, legacy: true }
    : { graphId: null, legacy: false };
}

/** Encode untrusted/user prose as literal GGG text. Formatting is added
 * only by deliberate adapter helpers so imported HTML-like strings cannot
 * become active game markup on re-export. */
export function gggPlainText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replaceAll("<", "‹")
    .replaceAll(">", "›")
    .replaceAll("{", "(")
    .replaceAll("}", ")");
}

export function gggMarkup(
  kind: "b" | "i" | "u" | "s" | "m" | "l",
  text: string,
): string {
  return "<" + kind + ">{" + gggPlainText(text) + "}";
}

function itemSocketHint(item: Item): string | null {
  if (!item.sockets?.length) return null;
  const groups = new Map<number, string[]>();
  for (const socket of item.sockets) {
    const kind = socket.kind?.trim();
    const label = socket.color?.trim() ||
      (kind && kind.toLocaleLowerCase() !== "gem" ? kind : "?");
    const group = groups.get(socket.group);
    if (group) group.push(label);
    else groups.set(socket.group, [label]);
  }
  return [...groups.values()].map(group => group.join("-")).join(" ");
}

/** Project native item facts into human-readable official Build Planner
 * hover text. The official schema has no typed affix, quality, corruption,
 * or socket fields, so those values remain explicit hints instead of being
 * silently discarded or invented as official identifiers. */
export function officialItemHintLines(item: Item): string[] {
  const lines: string[] = [];
  const displayName = item.name || item.base;
  if (displayName && displayName !== item.uniqueName) {
    lines.push(displayName);
  }
  if (item.rarity && item.rarity !== "normal") {
    lines.push("Rarity: " + item.rarity);
  }
  if (item.itemLevel != null) lines.push("Item level: " + item.itemLevel);
  if (item.quality != null) lines.push("Quality: +" + item.quality + "%");
  const sockets = itemSocketHint(item);
  if (sockets) lines.push("Sockets: " + sockets);
  if (item.corrupted) lines.push("Corrupted");
  if (item.mods?.length) {
    lines.push("Stat priority");
    item.mods.forEach((mod, index) => lines.push((index + 1) + ". " + mod));
  }
  if (item.note) {
    if (lines.length) lines.push("");
    lines.push(item.note);
  }
  if (item.sourceText) {
    if (lines.length) lines.push("");
    lines.push("Original imported item text");
    lines.push(item.sourceText);
  }
  return lines;
}

export function resolveOfficialItemLocation(
  item: Item,
  definition: OfficialBuildDefinition | null,
): OfficialItemLocation | null {
  const mapped: OfficialInventorySlot | undefined =
    item.slot ? definition?.inventorySlots[item.slot] : undefined;
  const inventoryId = mapped?.inventoryId || item.inventoryId || "";
  if (!inventoryId) return null;
  return {
    inventoryId,
    slotX: item.slotX ?? mapped?.slotX ?? 0,
    slotY: item.slotY ?? mapped?.slotY ?? 0,
  };
}

export function resolvePlannerSlot(
  inventoryId: string,
  slotX: number,
  slotY: number,
  definition: OfficialBuildDefinition | null,
): string | undefined {
  if (!definition) return undefined;
  for (const [slot, target] of Object.entries(definition.inventorySlots)) {
    if (target.inventoryId === inventoryId &&
        (target.slotX ?? 0) === slotX &&
        (target.slotY ?? 0) === slotY) {
      return slot;
    }
  }
  return undefined;
}

export function selectedNativeRoute(nativePlan: PlanV3 | undefined): CharacterStateV3[] {
  if (!nativePlan) return [];
  const byId = new Map(nativePlan.states.map(state => [state.id, state]));
  const route: CharacterStateV3[] = [];
  const seen = new Set<string>();
  let current = byId.get(nativePlan.editor?.routeLeafId ?? nativePlan.defaultLeafId);
  while (current) {
    if (seen.has(current.id)) return [];
    seen.add(current.id);
    route.push(current);
    current = current.parentId == null ? undefined : byId.get(current.parentId);
  }
  route.reverse();
  return route[0]?.id === nativePlan.rootStateId ? route : [];
}

function rangesFormRoute(captures: Capture[]): boolean {
  return captures.every((capture, index) => {
    const [lo, hi] = capture.levelRange;
    if (!Number.isInteger(lo) || !Number.isInteger(hi) ||
        lo < 0 || hi < lo || hi > 100) return false;
    if (index === 0) return true;
    return captures[index - 1]!.levelRange[1] + 1 === lo;
  });
}

function routeCharacterLevels(nativePlan: PlanV3 | undefined): number[] | null {
  const route = selectedNativeRoute(nativePlan);
  if (!route.length) return null;
  const levels = route.map(state => state.characterLevel);
  if (levels.some(level => !Number.isInteger(level) || level! < 1 || level! > 100)) {
    return null;
  }
  for (let index = 1; index < levels.length; index++) {
    if (levels[index]! <= levels[index - 1]!) return null;
  }
  return levels as number[];
}

/** Project the selected route without inventing chronology from labels.
 * Explicit contiguous ranges win; otherwise strictly increasing character
 * levels become boundaries. Ambiguous routes export the selected leaf. */
export function prepareOfficialRoute(
  plan: Plan,
  nativePlan?: PlanV3,
): { plan: Plan; projection: "route" | "final-state" } {
  const next = structuredClone(plan);
  if (next.captures.length <= 1) {
    next.captures[0]!.levelRange = [0, 100];
    next.activeCapture = 0;
    return { plan: next, projection: "route" };
  }
  if (rangesFormRoute(next.captures)) {
    return { plan: next, projection: "route" };
  }
  const levels = routeCharacterLevels(nativePlan);
  if (levels && levels.length === next.captures.length) {
    next.captures.forEach((capture, index) => {
      const lo = index === 0 && levels[index] === 1 ? 0 : levels[index]!;
      const hi = index + 1 < levels.length ? levels[index + 1]! - 1 : 100;
      capture.levelRange = [lo, hi];
    });
    return { plan: next, projection: "route" };
  }
  const leaf = structuredClone(next.captures[next.captures.length - 1]!);
  leaf.levelRange = [0, 100];
  next.captures = [leaf];
  next.activeCapture = 0;
  return { plan: next, projection: "final-state" };
}
