/// <reference lib="deno.ns" />

import type { Plan } from "../../../../types/shared.d.ts";
import { createGameProfile, gameDefinitionForPlan } from "./game_profile.ts";
import poe1Fixture from "./fixtures/v2-poe1-plan.json" with { type: "json" };
import poe2Fixture from "./fixtures/v2-poe2-plan.json" with { type: "json" };

function fixture(name: string): Plan {
  const source = name === "v2-poe1-plan.json" ? poe1Fixture : poe2Fixture;
  // Each test gets a fresh object; mutating one regression case cannot
  // influence the next through the JSON-module cache.
  return JSON.parse(JSON.stringify(source)) as Plan;
}

Deno.test("version-2 fixtures cover both isolated game profiles", () => {
  for (const name of ["v2-poe1-plan.json", "v2-poe2-plan.json"]) {
    const plan = fixture(name);
    const game = gameDefinitionForPlan(plan);
    if (plan.version !== 2 || plan.game !== game.id) {
      throw new Error(`${name} is not an explicit version-2 ${game.id} plan`);
    }
    if (plan.captures.length < 2 || plan.activeCapture !== plan.captures.length - 1) {
      throw new Error(`${name} must exercise a historical and working capture`);
    }
    const profile = createGameProfile(game.id);
    const legalSlots = new Set([
      ...profile.definition.slots.equipment,
      ...profile.definition.slots.flasks,
      ...profile.definition.slots.charms,
    ].map(slot => slot.key));
    for (const capture of plan.captures) {
      for (const item of capture.items) {
        if (!item.slot || !legalSlots.has(item.slot)) {
          throw new Error(`${name}:${capture.id} has an unprofiled slot ${item.slot}`);
        }
      }
    }
  }
});

Deno.test("version-2 fixtures retain game-specific authored facts", () => {
  const poe1 = fixture("v2-poe1-plan.json");
  const poe2 = fixture("v2-poe2-plan.json");
  const poe1Last = poe1.captures.at(-1)!;
  const poe2Last = poe2.captures.at(-1)!;

  const cluster = poe1Last.items.find(item => item.cluster)?.cluster;
  if (!cluster || cluster.size !== "Large" || cluster.sockets !== 2) {
    throw new Error("PoE1 fixture lost its cluster-jewel structure");
  }
  if (!poe1Last.items.some(item => item.slot === "flask5")) {
    throw new Error("PoE1 fixture must protect the fifth flask position");
  }
  if (!poe2Last.items.some(item => item.slot === "charm3")) {
    throw new Error("PoE2 fixture must protect the third charm position");
  }
  if (!poe2Last.passives.some(node => node.set === "set1") ||
      poe2.activeSet !== "set1") {
    throw new Error("PoE2 fixture lost its weapon-set state");
  }
});

Deno.test("fixture capture payloads are self-contained snapshots", () => {
  const plan = fixture("v2-poe2-plan.json");
  const first = plan.captures[0]!;
  const second = plan.captures[1]!;
  const original = second.items[0]?.name;
  first.items[0]!.name = "mutated only in first";
  if (second.items[0]?.name !== original) {
    throw new Error("fixture captures unexpectedly share mutable item references");
  }
});
