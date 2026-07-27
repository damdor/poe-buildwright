/// <reference lib="deno.ns" />

import fixtureXml from "./fixtures/pob-multi-loadout.xml" with { type: "text" };
import fixturePoE2Xml from "./fixtures/pob2-multi-loadout.xml" with {
  type: "text",
};
import { createGameProfile } from "./game_profile.ts";
import {
  inspectPoBImport,
  normalizePoBImport,
  plannerSlotForPoB,
} from "./pob_normalize.ts";
import { validatePlanV3 } from "../../../../viewer/assets/plan_v3.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const poe1 = createGameProfile("poe1");
const poe2 = createGameProfile("poe2");

Deno.test("PoB slot vocabulary maps to concrete shared planner slots", () => {
  assert(
    plannerSlotForPoB({ slotName: "Weapon 2" }, poe1) === "offhand1",
    "PoB offhand mapping drifted",
  );
  assert(
    plannerSlotForPoB({ slotName: "Weapon 1 Swap" }, poe1) === "weapon2",
    "PoB weapon swap mapping drifted",
  );
  assert(
    plannerSlotForPoB({ slotName: "Flask 5" }, poe1) === "flask5",
    "PoB flask mapping drifted",
  );
  assert(
    plannerSlotForPoB({
      slotName: "Jewel 500",
      socketNodeId: "500",
    }, poe1) === "jewel",
    "tree jewel mapping drifted",
  );
  assert(
    plannerSlotForPoB({ slotName: "Helmet Abyssal Socket 1" }, poe1) === null,
    "nested abyss socket was flattened into player gear",
  );
  assert(
    plannerSlotForPoB({ slotName: "Charm 2" }, poe2) === "charm2" &&
      plannerSlotForPoB({ slotName: "Charm 2" }, poe1) === null,
    "PoE2 charm vocabulary leaked into PoE1",
  );
  assert(
    plannerSlotForPoB({ slotName: "Flask 3" }, poe2) === null,
    "PoE1 flask capacity leaked into PoE2",
  );
});

Deno.test("PoB inspection proposes metadata without inventing chronology", async () => {
  const preview = await inspectPoBImport(fixtureXml);
  assert(preview.proposals.length === 3, "tree candidates were hidden");
  assert(
    preview.proposals[0]!.phase === "leveling",
    "campaign phase was missed",
  );
  assert(
    preview.proposals[1]!.phase === "early-endgame" &&
      preview.proposals[1]!.characterLevel === 92,
    "active mapping metadata was not proposed",
  );
  assert(
    preview.report.omitted.some((entry) =>
      entry.sourceField === "Build.PlayerStat"
    ),
    "calculation omissions were not disclosed",
  );
  assert(
    preview.report.unresolved.some((entry) =>
      entry.message.includes("Unmatched skill")
    ),
    "unmatched source sets were hidden",
  );
});

Deno.test("reviewed PoB profiles normalize into complete sibling states", async () => {
  const preview = await inspectPoBImport(fixtureXml);
  const selected = preview.proposals.slice(0, 2);
  const result = normalizePoBImport(preview, {
    planName: "Fixture PoB import",
    candidateOrder: selected.map((value) => value.candidateId),
    arrangement: "siblings",
    defaultLeafCandidateId: selected[1]!.candidateId,
    states: Object.fromEntries(selected.map((value) => [
      value.candidateId,
      {
        name: value.name,
        phase: value.phase,
        ...(value.characterLevel != null
          ? { characterLevel: value.characterLevel }
          : {}),
        ...(value.recommendedLevelRange
          ? { recommendedLevelRange: value.recommendedLevelRange }
          : {}),
      },
    ])),
    includeActorLoadouts: true,
  }, {
    profile: poe1,
    patch: "poe1.3.28.0k",
    knownNodeIds: new Set(["100", "101", "102"]),
    clusterSkills: [{
      id: "fixture_cluster_skill",
      size: "Large",
      stats: "12% increased Fixture Effect",
      name: "Fixture cluster passive",
    }],
    sourceUrl: "https://pobb.in/fixture",
  });
  const validation = validatePlanV3(result.plan);
  assert(
    validation.length === 0,
    "normalized plan is invalid: " + validation.join("; "),
  );
  assert(result.plan.states.length === 3, "safe sibling root was not created");
  const root = result.plan.states.find((state) => state.parentId === null)!;
  const children = result.plan.states.filter((state) =>
    state.parentId === root.id
  );
  assert(children.length === 2, "profiles were not imported as siblings");
  const mapping = children.find((state) => state.name === "Mapping")!;
  assert(mapping.inventory.items.length === 4, "player gear/jewel was lost");
  assert(
    mapping.inventory.items.some((item) => item.slot.id === "weapon2") &&
      mapping.inventory.items.some((item) => item.slot.id === "flask1"),
    "weapon swap or flask placement was lost",
  );
  const cluster = mapping.inventory.items.find((item) =>
    item.slot.group === "jewel"
  )!;
  assert(
    cluster.item.jewel?.cluster?.smallPassive.key === "fixture_cluster_skill",
    "cluster jewel did not resolve through first-party data",
  );
  assert(
    mapping.actors[0]?.kind === "animate-guardian" &&
      mapping.actors[0].inventory?.items[0]?.slot.id === "weapon1",
    "Animate Guardian inventory was mixed into player gear",
  );
  assert(
    result.plan.provenance?.[0]?.source === "pobb-in",
    "pobb.in provenance was lost",
  );
});

Deno.test("linear PoB import occurs only through explicit review choice", async () => {
  const preview = await inspectPoBImport(fixtureXml);
  const selected = preview.proposals.slice(0, 2);
  const result = normalizePoBImport(preview, {
    planName: "Explicit progression",
    candidateOrder: selected.map((value) => value.candidateId),
    arrangement: "linear",
    defaultLeafCandidateId: selected[1]!.candidateId,
    states: Object.fromEntries(selected.map((value) => [
      value.candidateId,
      { name: value.name, phase: value.phase },
    ])),
    includeActorLoadouts: false,
  }, {
    profile: poe1,
    patch: "poe1.3.28.0k",
  });
  assert(
    result.plan.states.length === 2,
    "linear import added a synthetic root",
  );
  assert(
    result.plan.states[1]!.parentId === result.plan.states[0]!.id,
    "explicit order was not preserved",
  );
  assert(
    result.report.transformed.some((entry) =>
      entry.message.includes("explicitly approved linear order")
    ),
    "chronology choice was not reported",
  );
});

Deno.test("PoB2 uses the shared review model with profile-owned inventory rules", async () => {
  const preview = await inspectPoBImport(fixturePoE2Xml);
  const proposal = preview.proposals[0]!;
  const result = normalizePoBImport(preview, {
    planName: "Fixture PoB2 import",
    candidateOrder: [proposal.candidateId],
    arrangement: "siblings",
    defaultLeafCandidateId: proposal.candidateId,
    states: {
      [proposal.candidateId]: {
        name: proposal.name,
        phase: proposal.phase,
        characterLevel: proposal.characterLevel,
      },
    },
    includeActorLoadouts: true,
  }, {
    profile: poe2,
    patch: "4.5.4.4_native",
    knownNodeIds: new Set(["54447", "52", "94"]),
  });
  const validation = validatePlanV3(result.plan);
  assert(
    validation.length === 0,
    "normalized PoB2 plan is invalid: " + validation.join("; "),
  );
  assert(result.plan.game === "poe2", "PoB2 was stamped as the wrong game");
  const state = result.plan.states[0]!;
  assert(
    state.inventory.items.some((item) =>
      item.slot.group === "charm" && item.slot.id === "charm1"
    ),
    "PoB2 charm did not reach the native charm strip",
  );
  assert(
    state.inventory.items.some((item) =>
      item.slot.group === "flask" && item.slot.id === "flask1"
    ),
    "PoB2 flask did not reach the native flask strip",
  );
  assert(
    state.inventory.items.length === 4,
    "unsupported PoB2 inventory extensions were flattened into native slots",
  );
  assert(
    state.actors[0]?.kind === "companion",
    "PoB2 companion was not retained as a profile-owned actor",
  );
  assert(
    result.report.unresolved.some((entry) =>
      entry.message.includes("Ring 3") && entry.message.includes("Arm 1")
    ),
    "unsupported PoB2 inventory positions were hidden from review",
  );
  assert(
    !state.inventory.items.some((item) => item.item.jewel?.cluster),
    "PoE1 cluster-jewel expansion leaked into PoE2",
  );
});

Deno.test("known PoB1/PoB2 target-version mismatches are blocking", async () => {
  const preview = await inspectPoBImport(fixturePoE2Xml, {}, poe1);
  assert(
    preview.report.errors.some((entry) =>
      entry.sourceField === "Build.targetVersion"
    ),
    "cross-game source was not marked as an error during inspection",
  );
  const proposal = preview.proposals[0]!;
  let rejected = false;
  try {
    normalizePoBImport(preview, {
      planName: "Wrong game",
      candidateOrder: [proposal.candidateId],
      arrangement: "linear",
      defaultLeafCandidateId: proposal.candidateId,
      states: {
        [proposal.candidateId]: {
          name: proposal.name,
          phase: proposal.phase,
        },
      },
      includeActorLoadouts: false,
    }, {
      profile: poe1,
      patch: "poe1.3.28.0k",
    });
  } catch {
    rejected = true;
  }
  assert(rejected, "known PoB2 source was normalized as PoE1");
});
