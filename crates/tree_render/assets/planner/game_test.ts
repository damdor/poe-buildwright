/// <reference lib="deno.ns" />

import {
  baseAllowedForPlannerSlot, charmSlotsFor, flaskSlotsFor, gearSlotsFor,
  groundingSlotFor, jewelAllowedInSocket, jewelLocateArtFor, jewelRadiusArtFor,
  jewelSocketArtForBase, nextRepeatedItemSlotFor, normalizeItemSlotFor, plannerSlot,
} from "./game.ts";
import { assertGameEnvelope } from "./asset_loader.ts";

function keys(game: string): string[] {
  return gearSlotsFor(game).map(slot => slot.key);
}

Deno.test("PoE1 separates five flasks and exposes shared jewel authoring", () => {
  const slots = keys("poe1");
  if (slots.some(slot => slot.startsWith("flask"))) throw new Error("flasks leaked into regular gear");
  const flasks = flaskSlotsFor("poe1");
  if (flasks.length !== 5) throw new Error(`expected 5 PoE1 flask slots, got ${flasks.length}`);
  if (!flasks.every(slot => slot.cat.includes("tincture"))) {
    throw new Error("every PoE1 flask position must accept tinctures");
  }
  if (!slots.includes("jewel")) throw new Error("PoE1 must expose the shared jewel editor");
  const offhand = gearSlotsFor("poe1").find(slot => slot.key === "offhand1");
  if (!offhand?.cat.includes("axe") || !offhand.cat.includes("shield")) {
    throw new Error("PoE1 offhands must accept one-hand weapons and dedicated offhands");
  }
});

Deno.test("PoE1 cluster jewels follow expansion-socket size limits", () => {
  if (!jewelAllowedInSocket("poe1", "Large Cluster Jewel", { cluster_size: 2, cluster_outer: true })) {
    throw new Error("outer-ring Large Jewel Sockets must accept cluster jewels");
  }
  if (jewelAllowedInSocket("poe1", "Large Cluster Jewel", { cluster_size: 1 })) {
    throw new Error("a Large cluster jewel leaked into a Medium expansion socket");
  }
  if (!jewelAllowedInSocket("poe1", "Medium Cluster Jewel", { cluster_size: 2 }) ||
      !jewelAllowedInSocket("poe1", "Small Cluster Jewel", { cluster_size: 1 })) {
    throw new Error("smaller cluster jewels must fit larger expansion sockets");
  }
  for (const socket of [{}, { cluster_outer: false }]) {
    if (jewelAllowedInSocket("poe1", "Medium Cluster Jewel", socket)) {
      throw new Error("cluster jewels leaked into an ordinary socket");
    }
  }
  if (!jewelAllowedInSocket("poe1", "Crimson Jewel", { cluster_outer: false })) {
    throw new Error("ordinary jewels must remain valid in ordinary sockets");
  }
  if (!jewelAllowedInSocket("poe2", "Large Cluster Jewel", {})) {
    throw new Error("the PoE1-only cluster policy changed PoE2");
  }
});

Deno.test("jewel art follows each game's native atlas", () => {
  if (jewelSocketArtForBase("poe1", "Crimson Jewel") !==
      "/assets/sprites/poe1_JewelSocketActiveRed.png") {
    throw new Error("PoE1 crimson jewel did not select the native red socket art");
  }
  if (jewelSocketArtForBase("poe1", "Large Cluster Jewel") !==
      "/assets/sprites/poe1_JewelSocketActiveAltPurple.png") {
    throw new Error("PoE1 Large cluster jewel did not select purple native art");
  }
  if (!jewelSocketArtForBase("poe1", "Medium Cluster Jewel")?.includes("AltBlue") ||
      !jewelSocketArtForBase("poe1", "Small Cluster Jewel")?.includes("AltRed")) {
    throw new Error("PoE1 Medium/Small cluster jewels did not select their native size art");
  }
  if (jewelSocketArtForBase("poe2", "Ruby") !== null) {
    throw new Error("PoE2 must retain its existing per-base jewel art chain");
  }
  if (!jewelRadiusArtFor("poe1").includes("poe1_JewelCircle1") ||
      !jewelLocateArtFor("poe1").includes("poe1_JewelSocket")) {
    throw new Error("PoE1 radius/locate overlays are not game-owned");
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
