/// <reference lib="deno.ns" />

import type {
  ActorLoadoutV3,
  EquippedItemV3,
  Plan,
} from "../../types/shared.d.ts";
import {
  addChildState,
  mergePlanV2RouteIntoV3,
  migratePlanV2ToV3,
  projectPlanV3ToV2,
  removeActor,
  removeInventoryItem,
  removeStateSubtree,
  reorderState,
  reparentState,
  replayFramesForRoute,
  routeToState,
  transitionBetweenStates,
  upsertActor,
  upsertInventoryItem,
  validatePlanV3,
} from "./plan_v3.ts";
import poe1Fixture from "../../crates/tree_render/assets/planner/fixtures/v2-poe1-plan.json" with {
  type: "json",
};
import poe2Fixture from "../../crates/tree_render/assets/planner/fixtures/v2-poe2-plan.json" with {
  type: "json",
};

function cloned(fixture: unknown): Plan {
  return JSON.parse(JSON.stringify(fixture)) as Plan;
}

function authoredFacts(plan: Plan): unknown {
  return {
    game: plan.game,
    name: plan.name,
    description: plan.description,
    class: plan.class,
    patch: plan.patch,
    activeCapture: plan.activeCapture,
    activeSet: plan.activeSet,
    guide: plan.guide,
    captures: plan.captures.map((capture) => ({
      id: capture.id,
      levelRange: capture.levelRange,
      name: capture.name,
      passives: capture.passives,
      skills: capture.skills.map((skill) => ({
        ...skill,
        // Omitted and explicit "main" are the same v2 semantic value.
        set: skill.set || "main",
      })),
      // v3 intentionally adds stable item instance ids. They are not an
      // authored v2 fact, so compare the rest of each item.
      items: capture.items.map(({ id: _id, ...item }) => item),
      ascendancy: capture.ascendancy,
      description: capture.description,
      class: capture.class,
    })),
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return "{" + entries.map(([key, item]) =>
      JSON.stringify(key) + ":" + canonical(item)
    ).join(",") + "}";
  }
  return JSON.stringify(value);
}

Deno.test("native validation safely rejects malformed untrusted JSON", () => {
  const malformed = {
    format: "buildwright-planner-plan",
    version: 3,
    game: "poe1",
    patch: null,
    identity: { name: "Broken", description: "" },
    states: [{
      id: "state-1",
      parentId: null,
      order: 0,
      name: "Broken",
      description: "",
      phase: "leveling",
      character: { class: null, ascendancy: null },
      passiveTree: { allocations: [] },
      skills: { groups: [] },
      inventory: { items: [{ id: "bad", slot: null, item: {} }] },
      actors: [],
      recommendedLevelRange: "1-20",
    }],
    rootStateId: "state-1",
    activeStateId: "state-1",
    defaultLeafId: "state-1",
  };
  const errors = validatePlanV3(malformed);
  if (
    !errors.some((error) => error.includes("recommendedLevelRange")) ||
    !errors.some((error) => error.includes(".slot must be an object"))
  ) {
    throw new Error(
      "malformed runtime values were not rejected by the shape gate: " +
        errors.join("; "),
    );
  }
});

for (
  const [name, source] of [
    ["poe1", poe1Fixture],
    ["poe2", poe2Fixture],
  ] as const
) {
  Deno.test(`v2 → v3 → v2 preserves ${name} authored facts`, () => {
    const before = cloned(source);
    const v3 = migratePlanV2ToV3(before);
    const errors = validatePlanV3(v3);
    if (errors.length) throw new Error(errors.join("; "));
    const after = projectPlanV3ToV2(v3);
    if (canonical(authoredFacts(after)) !== canonical(authoredFacts(before))) {
      throw new Error(
        `${name} authored facts changed across the migration boundary`,
      );
    }
  });
}

Deno.test("identity author and links survive the compatibility adapter", () => {
  const before = cloned(poe2Fixture);
  before.author = "Build Author";
  before.links = [{ label: "Guide", url: "https://example.com/guide" }];
  const after = projectPlanV3ToV2(migratePlanV2ToV3(before));
  if (
    after.author !== before.author ||
    canonical(after.links) !== canonical(before.links)
  ) {
    throw new Error(
      "author/link identity was lost at the v2 compatibility boundary",
    );
  }
});

Deno.test("verified unique source identity survives the compatibility adapter", () => {
  const before = cloned(poe2Fixture);
  before.captures[0]!.items[0] = {
    ...before.captures[0]!.items[0],
    uniqueName: "Display Name",
    officialUniqueName: "GGG Words Name",
  };
  const migrated = migratePlanV2ToV3(before);
  const unique = migrated.states[0]!.inventory.items[0]!.item.unique;
  if (
    unique?.name !== "Display Name" || unique.source !== "ggg" ||
    unique.sourceId !== "GGG Words Name"
  ) {
    throw new Error("verified Words identity was not retained natively");
  }
  const after = projectPlanV3ToV2(migrated);
  if (after.captures[0]!.items[0]!.officialUniqueName !== "GGG Words Name") {
    throw new Error("verified Words identity was lost on projection");
  }
});

Deno.test("rich item facts survive the temporary compatibility editor", () => {
  const before = cloned(poe1Fixture);
  before.captures[0]!.items[0] = {
    ...before.captures[0]!.items[0],
    itemLevel: 86,
    quality: 28,
    corrupted: true,
    sockets: [
      { group: 0, color: "R", kind: "gem" },
      { group: 0, color: "G", kind: "gem" },
      { group: 1, kind: "abyss" },
    ],
    sourceText: "Rarity: Rare\nReliable Hat\n--------\nImported source block",
  };
  const native = migratePlanV2ToV3(before);
  const spec = native.states[0]!.inventory.items[0]!.item;
  if (
    spec.itemLevel !== 86 || spec.quality !== 28 || !spec.corrupted ||
    spec.sockets?.length !== 3 || spec.sockets[1]?.color !== "G" ||
    !spec.sourceText?.includes("Imported source block")
  ) {
    throw new Error("rich item facts did not enter the native model");
  }
  const visible = projectPlanV3ToV2(native).captures[0]!.items[0]!;
  if (
    visible.itemLevel !== 86 || visible.quality !== 28 ||
    visible.sockets?.[2]?.kind !== "abyss" ||
    visible.sourceText !== before.captures[0]!.items[0]!.sourceText
  ) {
    throw new Error(
      "rich item facts disappeared from the compatibility editor",
    );
  }
  const merged = mergePlanV2RouteIntoV3(
    native,
    projectPlanV3ToV2(native),
  );
  if (
    canonical(merged.states[0]!.inventory.items[0]!.item) !== canonical(spec)
  ) {
    throw new Error("compatibility sync changed an untouched rich item");
  }
});

Deno.test("external adapter facts survive v2 migration without entering native ids", () => {
  const before = cloned(poe2Fixture);
  before.captures[0]!.gameData = {
    gggBuildImport: {
      unresolvedPassiveIds: ["future_passive"],
      source: { passives: ["future_passive"] },
    },
  };
  const migrated = migratePlanV2ToV3(before);
  const roundTrip = projectPlanV3ToV2(migrated);
  if (
    canonical(roundTrip.captures[0]!.gameData) !==
      canonical(before.captures[0]!.gameData)
  ) {
    throw new Error("external import report/source text was discarded");
  }
  if (
    migrated.states[0]!.passiveTree.allocations.some(
      (allocation) => allocation.nodeId === "future_passive",
    )
  ) {
    throw new Error(
      "an unresolved external id entered the native graph namespace",
    );
  }
});

Deno.test("state routes preserve shared history and select one branch", () => {
  const plan = migratePlanV2ToV3(cloned(poe2Fixture));
  const parent = plan.states.at(-1)!;
  const sibling = {
    ...JSON.parse(JSON.stringify(parent)),
    id: "cap_poe2_bossing",
    parentId: plan.rootStateId,
    order: parent.order + 1,
    name: "Bossing alternative",
  };
  plan.states.push(sibling);
  const route = routeToState(plan, sibling.id);
  if (
    route.map((state) => state.id).join(",") !==
      [plan.rootStateId, sibling.id].join(",")
  ) {
    throw new Error("selected branch route did not retain only its ancestry");
  }
});

Deno.test("state validation rejects cycles, duplicate roots, and dangling pointers", () => {
  const plan = migratePlanV2ToV3(cloned(poe1Fixture));
  plan.states[0]!.parentId = plan.states[1]!.id;
  plan.activeStateId = "missing";
  const errors = validatePlanV3(plan).join("\n");
  for (const expected of ["expected one root", "activeStateId", "cycle"]) {
    if (!errors.includes(expected)) {
      throw new Error(`validation did not report ${expected}:\n${errors}`);
    }
  }
});

Deno.test("level remains metadata rather than a state identity", () => {
  const plan = migratePlanV2ToV3(cloned(poe2Fixture));
  plan.states[0]!.characterLevel = 90;
  plan.states[1]!.characterLevel = 90;
  if (validatePlanV3(plan).length) {
    throw new Error("two distinct states at the same level must remain legal");
  }
});

Deno.test("recommended level ranges are optional validated guidance", () => {
  const original = migratePlanV2ToV3(cloned(poe2Fixture));
  const next = addChildState(original, original.defaultLeafId, {
    id: "late-maps",
    name: "Late maps",
    characterLevel: 92,
    recommendedLevelRange: [88, 95],
  });
  const child = next.states.find((state) => state.id === "late-maps");
  if (canonical(child?.recommendedLevelRange) !== "[88,95]") {
    throw new Error("recommended range was not retained on the state");
  }
  if (validatePlanV3(next).length) {
    throw new Error("a valid recommended range was rejected");
  }
  child!.recommendedLevelRange = [96, 88];
  if (
    !validatePlanV3(next).some((error) =>
      error.includes("recommendedLevelRange")
    )
  ) {
    throw new Error("an inverted recommended range was accepted");
  }
});

Deno.test("compatibility sync does not promote a recommended range to an exact level", () => {
  const original = migratePlanV2ToV3(cloned(poe2Fixture));
  const state = original.states[0]!;
  delete state.characterLevel;
  state.recommendedLevelRange = [68, 82];
  const projected = projectPlanV3ToV2(original);
  const merged = mergePlanV2RouteIntoV3(original, projected);
  const restored = merged.states[0]!;
  if (restored.characterLevel != null) {
    throw new Error(
      `compatibility sync invented exact level ${restored.characterLevel}`,
    );
  }
  if (canonical(restored.recommendedLevelRange) !== "[68,82]") {
    throw new Error("compatibility sync lost the recommended level range");
  }
});

Deno.test("an open-ended blank v2 capture migrates as level 1", () => {
  const blank = cloned(poe2Fixture);
  blank.captures = [{
    id: "blank",
    levelRange: [1, 100],
    name: null,
    description: "",
    ascendancy: null,
    passives: [],
    skills: [],
    items: [],
  }];
  blank.activeCapture = 0;
  const migrated = migratePlanV2ToV3(blank);
  if (
    migrated.states[0]?.characterLevel !== 1 ||
    migrated.states[0]?.name !== "Current build"
  ) {
    throw new Error(
      "blank working capture was mistaken for a level-100 milestone",
    );
  }
});

Deno.test("child states are complete deep copies and branches stay isolated", () => {
  const original = migratePlanV2ToV3(cloned(poe1Fixture));
  const parentId = original.defaultLeafId;
  const firstBranch = addChildState(original, parentId, {
    id: "mapping",
    name: "Mapping",
  });
  const branched = addChildState(firstBranch, parentId, {
    id: "bossing",
    name: "Bossing",
    makeDefault: false,
  });
  const mapping = branched.states.find((state) => state.id === "mapping")!;
  const bossing = branched.states.find((state) => state.id === "bossing")!;
  mapping.inventory.items[0]!.item.name = "Mapping-only mutation";
  if (
    bossing.inventory.items[0]!.item.name === "Mapping-only mutation" ||
    stateName(branched, parentId) === "Mapping-only mutation"
  ) {
    throw new Error("branch states share mutable item payloads");
  }
  if (mapping.parentId !== parentId || bossing.parentId !== parentId) {
    throw new Error("children were not attached to the requested parent");
  }
});

function actorFixture(id = "guardian"): ActorLoadoutV3 {
  return {
    id,
    kind: "animate-guardian",
    name: "Animate Guardian",
    inventory: { items: [] },
  };
}

function itemFixture(id: string, slot = "helmet"): EquippedItemV3 {
  return {
    id,
    slot: { group: "equipment", id: slot },
    item: {
      base: { kind: "base", key: "Iron Hat", name: "Iron Hat" },
      rarity: "rare",
      name: "Reliable Hat",
      itemLevel: 86,
      quality: 20,
      mods: [{ kind: "explicit", text: "+100 to maximum Life", values: [100] }],
    },
  };
}

Deno.test("state validation owns actor and stable item invariants", () => {
  const plan = migratePlanV2ToV3(cloned(poe1Fixture));
  const state = plan.states[0]!;
  state.actors = [actorFixture(), actorFixture()];
  const shared = itemFixture("shared-item");
  state.inventory.items.push(shared);
  state.actors[0]!.inventory!.items.push(shared);
  state.inventory.items[0]!.item.mods = [{
    kind: "explicit",
    text: "",
    values: [Number.NaN],
  }];
  state.inventory.items[0]!.item.sockets = [{ group: -1, color: "" }];
  const errors = validatePlanV3(plan).join("\n");
  for (
    const expected of [
      "duplicate actor id guardian",
      "belongs to both player and actor guardian",
      "mod with empty text",
      "non-finite mod values",
      "invalid socket group",
      "empty socket color",
    ]
  ) {
    if (!errors.includes(expected)) {
      throw new Error(`validation did not report ${expected}:\n${errors}`);
    }
  }
});

Deno.test("actor and inventory mutations are transactional and branch-isolated", () => {
  const original = migratePlanV2ToV3(cloned(poe1Fixture));
  const parentId = original.defaultLeafId;
  let plan = addChildState(original, parentId, {
    id: "guardian-setup",
    makeDefault: false,
  });
  plan = upsertActor(plan, "guardian-setup", actorFixture());
  plan = upsertInventoryItem(
    plan,
    "guardian-setup",
    { kind: "actor", actorId: "guardian" },
    itemFixture("guardian-hat"),
  );
  const child = plan.states.find((state) => state.id === "guardian-setup")!;
  const parent = plan.states.find((state) => state.id === parentId)!;
  if (
    child.actors[0]?.inventory?.items[0]?.id !== "guardian-hat" ||
    parent.actors.length !== 0
  ) {
    throw new Error("actor mutation leaked into its parent state");
  }
  plan = removeInventoryItem(
    plan,
    "guardian-setup",
    { kind: "actor", actorId: "guardian" },
    "guardian-hat",
  );
  plan = removeActor(plan, "guardian-setup", "guardian");
  if (
    plan.states.find((state) => state.id === "guardian-setup")!.actors.length
  ) {
    throw new Error("actor removal left native state behind");
  }
});

Deno.test("an item id cannot silently move between player and actor inventories", () => {
  const original = migratePlanV2ToV3(cloned(poe1Fixture));
  const stateId = original.defaultLeafId;
  let plan = upsertActor(original, stateId, actorFixture());
  plan = upsertInventoryItem(
    plan,
    stateId,
    { kind: "player" },
    itemFixture("single-owner-item"),
  );
  let refused = false;
  try {
    upsertInventoryItem(
      plan,
      stateId,
      { kind: "actor", actorId: "guardian" },
      itemFixture("single-owner-item"),
    );
  } catch (error) {
    refused = String(error).includes("already belongs to player");
  }
  if (!refused) throw new Error("item ownership collision was accepted");
});

Deno.test("upserting a concrete slot replaces its occupant transactionally", () => {
  const original = migratePlanV2ToV3(cloned(poe1Fixture));
  const stateId = original.defaultLeafId;
  let plan = upsertActor(original, stateId, actorFixture());
  plan = upsertInventoryItem(
    plan,
    stateId,
    { kind: "actor", actorId: "guardian" },
    itemFixture("first-hat"),
  );
  plan = upsertInventoryItem(
    plan,
    stateId,
    { kind: "actor", actorId: "guardian" },
    itemFixture("replacement-hat"),
  );
  const items = plan.states.find((state) => state.id === stateId)!
    .actors[0]!.inventory!.items;
  if (items.length !== 1 || items[0]?.id !== "replacement-hat") {
    throw new Error("concrete actor slot retained two occupants");
  }
});

Deno.test("actor inventory changes stay out of the player item transition", () => {
  const plan = migratePlanV2ToV3(cloned(poe1Fixture));
  const before = plan.states[0]!;
  const after = JSON.parse(JSON.stringify(before)) as typeof before;
  after.id = "actor-change";
  after.actors.push(actorFixture());
  after.actors[0]!.inventory!.items.push(itemFixture("guardian-hat"));
  const transition = transitionBetweenStates(before, after);
  if (
    transition.items.added.length || transition.items.changed.length ||
    transition.items.removed.length
  ) {
    throw new Error("actor equipment was reported as player equipment");
  }
  if (transition.actors.added[0] !== "guardian") {
    throw new Error("actor equipment did not stay within the actor transition");
  }
});

Deno.test("item transitions use both slot and stable instance identity", () => {
  const plan = migratePlanV2ToV3(cloned(poe2Fixture));
  const before = JSON.parse(
    JSON.stringify(plan.states[0]!),
  ) as typeof plan.states[number];
  const after = JSON.parse(JSON.stringify(before)) as typeof before;
  before.inventory.items = [itemFixture("first", "helmet")];
  after.inventory.items = [itemFixture("second", "helmet")];
  let transition = transitionBetweenStates(before, after);
  if (
    transition.items.added[0] !== "equipment|helmet|main|second" ||
    transition.items.removed[0] !== "equipment|helmet|main|first"
  ) {
    throw new Error("same-slot item swap lost stable instance identity");
  }
  after.inventory.items = [itemFixture("first", "boots")];
  transition = transitionBetweenStates(before, after);
  if (
    transition.items.added[0] !== "equipment|boots|main|first" ||
    transition.items.removed[0] !== "equipment|helmet|main|first"
  ) {
    throw new Error(
      "item slot movement was flattened into an ambiguous change",
    );
  }
});

function stateName(
  plan: ReturnType<typeof migratePlanV2ToV3>,
  id: string,
): string | undefined {
  return plan.states.find((state) => state.id === id)?.inventory.items[0]?.item
    .name;
}

Deno.test("reparent, reorder, and subtree deletion preserve graph invariants", () => {
  let plan = migratePlanV2ToV3(cloned(poe2Fixture));
  plan = addChildState(plan, plan.rootStateId, {
    id: "alt-a",
    makeDefault: false,
  });
  plan = addChildState(plan, plan.rootStateId, {
    id: "alt-b",
    makeDefault: false,
  });
  plan = reorderState(plan, "alt-b", 0);
  const siblings = plan.states
    .filter((state) => state.parentId === plan.rootStateId)
    .sort((a, b) => a.order - b.order);
  if (siblings[0]?.id !== "alt-b") throw new Error("sibling reorder failed");
  plan = reparentState(plan, "alt-a", "alt-b");
  if (plan.states.find((state) => state.id === "alt-a")?.parentId !== "alt-b") {
    throw new Error("state reparent failed");
  }
  let cycleRejected = false;
  try {
    reparentState(plan, "alt-b", "alt-a");
  } catch {
    cycleRejected = true;
  }
  if (!cycleRejected) throw new Error("cycle-producing reparent was accepted");
  plan = removeStateSubtree(plan, "alt-b");
  if (
    plan.states.some((state) => state.id === "alt-a" || state.id === "alt-b")
  ) {
    throw new Error("subtree deletion left descendants behind");
  }
  if (validatePlanV3(plan).length) {
    throw new Error("graph invalid after subtree deletion");
  }
});

Deno.test("computed transitions and replay frames describe route changes", () => {
  let plan = migratePlanV2ToV3(cloned(poe2Fixture));
  const route = routeToState(plan, plan.defaultLeafId);
  const transition = transitionBetweenStates(route[0]!, route[1]!);
  if (
    !transition.passives.added.some((id) => id.startsWith("2003|")) ||
    !transition.items.changed.length
  ) {
    throw new Error("transition did not detect passive and item changes");
  }
  plan = addChildState(plan, plan.defaultLeafId, {
    id: "aspirational",
    phase: "aspirational",
    characterLevel: 100,
  });
  const frames = replayFramesForRoute(plan);
  if (frames.length !== 3 || frames[2]?.state.phase !== "aspirational") {
    throw new Error(
      "replay route did not produce one frame per selected state",
    );
  }
  if (frames[0]?.transition.fromStateId !== null) {
    throw new Error("root replay frame must transition from an empty state");
  }
});

Deno.test("compatibility edits preserve sibling branches and native-only facts", () => {
  const base = migratePlanV2ToV3(cloned(poe2Fixture));
  const branched = addChildState(base, base.rootStateId, {
    id: "alternate",
    name: "Alternate",
    makeDefault: false,
  });
  branched.editor = {
    ...(branched.editor ?? {}),
    routeLeafId: branched.defaultLeafId,
  };
  branched.activeStateId = branched.defaultLeafId;
  const active = branched.states.find((state) =>
    state.id === branched.defaultLeafId
  )!;
  active.phase = "endgame";
  active.actors.push({
    id: "guardian",
    kind: "animate-guardian",
    name: "Animate Guardian",
    inventory: { items: [] },
  });
  active.inventory.items[0]!.item.sourceText = "raw imported item";
  active.inventory.items[0]!.item.base = {
    kind: "base",
    key: "Local base",
    name: "Local base",
    source: "pob",
    sourceId: "Metadata/Items/PobBase",
  };
  active.inventory.items[0]!.item.mods = [{
    kind: "fractured",
    text: "+100 to maximum Life",
    sourceId: "LocalLifeMod",
    values: [100],
  }];
  const view = projectPlanV3ToV2(branched);
  view.name = "Edited through compatibility view";
  view.captures.at(-1)!.description = "Updated";
  const merged = mergePlanV2RouteIntoV3(branched, view);
  if (!merged.states.some((state) => state.id === "alternate")) {
    throw new Error("compatibility merge discarded a sibling branch");
  }
  const mergedActive = merged.states.find((state) =>
    state.id === merged.defaultLeafId
  )!;
  if (
    mergedActive.phase !== "endgame" ||
    mergedActive.actors[0]?.id !== "guardian" ||
    mergedActive.inventory.items[0]?.item.sourceText !== "raw imported item" ||
    mergedActive.inventory.items[0]?.item.base?.sourceId !==
      "Metadata/Items/PobBase" ||
    mergedActive.inventory.items[0]?.item.mods?.[0]?.kind !== "fractured" ||
    mergedActive.inventory.items[0]?.item.mods?.[0]?.sourceId !==
      "LocalLifeMod" ||
    mergedActive.inventory.items[0]?.item.mods?.[0]?.values?.[0] !== 100
  ) {
    throw new Error("compatibility merge discarded native-only state data");
  }
  if (
    merged.identity.name !== "Edited through compatibility view" ||
    mergedActive.description !== "Updated"
  ) {
    throw new Error("compatibility edits did not reach the native plan");
  }
});

Deno.test("removing a compatibility keyframe promotes descendants without data loss", () => {
  const base = migratePlanV2ToV3(cloned(poe1Fixture));
  const middle = base.states[0]!;
  const leaf = base.states[1]!;
  const alternative = addChildState(base, middle.id, {
    id: "alternative",
    name: "Alternative",
    makeDefault: false,
  });
  // Add a state between root and the current leaf, then project that route.
  const inserted = addChildState(alternative, middle.id, {
    id: "middle",
    name: "Middle",
  });
  const oldLeaf = inserted.states.find((state) => state.id === leaf.id)!;
  oldLeaf.parentId = "middle";
  inserted.defaultLeafId = oldLeaf.id;
  inserted.activeStateId = oldLeaf.id;
  const view = projectPlanV3ToV2(inserted);
  view.captures.splice(1, 1);
  view.activeCapture = view.captures.length - 1;
  const merged = mergePlanV2RouteIntoV3(inserted, view);
  if (merged.states.some((state) => state.id === "middle")) {
    throw new Error("removed keyframe remained in the native graph");
  }
  if (
    merged.states.find((state) => state.id === leaf.id)?.parentId !== middle.id
  ) {
    throw new Error("route descendant was not promoted");
  }
  if (
    merged.states.find((state) => state.id === "alternative")?.parentId !==
      middle.id
  ) {
    throw new Error("unrelated sibling branch was changed");
  }
});
