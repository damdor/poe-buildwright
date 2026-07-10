// Fixture tests for the codified .build schema walker (deno test).
// These are the drift-lock's own guards: if a schema table or the
// walker changes shape, these fail before an export ever ships.
//
// deno.json keeps the app code browser-only (`types: []`), so the
// Deno test namespace is pulled in per test file:
/// <reference lib="deno.ns" />

import { GGG_BUILD_SCHEMAS, GGG_BUILD_SCHEMA_CURRENT, checkGGGBuild } from "./build_schema.ts";

function expectOk(got: string | null): void {
  if (got !== null) throw new Error(`expected null, got: ${got}`);
}
function expectErr(got: string | null, containing: string): void {
  if (got === null || !got.includes(containing)) {
    throw new Error(`expected error ~"${containing}", got: ${JSON.stringify(got)}`);
  }
}

// ---- import mode: everything spec-legal must pass -------------------------

Deno.test("import: modern full file", () => {
  expectOk(checkGGGBuild({
    name: "Storm Druid", author: "someone", link: "https://example.com/x",
    description: "d", ascendancy: "Druid1", patch: "0.5.4",
    passives: ["123", 456, { id: "789", weapon_set: 1, level_interval: 30, additional_text: "<b>hi</b>" }],
    skills: [{ id: "LightningBolt", level_interval: [12], support_skills: ["SupportA", { id: "SupportB" }] }],
    inventory_slots: [{ inventory_id: "Weapon1", slot_x: 0, slot_y: 1, level_interval: [1, 40] }],
  }, GGG_BUILD_SCHEMA_CURRENT, "import"));
});

Deno.test("import: our pre-audit legacy export (items/x/y)", () => {
  expectOk(checkGGGBuild({
    name: "Old", items: [{ inventory_id: "Helmet", x: 0, y: 0 }],
    passives: [{ id: "1", level_interval: [1, 30] }],
  }, 1, "import"));
});

Deno.test("import: unknown fields ignored", () => {
  expectOk(checkGGGBuild({ name: "n", some_future_ggg_field: { deep: true } }, 1, "import"));
});

Deno.test("import: missing name tolerated", () => {
  expectOk(checkGGGBuild({ passives: ["1"] }, 1, "import"));
});

// ---- import mode: type garbage must fail ----------------------------------

Deno.test("import: bad weapon_set", () => {
  expectErr(checkGGGBuild({ passives: [{ id: "1", weapon_set: 3 }] }, 1, "import"), "weapon_set");
});

Deno.test("import: bad interval", () => {
  expectErr(checkGGGBuild({ passives: [{ id: "1", level_interval: "1-30" }] }, 1, "import"), "level_interval");
});

Deno.test("import: skill without id", () => {
  expectErr(checkGGGBuild({ skills: [{ level: 5 }] }, 1, "import"), "id");
});

Deno.test("import: slot without inventory_id", () => {
  expectErr(checkGGGBuild({ inventory_slots: [{ slot_x: 1 }] }, 1, "import"), "inventory_id");
});

Deno.test("import: link must be a string", () => {
  expectErr(checkGGGBuild({ name: "n", link: 42 }, 1, "import"), "link");
});

// ---- export mode: our emitter contract -------------------------------------

const goodExport = {
  name: "Untitled Build", patch: "0.5.4", ascendancy: "Druid1",
  passives: ["12", { id: "34", level_interval: [1, 30], weapon_set: 2, additional_text: "<b>x</b>" }],
  skills: [{ id: "Skill", level: 5, quality: 0, level_interval: [1, 100], support_skills: [{ id: "S", level: 1, quality: 0 }] }],
  inventory_slots: [{ inventory_id: "Weapon1", slot_x: 0, slot_y: 0, unique_name: "U", level_interval: [10, 100] }],
};

Deno.test("export: conformant output passes", () => {
  expectOk(checkGGGBuild(goodExport, 1, "export"));
});

Deno.test("export: missing name is drift", () => {
  expectErr(checkGGGBuild({ passives: ["1"] }, 1, "export"), "name");
});

Deno.test("export: unknown field is drift", () => {
  expectErr(checkGGGBuild({ ...goodExport, foo: 1 }, 1, "export"), "unexpected field");
});

Deno.test("export: legacy items alias is drift", () => {
  expectErr(checkGGGBuild({ name: "n", items: [{ inventory_id: "W" }] }, 1, "export"), "import-only");
});

Deno.test("export: legacy slot x alias is drift", () => {
  expectErr(checkGGGBuild({ name: "n", inventory_slots: [{ inventory_id: "W", x: 1 }] }, 1, "export"), "import-only");
});

Deno.test("export: short-form interval is drift", () => {
  expectErr(checkGGGBuild({ name: "n", passives: [{ id: "1", level_interval: [5] }] }, 1, "export"), "[lo, hi]");
});

Deno.test("export: inverted interval is drift", () => {
  expectErr(checkGGGBuild({ name: "n", passives: [{ id: "1", level_interval: [30, 1] }] }, 1, "export"), "[lo, hi]");
});

Deno.test("export: bare numeric passive id is drift", () => {
  expectErr(checkGGGBuild({ name: "n", passives: [42] }, 1, "export"), "string ids");
});

Deno.test("export: numeric object id is drift", () => {
  expectErr(checkGGGBuild({ name: "n", passives: [{ id: 42 }] }, 1, "export"), "id string");
});

// ---- the freeze -------------------------------------------------------------

Deno.test("schema revisions are frozen", () => {
  const v1 = GGG_BUILD_SCHEMAS[1]!;
  let threw = false;
  try {
    (v1.root.fields as Record<string, unknown>)["name"] = { type: "string" };
  } catch (_e) {
    threw = true; // strict mode: assignment to frozen object throws
  }
  const intact = v1.root.fields["name"]?.required === "export";
  if (!threw || !intact) throw new Error("schema rev 1 is mutable — the freeze is broken");
});

Deno.test("unknown revision is rejected", () => {
  expectErr(checkGGGBuild({}, 99, "import"), "unknown .build schema revision");
});
