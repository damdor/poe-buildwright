/// <reference lib="deno.ns" />

import type { Capture, CharacterStateV3, Plan, PlanV3 } from "../../../../types/shared.d.ts";
import { gameDefinitionFor } from "./game_profile.ts";
import {
  buildOfficialCatalogueData, enrichPlanWithOfficialCatalogue,
  gggMarkup, gggPlainText, graphIdToOfficial, officialIdToGraph,
  inspectOfficialBuildIdentifiers, officialInventoryDefinitionIssues,
  officialInventoryIdSupported, officialItemHintLines,
  prepareOfficialRoute, resolveOfficialItemLocation, resolvePlannerSlot,
} from "./ggg_build_core.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function capture(id: string, range: [number, number]): Capture {
  return {
    id,
    levelRange: range,
    name: id,
    description: "",
    ascendancy: null,
    passives: [],
    skills: [],
    items: [],
  };
}

function plan(captures: Capture[]): Plan {
  return {
    game: "poe2",
    name: "Adapter fixture",
    description: "",
    class: "Druid",
    patch: "4.5.4.4.native",
    captures,
    activeCapture: captures.length - 1,
  };
}

function state(
  id: string,
  parentId: string | null,
  order: number,
  characterLevel?: number,
): CharacterStateV3 {
  return {
    id,
    parentId,
    order,
    name: id,
    description: "",
    phase: "custom",
    ...(characterLevel != null ? { characterLevel } : {}),
    character: { class: "Druid", ascendancy: null },
    passiveTree: { allocations: [] },
    skills: { groups: [] },
    inventory: { items: [] },
    actors: [],
  };
}

function native(states: CharacterStateV3[], leafId: string): PlanV3 {
  return {
    format: "buildwright-planner-plan",
    version: 3,
    game: "poe2",
    patch: "4.5.4.4.native",
    identity: { name: "Adapter fixture", description: "" },
    states,
    rootStateId: states[0]!.id,
    activeStateId: leafId,
    defaultLeafId: leafId,
    editor: { routeLeafId: leafId },
  };
}

Deno.test("official passive ids stay outside native graph identity", () => {
  const ids = {
    graphToBuild: { "35426": "strength89" },
    buildToGraph: { strength89: "35426" },
  };
  assert(graphIdToOfficial("35426", ids) === "strength89", "graph → build failed");
  const imported = officialIdToGraph("strength89", ids);
  assert(imported.graphId === "35426" && !imported.legacy, "build → graph failed");
  const legacy = officialIdToGraph("35426", ids, new Set(["35426"]));
  assert(legacy.graphId === "35426" && legacy.legacy, "legacy graph id was lost");
  assert(officialIdToGraph("missing", ids).graphId === null, "unknown id was invented");
});

Deno.test("official markup is deliberate and user text stays literal", () => {
  assert(
    gggPlainText("<b>{not markup}") === "‹b›(not markup)",
    "untrusted markup was not neutralized",
  );
  assert(
    gggMarkup("b", "Respec <now>") === "<b>{Respec ‹now›}",
    "official brace markup drifted",
  );
});

Deno.test("rich native items become explicit loss-aware official hints", () => {
  const lines = officialItemHintLines({
    name: "Doom Shelter",
    base: "Expert Hexer's Robe",
    rarity: "rare",
    itemLevel: 86,
    quality: 30,
    corrupted: true,
    sockets: [
      { group: 0, color: "R", kind: "gem" },
      { group: 0, color: "G", kind: "gem" },
      { group: 1, kind: "abyss" },
    ],
    mods: ["+100 to maximum Life"],
    note: "Use after fixing resistances.",
    sourceText: "Rarity: Rare\nDoom Shelter\nExpert Hexer's Robe",
  });
  assert(lines.includes("Item level: 86"), "item level hint was lost");
  assert(lines.includes("Quality: +30%"), "quality hint was lost");
  assert(lines.includes("Sockets: R-G abyss"), "socket links were flattened");
  assert(lines.includes("Corrupted"), "corruption hint was lost");
  assert(
    lines.includes("1. +100 to maximum Life"),
    "typed item stat text was lost",
  );
  assert(
    lines.at(-1)?.includes("Expert Hexer's Robe"),
    "original imported item text was lost",
  );
});

Deno.test("official catalogues separate exact source ids from display labels", () => {
  const catalogue = buildOfficialCatalogueData({
    source: "ggg",
    gems: [
      { id: "Metadata/Items/Gems/SkillGemEarthquake", gem_type: "Active" },
      {
        id: "Metadata/Items/Gems/SkillGemCastOnCritical",
        gem_type: "Active",
        skill_types: ["Meta"],
      },
      { id: "Metadata/Items/Gems/SupportGemFastForward", gem_type: "Support" },
    ],
  }, {
    official_build: {
      source: "ggg",
      inventory_ids: ["Weapon1", "Helm1", "BodyArmour1"],
    },
    uniques: [
      { name: "Exact Unique", official_name: "Exact Unique" },
      { name: "Fuzzy Art Only" },
    ],
  });
  assert(
    catalogue.activeSkillIds.has("Metadata/Items/Gems/SkillGemEarthquake"),
    "active BaseItemTypes.Id was lost",
  );
  assert(
    catalogue.supportSkillIds.has("Metadata/Items/Gems/SupportGemFastForward"),
    "support BaseItemTypes.Id was lost",
  );
  assert(
    catalogue.metaSkillIds.has("Metadata/Items/Gems/SkillGemCastOnCritical"),
    "unsupported meta identity was lost",
  );
  const source = plan([capture("root", [0, 100])]);
  source.captures[0]!.items = [
    { slot: "ring1", uniqueName: "Exact Unique" },
    { slot: "ring2", uniqueName: "Fuzzy Art Only" },
  ];
  const enriched = enrichPlanWithOfficialCatalogue(source, catalogue);
  assert(
    enriched.captures[0]!.items[0]!.officialUniqueName === "Exact Unique",
    "exact Words entry was not attached",
  );
  assert(
    enriched.captures[0]!.items[1]!.officialUniqueName === undefined,
    "fuzzy art match escaped into the official identifier",
  );
  assert(
    source.captures[0]!.items[0]!.officialUniqueName === undefined,
    "catalogue enrichment mutated the native source plan",
  );
});

Deno.test("official inventory ids retain their distinct source boundaries", () => {
  const definition = gameDefinitionFor("poe2").officialBuild;
  const tableIds = new Set([
    "Weapon1", "Offhand1", "Weapon2", "Offhand2", "Helm1",
    "BodyArmour1", "Gloves1", "Boots1", "Amulet1", "Ring1", "Ring2",
    "Belt1", "Flask1",
  ]);
  assert(
    officialInventoryDefinitionIssues(definition, tableIds).length === 0,
    "a profile target claimed a missing Inventories.Id",
  );
  assert(
    officialInventoryIdSupported("Charm3", definition, tableIds),
    "Build Planner-only charm target was rejected",
  );
  assert(
    !officialInventoryIdSupported("MadeUpSlot", definition, tableIds),
    "unknown inventory id was accepted",
  );
  const broken = structuredClone(definition)!;
  broken.inventorySlots.helmet = { inventoryId: "Helmet" };
  assert(
    officialInventoryDefinitionIssues(broken, tableIds)[0]?.slot === "helmet",
    "profile/table drift was not detected",
  );
});

Deno.test("official import inspection separates invalid from opaque identifiers", () => {
  const definition = gameDefinitionFor("poe2").officialBuild;
  const catalogue = buildOfficialCatalogueData({
    source: "ggg",
    gems: [
      { id: "active", gem_type: "Active" },
      { id: "meta", gem_type: "Active", skill_types: ["Meta"] },
      { id: "support", gem_type: "Support" },
    ],
  }, {
    official_build: {
      source: "ggg",
      inventory_ids: ["Weapon1", "PassiveJewels1"],
    },
    uniques: [{ name: "Known", official_name: "Known" }],
  });
  const report = inspectOfficialBuildIdentifiers({
    name: "Import identifiers",
    skills: [
      { id: "meta", support_skills: ["support", "missing-support"] },
      "missing-active",
    ],
    inventory_slots: [
      { inventory_id: "Charm2", unique_name: "Known" },
      { inventory_id: "PassiveJewels1" },
      { inventory_id: "MadeUpSlot", unique_name: "Missing Unique" },
    ],
  }, catalogue, definition);
  assert(report.metaSkillIds[0] === "meta", "meta gem was not reported");
  assert(
    report.unknownActiveSkillIds[0] === "missing-active",
    "unknown active id was not reported",
  );
  assert(
    report.unknownSupportSkillIds[0] === "missing-support",
    "unknown support id was not reported",
  );
  assert(
    report.uneditableInventoryIds[0] === "PassiveJewels1",
    "valid but unsupported inventory was treated as invalid",
  );
  assert(
    report.invalidInventoryIds[0] === "MadeUpSlot",
    "invalid inventory id was not separated",
  );
  assert(
    report.unknownUniqueNames[0] === "Missing Unique",
    "unknown Words entry was not reported",
  );
});

Deno.test("PoE2 profile owns bidirectional official inventory ids", () => {
  const definition = gameDefinitionFor("poe2").officialBuild;
  const location = resolveOfficialItemLocation({ slot: "helmet" }, definition);
  assert(location?.inventoryId === "Helm1", "helmet mapping failed");
  assert(
    resolvePlannerSlot("Charm3", 0, 0, definition) === "charm3",
    "Charm 3 reverse mapping failed",
  );
  assert(
    resolveOfficialItemLocation({ slot: "jewel" }, definition) === null,
    "unsupported jewel inventory hint was fabricated",
  );
  assert(
    resolveOfficialItemLocation({ slot: "helmet" }, gameDefinitionFor("poe1").officialBuild) === null,
    "PoE1 inherited PoE2 inventory ids",
  );
});

Deno.test("strict route projection derives ranges only from explicit order", () => {
  const v2 = plan([capture("root", [1, 100]), capture("maps", [1, 100])]);
  const v3 = native([
    state("root", null, 0, 1),
    state("maps", "root", 0, 72),
  ], "maps");
  const projected = prepareOfficialRoute(v2, v3);
  assert(projected.projection === "route", "ordered levels should preserve the route");
  assert(
    JSON.stringify(projected.plan.captures.map(value => value.levelRange)) ===
      JSON.stringify([[0, 71], [72, 100]]),
    "character-level boundaries were not projected deterministically",
  );
});

Deno.test("same-level states remain distinct natively and export the leaf", () => {
  const v2 = plan([capture("mapping", [90, 90]), capture("bossing", [90, 90])]);
  const v3 = native([
    state("mapping", null, 0, 90),
    state("bossing", "mapping", 0, 90),
  ], "bossing");
  const projected = prepareOfficialRoute(v2, v3);
  assert(projected.projection === "final-state", "same-level order was fabricated");
  assert(projected.plan.captures.length === 1, "ambiguous route was silently merged");
  assert(projected.plan.captures[0]!.id === "bossing", "selected leaf was not exported");
  assert(
    JSON.stringify(projected.plan.captures[0]!.levelRange) === "[0,100]",
    "final-state applicability should cover the official file",
  );
});
