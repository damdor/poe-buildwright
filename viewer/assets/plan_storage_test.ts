/// <reference lib="deno.ns" />

import type { Plan, PlanV3 } from "../../types/shared.d.ts";
import poe1Fixture from "../../crates/tree_render/assets/planner/fixtures/v2-poe1-plan.json" with { type: "json" };
import poe2Fixture from "../../crates/tree_render/assets/planner/fixtures/v2-poe2-plan.json" with { type: "json" };
import { addChildState, migratePlanV2ToV3 } from "./plan_v3.ts";
import {
  legacyPlanBackupKey, loadNativePlan, pendingPlanKey, saveNativePlan,
  type StorageLike,
} from "./plan_storage.ts";

class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  writes = 0;
  failWriteAt: number | null = null;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes++;
    if (this.failWriteAt === this.writes) throw new Error("simulated storage failure");
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

Deno.test("loading v2 migrates in memory without touching storage", () => {
  const storage = new MemoryStorage();
  const key = "poe1-planner:plan:test";
  const raw = JSON.stringify(poe1Fixture);
  storage.values.set(key, raw);
  const loaded = loadNativePlan(storage, key, "poe1");
  if (!loaded.plan || loaded.sourceVersion !== 2) throw new Error("v2 plan did not migrate");
  if (storage.writes !== 0 || storage.getItem(key) !== raw) {
    throw new Error("read-only migration modified the v2 record");
  }
  if (storage.getItem(legacyPlanBackupKey(key)) != null) {
    throw new Error("opening alone created an unnecessary backup");
  }
});

Deno.test("first v3 save preserves exact v2 source and commits transaction", () => {
  const storage = new MemoryStorage();
  const key = "poe2-planner:plan:test";
  const raw = JSON.stringify(poe2Fixture);
  storage.values.set(key, raw);
  const plan = loadNativePlan(storage, key, "poe2").plan!;
  const saved = saveNativePlan(storage, key, plan, "poe2", () => "2030-01-01T00:00:00.000Z");
  if (!saved.preservedV2Backup) throw new Error("v2 backup was not reported");
  if (storage.getItem(legacyPlanBackupKey(key)) !== raw) {
    throw new Error("v2 backup was not byte-identical");
  }
  if (storage.getItem(pendingPlanKey(key)) != null) {
    throw new Error("completed transaction left a pending record");
  }
  const persisted = JSON.parse(storage.getItem(key)!) as PlanV3;
  if (persisted.version !== 3 || persisted.savedAt !== "2030-01-01T00:00:00.000Z") {
    throw new Error("primary record is not the validated v3 candidate");
  }
});

Deno.test("invalid and cross-game candidates never enter storage", () => {
  const storage = new MemoryStorage();
  const key = "poe2-planner:plan:test";
  const plan = migratePlanV2ToV3(copy(poe2Fixture) as Plan);
  const invalid = copy(plan);
  invalid.activeStateId = "missing";
  for (const candidate of [invalid, { ...plan, game: "poe1" } as PlanV3]) {
    let rejected = false;
    try {
      saveNativePlan(storage, key, candidate, "poe2");
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("unsafe candidate was accepted");
  }
  if (storage.writes !== 0 || storage.getItem(key) != null) {
    throw new Error("rejected candidate wrote to storage");
  }
});

Deno.test("an interrupted primary write recovers the staged v3 plan", () => {
  const storage = new MemoryStorage();
  const key = "poe2-planner:plan:test";
  storage.values.set(key, JSON.stringify(poe2Fixture));
  const branched = addChildState(
    migratePlanV2ToV3(copy(poe2Fixture) as Plan),
    (poe2Fixture as Plan).captures[0]!.id,
    { id: "bossing", name: "Bossing" },
  );
  // Backup succeeds, pending succeeds, primary replacement fails.
  storage.failWriteAt = 3;
  let failed = false;
  try {
    saveNativePlan(storage, key, branched, "poe2");
  } catch {
    failed = true;
  }
  if (!failed) throw new Error("simulated interrupted save unexpectedly succeeded");
  const loaded = loadNativePlan(storage, key, "poe2");
  if (!loaded.recoveredFromPending || loaded.plan?.activeStateId !== "bossing") {
    throw new Error("valid staged transaction was not recovered");
  }
});

Deno.test("v3 branches and stable state ids survive save and reload", () => {
  const storage = new MemoryStorage();
  const key = "poe1-planner:plan:test";
  const base = migratePlanV2ToV3(copy(poe1Fixture) as Plan);
  const parentId = base.states[0]!.id;
  const branchA = addChildState(base, parentId, { id: "mapping", name: "Mapping" });
  const branchB = addChildState(branchA, parentId, { id: "bossing", name: "Bossing" });
  saveNativePlan(storage, key, branchB, "poe1");
  const loaded = loadNativePlan(storage, key, "poe1");
  if (loaded.sourceVersion !== 3) throw new Error("saved v3 plan was not recognized");
  const ids = loaded.plan?.states.map(state => state.id).sort().join(",");
  if (ids !== branchB.states.map(state => state.id).sort().join(",")) {
    throw new Error("state ids or sibling branches changed across reload");
  }
});

Deno.test("cross-game stored plans are rejected without fallback mutation", () => {
  const storage = new MemoryStorage();
  const key = "poe1-planner:plan:test";
  const raw = JSON.stringify(poe2Fixture);
  storage.values.set(key, raw);
  const loaded = loadNativePlan(storage, key, "poe1");
  if (loaded.plan != null || !loaded.warnings.some(w => w.includes("cannot open"))) {
    throw new Error("cross-game storage did not fail explicitly");
  }
  if (storage.getItem(key) !== raw || storage.writes !== 0) {
    throw new Error("cross-game rejection modified storage");
  }
});
