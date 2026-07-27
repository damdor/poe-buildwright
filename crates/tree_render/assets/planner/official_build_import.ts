// Pure official GGG Build Planner import.
//
// No DOM, TREE, active page, storage, or current-game globals participate.
// Browser and Rust-owned CLI callers supply the selected PoE2 profile plus
// patch-generated ID/catalogue facts and receive one native v3 plan and an
// explicit compatibility report.

import type {
  CharacterStatePhase,
  CharacterStateV3,
  EquippedItemV3,
  PassiveAllocationV3,
  PlanV3,
  SkillGroupV3,
} from "../../../../types/shared.d.ts";
import type {
  GGGBuild,
  GGGItem,
  GGGLevelInterval,
  GGGPassive,
  GGGSkill,
  GGGSupport,
} from "../../../../types/poe2.d.ts";
import { checkGGGBuild, GGG_BUILD_SCHEMA_CURRENT } from "./build_schema.ts";
import type { GameProfile } from "./game_profile.ts";
import {
  inspectOfficialBuildIdentifiers,
  officialIdToGraph,
  resolvePlannerSlot,
} from "./ggg_build_core.ts";
import type {
  OfficialBuildCatalogueData,
  PassiveInteropIds,
} from "./ggg_build_core.ts";

export interface OfficialBuildRuntimeMetadata {
  game: string;
  patch?: string;
  passive_ids?: PassiveInteropIds & {
    attributeToParent?: Record<string, string>;
  };
  classes?: Array<{
    name: string;
    ascendancies?: Array<{ name: string; internal: string }>;
  }>;
}

export interface OfficialBuildImportContext {
  profile: GameProfile;
  metadata: OfficialBuildRuntimeMetadata;
  nativeNodeIds: ReadonlySet<string>;
  catalogue: OfficialBuildCatalogueData;
}

export interface OfficialBuildImportReport {
  unresolvedPassiveIds: string[];
  unknownInventoryIds: string[];
  invalidInventoryIds: string[];
  legacyGraphIds: string[];
  unknownActiveSkillIds: string[];
  metaSkillIds: string[];
  unknownSupportSkillIds: string[];
  unknownUniqueNames: string[];
  unknownAscendancyId: string | null;
}

export interface OfficialBuildImportResult {
  plan: PlanV3;
  report: OfficialBuildImportReport;
}

interface NormalizedPassive {
  allocation: PassiveAllocationV3;
  interval?: [number, number];
}

interface NormalizedSupport {
  id: string;
  note?: string;
  interval?: [number, number];
}

interface NormalizedSkill {
  index: number;
  id: string;
  note?: string;
  interval?: [number, number];
  supports: NormalizedSupport[];
}

interface NormalizedItem {
  index: number;
  item: EquippedItemV3;
  interval?: [number, number];
}

function stablePart(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return clean || "unknown";
}

export function normalizeOfficialInterval(
  raw: GGGLevelInterval | undefined,
): [number, number] | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "number") return [raw, 100];
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const low = raw[0];
  if (typeof low !== "number") return undefined;
  const high = raw.length > 1 && typeof raw[1] === "number" ? raw[1] : 100;
  return [low, high];
}

function activeAt(
  interval: [number, number] | undefined,
  level: number,
): boolean {
  return !interval || (level >= interval[0] && level <= interval[1]);
}

function statePhase(high: number): CharacterStatePhase {
  if (high <= 67) return "leveling";
  if (high <= 84) return "early-endgame";
  return "endgame";
}

function reportFromSource(
  build: GGGBuild,
  context: OfficialBuildImportContext,
): OfficialBuildImportReport {
  const identifiers = inspectOfficialBuildIdentifiers(
    build,
    context.catalogue,
    context.profile.definition.officialBuild,
  );
  return {
    unresolvedPassiveIds: [],
    unknownInventoryIds: identifiers.uneditableInventoryIds,
    invalidInventoryIds: identifiers.invalidInventoryIds,
    legacyGraphIds: [],
    unknownActiveSkillIds: identifiers.unknownActiveSkillIds,
    metaSkillIds: identifiers.metaSkillIds,
    unknownSupportSkillIds: identifiers.unknownSupportSkillIds,
    unknownUniqueNames: identifiers.unknownUniqueNames,
    unknownAscendancyId: null,
  };
}

function normalizePassives(
  build: GGGBuild,
  context: OfficialBuildImportContext,
  report: OfficialBuildImportReport,
): NormalizedPassive[] {
  const ids = context.metadata.passive_ids;
  const attributeParents = ids?.attributeToParent ?? {};
  const normalized: NormalizedPassive[] = [];
  for (const raw of build.passives ?? []) {
    const bare = typeof raw === "string" || typeof raw === "number";
    const sourceId = bare ? String(raw) : String(raw.id);
    const resolved = officialIdToGraph(
      sourceId,
      ids,
      context.nativeNodeIds,
    );
    if (!resolved.graphId) {
      report.unresolvedPassiveIds.push(sourceId);
      continue;
    }
    if (resolved.legacy) report.legacyGraphIds.push(sourceId);
    const parent = attributeParents[resolved.graphId];
    normalized.push({
      allocation: {
        nodeId: parent ?? resolved.graphId,
        specialization: !bare && raw.weapon_set === 1
          ? "set1"
          : !bare && raw.weapon_set === 2
          ? "set2"
          : "main",
        ...(parent ? { optionId: resolved.graphId } : {}),
        ...(!bare && raw.additional_text ? { note: raw.additional_text } : {}),
      },
      interval: bare
        ? undefined
        : normalizeOfficialInterval(raw.level_interval),
    });
  }
  return normalized;
}

function normalizeSupport(raw: string | GGGSupport): NormalizedSupport {
  if (typeof raw === "string") return { id: raw };
  return {
    id: raw.id,
    ...(raw.additional_text ? { note: raw.additional_text } : {}),
    ...(normalizeOfficialInterval(raw.level_interval)
      ? { interval: normalizeOfficialInterval(raw.level_interval) }
      : {}),
  };
}

function normalizeSkills(build: GGGBuild): NormalizedSkill[] {
  return (build.skills ?? []).map((raw: GGGSkill, index) => {
    if (typeof raw === "string") {
      return { index, id: raw, supports: [] };
    }
    return {
      index,
      id: raw.id,
      ...(raw.additional_text ? { note: raw.additional_text } : {}),
      ...(normalizeOfficialInterval(raw.level_interval)
        ? { interval: normalizeOfficialInterval(raw.level_interval) }
        : {}),
      supports: (raw.support_skills ?? []).map(normalizeSupport),
    };
  });
}

function itemSlotGroup(slot: string): EquippedItemV3["slot"]["group"] {
  if (/^flask\d+$/.test(slot)) return "flask";
  if (/^charm\d+$/.test(slot)) return "charm";
  if (slot === "jewel") return "jewel";
  return "equipment";
}

function normalizeItems(
  build: GGGBuild,
  context: OfficialBuildImportContext,
  report: OfficialBuildImportReport,
): NormalizedItem[] {
  const output: NormalizedItem[] = [];
  const rawItems: GGGItem[] = build.inventory_slots ?? build.items ?? [];
  rawItems.forEach((raw, index) => {
    const x = raw.slot_x ?? raw.x ?? 0;
    const y = raw.slot_y ?? raw.y ?? 0;
    const slot = resolvePlannerSlot(
      raw.inventory_id,
      x,
      y,
      context.profile.definition.officialBuild,
    );
    if (!slot) {
      report.unknownInventoryIds.push(raw.inventory_id);
      return;
    }
    output.push({
      index,
      item: {
        id: `ggg:item:${stablePart(raw.inventory_id)}:${x}:${y}`,
        slot: {
          group: itemSlotGroup(slot),
          id: slot,
          x,
          y,
          sourceId: raw.inventory_id,
        },
        item: {
          ...(raw.unique_name
            ? {
              unique: {
                kind: "unique",
                key: raw.unique_name,
                name: raw.unique_name,
                source: "ggg",
                sourceId: raw.unique_name,
              },
            }
            : {}),
        },
        ...(raw.additional_text ? { note: raw.additional_text } : {}),
      },
      ...(normalizeOfficialInterval(raw.level_interval)
        ? { interval: normalizeOfficialInterval(raw.level_interval) }
        : {}),
    });
  });
  return output;
}

function skillGroupAt(
  skill: NormalizedSkill,
  level: number,
): SkillGroupV3 {
  return {
    id: `ggg:skill:${skill.index}:${stablePart(skill.id)}`,
    enabled: true,
    ...(skill.note ? { note: skill.note } : {}),
    gems: [
      {
        id: `ggg:skill:${skill.index}:active`,
        gem: {
          kind: "gem",
          key: skill.id,
          source: "ggg",
          sourceId: skill.id,
        },
        role: "active",
        enabled: true,
      },
      ...skill.supports
        .filter((support) => activeAt(support.interval, level))
        .map((support, index) => ({
          id: `ggg:skill:${skill.index}:support:${index}`,
          gem: {
            kind: "gem",
            key: support.id,
            source: "ggg",
            sourceId: support.id,
          },
          role: "support" as const,
          enabled: true,
          ...(support.note ? { note: support.note } : {}),
        })),
    ],
  };
}

function sourceBoundaries(
  passives: NormalizedPassive[],
  skills: NormalizedSkill[],
  items: NormalizedItem[],
): number[] {
  const boundaries = new Set([0, 101]);
  const add = (interval: [number, number] | undefined): void => {
    if (!interval) return;
    boundaries.add(interval[0]);
    boundaries.add(Math.min(101, interval[1] + 1));
  };
  passives.forEach((entry) => add(entry.interval));
  skills.forEach((entry) => {
    add(entry.interval);
    entry.supports.forEach((support) => add(support.interval));
  });
  items.forEach((entry) => add(entry.interval));
  return [...boundaries]
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 101)
    .sort((a, b) => a - b);
}

function sourceAscendancy(
  build: GGGBuild,
  metadata: OfficialBuildRuntimeMetadata,
  report: OfficialBuildImportReport,
): { name: string | null; className: string | null } {
  if (!build.ascendancy) return { name: null, className: null };
  for (const klass of metadata.classes ?? []) {
    for (const ascendancy of klass.ascendancies ?? []) {
      if (ascendancy.internal === build.ascendancy) {
        return { name: ascendancy.name, className: klass.name };
      }
    }
  }
  report.unknownAscendancyId = build.ascendancy;
  return { name: null, className: null };
}

export function importOfficialBuild(
  input: unknown,
  context: OfficialBuildImportContext,
): OfficialBuildImportResult {
  const definition = context.profile.definition;
  if (
    definition.id !== "poe2" ||
    !definition.integrations.gggBuild ||
    !definition.officialBuild
  ) {
    throw new Error(
      "Official GGG .build import is currently supported only for PoE2.",
    );
  }
  if (context.metadata.game !== definition.id) {
    throw new Error(
      `interop metadata belongs to ${context.metadata.game}, expected ${definition.id}`,
    );
  }
  const schemaError = checkGGGBuild(
    input,
    GGG_BUILD_SCHEMA_CURRENT,
    "import",
  );
  if (schemaError) throw new Error("Not a valid .build file: " + schemaError);
  const build = input as GGGBuild;
  const report = reportFromSource(build, context);
  const passives = normalizePassives(build, context, report);
  const skills = normalizeSkills(build);
  const items = normalizeItems(build, context, report);
  const ascendancy = sourceAscendancy(build, context.metadata, report);
  const points = sourceBoundaries(passives, skills, items);
  const states: CharacterStateV3[] = [];
  for (let index = 0; index < points.length - 1; index++) {
    const low = points[index]!;
    const high = points[index + 1]! - 1;
    if (high < low) continue;
    const stateId = `state:ggg:${low}-${high}`;
    const allocations = new Map<string, PassiveAllocationV3>();
    for (const entry of passives) {
      if (!activeAt(entry.interval, high)) continue;
      const key = `${entry.allocation.nodeId}|${
        entry.allocation.specialization ?? "main"
      }`;
      allocations.set(key, structuredClone(entry.allocation));
    }
    const state: CharacterStateV3 = {
      id: stateId,
      parentId: states.at(-1)?.id ?? null,
      order: 0,
      name: low === 0 && high === 0
        ? "Before level 1"
        : low === high
        ? `Level ${high}`
        : `Levels ${Math.max(1, low)}–${high}`,
      description: "Imported from the official GGG Build Planner format.",
      phase: statePhase(high),
      ...(high >= 1 ? { characterLevel: Math.min(100, high) } : {}),
      ...(low >= 1
        ? {
          recommendedLevelRange: [
            Math.min(100, low),
            Math.min(100, high),
          ] as [number, number],
        }
        : {}),
      character: {
        class: ascendancy.className,
        ascendancy: ascendancy.name,
      },
      passiveTree: { allocations: [...allocations.values()] },
      skills: {
        groups: skills
          .filter((skill) => activeAt(skill.interval, high))
          .map((skill) => skillGroupAt(skill, high)),
      },
      inventory: {
        items: items
          .filter((item) => activeAt(item.interval, high))
          .map((item) => structuredClone(item.item)),
      },
      actors: [],
      gameData: {
        gggBuildImport: {
          interval: [low, high],
          ...(states.length === 0
            ? {
              source: structuredClone(build),
              report: structuredClone(report),
            }
            : {}),
        },
      },
      provenance: { source: "ggg-build" },
    };
    states.push(state);
  }
  if (!states.length) {
    throw new Error("The official build produced no native states.");
  }
  const activeStateId = states.at(-1)!.id;
  const unique = (values: string[]) => [...new Set(values)].sort();
  report.unresolvedPassiveIds = unique(report.unresolvedPassiveIds);
  report.unknownInventoryIds = unique(report.unknownInventoryIds);
  report.invalidInventoryIds = unique(report.invalidInventoryIds);
  report.legacyGraphIds = unique(report.legacyGraphIds);
  const plan: PlanV3 = {
    format: "buildwright-planner-plan",
    version: 3,
    game: "poe2",
    patch: context.metadata.patch || null,
    identity: {
      name: build.name || "Imported GGG build",
      description: build.description || "",
      ...(build.author ? { author: build.author } : {}),
      ...(build.link ? { links: [{ url: build.link }] } : {}),
    },
    states,
    rootStateId: states[0]!.id,
    activeStateId,
    defaultLeafId: activeStateId,
    editor: { routeLeafId: activeStateId },
    provenance: [{
      source: "ggg-build",
      importedAt: new Date().toISOString(),
      ...(context.metadata.patch
        ? { sourceVersion: context.metadata.patch }
        : {}),
    }],
  };
  return { plan, report };
}
