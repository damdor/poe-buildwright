/// <reference lib="deno.ns" />

import {
  baseAllowedForPlannerSlot, charmSlotsFor, flaskSlotsFor, gearSlotsFor,
  groundingSlotFor, nextRepeatedItemSlotFor, normalizeItemSlotFor, plannerSlot,
} from "./game.ts";
import { assertGameEnvelope } from "./asset_loader.ts";

function keys(game: string): string[] {
  return gearSlotsFor(game).map(slot => slot.key);
}

Deno.test("PoE1 separates five flasks from regular gear and excludes jewels", () => {
  const slots = keys("poe1");
  if (slots.some(slot => slot.startsWith("flask"))) throw new Error("flasks leaked into regular gear");
  const flasks = flaskSlotsFor("poe1");
  if (flasks.length !== 5) throw new Error(`expected 5 PoE1 flask slots, got ${flasks.length}`);
  if (!flasks.every(slot => slot.cat.includes("tincture"))) {
    throw new Error("every PoE1 flask position must accept tinctures");
  }
  if (slots.includes("jewel")) throw new Error("PoE1 must not expose the deferred jewel editor");
  const offhand = gearSlotsFor("poe1").find(slot => slot.key === "offhand1");
  if (!offhand?.cat.includes("axe") || !offhand.cat.includes("shield")) {
    throw new Error("PoE1 offhands must accept one-hand weapons and dedicated offhands");
  }
});

Deno.test("PoE2 has two dedicated flask positions and retains jewels", () => {
  const slots = keys("poe2");
  if (!slots.includes("jewel")) throw new Error("PoE2 must retain its jewel authoring slot");
  if (slots.some(slot => slot.startsWith("flask"))) throw new Error("flasks leaked into regular gear");
  const flasks = flaskSlotsFor("poe2");
  if (JSON.stringify(flasks.map(slot => slot.key)) !== JSON.stringify(["flask1", "flask2"])) {
    throw new Error("PoE2 must expose exactly two flask positions");
  }
  const charms = charmSlotsFor("poe2").map(slot => slot.key);
  if (JSON.stringify(charms) !== JSON.stringify(["charm1", "charm2", "charm3"])) {
    throw new Error(`PoE2 must expose exactly three charm positions, got ${charms}`);
  }
  if (charmSlotsFor("poe1").length !== 0) throw new Error("PoE1 must not expose charm positions");
});

Deno.test("repeated PoE1 slots resolve to shared grounding slots", () => {
  const got = ["weapon2", "offhand2", "ring2", "flask5"]
    .map(slot => groundingSlotFor("poe1", slot));
  const want = ["weapon1", "offhand1", "ring1", "flask1"];
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`grounding slots: expected ${want}, got ${got}`);
  }
});

Deno.test("PoE2 flask positions use its legacy catalogue family", () => {
  const got = ["flask1", "flask2", "charm3"].map(slot => groundingSlotFor("poe2", slot));
  if (JSON.stringify(got) !== JSON.stringify(["flask", "flask", "flask"])) {
    throw new Error(`expected PoE2 flasks and charms to use the mined flask family, got ${got}`);
  }
  if (plannerSlot("flask", "poe2") !== "flask1") {
    throw new Error("legacy PoE2 flask saves must render in Flask 1");
  }
});

Deno.test("PoE2 flask UX excludes charms without changing PoE1 flask taxonomy", () => {
  if (!baseAllowedForPlannerSlot("poe2", "flask1", "LifeFlask", "Ultimate Life Flask")) {
    throw new Error("PoE2 life flasks must remain selectable");
  }
  if (!baseAllowedForPlannerSlot("poe2", "flask2", "ManaFlask", "Ultimate Mana Flask")) {
    throw new Error("PoE2 mana flasks must remain selectable");
  }
  if (baseAllowedForPlannerSlot("poe2", "flask1", "UtilityFlask", "Antidote Charm")) {
    throw new Error("PoE2 charms must not leak into the flask belt search");
  }
  if (!baseAllowedForPlannerSlot("poe2", "charm1", "UtilityFlask", "Antidote Charm")) {
    throw new Error("PoE2 charms must remain selectable in their own belt");
  }
  if (baseAllowedForPlannerSlot("poe2", "charm2", "LifeFlask", "Ultimate Life Flask")) {
    throw new Error("PoE2 recovery flasks must not leak into the charm belt search");
  }
  if (!baseAllowedForPlannerSlot("poe1", "flask4", "UtilityFlask", "Granite Flask")) {
    throw new Error("PoE1 utility flasks must remain selectable");
  }
  if (!baseAllowedForPlannerSlot("poe1", "flask5", "Tincture", "Oakbranch Tincture")) {
    throw new Error("PoE1 tinctures must remain selectable");
  }
});

Deno.test("agent slot normalization consumes the shared game policy", () => {
  if (normalizeItemSlotFor("poe1", "utility_flask") !== "flask1") {
    throw new Error("PoE1 utility flask must enter the flask belt");
  }
  if (normalizeItemSlotFor("poe2", "utility_flask") !== "charm1") {
    throw new Error("PoE2 utility flask taxonomy must enter the Charm belt");
  }
  if (normalizeItemSlotFor("poe2", "flask", "Antidote Charm") !== "charm1") {
    throw new Error("a grounded Charm base must override the legacy flask family");
  }
  if (nextRepeatedItemSlotFor("poe1", "flask4") !== "flask5" ||
      nextRepeatedItemSlotFor("poe2", "charm2") !== "charm3") {
    throw new Error("repeated slot progression drifted from the rendered boards");
  }
});

Deno.test("game asset envelopes reject cross-wired data", () => {
  assertGameEnvelope({ game: "poe2" }, "bases", "/assets/agent/bases.json");
  let rejected = false;
  try {
    assertGameEnvelope({ game: "poe1" }, "bases", "/assets/agent/bases.json");
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("PoE1 data was accepted by a PoE2 page");
});
