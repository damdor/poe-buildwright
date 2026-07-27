/// <reference lib="deno.ns" />

import fixtureXml from "./fixtures/pob-multi-loadout.xml" with { type: "text" };
import fixturePoE2Xml from "./fixtures/pob2-multi-loadout.xml" with {
  type: "text",
};
import {
  decodePoBInput,
  parsePoBTitle,
  parsePoBXml,
  resolvePoBLoadouts,
} from "./pob_import_core.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function shareCode(xml: string): Promise<string> {
  const compressed = new Uint8Array(
    await new Response(
      new Blob([xml]).stream().pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );
  let binary = "";
  for (const value of compressed) binary += String.fromCharCode(value);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/, "");
}

Deno.test("PoB titles retain raw matching and expose clean brace links", () => {
  const title = parsePoBTitle("^6Campaign {levelling,mapping}");
  assert(title.raw.startsWith("^6"), "raw PoB title was changed");
  assert(title.display === "Campaign {levelling,mapping}", "color code leaked");
  assert(title.setName === "Campaign", "brace identifier leaked into set name");
  assert(
    JSON.stringify(title.identifiers) === '["levelling","mapping"]',
    "brace identifiers were not split",
  );
});

Deno.test("bounded share decoding round-trips PoB XML", async () => {
  const encoded = await shareCode(fixtureXml);
  const decoded = await decodePoBInput(encoded);
  assert(decoded === fixtureXml, "share code did not round-trip exactly");
  let rejected = false;
  try {
    await decodePoBInput(encoded, { maxXmlBytes: 100 });
  } catch (error) {
    rejected = String(error).includes("exceeds 100 bytes");
  }
  assert(rejected, "decompression limit was not enforced");
});

Deno.test("PoB XML parser rejects declarations and malformed nesting", () => {
  for (
    const xml of [
      '<!DOCTYPE x [<!ENTITY e "boom">]><PathOfBuilding/>',
      "<PathOfBuilding><Build></PathOfBuilding>",
    ]
  ) {
    let rejected = false;
    try {
      parsePoBXml(xml);
    } catch {
      rejected = true;
    }
    assert(rejected, "hostile or malformed XML was accepted");
  }
});

Deno.test("PoB source parsing retains authored sets and strips calculations", () => {
  const model = parsePoBXml(fixtureXml);
  assert(model.className === "Witch", "class identity was lost");
  assert(model.ascendancyName === "Necromancer", "ascendancy was lost");
  assert(
    model.calculatedPlayerStatCount === 2,
    "calculation omission count drifted",
  );
  assert(model.treeSets.length === 3, "tree specs were lost");
  assert(
    model.treeSets[1]!.sockets[0]?.nodeId === "500",
    "tree jewel was lost",
  );
  assert(
    model.treeSets[1]!.overrideCount === 1,
    "override was silently ignored",
  );
  assert(
    model.skillSets[1]!.groups[0]!.gems[0]!.minionItemSetId === "90",
    "actor item-set relationship was lost",
  );
  const item = model.items["1"]!;
  assert(
    item.itemLevel === 86 && item.quality === 30 && item.corrupted,
    "rich item facts were not parsed",
  );
  assert(item.sockets?.length === 6, "linked sockets were lost");
  assert(
    item.mods?.some((mod) => mod.text === "+100 to maximum Life"),
    "rendered item stat text was lost",
  );
  assert(item.sourceText.includes("Fixture Shelter"), "raw item text was lost");
  assert(
    model.items["6"]!.name === "Perpetual Granite Flask of the Armadillo" &&
      model.items["6"]!.base === undefined,
    "a magic item metadata row was mistaken for its base",
  );
  assert(
    model.items["7"]!.name === undefined &&
      model.items["7"]!.base === "Leather Belt",
    "a punctuation-only PoB placeholder obscured the real item base",
  );
  assert(
    model.items["2"]!.cluster?.passiveCount === 8 &&
      model.items["2"]!.cluster?.jewelSocketCount === 2 &&
      model.items["2"]!.cluster?.smallPassiveText ===
        "12% increased Fixture Effect",
    "cluster-jewel structure was not parsed",
  );
  assert(
    !model.items["2"]!.mods?.some((mod) =>
      /Passive Skills|Jewel Sockets/i.test(mod.text)
    ),
    "cluster structure was duplicated into ordinary item modifiers",
  );
  assert(
    model.notes === "Fixture notes & safe text.",
    "XML entities were not decoded",
  );
});

Deno.test("PoB loadouts use brace, exact-title, and single-set broadcast rules", () => {
  const resolution = resolvePoBLoadouts(parsePoBXml(fixtureXml));
  const campaign = resolution.candidates[0]!;
  const mapping = resolution.candidates[1]!;
  const bossing = resolution.candidates[2]!;
  assert(
    campaign.skills?.id === "10" && campaign.items?.id === "10",
    "brace-linked loadout did not resolve",
  );
  assert(
    mapping.skills?.id === "11" && mapping.items?.id === "11",
    "exact-title loadout did not resolve",
  );
  assert(
    campaign.config?.id === "1" && mapping.config?.id === "1",
    "single config set did not broadcast",
  );
  assert(
    !bossing.complete && bossing.missingSections.includes("skills"),
    "unmatched tree candidate was hidden",
  );
  assert(
    resolution.actorItemSets[0]?.itemSet.id === "90" &&
      resolution.actorItemSets[0]?.kind === "animate-guardian",
    "Animate Guardian item set was not classified separately",
  );
  assert(
    resolution.unmatched.skills[0]?.id === "12" &&
      resolution.unmatched.items[0]?.id === "91",
    "unmatched sets were not surfaced",
  );
});

Deno.test("PoB2 keeps the shared format while retaining companion relations", () => {
  const model = parsePoBXml(fixturePoE2Xml);
  const resolution = resolvePoBLoadouts(model);
  assert(model.targetVersion === "0_1", "PoB2 target version was lost");
  assert(
    model.itemSets[0]?.placements.some((value) => value.slotName === "Charm 1"),
    "PoB2 charm placement was lost in the shared parser",
  );
  assert(
    resolution.actorItemSets[0]?.kind === "companion" &&
      resolution.actorItemSets[0]?.itemSet.id === "9",
    "PoB2 companion item-set relationship was misclassified",
  );
});
