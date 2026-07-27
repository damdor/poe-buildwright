// ============================================================================
// === Build I/O: internal save format + GGG .build export/import ==========
// ============================================================================
//
// Two file formats live here. Both are JSON.
//
//  1. "Internal plan" — our own complete snapshot. Versioned via
//     `format` + `version` so we never accidentally load a future
//     save into an older client without noticing. Includes
//     everything our planner tracks (class, ascendancy, per-node
//     set + attribute pick + future level_interval).
//
//  2. "GGG .build" — the in-game Build Planner format introduced
//     in patch 0.5 (2026-05-29). Schema lives at
//     <https://www.pathofexile.com/developer/docs/game> and is
//     documented in docs/build_planner_format.md. We track which
//     GGG schema revision our exporter targets; if GGG ships a new
//     version we bump GGG_BUILD_SCHEMA, add a new emit/parse
//     branch, and keep the old one for fallback.
//
// Both formats have hand-written validators (no external deps) so a
// malformed file is rejected with a clear error rather than silently
// corrupting state.


import {
  ascSel, buildAuthorInput, buildDescInput, buildLinkInput, buildNameInput,
  classSel, state, resolveAscName,
} from "./state.ts";
import { GGG_BUILD_SCHEMA_CURRENT, checkGGGBuild } from "./build_schema.ts";
import {
  buildOfficialCatalogueData, enrichPlanWithOfficialCatalogue,
  gggMarkup, gggPlainText, graphIdToOfficial, officialIdToGraph,
  officialInventoryDefinitionIssues,
  officialInventoryIdSupported, officialItemHintLines,
  prepareOfficialRoute, resolveOfficialItemLocation,
  selectedNativeRoute,
} from "./ggg_build_core.ts";
import type {
  OfficialBuildCatalogueData, OfficialItemCatalogueEnvelope,
  OfficialSkillCatalogueEnvelope,
} from "./ggg_build_core.ts";
import {
  importOfficialBuild,
} from "./official_build_import.ts";
import { loadGameAsset } from "./asset_loader.ts";
import { requestRender } from "./render.ts";
import { updatePreview } from "./pathfind.ts";
import { applyAsc, refreshAscOptions, updateSelectionUI } from "./sidebar.ts";
import { flushPersistNow, hydrateFromActiveCapture } from "./wizard_sync.ts";
import { GAME, PROFILE } from "./game.ts";
import { validatePlanForSelectedGame } from "./game_profile.ts";
import {
  projectPlanV3ToV2,
} from "../../../../viewer/assets/plan_v3.ts";
import type {
  Allocation, Capture, Item, Plan, PlanV3, PlanVersion, Skill,
} from "../../../../types/shared.d.ts";

export { gggMarkup, gggPlainText } from "./ggg_build_core.ts";
import type {
  GGGBuild, GGGItem, GGGPassive, GGGPassiveEntry,
  GGGSkill, GGGSkillEntry, GGGSupport,
} from "../../../../types/poe2.d.ts";

export const PLAN_FORMAT = 'buildwright-planner-plan' as const;
export const LEGACY_PLAN_FORMAT = 'poe2-planner-plan' as const;
// Keep this in sync with types/shared.d.ts:PlanVersion (currently 2).
// The on-disk snapshot's version field is stamped from this constant.
export const PLAN_VERSION: PlanVersion = 2;
// Schema rev of the GGG .build format we target. The mapping itself
// is codified (and frozen per revision) in build_schema.ts —
// changing the format means adding a revision there, never editing.
export const GGG_BUILD_SCHEMA = GGG_BUILD_SCHEMA_CURRENT;

// -------- Internal plan snapshot / restore --------

// Convert the live in-memory state into the on-disk plan format.
// Fields are pinned in this contract; adding a new field requires
// bumping PLAN_VERSION and adding a migration in loadPlanData().
export interface SnapshotMeta { name?: string; description?: string; }
// Legacy flat-allocations shape — only used by the standalone
// snapshot path. Live plans go through the chrome (PoE2Plan.get())
// and arrive in the canonical Plan shape.
export interface LegacyAllocation {
  id: string;
  set?: "main" | "set1" | "set2";
  attrPick?: string;
  levelInterval?: [number, number];
  notes?: string;
}
export interface LegacyPlanSnapshot {
  format: typeof PLAN_FORMAT;
  version: typeof PLAN_VERSION;
  savedAt: string;
  game: typeof GAME.id;
  name: string;
  description: string;
  class: string | null;
  ascendancy: string | null;
  allocations: LegacyAllocation[];
}
export function snapshotPlan(meta?: SnapshotMeta): LegacyPlanSnapshot {
  const m = meta || {};
  const allocations: LegacyAllocation[] = [];
  for (const [id, set] of state.selected) {
    const a: LegacyAllocation = { id: String(id), set: set as "main" | "set1" | "set2" };
    const pick = state.pickedAttrs.get(id);
    if (pick) a.attrPick = pick;
    const am = state.allocationMeta.get(id) as { notes?: string; levelInterval?: [number, number] } | undefined;
    if (am) {
      // Emit only fields the user actually set — keeps the JSON
      // tight for the 99% of nodes that have no per-allocation
      // metadata.
      if (am.levelInterval) a.levelInterval = am.levelInterval;
      if (am.notes) a.notes = am.notes;
    }
    allocations.push(a);
  }
  // Stable ordering so re-saving without changes gives a byte-
  // identical file (helps git diffs and idempotent shares).
  allocations.sort((a, b) => +a.id - +b.id);
  return {
    format: PLAN_FORMAT,
    version: PLAN_VERSION,
    savedAt: new Date().toISOString(),
    game: GAME.id,
    name: m.name || '',
    description: m.description || '',
    class: state.klass || null,
    ascendancy: state.asc || null,
    allocations,
  };
}

// Validate a parsed plan object. Returns null on success or a
// human-readable error string. We deliberately reject UNKNOWN
// future versions (refuses to guess); migrations from PAST versions
// run in loadPlanData().
//
// Accepts `unknown` and narrows manually — JSON.parse hands us raw
// untrusted data, and we want each branch to surface a specific
// error rather than a generic cast failure.
export function validatePlan(d: unknown): string | null {
  if (!d || typeof d !== 'object') return 'not a JSON object';
  const r = d as Record<string, unknown>;
  if (r.format !== PLAN_FORMAT && r.format !== LEGACY_PLAN_FORMAT) {
    return 'wrong format tag: ' + JSON.stringify(r.format);
  }
  if (r.game != null && r.game !== GAME.id) {
    return 'plan belongs to ' + JSON.stringify(r.game) + ', current planner is ' + GAME.id;
  }
  if (typeof r.version !== 'number') return 'missing version (number)';
  if (r.version > PLAN_VERSION) {
    return 'plan version ' + r.version + ' is newer than this planner (' + PLAN_VERSION + ')';
  }
  if (r.class != null && typeof r.class !== 'string') return 'class must be string or null';
  if (r.ascendancy != null && typeof r.ascendancy !== 'string') return 'ascendancy must be string or null';
  // Either the legacy flat allocations[] OR the new captures{} must
  // be present. Imports of both forms are accepted; chrome migrates
  // legacy → captures on .set().
  const captures = r.captures as { passives?: unknown } | undefined;
  const hasCaptures = !!(captures && typeof captures === 'object'
                    && Array.isArray(captures.passives));
  const hasAlloc    = Array.isArray(r.allocations);
  if (!hasCaptures && !hasAlloc) return 'plan must include allocations[] or captures.passives[]';
  if (hasAlloc) {
    const allocs = r.allocations as unknown[];
    for (let i = 0; i < allocs.length; i++) {
      const a = allocs[i] as Record<string, unknown> | null;
      if (!a || typeof a !== 'object') return 'allocations[' + i + '] is not an object';
      if (typeof a.id !== 'string' && typeof a.id !== 'number') {
        return 'allocations[' + i + '].id must be string or number';
      }
      if (a.set != null && !['main', 'set1', 'set2'].includes(a.set as string)) {
        return 'allocations[' + i + '].set must be one of main|set1|set2';
      }
      if (a.attrPick != null && !['Strength', 'Dexterity', 'Intelligence'].includes(a.attrPick as string)) {
        return 'allocations[' + i + '].attrPick must be Strength|Dexterity|Intelligence';
      }
      if (a.levelInterval != null) {
        const li = a.levelInterval as unknown[];
        if (!Array.isArray(li) || li.length !== 2
            || typeof li[0] !== 'number' || typeof li[1] !== 'number'
            || li[0] < 1 || li[1] > 100
            || li[0] > li[1]) {
          return 'allocations[' + i + '].levelInterval must be [low, high] with 1 ≤ low ≤ high ≤ 100';
        }
      }
      if (a.notes != null && typeof a.notes !== 'string') {
        return 'allocations[' + i + '].notes must be string';
      }
    }
  }
  if (hasCaptures && captures) {
    const passives = captures.passives as unknown[];
    for (let i = 0; i < passives.length; i++) {
      const c = passives[i] as Record<string, unknown> | null;
      if (!c || typeof c !== 'object') return 'captures.passives[' + i + '] is not an object';
      const lr = c.levelRange as unknown[];
      if (!Array.isArray(lr) || lr.length !== 2
          || typeof lr[0] !== 'number' || typeof lr[1] !== 'number') {
        return 'captures.passives[' + i + '].levelRange must be [low, high]';
      }
      if (!c.delta || typeof c.delta !== 'object') {
        return 'captures.passives[' + i + '].delta must be object';
      }
    }
  }
  return null;
}

// Apply a validated plan to live state, replacing the current build.
// Called from the .build / .poe2plan.json import flows. The plan may
// arrive in legacy flat-allocations shape OR the newer captures
// shape — we hand it to the chrome which migrates either into the
// canonical captures form, then hydrate passives from its active
// capture so we share one source of truth with every other page.
// Typed as Plan-ish: the import path runs validatePlan first, so by
// the time we get here the shape is one of {Plan, LegacyPlanSnapshot},
// both of which carry name/description/class. Other fields are read
// defensively.
type ImportedPlan = Plan | PlanV3 | LegacyPlanSnapshot;
export function loadPlanData(plan: ImportedPlan): void {
  const native = "identity" in plan ? plan : null;
  const activeNativeState = native?.states.find(
    candidate => candidate.id === native.activeStateId,
  );
  const name = native?.identity.name ?? ("name" in plan ? plan.name : "") ?? "";
  const description = native?.identity.description ??
    ("description" in plan ? plan.description : "") ?? "";
  const author = native?.identity.author ??
    ("author" in plan ? plan.author : undefined);
  const link = native?.identity.links?.[0]?.url ??
    ("links" in plan ? plan.links?.[0]?.url : undefined);
  const characterClass = activeNativeState?.character.class ??
    ("class" in plan ? plan.class : null);
  if (buildNameInput) buildNameInput.value = name;
  if (buildDescInput) buildDescInput.value = description;
  if (buildAuthorInput) {
    buildAuthorInput.value = author || '';
  }
  if (buildLinkInput) {
    buildLinkInput.value = link || '';
  }
  if (characterClass && characterClass !== state.klass) {
    classSel.value = characterClass;
    refreshAscOptions();
  }
  state.klass = characterClass || null;
  if (window.BuildwrightPlan) {
    // The chrome owns the plan; let it absorb the imported shape and
    // re-derive everything (active capture asc, passives, etc.).
    if (native) {
      if (!window.BuildwrightPlan.native.replace(native)) return;
    } else {
      window.BuildwrightPlan.set(plan as Plan);
    }
    const active = window.BuildwrightPlan.captures.active();
    const asc = active && active.ascendancy;
    if (asc) {
      const opt = [...ascSel.options].find(o => o.value === asc);
      if (opt) { ascSel.value = asc; applyAsc(); }
    }
    {
      const r = resolveAscName(asc || null);
      state.asc = r.panel;
      state.ascVariant = r.variant;
    }
    hydrateFromActiveCapture();
  } else {
    if (native) {
      throw new Error("Native backup restore requires the shared plan service.");
    }
    // Standalone smoke-test fallback (no wizard chrome present).
    const captures = 'captures' in plan ? plan.captures : undefined;
    const activeIdx = 'activeCapture' in plan ? (plan.activeCapture || 0) : 0;
    const active: Partial<Capture> = (captures && captures[activeIdx]) || {};
    if (active.ascendancy) {
      const opt = [...ascSel.options].find(o => o.value === active.ascendancy);
      if (opt) { ascSel.value = active.ascendancy; applyAsc(); }
    }
    {
      const r = resolveAscName(active.ascendancy || null);
      state.asc = r.panel;
      state.ascVariant = r.variant;
    }
    state.selected = new Map();
    state.allocationMeta = new Map();
    state.pickedAttrs = new Map();
    state.popoutId = null;
    state.searchHighlight = new Set();
    state.pathSwapTarget = null;
    state.pathSwapIndex = 0;
    for (const a of (active.passives || [])) {
      const id = String(a.id);
      if (!TREE.nodes[id]) continue;
      state.selected.set(id, a.set || 'main');
    }
    state.selDirty = true;
    updatePreview();
    requestRender();
    updateSelectionUI();
  }
}

// -------- GGG .build export (subset, passive-tree slice) --------

// Convert an internal captures[] plan to a GGG .build JSON object
// by run-collapsing each section's per-capture presence into
// level_interval entries. See docs/captures_data_model.md "Export
// to GGG .build (run-collapse)" for the spec.
//
// Headline ascendancy = the LAST capture's ascendancy. For builds
// that asc-respec mid-leveling (Pathfinder → Deadeye), only the
// final asc is named at the top level; the per-capture passives
// still emit with their level_intervals so the reader sees the
// pre-respec asc nodes too. (Edge case — most builds won't hit it.)
export function officialPassiveId(graphId: string | number): string | null {
  return graphIdToOfficial(graphId, TREE.passive_ids);
}

export function nativePassiveId(buildId: string | number): string | null {
  return officialIdToGraph(
    buildId,
    TREE.passive_ids,
    new Set(Object.keys(TREE.nodes)),
  ).graphId;
}

export interface GGGBuildCompatibilityIssue {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
}

export interface GGGBuildCompatibilityReport {
  canExport: boolean;
  projection: "route" | "final-state";
  issues: GGGBuildCompatibilityIssue[];
}

/** Load patch-owned BaseItemTypes and Words facts through the selected
 * game's data provider. This is intentionally separate from the UI's
 * display catalogue state: export correctness must not depend on whether a
 * picker happened to open before the user pressed Export. */
export async function loadOfficialBuildCatalogueData(): Promise<OfficialBuildCatalogueData> {
  const [skills, items] = await Promise.all([
    loadGameAsset<OfficialSkillCatalogueEnvelope>("skillCatalogue"),
    loadGameAsset<OfficialItemCatalogueEnvelope>("itemCatalogue"),
  ]);
  return buildOfficialCatalogueData(skills, items);
}

export function enrichPlanForOfficialBuild(
  plan: Plan,
  catalogue: OfficialBuildCatalogueData,
): Plan {
  return enrichPlanWithOfficialCatalogue(plan, catalogue);
}

export function preparePlanForGGGBuild(
  plan: Plan,
  nativePlan?: PlanV3,
): { plan: Plan; projection: GGGBuildCompatibilityReport["projection"] } {
  return prepareOfficialRoute(plan, nativePlan);
}

export function inspectGGGBuildCompatibility(
  plan: Plan,
  nativePlan?: PlanV3,
  catalogue?: OfficialBuildCatalogueData,
): GGGBuildCompatibilityReport {
  const issues: GGGBuildCompatibilityIssue[] = [];
  const add = (
    severity: GGGBuildCompatibilityIssue["severity"],
    code: string,
    message: string,
  ): void => {
    if (!issues.some(issue => issue.code === code && issue.message === message)) {
      issues.push({ severity, code, message });
    }
  };

  if (GAME.id !== "poe2" || !PROFILE.integrations.gggBuild ||
      !PROFILE.definition.officialBuild) {
    add("error", "unsupported-game", "Official .build files are currently supported only for PoE2.");
  }
  if (!TREE.passive_ids ||
      Object.keys(TREE.passive_ids.graphToBuild).length === 0) {
    add("error", "missing-passive-map",
      "This local patch has no PassiveSkills.Id translation table.");
  }
  if (catalogue) {
    for (const drift of officialInventoryDefinitionIssues(
      PROFILE.definition.officialBuild,
      catalogue.inventoryIds,
    )) {
      add(
        "error",
        "inventory-profile-drift:" + drift.slot,
        `Planner slot "${drift.slot}" targets "${drift.inventoryId}", ` +
          "which is not present in this patch’s GGG Inventories table.",
      );
    }
  }
  for (const capture of plan.captures) {
    for (const allocation of capture.passives) {
      const graphId = allocation.attrVariantId || allocation.id;
      if (!officialPassiveId(graphId)) {
        add("error", "unresolved-passive:" + graphId,
          'Passive graph id "' + graphId + '" has no official PassiveSkills.Id.');
      }
    }
    for (const item of capture.items) {
      const location = officialItemLocation(item);
      if (!location) {
        add("warning", "omitted-item-slot:" + (item.slot || item.inventoryId || "unknown"),
          'Item slot "' + (item.slot || item.inventoryId || "unknown") +
          '" has no official inventory target and will be omitted.');
      } else if (catalogue && !officialInventoryIdSupported(
        location.inventoryId,
        PROFILE.definition.officialBuild,
        catalogue.inventoryIds,
      )) {
        add(
          "error",
          "unknown-official-inventory:" + location.inventoryId,
          `Inventory id "${location.inventoryId}" is neither a current ` +
            "GGG Inventories.Id nor an explicit Build Planner target.",
        );
      }
      if (
        item.base || item.rarity || item.mods?.length ||
        item.itemLevel != null || item.quality != null ||
        item.corrupted || item.sockets?.length || item.sourceText
      ) {
        add("info", "item-summary",
          "Native item details will be rendered as inventory hover text because the official schema has no typed item-affix, quality, corruption, or socket fields.");
      }
      if (item.uniqueName && !item.officialUniqueName) {
        add("warning", "unique-name-verification",
          "An authored unique name has no exact Words-table match; it will remain hover text instead of an in-game unique hint.");
      } else if (item.officialUniqueName &&
          !catalogue?.uniqueNames.has(item.officialUniqueName)) {
        add("error", "unknown-official-unique:" + item.officialUniqueName,
          'Unique name "' + item.officialUniqueName +
          '" is not present in this patch’s verified Words catalogue.');
      }
    }
    for (const skill of capture.skills) {
      if (!catalogue) {
        add("error", "missing-skill-catalogue",
          "The current patch’s GGG BaseItemTypes skill catalogue could not be loaded.");
        break;
      }
      if (!catalogue.activeSkillIds.has(skill.id)) {
        add("error", "unknown-active-skill:" + skill.id,
          'Active skill id "' + skill.id +
          '" is not a current GGG skill-gem BaseItemTypes.Id.');
      } else if (catalogue.metaSkillIds.has(skill.id)) {
        add("error", "unsupported-meta-skill:" + skill.id,
          'Meta skill "' + skill.id +
          '" cannot be represented by the current official Build Planner.');
      }
      for (const support of skill.supports ?? []) {
        if (!catalogue.supportSkillIds.has(support.id)) {
          add("error", "unknown-support-skill:" + support.id,
            'Support id "' + support.id +
            '" is not a current GGG support-gem BaseItemTypes.Id.');
        }
      }
    }
    if (capture.skills.some(skill =>
      skill.level !== 1 || (skill.quality ?? 0) !== 0 || (skill.set && skill.set !== "main"))) {
      add("warning", "skill-metadata-loss",
        "Gem level, quality, and Buildwright skill specialization are not fields in the official schema.");
    }
  }
  if (plan.links && plan.links.length > 1) {
    add("warning", "extra-links", "The official format can carry only one build link.");
  }
  const ascendancyRoute = plan.captures
    .map(capture => capture.ascendancy)
    .filter((value): value is string => !!value);
  if (new Set(ascendancyRoute).size > 1) {
    add(
      "info",
      "ascendancy-progression",
      "The official file can name only the final ascendancy. Earlier " +
        "ascendancies are represented through timed passives and hover guidance.",
    );
  }
  const firstLink = plan.links?.[0]?.url;
  if (firstLink) {
    try {
      const parsed = new URL(firstLink);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error("unsupported protocol");
      }
    } catch {
      add("warning", "invalid-link",
        "The build link is not an HTTP(S) URL and will be omitted.");
    }
  }

  const routeIds = new Set(selectedNativeRoute(nativePlan).map(state => state.id));
  const offRoute = nativePlan?.states.filter(state => !routeIds.has(state.id)) ?? [];
  if (offRoute.length) {
    add("warning", "omitted-branches",
      offRoute.length + " state" + (offRoute.length === 1 ? "" : "s") +
      " outside the selected route will remain only in the native backup.");
  }
  const actorCount = nativePlan?.states.reduce(
    (count, state) => count + state.actors.length,
    0,
  ) ?? 0;
  if (actorCount) {
    add("warning", "omitted-actors",
      "Actor loadouts are not representable in the official .build format.");
  }

  const prepared = preparePlanForGGGBuild(plan, nativePlan);
  if (prepared.projection === "final-state") {
    add("warning", "final-state-projection",
      "This route has same-level or level-less states, so the official file will contain the selected leaf state only.");
  }
  return {
    canExport: !issues.some(issue => issue.severity === "error"),
    projection: prepared.projection,
    issues,
  };
}

export function formatGGGBuildCompatibility(report: GGGBuildCompatibilityReport): string {
  if (!report.issues.length) return "Official .build compatibility: no known losses.";
  return report.issues.map(issue => {
    const label = issue.severity === "error"
      ? "BLOCKING"
      : issue.severity === "warning" ? "LOSS" : "NOTE";
    return label + " — " + issue.message;
  }).join("\n");
}

interface GGGBuildCompatibilityDialogOptions {
  mode?: "export" | "import";
}

function showGGGBuildCompatibility(
  report: GGGBuildCompatibilityReport,
  options: GGGBuildCompatibilityDialogOptions = {},
): Promise<boolean> {
  const mode = options.mode ?? "export";
  const modal = document.getElementById("build-compatibility");
  const kicker = document.getElementById("build-compatibility-kicker");
  const title = document.getElementById("build-compatibility-title");
  const status = document.getElementById("build-compatibility-status");
  const projection = document.getElementById("build-compatibility-projection");
  const groups = document.getElementById("build-compatibility-groups");
  const footnote = document.getElementById("build-compatibility-footnote");
  const close = document.getElementById("build-compatibility-close") as HTMLButtonElement | null;
  const cancel = document.getElementById("build-compatibility-cancel") as HTMLButtonElement | null;
  const exportButton =
    document.getElementById("build-compatibility-export") as HTMLButtonElement | null;
  if (!modal || !kicker || !title || !status || !projection || !groups ||
      !footnote || !close || !cancel || !exportButton) {
    throw new Error("Official .build compatibility dialog is unavailable.");
  }

  kicker.textContent = mode === "import"
    ? "OFFICIAL POE2 BUILD · IMPORT"
    : "OFFICIAL POE2 BUILD · EXPORT";
  title.textContent = mode === "import"
    ? "Review imported build"
    : "Export compatibility";
  status.textContent = !report.canExport
    ? "Blocked"
    : mode === "import" && report.issues.length ? "Review" : "Ready";
  status.classList.toggle("blocked", !report.canExport);
  projection.textContent = mode === "import"
    ? "The file is structurally valid. Review what this patch can edit before replacing the current local plan."
    : report.projection === "route"
    ? "The selected route will be projected into level intervals."
    : "These states have no unambiguous level order; only the selected final state can be projected.";
  groups.replaceChildren();

  const labels: Record<GGGBuildCompatibilityIssue["severity"], string> =
    mode === "import"
      ? {
        error: "Blocking",
        warning: "Preserved, not editable",
        info: "Migration note",
      }
      : {
        error: "Blocking",
        warning: "Not represented",
        info: "Represented as guidance",
      };
  for (const severity of ["error", "warning", "info"] as const) {
    const matches = report.issues.filter(issue => issue.severity === severity);
    if (!matches.length) continue;
    const section = document.createElement("section");
    section.className = "build-compatibility-group";
    section.dataset.severity = severity;
    const heading = document.createElement("h3");
    heading.textContent = labels[severity] + " · " + matches.length;
    const list = document.createElement("ul");
    for (const issue of matches) {
      const row = document.createElement("li");
      row.textContent = issue.message;
      list.appendChild(row);
    }
    section.append(heading, list);
    groups.appendChild(section);
  }
  if (!report.issues.length) {
    const clean = document.createElement("p");
    clean.className = "build-compatibility-clean";
    clean.textContent = "No known compatibility losses on this route.";
    groups.appendChild(clean);
  }

  exportButton.disabled = !report.canExport;
  exportButton.textContent = report.canExport
    ? mode === "import" ? "Import .build" : "Export .build"
    : "Resolve blockers";
  footnote.textContent = mode === "import"
    ? "Nothing changes until you confirm. The original source is retained in the native plan."
    : "Your full Buildwright plan remains unchanged.";
  modal.classList.remove("hidden");
  close.focus();

  return new Promise(resolve => {
    let settled = false;
    const finish = (confirmed: boolean): void => {
      if (settled) return;
      settled = true;
      modal.classList.add("hidden");
      document.removeEventListener("keydown", onKey);
      resolve(confirmed);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      finish(false);
    };
    close.onclick = () => finish(false);
    cancel.onclick = () => finish(false);
    exportButton.onclick = () => {
      if (report.canExport) finish(true);
    };
    modal.onclick = event => {
      if (event.target === modal) finish(false);
    };
    document.addEventListener("keydown", onKey);
  });
}

export function planToGGGBuild(
  plan: Plan,
  meta?: SnapshotMeta,
  catalogue?: OfficialBuildCatalogueData,
): GGGBuild {
  if (plan.captures.some(capture => capture.skills.length) && !catalogue) {
    throw new Error("Official .build export requires the current GGG skill catalogue.");
  }
  if (catalogue) {
    const report = inspectGGGBuildCompatibility(plan, undefined, catalogue);
    const blocking = report.issues.filter(issue =>
      issue.severity === "error" &&
      (issue.code.startsWith("unknown-active-skill:") ||
       issue.code.startsWith("unsupported-meta-skill:") ||
       issue.code.startsWith("unknown-support-skill:") ||
       issue.code.startsWith("unknown-official-unique:")));
    if (blocking.length) {
      throw new Error(blocking.map(issue => issue.message).join(" "));
    }
  }
  const out: GGGBuild = {};
  const name = (meta && meta.name) || plan.name;
  const desc = (meta && meta.description) || plan.description;
  // `name` is the one field GGG's schema marks required — always emit.
  out.name = name || 'Untitled Build';
  if (plan.author) out.author = plan.author;
  const link = plan.links?.map(entry => entry.url).find((url) => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" || parsed.protocol === "http:";
    } catch {
      return false;
    }
  });
  if (link) out.link = link;
  if (desc) out.description = desc;
  const lastCapture = plan.captures[plan.captures.length - 1];
  if (lastCapture && lastCapture.ascendancy && TREE.asc_internal) {
    const info = TREE.asc_internal[lastCapture.ascendancy];
    if (info) out.ascendancy = info.internal;
  }
  const passives = collapsePassives(plan.captures);
  const skills   = collapseSkills(plan.captures);
  const items    = collapseItems(plan.captures);
  if (passives.length > 0) out.passives = passives;
  if (skills.length   > 0) out.skills   = skills;
  if (items.length    > 0) out.inventory_slots = items;
  if (out.passives) stampAscPivots(out.passives, plan.captures);
  // The lock: every export is checked against the frozen schema
  // revision it claims to target (build_schema.ts). A drift —
  // renamed field, wrong shape, deprecated alias — throws here, at
  // the first export, instead of silently shipping guides the client
  // ignores parts of.
  const drift = checkGGGBuild(out, GGG_BUILD_SCHEMA, 'export');
  if (drift) {
    throw new Error('.build export does not conform to schema rev ' +
      GGG_BUILD_SCHEMA + ': ' + drift);
  }
  return out;
}

// Auto-annotate ascendancy respec pivots into the .build's
// additional_text fields. The .build format only carries ONE
// top-level ascendancy (the final one), but `level_interval` lets
// each per-stage asc node surface at the right level. The missing
// piece is HUMAN GUIDANCE — without it the player at lvl 65 has no
// idea they're supposed to refund Oracle. So we stamp two pivot
// annotations per asc switch: one on the last outgoing-asc node
// ("respec coming"), one on the first incoming-asc node ("picked
// after respec"). Author-written notes are preserved by prepending
// our prose with a blank line between.
//
// Asc swap detection: walks captures pairwise. A switch is a
// capture[i].ascendancy !== capture[i+1].ascendancy with both set.
// The pivot level is capture[i+1].levelRange[0] — the first level
// at which the new ascendancy is active.
export function stampAscPivots(passives: GGGPassive[], captures: Capture[]): void {
  if (!passives || !captures || captures.length < 2) return;
  for (let i = 0; i < captures.length - 1; i++) {
    const capA = captures[i]!;
    const capB = captures[i + 1]!;
    const A = capA.ascendancy;
    const B = capB.ascendancy;
    if (!A || !B || A === B) continue;
    const ascA = capA.passives.filter((p) => {
      const n = TREE.nodes[String(p.id)];
      return n && n.a === A;
    });
    const ascB = capB.passives.filter((p) => {
      const n = TREE.nodes[String(p.id)];
      return n && n.a === B;
    });
    if (ascA.length === 0 || ascB.length === 0) continue;
    const lastA  = ascA[ascA.length - 1]!;
    const firstB = ascB[0]!;
    const lvl    = capB.levelRange[0];
    const outgoingProse = gggMarkup("b", "Respec at Lv " + lvl + ":") + " " +
      gggPlainText("refund " + A + " ascendancy and pick " + B +
        " (costs ascendancy refund orbs).");
    const incomingProse = gggMarkup("b", "Picked at Lv " + lvl) + " " +
      gggPlainText("after refunding " + A + " ascendancy.");
    const lastOfficial = officialPassiveId(lastA.attrVariantId || lastA.id);
    const firstOfficial = officialPassiveId(firstB.attrVariantId || firstB.id);
    if (lastOfficial) annotateById(passives, lastOfficial, outgoingProse);
    if (firstOfficial) annotateById(passives, firstOfficial, incomingProse);
  }
}

// Prepend `prose` to every passive entry matching `id`'s
// additional_text, separated by a blank line if the author already
// had a note there.
function annotateById(passives: GGGPassive[], id: string, prose: string): void {
  for (const entry of passives) {
    const eid = typeof entry === 'string' || typeof entry === 'number'
      ? String(entry) : String(entry.id);
    if (eid !== id) continue;
    // Bare-string entries can't carry additional_text — but asc
    // nodes always have a level_interval, so they're emitted as
    // objects. Defensive guard for the unlikely case.
    if (typeof entry === 'string' || typeof entry === 'number') continue;
    entry.additional_text = entry.additional_text
      ? prose + '\n\n' + entry.additional_text
      : prose;
  }
}

// Generic run-collapse — walks consecutive captures, groups by a
// section-specific key (see below), emits one .build entry per
// contiguous run. Per-section collapse keys per the spec:
//
//   passives: id + set
//   skills:   id + level + quality + set + sorted supports
//   items:    inventoryId + slotX + slotY + verified officialUniqueName
//
// A run that spans the WHOLE build range (first capture's lo to
// last capture's hi) emits a bare id (when possible) — no
// level_interval needed because the node is always present.
type CollapseRange = [number, number] | null;
function collapseRuns<E, O>(
  captures: Capture[],
  itemsOf: (c: Capture) => E[],
  keyOf: (e: E) => string,
  emitOf: (e: E, range: CollapseRange) => O,
): O[] {
  if (!captures || captures.length === 0) return [];
  const perCapture = captures.map(c => {
    const m = new Map<string, E>();
    for (const e of (itemsOf(c) || [])) m.set(keyOf(e), e);
    return m;
  });
  const allKeys = new Set<string>();
  for (const m of perCapture) for (const k of m.keys()) allKeys.add(k);

  const fullLow  = captures[0]!.levelRange[0];
  const fullHigh = captures[captures.length - 1]!.levelRange[1];
  const isFullRange = (lo: number, hi: number): boolean => lo === fullLow && hi === fullHigh;

  const out: O[] = [];
  for (const key of allKeys) {
    let runStart = -1;
    let runEntry: E | null = null;
    for (let i = 0; i < captures.length; i++) {
      const e = perCapture[i]!.get(key);
      if (e) {
        if (runStart < 0) runStart = i;
        runEntry = e;  // last-write wins for note + other metadata
      } else if (runStart >= 0) {
        const lo = captures[runStart]!.levelRange[0];
        const hi = captures[i - 1]!.levelRange[1];
        if (runEntry) out.push(emitOf(runEntry, isFullRange(lo, hi) ? null : [lo, hi]));
        runStart = -1;
        runEntry = null;
      }
    }
    if (runStart >= 0 && runEntry) {
      const lo = captures[runStart]!.levelRange[0];
      const hi = captures[captures.length - 1]!.levelRange[1];
      out.push(emitOf(runEntry, isFullRange(lo, hi) ? null : [lo, hi]));
    }
  }
  return out;
}

export function collapsePassives(captures: Capture[]): GGGPassive[] {
  const entries = collapseRuns<Allocation, GGGPassive>(
    captures,
    c => c.passives,
    // Collapse key includes attrVariantId AND level — changing
    // variant (Str → Dex) or re-allocating an asc/set node at a
    // different level both split into two runs with their own
    // level_intervals, matching the gem-progression behavior for
    // skills.
    (e) => String(e.id) + '|' + (e.set || 'main') + '|' +
         (e.attrVariantId || '') + '|' +
         (typeof e.level === 'number' ? e.level : ''),
    (e, range) => {
      // For attribute nodes with a picked variant, the .build entry
      // uses the VARIANT'S id (Str / Dex / Int has its own passive id
      // in tree.json). The parent attribute id is UI grouping only.
      const graphId = e.attrVariantId ? String(e.attrVariantId) : String(e.id);
      const exportId = officialPassiveId(graphId);
      if (!exportId) {
        throw new Error(
          'Cannot export passive graph id "' + graphId +
          '": this patch has no PassiveSkills.Id translation.',
        );
      }
      // If the entry carries an explicit authoring level (asc + set
      // allocations get one stamped on allocate), use it as the lower
      // bound — that's the level the author actually took this node.
      // Mains have no explicit level (their position in the capture
      // implies it), so they fall through to the run's natural lo.
      let effRange = range;
      if (typeof e.level === 'number') {
        if (range) {
          effRange = [Math.max(e.level, range[0]), range[1]];
        } else {
          // Run spans the full build but author tagged a level —
          // promote to range form so the in-game planner knows when
          // to surface this allocation.
          const lastHi = captures[captures.length - 1]!.levelRange[1];
          effRange = [e.level, lastHi];
        }
      }
      return makePassiveEntry(
        exportId,
        e.set || 'main',
        effRange,
        e.note ? gggPlainText(e.note) : undefined,
      );
    },
  );
  // Stable sort by numeric id (string-fallback) so byte-identical
  // re-exports are diff-friendly.
  entries.sort((a, b) => {
    const ai = typeof a === 'object' ? a.id : a;
    const bi = typeof b === 'object' ? b.id : b;
    const na = +ai, nb = +bi;
    if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
    return String(ai).localeCompare(String(bi));
  });
  return entries;
}

export function makePassiveEntry(id: string, set: string, range: CollapseRange, note?: string): GGGPassive {
  const hasWeaponSet = set === 'set1' || set === 'set2';
  if (!hasWeaponSet && !range && !note) return id;
  const obj: GGGPassiveEntry = { id };
  if (set === 'set1') obj.weapon_set = 1;
  else if (set === 'set2') obj.weapon_set = 2;
  if (range) obj.level_interval = range;
  if (note)  obj.additional_text = note;
  return obj;
}

export function collapseSkills(captures: Capture[]): GGGSkill[] {
  return collapseRuns<Skill, GGGSkill>(
    captures,
    c => c.skills,
    (e) => {
      // Sorted supports so [A, B] vs [B, A] don't split into two runs.
      const supports = (e.supports || [])
        .map((s) => s.id + ':' + (s.level || 1) + ':' + (s.quality || 0))
        .sort()
        .join(';');
      return e.id + '|' + (e.level || 1) + '|' + (e.quality || 0) +
             '|' + (e.set || 'main') + '|' + supports;
    },
    (e, range) => {
      const out: GGGSkillEntry = { id: e.id };
      if (range) out.level_interval = range;
      if (e.note) out.additional_text = gggPlainText(e.note);
      if (e.supports && e.supports.length > 0) {
        out.support_skills = e.supports.map((s) => {
          if (!s.note) return s.id;
          const support: GGGSupport = {
            id: s.id,
            additional_text: gggPlainText(s.note),
          };
          return support;
        });
      }
      // GGG permits a bare BaseItemTypes.Id when the root skill carries
      // no interval, note, or supports.
      return !out.level_interval && !out.additional_text && !out.support_skills
        ? out.id
        : out;
    },
  );
}

function officialItemLocation(item: Item): {
  inventoryId: string;
  slotX: number;
  slotY: number;
} | null {
  return resolveOfficialItemLocation(item, PROFILE.definition.officialBuild);
}

function officialItemText(item: Item): string | undefined {
  const lines = officialItemHintLines(item);
  return lines.length ? gggPlainText(lines.join("\n")) : undefined;
}

export function collapseItems(captures: Capture[]): GGGItem[] {
  return collapseRuns<Item, GGGItem>(
    captures,
    c => c.items.filter(item => officialItemLocation(item) !== null),
    (e) => {
      const location = officialItemLocation(e);
      if (!location) throw new Error("internal .build item projection mismatch");
      return location.inventoryId + '|' + location.slotX + '|' +
        location.slotY + '|' + (e.officialUniqueName || '');
    },
    (e, range) => {
      const location = officialItemLocation(e);
      if (!location) throw new Error("internal .build item projection mismatch");
      const out: GGGItem = {
        inventory_id: location.inventoryId,
        slot_x: location.slotX,
        slot_y: location.slotY,
      };
      if (e.officialUniqueName) out.unique_name = e.officialUniqueName;
      if (range) out.level_interval = range;
      const text = officialItemText(e);
      if (text) out.additional_text = text;
      return out;
    },
  );
}

// Validate an incoming GGG .build object. Derived entirely from the
// codified schema tables in build_schema.ts — lenient on unknown
// fields (GGG can add forward-compatible properties), strict on the
// types of fields we know.
export function validateGGGBuild(d: unknown): string | null {
  return checkGGGBuild(d, GGG_BUILD_SCHEMA, 'import');
}

// Reverse-lookup: variant id (Str / Dex / Int) → its parent attribute
// node id. Built once on first import. Lets us detect when a .build
// passive entry is actually an attribute variant and route it back to
// (parent id, attrVariantId) on the captures side.
let _attrVariantToParent: Map<string, string> | null = null;
export function attrVariantToParent(): Map<string, string> {
  if (_attrVariantToParent) return _attrVariantToParent;
  const m = new Map<string, string>();
  for (const parentId in TREE.nodes) {
    const n = TREE.nodes[parentId];
    if (!n || !n.o) continue;
    for (const opt of n.o) {
      if (opt.id != null) m.set(String(opt.id), String(parentId));
    }
  }
  _attrVariantToParent = m;
  return m;
}

// The pure importer uses this loss report in both the browser and CLI.
export interface GGGBuildImportReport {
  unresolvedPassiveIds: string[];
  unknownInventoryIds: string[];
  invalidInventoryIds: string[];
  legacyGraphIds: string[];
  unknownActiveSkillIds: string[];
  metaSkillIds: string[];
  unknownSupportSkillIds: string[];
  unknownUniqueNames: string[];
  unknownAscendancyId: string | null;
}

export function gggBuildToNativePlanWithReport(
  b: GGGBuild,
  catalogue: OfficialBuildCatalogueData,
): { plan: PlanV3; report: GGGBuildImportReport } {
  const classes = new Map<
    string,
    Array<{ name: string; internal: string }>
  >();
  for (const [name, value] of Object.entries(TREE.asc_internal ?? {})) {
    const list = classes.get(value.class) ?? [];
    list.push({ name, internal: value.internal });
    classes.set(value.class, list);
  }
  const result = importOfficialBuild(b, {
    profile: PROFILE,
    metadata: {
      game: GAME.id,
      patch: window.BuildwrightPatch,
      passive_ids: {
        ...(TREE.passive_ids ?? {
          graphToBuild: {},
          buildToGraph: {},
        }),
        attributeToParent: Object.fromEntries(attrVariantToParent()),
      },
      classes: [...classes.entries()].map(([name, ascendancies]) => ({
        name,
        ascendancies,
      })),
    },
    nativeNodeIds: new Set(Object.keys(TREE.nodes)),
    catalogue,
  });
  return result;
}

export function gggBuildToPlanWithReport(
  b: GGGBuild,
  catalogue: OfficialBuildCatalogueData,
): { plan: Plan; report: GGGBuildImportReport } {
  const result = gggBuildToNativePlanWithReport(b, catalogue);
  return {
    plan: projectPlanV3ToV2(result.plan),
    report: result.report,
  };
}

export function gggBuildToPlan(
  b: GGGBuild,
  catalogue: OfficialBuildCatalogueData,
): Plan {
  return gggBuildToPlanWithReport(b, catalogue).plan;
}

export function importCompatibilityReport(
  report: GGGBuildImportReport,
): GGGBuildCompatibilityReport {
  const issues: GGGBuildCompatibilityIssue[] = [];
  const addList = (
    severity: GGGBuildCompatibilityIssue["severity"],
    code: string,
    values: string[],
    message: (values: string[]) => string,
  ): void => {
    if (values.length) issues.push({ severity, code, message: message(values) });
  };
  addList("warning", "unresolved-passives", report.unresolvedPassiveIds, values =>
    `${values.length} passive id(s) are unavailable in this patch and will ` +
    "remain only in the retained source record: " + values.join(", "));
  addList("warning", "invalid-inventories", report.invalidInventoryIds, values =>
    `${values.length} inventory id(s) are neither current GGG table rows nor ` +
    "known Build Planner targets: " + values.join(", "));
  const opaqueInventories = report.unknownInventoryIds.filter(
    id => !report.invalidInventoryIds.includes(id),
  );
  addList("warning", "opaque-inventories", opaqueInventories, values =>
    `${values.length} valid inventory target(s) have no Buildwright editor ` +
    "slot and will remain only in the retained source record: " +
    values.join(", "));
  addList("warning", "unknown-active-skills", report.unknownActiveSkillIds, values =>
    `${values.length} active skill id(s) are not in this patch’s GGG gem ` +
    "catalogue: " + values.join(", "));
  addList("warning", "meta-skills", report.metaSkillIds, values =>
    `${values.length} meta gem id(s) are unsupported by the official Build ` +
    "Planner and will be retained without official guarantees: " +
    values.join(", "));
  addList("warning", "unknown-support-skills", report.unknownSupportSkillIds, values =>
    `${values.length} support id(s) are not in this patch’s GGG support ` +
    "catalogue: " + values.join(", "));
  addList("warning", "unknown-unique-names", report.unknownUniqueNames, values =>
    `${values.length} unique name(s) are not exact Words entries in this ` +
    "patch and cannot be safely re-exported: " + values.join(", "));
  if (report.unknownAscendancyId) {
    issues.push({
      severity: "warning",
      code: "unknown-ascendancy",
      message: `Ascendancy id "${report.unknownAscendancyId}" is unavailable ` +
        "in this patch and will remain only in the retained source record.",
    });
  }
  addList("info", "legacy-passive-ids", report.legacyGraphIds, values =>
    `${values.length} legacy numeric passive graph id(s) were migrated to ` +
    "current native allocations: " + values.join(", "));
  return { canExport: true, projection: "route", issues };
}

// -------- File I/O helpers --------

export function downloadJsonFile(filename: string, obj: unknown): void {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Trigger a hidden <input type=file> and resolve with the chosen file.
export function pickFile(accept?: string): Promise<File | null> {
  return new Promise(resolve => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.hidden = true;
    inp.dataset.buildwrightFilePicker = "true";
    if (accept) inp.accept = accept;
    const finish = (file: File | null): void => {
      inp.remove();
      resolve(file);
    };
    inp.onchange = () => finish((inp.files && inp.files[0]) || null);
    document.body.appendChild(inp);
    inp.click();
  });
}

export async function readJsonFile(file: File): Promise<unknown> {
  let text: string;
  try {
    text = await file.text();
  } catch (error) {
    throw new Error("Read failed: " +
      (error instanceof Error ? error.message : String(error)));
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("Invalid JSON: " +
      (error instanceof Error ? error.message : String(error)));
  }
}

// -------- Public actions (called from cmd-k + Export button) --------

export function safeFilename(s: string): string {
  return (s || 'untitled').toString().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'untitled';
}

// Read the live name + description from the sidebar inputs — the
// export flow no longer prompts; the author edits these inline as
// they design the build, matching the sidebar's GGG-order layout.
export function readBuildMeta(): SnapshotMeta {
  return {
    name: (buildNameInput.value || '').trim(),
    description: (buildDescInput.value || '').trim(),
  };
}

export async function doExportBuild(): Promise<void> {
  const meta = readBuildMeta();
  if (!meta.name) {
    alert('Set a build name in the sidebar (section 1 — Identity) before exporting.');
    buildNameInput.focus();
    return;
  }
  // Push pending sidebar edits + tree state into the chrome plan
  // so the export sees the freshest in-memory state.
  flushPersistNow();  // sync — wait until typed notes have landed in the plan before reading
  window.BuildwrightPlan?.native.sync();
  // The chrome's PoE2Plan.get() returns the canonical Plan; the
  // standalone fallback returns the LegacyPlanSnapshot shape. Cast
  // to Plan at the export-pipeline boundary — planToGGGBuild reads
  // `captures`/`patch`, both absent on the legacy shape, so without
  // the chrome the legacy snapshot path will only emit name + desc.
  const nativePlanSource = window.BuildwrightPlan
    ? window.BuildwrightPlan.get()
    : (snapshotPlan(meta) as unknown as Plan);
  let catalogue: OfficialBuildCatalogueData;
  try {
    catalogue = await loadOfficialBuildCatalogueData();
  } catch (error) {
    alert("Cannot verify official identifiers for this patch:\n\n" +
      (error as Error).message);
    return;
  }
  const plan = enrichPlanForOfficialBuild(nativePlanSource, catalogue);
  const nativePlan = window.BuildwrightPlan?.native.get();
  const report = inspectGGGBuildCompatibility(plan, nativePlan, catalogue);
  if (!await showGGGBuildCompatibility(report)) {
    return;
  }
  const prepared = preparePlanForGGGBuild(plan, nativePlan);
  const build = planToGGGBuild(prepared.plan, meta, catalogue);
  const err = validateGGGBuild(build);
  if (err) { alert('Refusing to export — output failed validation: ' + err); return; }
  downloadJsonFile(safeFilename(meta.name) + '.build', build);
}

export function doExportPlan(): void {
  const meta = readBuildMeta();
  const name = meta.name || 'untitled';
  flushPersistNow();  // sync — wait until typed notes have landed in the plan before reading
  window.BuildwrightPlan?.native.sync();
  const plan = window.BuildwrightPlan
    ? window.BuildwrightPlan.native.get()
    : snapshotPlan({ name, description: meta.description });
  // Native backups are v3 when the shared chrome is available. The
  // standalone fallback retains the legacy snapshot shape.
  if ("identity" in plan) {
    plan.identity.name = meta.name || plan.identity.name || '';
    plan.identity.description = meta.description || plan.identity.description || '';
  } else {
    plan.name = meta.name || plan.name || '';
    plan.description = meta.description || plan.description || '';
  }
  downloadJsonFile(safeFilename(name) + '.buildwright.json', plan);
}

export async function doImportBuild(): Promise<void> {
  const file = await pickFile('.build,application/json,.json');
  if (!file) return;
  try {
    const data = await readJsonFile(file);
    const err = validateGGGBuild(data);
    if (err) { alert('Not a valid .build file: ' + err); return; }
    let catalogue: OfficialBuildCatalogueData;
    try {
      catalogue = await loadOfficialBuildCatalogueData();
    } catch (error) {
      alert("Cannot verify imported identifiers for this patch:\n\n" +
        (error as Error).message);
      return;
    }
    // validateGGGBuild succeeded, so `data` matches GGGBuild's shape.
    const { plan, report } = gggBuildToNativePlanWithReport(
      data as GGGBuild,
      catalogue,
    );
    if (!await showGGGBuildCompatibility(
      importCompatibilityReport(report),
      { mode: "import" },
    )) {
      return;
    }
    loadPlanData(plan);
  } catch (e) { alert((e as Error).message); }
}

// Test/debug surface: lets external tooling (Playwright tests,
// browser console) call the export pipeline without going through
// the download UI. Not part of the user-facing app contract.
window.PoE2BuildIO = {
  planToGGGBuild,
  validateGGGBuild,
  gggBuildToPlan,
  gggBuildToPlanWithReport,
  gggBuildToNativePlanWithReport,
  inspectGGGBuildCompatibility,
};

export async function doImportPlan(): Promise<void> {
  const file = await pickFile('.json,.poe2plan,application/json');
  if (!file) return;
  try {
    const data = await readJsonFile(file);
    const record = data && typeof data === "object"
      ? data as Record<string, unknown>
      : null;
    const isNativeV3 = record?.format === PLAN_FORMAT &&
      record.version === 3 &&
      Array.isArray(record.states);
    const err = isNativeV3
      ? (() => {
        const candidate = data as PlanV3;
        if (candidate.game !== GAME.id) {
          return `plan belongs to ${JSON.stringify(candidate.game)}, ` +
            `current planner is ${GAME.id}`;
        }
        const errors = validatePlanForSelectedGame(candidate, PROFILE);
        return errors.length ? errors.join("; ") : null;
      })()
      : validatePlan(data);
    if (err) { alert('Not a valid plan file: ' + err); return; }
    // validatePlan succeeded, so `data` matches one of the
    // ImportedPlan shapes (canonical Plan or legacy flat-allocations).
    loadPlanData(data as ImportedPlan);
  } catch (e) { alert((e as Error).message); }
}
