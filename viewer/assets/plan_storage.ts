// Transactional native-plan persistence.
//
// Loading is deliberately read-only. A version-2 plan is migrated in memory
// and is not replaced merely because somebody opened it. The first explicit
// save validates a complete v3 candidate, preserves the exact v2 JSON once,
// stages the v3 document, then replaces the primary key.

import type {
  AnyPersistedPlan,
  GameId,
  Plan,
  PlanV3,
} from "../../types/shared.d.ts";
import {
  createGameProfile,
  validatePlanForSelectedGame,
} from "../../crates/tree_render/assets/planner/game_profile.ts";
import { migratePlanV2ToV3 } from "./plan_v3.ts";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface NativePlanLoadResult {
  plan: PlanV3 | null;
  sourceVersion: 2 | 3 | null;
  sourceRaw: string | null;
  recoveredFromPending: boolean;
  warnings: string[];
}

export interface NativePlanSaveResult {
  plan: PlanV3;
  raw: string;
  preservedV2Backup: boolean;
}

interface DecodedCandidate {
  plan: PlanV3;
  sourceVersion: 2 | 3;
  raw: string;
}

export function pendingPlanKey(primaryKey: string): string {
  return primaryKey + ":pending-v3";
}

export function legacyPlanBackupKey(primaryKey: string): string {
  return primaryKey + ":v2-backup";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function decodeCandidate(
  raw: string,
  expectedGame: GameId,
): { candidate: DecodedCandidate | null; error: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { candidate: null, error: "stored plan is not valid JSON" };
  }
  if (!isObject(parsed)) {
    return { candidate: null, error: "stored plan must be a JSON object" };
  }
  const version = parsed.version;
  const format = parsed.format;
  if (version === 3 && format === "buildwright-planner-plan") {
    const plan = parsed as unknown as PlanV3;
    if (plan.game !== expectedGame) {
      return {
        candidate: null,
        error: `stored ${
          plan.game || "unknown"
        } plan cannot open in ${expectedGame}`,
      };
    }
    const errors = validatePlanForSelectedGame(
      plan,
      createGameProfile(expectedGame),
    );
    if (errors.length) return { candidate: null, error: errors.join("; ") };
    return {
      candidate: { plan: structuredClone(plan), sourceVersion: 3, raw },
      error: null,
    };
  }
  if (
    version === 2 &&
    (format === "buildwright-planner-plan" || format === "poe2-planner-plan")
  ) {
    const plan = parsed as unknown as Plan;
    if (plan.game && plan.game !== expectedGame) {
      return {
        candidate: null,
        error: `stored ${plan.game} plan cannot open in ${expectedGame}`,
      };
    }
    try {
      const migrated = migratePlanV2ToV3({
        ...structuredClone(plan),
        game: expectedGame,
      });
      const errors = validatePlanForSelectedGame(
        migrated,
        createGameProfile(expectedGame),
      );
      if (errors.length) return { candidate: null, error: errors.join("; ") };
      return {
        candidate: { plan: migrated, sourceVersion: 2, raw },
        error: null,
      };
    } catch (error) {
      return {
        candidate: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return {
    candidate: null,
    error: `unsupported plan format/version ${String(format)}/${
      String(version)
    }`,
  };
}

/** Read a primary plan plus any interrupted v3 transaction. No storage
 * mutation occurs, including cleanup. */
export function loadNativePlan(
  storage: StorageLike,
  primaryKey: string,
  expectedGame: GameId,
): NativePlanLoadResult {
  const primaryRaw = storage.getItem(primaryKey);
  const pendingRaw = storage.getItem(pendingPlanKey(primaryKey));
  const warnings: string[] = [];
  const primary = primaryRaw == null
    ? { candidate: null, error: null }
    : decodeCandidate(primaryRaw, expectedGame);
  const pending = pendingRaw == null
    ? { candidate: null, error: null }
    : decodeCandidate(pendingRaw, expectedGame);

  if (primary.error) warnings.push("primary: " + primary.error);
  if (pending.error) warnings.push("pending: " + pending.error);

  // A valid pending record exists only when a prior explicit save reached
  // the staging step. Prefer it so an interrupted primary write is recoverable.
  const chosen = pending.candidate ?? primary.candidate;
  return {
    plan: chosen ? structuredClone(chosen.plan) : null,
    sourceVersion: chosen?.sourceVersion ?? null,
    sourceRaw: chosen?.raw ?? null,
    recoveredFromPending: chosen === pending.candidate && !!chosen,
    warnings,
  };
}

/** Validate then persist a complete v3 document. The exact original v2 JSON
 * is retained at a sibling key before the primary record is changed. */
export function saveNativePlan(
  storage: StorageLike,
  primaryKey: string,
  candidate: PlanV3,
  expectedGame: GameId,
  now: () => string = () => new Date().toISOString(),
): NativePlanSaveResult {
  const plan = structuredClone(candidate);
  if (plan.game !== expectedGame) {
    throw new Error(
      `refusing to save ${plan.game} plan in ${expectedGame} storage`,
    );
  }
  const errors = validatePlanForSelectedGame(
    plan,
    createGameProfile(expectedGame),
  );
  if (errors.length) {
    throw new Error("refusing to save invalid plan: " + errors.join("; "));
  }
  plan.savedAt = now();
  const raw = JSON.stringify(plan);
  const primaryRaw = storage.getItem(primaryKey);
  let preservedV2Backup = false;

  if (
    primaryRaw != null &&
    storage.getItem(legacyPlanBackupKey(primaryKey)) == null
  ) {
    try {
      const parsed = JSON.parse(primaryRaw) as AnyPersistedPlan;
      if (parsed?.version === 2) {
        storage.setItem(legacyPlanBackupKey(primaryKey), primaryRaw);
        preservedV2Backup = true;
      }
    } catch {
      // A corrupt primary is not copied into the trusted v2 backup slot.
    }
  }

  const pendingKey = pendingPlanKey(primaryKey);
  storage.setItem(pendingKey, raw);
  storage.setItem(primaryKey, raw);
  storage.removeItem(pendingKey);
  return { plan, raw, preservedV2Backup };
}
