/// <reference lib="deno.ns" />

import officialFixture from "./fixtures/official-poe2-build-v1.json" with {
  type: "json",
};
import {
  createGameProfile,
  validatePlanForGameProfile,
} from "./game_profile.ts";
import { importOfficialBuild } from "./official_build_import.ts";
import { validatePlanV3 } from "../../../../viewer/assets/plan_v3.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function context() {
  const profile = createGameProfile("poe2");
  return {
    profile,
    metadata: {
      game: "poe2",
      patch: "fixture.native",
      passive_ids: {
        graphToBuild: { "100": "strength89", "200": "melee17" },
        buildToGraph: { strength89: "100", melee17: "200" },
        attributeToParent: { "100": "99" },
      },
      classes: [{
        name: "Druid",
        ascendancies: [{ name: "Oracle", internal: "Druid1" }],
      }],
    },
    nativeNodeIds: new Set(["99", "100", "200"]),
    catalogue: {
      activeSkillIds: new Set([
        "Metadata/Items/Gems/SkillGemEarthquake",
      ]),
      supportSkillIds: new Set([
        "Metadata/Items/Gems/SupportGemFastForward",
      ]),
      metaSkillIds: new Set<string>(),
      uniqueNames: new Set<string>(),
      authoredUniqueNames: new Map<string, string>(),
      inventoryIds: new Set([
        "Weapon1",
      ]),
    },
  };
}

Deno.test("official import uses native v3, patch ids, and profile slots", () => {
  const imported = importOfficialBuild(officialFixture, context());
  const errors = [
    ...validatePlanV3(imported.plan),
    ...validatePlanForGameProfile(imported.plan, context().profile),
  ];
  assert(errors.length === 0, errors.join("; "));
  assert(imported.plan.game === "poe2", "wrong native game");
  assert(imported.plan.patch === "fixture.native", "patch was not retained");
  assert(imported.plan.states.length === 3, "interval boundaries were lost");
  const first = imported.plan.states[0]!;
  assert(
    first.passiveTree.allocations[0]?.nodeId === "99" &&
      first.passiveTree.allocations[0]?.optionId === "100",
    "official attribute variant did not resolve through the parent map",
  );
  const final = imported.plan.states.at(-1)!;
  assert(
    final.character.class === "Druid" &&
      final.character.ascendancy === "Oracle",
    "ascendancy metadata did not resolve",
  );
  assert(
    final.inventory.items.some((item) => item.slot.id === "flask2") &&
      final.inventory.items.some((item) => item.slot.id === "charm1"),
    "Build Planner-only profile positions were not imported",
  );
});

Deno.test("official level zero remains source metadata, not invalid character level", () => {
  const source = {
    name: "Level zero",
    passives: [{ id: "strength89", level_interval: [0, 0] }],
  };
  const imported = importOfficialBuild(source, context());
  const zero = imported.plan.states[0]!;
  assert(
    zero.gameData?.gggBuildImport &&
      JSON.stringify(zero.gameData.gggBuildImport).includes("[0,0]"),
    "level-zero source interval was not retained",
  );
  assert(
    zero.characterLevel === undefined &&
      zero.recommendedLevelRange === undefined,
    "level zero was fabricated as native character-level guidance",
  );
  const errors = validatePlanV3(imported.plan);
  assert(errors.length === 0, errors.join("; "));
});

Deno.test("official import refuses cross-wired game metadata", () => {
  const invalid = context();
  invalid.metadata.game = "poe1";
  let rejected = false;
  try {
    importOfficialBuild(officialFixture, invalid);
  } catch {
    rejected = true;
  }
  assert(rejected, "cross-game metadata was accepted");
});
