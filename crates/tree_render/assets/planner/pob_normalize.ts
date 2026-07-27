// Path of Building source model → complete native Buildwright states.
//
// Every timeline decision is supplied through PoBImportReview. The adapter
// proposes names/levels/phases, but it cannot choose chronology by itself.

import type {
  ActorLoadoutV3,
  CharacterStatePhase,
  CharacterStateV3,
  EntityRefV3,
  EquippedItemV3,
  ItemSpecV3,
  PlanV3,
  SkillGroupV3,
} from "../../../../types/shared.d.ts";
import type { GameProfile } from "./game_profile.ts";
import type {
  PoBImportLimits,
  PoBItem,
  PoBItemPlacement,
  PoBLoadoutCandidate,
  PoBLoadoutResolution,
  PoBSourceModel,
} from "./pob_import_core.ts";
import {
  decodePoBInput,
  parsePoBXml,
  resolvePoBLoadouts,
} from "./pob_import_core.ts";

export interface PoBReportEntry {
  path: string;
  sourceField: string;
  message: string;
}

export interface PoBCompatibilityReport {
  imported: PoBReportEntry[];
  transformed: PoBReportEntry[];
  omitted: PoBReportEntry[];
  unresolved: PoBReportEntry[];
  errors: PoBReportEntry[];
}

export interface PoBStateProposal {
  candidateId: string;
  name: string;
  phase: CharacterStatePhase;
  characterLevel?: number;
  recommendedLevelRange?: [number, number];
}

export interface PoBImportReview {
  planName: string;
  /** Exact candidate IDs in the user-approved display/order sequence. */
  candidateOrder: string[];
  /** Sibling mode is the safe default; linear mode is explicit chronology. */
  arrangement: "siblings" | "linear";
  defaultLeafCandidateId: string;
  states: Record<string, {
    name: string;
    phase: CharacterStatePhase;
    characterLevel?: number;
    recommendedLevelRange?: [number, number];
  }>;
  includeActorLoadouts: boolean;
}

export interface PoBNormalizationContext {
  profile: GameProfile;
  patch: string | null;
  knownNodeIds?: ReadonlySet<string>;
  clusterSkills?: Array<{
    id: string;
    size: "Small" | "Medium" | "Large";
    stats: string;
    name?: string;
  }>;
  sourceUrl?: string;
}

export interface PoBImportPreview {
  source: PoBSourceModel;
  resolution: PoBLoadoutResolution;
  proposals: PoBStateProposal[];
  report: PoBCompatibilityReport;
}

export interface PoBImportResult {
  plan: PlanV3;
  report: PoBCompatibilityReport;
}

function targetVersionMismatch(
  source: PoBSourceModel,
  profile: GameProfile,
): string | null {
  if (
    !source.targetVersion ||
    source.targetVersion.startsWith(
      profile.definition.pathOfBuilding.targetVersionPrefix,
    )
  ) {
    return null;
  }
  return `PoB target version "${source.targetVersion}" does not match ` +
    `${profile.definition.pathOfBuilding.label} for ` +
    `${profile.definition.shortLabel}.`;
}

function emptyReport(): PoBCompatibilityReport {
  return {
    imported: [],
    transformed: [],
    omitted: [],
    unresolved: [],
    errors: [],
  };
}

function add(
  report: PoBCompatibilityReport,
  group: keyof PoBCompatibilityReport,
  path: string,
  sourceField: string,
  message: string,
): void {
  report[group].push({ path, sourceField, message });
}

function stablePart(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return clean || "unknown";
}

function inferredLevel(
  candidate: PoBLoadoutCandidate,
  model: PoBSourceModel,
): { level?: number; range?: [number, number] } {
  const title = candidate.name;
  const range = /(?:lvl|level)\s*(\d+)\s*[-–]\s*(\d+)/i.exec(title);
  if (range) {
    const lo = Math.max(1, Math.min(100, Number(range[1])));
    const hi = Math.max(lo, Math.min(100, Number(range[2])));
    return { level: hi, range: [lo, hi] };
  }
  const exact = /(?:lvl|level)\s*(\d+)/i.exec(title);
  if (exact) {
    const level = Math.max(1, Math.min(100, Number(exact[1])));
    return { level, range: [level, level] };
  }
  if (candidate.tree.index === model.activeTreeIndex && model.activeLevel) {
    return { level: Math.max(1, Math.min(100, model.activeLevel)) };
  }
  return {};
}

function inferredPhase(
  name: string,
  level?: number,
): CharacterStatePhase {
  if (/mirror|min[\s-]*max|aspir/i.test(name)) return "aspirational";
  if (/early\s*maps?|mapping|maps?\b/i.test(name)) return "early-endgame";
  if (/boss|endgame|late\s*maps?|\bHC\b|\bSC\b/i.test(name)) return "endgame";
  if (
    /campaign|level|levelling|leveling|act\s*\d+/i.test(name) ||
    (level != null && level <= 67)
  ) return "leveling";
  return "custom";
}

export function proposePoBStateMetadata(
  candidate: PoBLoadoutCandidate,
  model: PoBSourceModel,
): PoBStateProposal {
  const inferred = inferredLevel(candidate, model);
  return {
    candidateId: candidate.id,
    name: candidate.name,
    phase: inferredPhase(candidate.name, inferred.level),
    ...(inferred.level != null ? { characterLevel: inferred.level } : {}),
    ...(inferred.range ? { recommendedLevelRange: inferred.range } : {}),
  };
}

function slotGroup(slot: string): EquippedItemV3["slot"]["group"] {
  if (/^flask\d+$/.test(slot)) return "flask";
  if (/^charm\d+$/.test(slot)) return "charm";
  if (slot === "jewel") return "jewel";
  return "equipment";
}

export function plannerSlotForPoB(
  placement: Pick<PoBItemPlacement, "slotName" | "socketNodeId">,
  profile: GameProfile,
): string | null {
  if (placement.socketNodeId) return "jewel";
  const source = placement.slotName.trim();
  if (/Abyssal Socket/i.test(source)) return null;
  const adapter = profile.definition.pathOfBuilding;
  if (adapter.itemSlots[source]) return adapter.itemSlots[source]!;
  for (const family of adapter.numberedItemSlots) {
    const match = new RegExp(
      "^" + family.sourcePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
        " ([1-9]\\d*)$",
    ).exec(source);
    const index = match ? Number(match[1]) : 0;
    if (index >= 1 && index <= family.count) {
      return family.targetPrefix + index;
    }
  }
  return null;
}

function entity(
  kind: string,
  key: string,
  name?: string,
): EntityRefV3 {
  return {
    kind,
    key,
    ...(name ? { name } : {}),
    source: "pob",
    sourceId: key,
  };
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function itemSpec(
  source: PoBItem,
  context: PoBNormalizationContext,
  report: PoBCompatibilityReport,
  path: string,
  socketNodeId?: string,
): ItemSpecV3 {
  const spec: ItemSpecV3 = {
    ...(source.name ? { name: source.name } : {}),
    ...(source.base ? { base: entity("base", source.base, source.base) } : {}),
    ...(source.rarity ? { rarity: source.rarity } : {}),
    ...(source.uniqueName
      ? { unique: entity("unique", source.uniqueName, source.uniqueName) }
      : {}),
    ...(source.itemLevel != null ? { itemLevel: source.itemLevel } : {}),
    ...(source.quality != null ? { quality: source.quality } : {}),
    ...(source.corrupted ? { corrupted: true } : {}),
    ...(source.sockets?.length
      ? { sockets: source.sockets.map((socket) => ({ ...socket })) }
      : {}),
    ...(source.mods?.length
      ? { mods: source.mods.map((mod) => ({ ...mod })) }
      : {}),
    sourceText: source.sourceText,
  };
  if (socketNodeId || source.cluster) {
    spec.jewel = {
      ...(socketNodeId ? { socketNodeId } : {}),
    };
  }
  if (source.cluster && spec.jewel) {
    const match = context.clusterSkills?.find((skill) =>
      skill.size === source.cluster!.size &&
      normalizeText(skill.stats) ===
        normalizeText(source.cluster!.smallPassiveText || "")
    );
    if (match) {
      spec.jewel.cluster = {
        size: source.cluster.size,
        smallPassive: entity("passive", match.id, match.name || match.stats),
        passiveCount: source.cluster.passiveCount ??
          (source.cluster.size === "Large"
            ? 8
            : source.cluster.size === "Medium"
            ? 4
            : 2),
        jewelSocketCount: source.cluster.jewelSocketCount ??
          (source.cluster.size === "Large"
            ? 2
            : source.cluster.size === "Medium"
            ? 1
            : 0),
      };
    } else {
      add(
        report,
        "unresolved",
        path + ".cluster.smallPassive",
        "Items.Item",
        "Cluster small-passive text has no exact first-party skill match; " +
          "the source item text is preserved.",
      );
    }
  }
  return spec;
}

function normalizePlacement(
  placement: PoBItemPlacement,
  model: PoBSourceModel,
  context: PoBNormalizationContext,
  report: PoBCompatibilityReport,
  path: string,
  ownerPrefix: string,
  allowedSlots: ReadonlySet<string>,
): EquippedItemV3 | null {
  const slot = plannerSlotForPoB(placement, context.profile);
  if (!slot || !allowedSlots.has(slot)) {
    add(
      report,
      "unresolved",
      path,
      "Items.ItemSet.Slot",
      `PoB slot "${placement.slotName}" is not editable for this inventory owner.`,
    );
    return null;
  }
  const source = model.items[placement.itemId];
  if (!source) {
    add(
      report,
      "unresolved",
      path,
      "Items.ItemSet.Slot.itemId",
      `Item ${placement.itemId} is missing from the PoB item table.`,
    );
    return null;
  }
  return {
    id: `pob:${ownerPrefix}:item:${stablePart(placement.itemId)}:${slot}:${
      stablePart(placement.socketNodeId || "slot")
    }`,
    slot: {
      group: slotGroup(slot),
      id: slot,
      sourceId: placement.slotName,
    },
    item: itemSpec(
      source,
      context,
      report,
      path + ".item",
      placement.socketNodeId,
    ),
  };
}

function playerInventory(
  candidate: PoBLoadoutCandidate,
  model: PoBSourceModel,
  context: PoBNormalizationContext,
  report: PoBCompatibilityReport,
): EquippedItemV3[] {
  const allowed = new Set([
    ...context.profile.definition.slots.equipment.map((slot) => slot.key),
    ...context.profile.definition.slots.flasks.map((slot) => slot.key),
    ...context.profile.definition.slots.charms.map((slot) => slot.key),
    "jewel",
  ]);
  const placements = candidate.items?.placements.slice() ?? [];
  for (const socket of candidate.tree.sockets) {
    placements.push({
      slotName: "Jewel " + socket.nodeId,
      itemId: socket.itemId,
      socketNodeId: socket.nodeId,
    });
  }
  const seen = new Set<string>();
  const unsupported = placements.filter((placement) =>
    plannerSlotForPoB(placement, context.profile) === null
  );
  if (unsupported.length) {
    const examples = [...new Set(unsupported.map((value) => value.slotName))]
      .slice(0, 3);
    add(
      report,
      "unresolved",
      `states.${candidate.id}.inventory.unsupportedSlots`,
      "Items.ItemSet.Slot",
      `${unsupported.length} nested or unsupported PoB placement(s) remain ` +
        `in source metadata (${examples.join(", ")}${
          unsupported.length > examples.length ? ", …" : ""
        }).`,
    );
  }
  return placements.flatMap((placement, index) => {
    if (plannerSlotForPoB(placement, context.profile) === null) return [];
    const key = [
      placement.itemId,
      placement.socketNodeId || "",
      plannerSlotForPoB(placement, context.profile) || placement.slotName,
    ].join("|");
    if (seen.has(key)) return [];
    seen.add(key);
    const item = normalizePlacement(
      placement,
      model,
      context,
      report,
      `states.${candidate.id}.inventory.${index}`,
      candidate.id,
      allowed,
    );
    return item ? [item] : [];
  });
}

function skillGroups(
  candidate: PoBLoadoutCandidate,
  profile: GameProfile,
  report: PoBCompatibilityReport,
): SkillGroupV3[] {
  if (!candidate.skills) return [];
  return candidate.skills.groups.map((group) => {
    const rawSlot = group.slot || "";
    const slot = rawSlot
      ? plannerSlotForPoB({ slotName: rawSlot }, profile) || undefined
      : undefined;
    if (rawSlot && !slot) {
      add(
        report,
        "transformed",
        `states.${candidate.id}.skills.${group.index}.slot`,
        "Skills.SkillSet.Skill.slot",
        `Unsupported PoB skill slot "${rawSlot}" remains in source metadata.`,
      );
    }
    return {
      id: `pob:skills:${stablePart(candidate.skills!.id)}:${group.index}`,
      ...(group.label ? { label: group.label } : {}),
      ...(slot ? { slot } : {}),
      enabled: group.enabled,
      gems: group.gems.map((gem, index) => ({
        id: `pob:gem:${
          stablePart(candidate.skills!.id)
        }:${group.index}:${index}`,
        gem: entity("gem", gem.sourceId, gem.name),
        role: gem.role,
        ...(gem.level != null ? { level: gem.level } : {}),
        ...(gem.quality != null ? { quality: gem.quality } : {}),
        ...(gem.variant ? { variant: gem.variant } : {}),
        enabled: gem.enabled,
      })),
    };
  });
}

function actors(
  candidate: PoBLoadoutCandidate,
  model: PoBSourceModel,
  resolution: PoBLoadoutResolution,
  context: PoBNormalizationContext,
  report: PoBCompatibilityReport,
): ActorLoadoutV3[] {
  if (!candidate.skills) return [];
  return resolution.actorItemSets.flatMap((relation, relationIndex) => {
    if (!relation.skillSetIds.includes(candidate.skills!.id)) return [];
    if (!context.profile.rules.actorKindAllowed(relation.kind)) {
      add(
        report,
        "unresolved",
        `states.${candidate.id}.actors.${relationIndex}`,
        "Skills.Gem.skillMinionItemSet",
        `The ${context.profile.definition.shortLabel} profile does not support ` +
          `${relation.kind} actors.`,
      );
      return [];
    }
    const allowed = new Set(
      context.profile.rules.actorInventorySlots(relation.kind)
        .map((slot) => slot.key),
    );
    const actorId = `pob:actor:${candidate.id}:${relation.itemSet.id}`;
    const unsupported = relation.itemSet.placements.filter((placement) =>
      plannerSlotForPoB(placement, context.profile) === null
    );
    if (unsupported.length) {
      add(
        report,
        "unresolved",
        `states.${candidate.id}.actors.${relationIndex}.inventory.unsupportedSlots`,
        "Items.ItemSet.Slot",
        `${unsupported.length} nested or unsupported actor placement(s) ` +
          "remain in source metadata.",
      );
    }
    const inventory = relation.itemSet.placements.flatMap(
      (placement, placementIndex) => {
        if (plannerSlotForPoB(placement, context.profile) === null) return [];
        const item = normalizePlacement(
          placement,
          model,
          context,
          report,
          `states.${candidate.id}.actors.${relationIndex}.inventory.${placementIndex}`,
          actorId,
          allowed,
        );
        return item ? [item] : [];
      },
    );
    return [{
      id: actorId,
      kind: relation.kind,
      name: relation.kind === "animate-guardian"
        ? "Animate Guardian"
        : relation.itemSet.title.display,
      inventory: { items: inventory },
      notes: `Imported from PoB item set "${relation.itemSet.title.display}" ` +
        `via ${relation.sourceSkill}.`,
    }];
  });
}

function stateForCandidate(
  candidate: PoBLoadoutCandidate,
  review: PoBImportReview,
  parentId: string | null,
  order: number,
  model: PoBSourceModel,
  resolution: PoBLoadoutResolution,
  context: PoBNormalizationContext,
  report: PoBCompatibilityReport,
): CharacterStateV3 {
  const approved = review.states[candidate.id];
  if (!approved) throw new Error(`Missing reviewed state ${candidate.id}.`);
  const unresolvedNodes = candidate.tree.nodes.filter((node) =>
    context.knownNodeIds && !context.knownNodeIds.has(node)
  );
  if (unresolvedNodes.length) {
    add(
      report,
      "unresolved",
      `states.${candidate.id}.passives.unresolved`,
      "Tree.Spec.nodes",
      `${unresolvedNodes.length} passive node(s) are not present in the ` +
        `selected patch (${unresolvedNodes.slice(0, 5).join(", ")}${
          unresolvedNodes.length > 5 ? ", …" : ""
        }). Their IDs remain in source metadata.`,
    );
  }
  const masteryByNode = new Map(
    candidate.tree.masteries.map((value) => [value.nodeId, value.effectId]),
  );
  if (candidate.tree.overrideCount) {
    add(
      report,
      "omitted",
      `states.${candidate.id}.passiveOverrides`,
      "Tree.Spec.Overrides",
      `${candidate.tree.overrideCount} tattoo/override record(s) are retained ` +
        "as source metadata but are not yet editable.",
    );
  }
  if (candidate.config?.inputCount) {
    add(
      report,
      "omitted",
      `states.${candidate.id}.configuration`,
      "Config.ConfigSet.Input",
      `${candidate.config.inputCount} calculation/configuration input(s) are ` +
        "not promoted into native character facts.",
    );
  }
  const inventory = playerInventory(candidate, model, context, report);
  const stateActors = review.includeActorLoadouts
    ? actors(candidate, model, resolution, context, report)
    : [];
  return {
    id: `state:${stablePart(candidate.id)}`,
    parentId,
    order,
    name: approved.name,
    description: "",
    phase: approved.phase,
    ...(approved.characterLevel != null
      ? { characterLevel: approved.characterLevel }
      : {}),
    ...(approved.recommendedLevelRange
      ? { recommendedLevelRange: [...approved.recommendedLevelRange] }
      : {}),
    character: {
      class: model.className || null,
      ascendancy: candidate.tree.ascendancyId === 0
        ? null
        : model.ascendancyName || null,
    },
    passiveTree: {
      allocations: candidate.tree.nodes
        .filter((node) =>
          !context.knownNodeIds || context.knownNodeIds.has(node)
        )
        .map((nodeId) => ({
          nodeId,
          ...(masteryByNode.get(nodeId)
            ? { optionId: masteryByNode.get(nodeId) }
            : {}),
        })),
    },
    skills: { groups: skillGroups(candidate, context.profile, report) },
    inventory: { items: inventory },
    actors: stateActors,
    gameData: {
      pob: {
        treeSet: {
          index: candidate.tree.index,
          title: candidate.tree.title.raw,
          treeVersion: candidate.tree.treeVersion,
        },
        skillSetId: candidate.skills?.id,
        itemSetId: candidate.items?.id,
        configSetId: candidate.config?.id,
        configCustomMods: candidate.config?.customMods,
        unresolvedNodes,
        passiveOverrideCount: candidate.tree.overrideCount,
      },
    },
    provenance: { source: "pob", sourceId: candidate.id },
  };
}

function syntheticRoot(
  model: PoBSourceModel,
  context: PoBNormalizationContext,
): CharacterStateV3 {
  return {
    id: "state:pob-import-root",
    parentId: null,
    order: 0,
    name: "Imported PoB profiles",
    description:
      "Choose a branch to replay one imported Path of Building profile.",
    phase: "custom",
    character: {
      class: model.className || null,
      ascendancy: null,
    },
    passiveTree: { allocations: [] },
    skills: { groups: [] },
    inventory: { items: [] },
    actors: [],
    gameData: { pob: { syntheticRoot: true } },
    provenance: { source: "pob" },
  };
}

export function normalizePoBImport(
  preview: PoBImportPreview,
  review: PoBImportReview,
  context: PoBNormalizationContext,
): PoBImportResult {
  if (context.profile.integrations.pobImport !== "enabled") {
    throw new Error(
      `${context.profile.definition.shortLabel} does not enable Path of Building import.`,
    );
  }
  if (!review.planName.trim()) throw new Error("PoB import needs a plan name.");
  if (!review.candidateOrder.length) {
    throw new Error("Select at least one PoB profile to import.");
  }
  const mismatch = targetVersionMismatch(preview.source, context.profile);
  if (mismatch) {
    throw new Error(
      `${mismatch} Cross-game imports are blocked instead of guessing.`,
    );
  }
  const candidates = review.candidateOrder.map((id) => {
    const candidate = preview.resolution.candidates.find((value) =>
      value.id === id
    );
    if (!candidate) throw new Error(`Unknown reviewed PoB candidate ${id}.`);
    return candidate;
  });
  if (!candidates.some((value) => value.id === review.defaultLeafCandidateId)) {
    throw new Error("The selected default PoB profile is not being imported.");
  }
  const report = structuredClone(preview.report);
  const states: CharacterStateV3[] = [];
  const siblings = review.arrangement === "siblings" && candidates.length > 1;
  if (siblings) states.push(syntheticRoot(preview.source, context));
  let parentId = siblings ? "state:pob-import-root" : null;
  candidates.forEach((candidate, index) => {
    const state = stateForCandidate(
      candidate,
      review,
      parentId,
      siblings ? index : 0,
      preview.source,
      preview.resolution,
      context,
      report,
    );
    states.push(state);
    if (!siblings) parentId = state.id;
    add(
      report,
      "imported",
      `states.${candidate.id}`,
      "Tree.Spec",
      `Imported "${candidate.name}" as a complete native state.`,
    );
  });
  add(
    report,
    "transformed",
    "states",
    "PoB independent set order",
    siblings
      ? "Reviewed profiles were imported as sibling branches."
      : "Reviewed profiles were imported in the explicitly approved linear order.",
  );
  const defaultCandidateState = `state:${
    stablePart(review.defaultLeafCandidateId)
  }`;
  const activeStateId = defaultCandidateState;
  const rootStateId = states.find((state) => state.parentId === null)!.id;
  const plan: PlanV3 = {
    format: "buildwright-planner-plan",
    version: 3,
    game: context.profile.definition.id,
    patch: context.patch,
    identity: {
      name: review.planName.trim(),
      description: "Imported from Path of Building after compatibility review.",
    },
    states,
    rootStateId,
    activeStateId,
    defaultLeafId: defaultCandidateState,
    editor: { routeLeafId: defaultCandidateState },
    ...(preview.source.notes ? { guide: preview.source.notes } : {}),
    provenance: [{
      source: context.sourceUrl ? "pobb-in" : "pob",
      importedAt: new Date().toISOString(),
      ...(context.sourceUrl ? { sourceUrl: context.sourceUrl } : {}),
      ...(preview.source.targetVersion
        ? { sourceVersion: preview.source.targetVersion }
        : {}),
    }],
  };
  return { plan, report };
}

export async function inspectPoBImport(
  input: string,
  limits: Partial<PoBImportLimits> = {},
  profile?: GameProfile,
): Promise<PoBImportPreview> {
  const xml = await decodePoBInput(input, limits);
  const source = parsePoBXml(xml, limits);
  const resolution = resolvePoBLoadouts(source);
  const report = emptyReport();
  if (profile) {
    const mismatch = targetVersionMismatch(source, profile);
    if (mismatch) {
      add(
        report,
        "errors",
        "build.targetVersion",
        "Build.targetVersion",
        `${mismatch} Open the source in the matching game planner.`,
      );
    }
  }
  if (source.calculatedPlayerStatCount) {
    add(
      report,
      "omitted",
      "build.calculatedStats",
      "Build.PlayerStat",
      `${source.calculatedPlayerStatCount} cached calculation result(s) will ` +
        "not be imported.",
    );
  }
  for (const section of source.omittedSections) {
    add(
      report,
      "omitted",
      `source.${section.name}`,
      section.name,
      `${section.name} is outside the authored character-state model.`,
    );
  }
  for (const candidate of resolution.candidates) {
    for (const missing of candidate.missingSections) {
      add(
        report,
        "unresolved",
        `candidates.${candidate.id}.${missing}`,
        `${missing} set`,
        `"${candidate.name}" has no matching ${missing} set.`,
      );
    }
  }
  for (const [kind, values] of Object.entries(resolution.unmatched)) {
    for (const value of values) {
      add(
        report,
        "unresolved",
        `unmatched.${kind}.${value.id}`,
        `${kind} set`,
        `Unmatched ${kind} set "${value.title.display}" will not be hidden.`,
      );
    }
  }
  return {
    source,
    resolution,
    proposals: resolution.candidates.map((candidate) =>
      proposePoBStateMetadata(candidate, source)
    ),
    report,
  };
}
