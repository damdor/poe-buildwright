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


import { ascSel, buildDescInput, buildNameInput, classSel, state , resolveAscName} from "./02_state.ts";
import { requestRender } from "./04f_render.ts";
import { updatePreview } from "./06_pathfind.ts";
import { applyAsc, refreshAscOptions, updateSelectionUI } from "./07_sidebar.ts";
import { flushPersistNow, hydrateFromActiveCapture } from "./11_wizard_sync.ts";
import type { Allocation, Capture, GGGBuild, GGGItem, GGGPassive, GGGPassiveEntry, GGGSkill, GGGSupport, Item, Plan, PlanFormat, PlanVersion, Skill, SupportGem } from "../../../../types/poe2.d.ts";

export const PLAN_FORMAT: PlanFormat = 'poe2-planner-plan';
// Keep this in sync with types/poe2.d.ts:PlanVersion (currently 2).
// The on-disk snapshot's version field is stamped from this constant.
export const PLAN_VERSION: PlanVersion = 2;
// Schema rev of the GGG .build format we target. Bump when GGG
// changes the shape (new field, dropped field, renamed enum).
export const GGG_BUILD_SCHEMA = 1;

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
  if (r.format !== PLAN_FORMAT) return 'wrong format tag: ' + JSON.stringify(r.format);
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
type ImportedPlan = Plan | LegacyPlanSnapshot;
export function loadPlanData(plan: ImportedPlan): void {
  if (buildNameInput) buildNameInput.value = plan.name || '';
  if (buildDescInput) buildDescInput.value = plan.description || '';
  if (plan.class && plan.class !== state.klass) {
    classSel.value = plan.class;
    refreshAscOptions();
  }
  state.klass = plan.class || null;
  if (window.PoE2Plan) {
    // The chrome owns the plan; let it absorb the imported shape and
    // re-derive everything (active capture asc, passives, etc.).
    window.PoE2Plan.set(plan as Plan);
    const active = window.PoE2Plan.captures.active();
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
export function planToGGGBuild(plan: Plan, meta?: SnapshotMeta): GGGBuild {
  const out: GGGBuild = {};
  const name = (meta && meta.name) || plan.name;
  const desc = (meta && meta.description) || plan.description;
  if (name) out.name = name;
  if (desc) out.description = desc;
  // Stamp the game patch this build was authored against. Lets the
  // in-game planner / any third-party tool know which tree shape
  // these passive ids reference, in case a future patch rearranges
  // them. Field name `patch` matches our internal plan format.
  const patch = plan.patch || window.POE2_PATCH;
  if (patch) out.patch = patch;
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
  if (items.length    > 0) out.items    = items;
  if (out.passives) stampAscPivots(out.passives, plan.captures);
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
    const outgoingProse = '<bold>Respec at Lv ' + lvl + ':</bold> refund ' +
      A + ' ascendancy and pick ' + B + ' (costs ascendancy refund orbs).';
    const incomingProse = '<bold>Picked at Lv ' + lvl + '</bold> after refunding ' +
      A + ' ascendancy.';
    annotateById(passives, String(lastA.id),  outgoingProse);
    annotateById(passives, String(firstB.id), incomingProse);
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
//   items:    inventoryId + slotX + slotY + uniqueName
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
      const exportId = e.attrVariantId ? String(e.attrVariantId) : String(e.id);
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
      return makePassiveEntry(exportId, e.set || 'main', effRange, e.note);
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
      const out: GGGSkill = { id: e.id, level: e.level || 1, quality: e.quality || 0 };
      if (e.set === 'set1') out.weapon_set = 1;
      else if (e.set === 'set2') out.weapon_set = 2;
      if (range) out.level_interval = range;
      if (e.note) out.additional_text = e.note;
      if (e.supports && e.supports.length > 0) {
        out.support_skills = e.supports.map((s) => {
          const o: GGGSupport = { id: s.id, level: s.level || 1, quality: s.quality || 0 };
          if (s.note) o.additional_text = s.note;
          return o;
        });
      }
      return out;
    },
  );
}

export function collapseItems(captures: Capture[]): GGGItem[] {
  return collapseRuns<Item, GGGItem>(
    captures,
    c => c.items,
    (e) => (e.inventoryId || '') + '|' + (e.slotX || 0) + '|' +
                (e.slotY || 0) + '|' + (e.uniqueName || ''),
    (e, range) => {
      const out: GGGItem = {
        inventory_id: e.inventoryId || '',
        x: e.slotX || 0,
        y: e.slotY || 0,
      };
      if (e.uniqueName) out.unique_name = e.uniqueName;
      if (range) out.level_interval = range;
      if (e.note) out.additional_text = e.note;
      return out;
    },
  );
}

// Validate a GGG .build object. Strict on TYPES; lenient on
// UNKNOWN fields (we ignore them so a forward-compatible field GGG
// adds doesn't break our import).
export function validateGGGBuild(d: unknown): string | null {
  if (!d || typeof d !== 'object') return 'not a JSON object';
  const r = d as Record<string, unknown>;
  if (r.name !== undefined && typeof r.name !== 'string') return 'name must be string';
  if (r.description !== undefined && typeof r.description !== 'string') return 'description must be string';
  if (r.ascendancy !== undefined && typeof r.ascendancy !== 'string') return 'ascendancy must be string';
  if (r.passives !== undefined) {
    if (!Array.isArray(r.passives)) return 'passives must be an array';
    for (let i = 0; i < r.passives.length; i++) {
      const p = r.passives[i] as Record<string, unknown> | string | number | null;
      if (typeof p === 'string' || typeof p === 'number') continue;
      if (!p || typeof p !== 'object') return 'passives[' + i + '] must be id-string or object';
      if (typeof p.id !== 'string' && typeof p.id !== 'number') {
        return 'passives[' + i + '].id required (string or number)';
      }
      if (p.weapon_set !== undefined && p.weapon_set !== 1 && p.weapon_set !== 2) {
        return 'passives[' + i + '].weapon_set must be 1 or 2';
      }
      if (p.level_interval !== undefined) {
        const li = p.level_interval as unknown[];
        if (!Array.isArray(li) || li.length !== 2
            || typeof li[0] !== 'number' || typeof li[1] !== 'number') {
          return 'passives[' + i + '].level_interval must be [low, high] numbers';
        }
      }
    }
  }
  // skills / items / support_skills — accept but don't process yet.
  return null;
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

// Import a GGG .build into the captures[] plan shape. Reverses
// the run-collapse export: distinct level_interval boundaries
// become capture splits, and each capture's cumulative content is
// the set of entries whose level_interval includes that capture's
// upper bound. Bare-string passives (no level_interval) count as
// "always present" and land in every capture.
export function gggBuildToPlan(b: GGGBuild): Plan {
  let asc: string | null = null;
  if (b.ascendancy && TREE.asc_internal) {
    for (const name in TREE.asc_internal) {
      if (TREE.asc_internal[name]?.internal === b.ascendancy) { asc = name; break; }
    }
  }
  const klass = (asc && TREE.asc_internal?.[asc]?.class) || state.klass;

  // Normalize sections to a uniform { ..., level_interval?, note? } shape.
  // Detect attribute-variant ids (Str / Dex / Int) and reverse-map them
  // to the parent attribute node id + attrVariantId — the captures
  // model uses the parent id for tree positioning, with the variant
  // id stashed on the entry.
  const attrMap = attrVariantToParent();
  function normalizePassive(p: GGGPassive): Allocation {
    const isBare = typeof p === 'string' || typeof p === 'number';
    const idStr = isBare ? String(p) : String(p.id);
    const set: "main" | "set1" | "set2" =
                !isBare && p.weapon_set === 1 ? 'set1'
              : !isBare && p.weapon_set === 2 ? 'set2' : 'main';
    const e: Allocation = { id: idStr, set };
    const parentForVariant = attrMap.get(idStr);
    if (parentForVariant) {
      e.id = parentForVariant;
      e.attrVariantId = idStr;
    }
    if (!isBare) {
      if (p.level_interval) e.level_interval = p.level_interval;
      if (p.additional_text) e.note = p.additional_text;
      // For asc + weapon-set entries, the level_interval[0] is the
      // authoring level the export stamped on them. Restore it as
      // entry.level so the slider + future re-exports preserve the
      // off-curve timing. Mains derive level from position and skip
      // this — their level_interval[0] is just the capture's lo.
      const node = TREE.nodes[e.id];
      const isAscOrSet = (node && node.a) || e.set === 'set1' || e.set === 'set2';
      if (isAscOrSet && p.level_interval) {
        e.level = p.level_interval[0];
      }
    }
    return e;
  }
  const passiveEntries: Allocation[] = (b.passives || []).map(normalizePassive);
  const skillEntries: Skill[] = (b.skills || []).map((s) => {
    const e: Skill = {
      id:    s.id,
      level: typeof s.level === 'number' ? s.level : 1,
      quality: typeof s.quality === 'number' ? s.quality : 0,
      set:   s.weapon_set === 1 ? 'set1' : s.weapon_set === 2 ? 'set2' : 'main',
      supports: (s.support_skills || []).map((sup) => {
        const so: SupportGem = {
          id:    sup.id,
          level: typeof sup.level === 'number' ? sup.level : 1,
          quality: typeof sup.quality === 'number' ? sup.quality : 0,
        };
        if (sup.additional_text) so.note = sup.additional_text;
        return so;
      }),
    };
    if (s.level_interval) e.level_interval = s.level_interval;
    if (s.additional_text) e.note = s.additional_text;
    return e;
  });
  const itemEntries: Item[] = (b.items || []).map((it) => {
    const e: Item = {
      inventoryId: it.inventory_id,
      slotX: typeof it.x === 'number' ? it.x : 0,
      slotY: typeof it.y === 'number' ? it.y : 0,
    };
    if (it.unique_name) e.uniqueName = it.unique_name;
    if (it.level_interval) e.level_interval = it.level_interval;
    if (it.additional_text) e.note = it.additional_text;
    return e;
  });

  const captures = reconstructCaptures(passiveEntries, skillEntries, itemEntries, asc);

  return {
    format: PLAN_FORMAT,
    version: PLAN_VERSION,
    savedAt: new Date().toISOString(),
    name: b.name || '',
    description: b.description || '',
    class: klass,
    patch: null,
    activeSet: 'main',
    captures,
    activeCapture: captures.length - 1,
  };
}

// Reverse run-collapse: derive capture ranges from the distinct
// boundary points in the entries' level_intervals, then populate
// each capture's cumulative content via per-section presence check.
// See docs/captures_data_model.md "Slider behavior" for the
// entry-is-present-at-level rule.
//
// Three sections take separate parameters now (was a 3-tuple array)
// so each entry carries its own type and stays narrowed downstream.
// Local-only counter for the per-capture stable id; reset on each
// call so re-imports produce deterministic ids.
let _capIdCounter = 0;
function genCapId(): string {
  _capIdCounter += 1;
  return 'imp_' + _capIdCounter;
}
export function reconstructCaptures(
  passives: Allocation[],
  skills: Skill[],
  items: Item[],
  ascendancy: string | null,
): Capture[] {
  _capIdCounter = 0;
  let maxHi = -1;  // sentinel — when no level_intervals exist we fall back to 100
  const boundaries = new Set([1]);
  const collectBoundaries = (li: [number, number] | undefined): void => {
    if (!li) return;
    const lo = li[0], hi = li[1];
    boundaries.add(lo);
    boundaries.add(hi + 1);
    if (hi > maxHi) maxHi = hi;
  };
  for (const e of passives) collectBoundaries(e.level_interval);
  for (const e of skills)   collectBoundaries(e.level_interval);
  for (const e of items)    collectBoundaries(e.level_interval);
  if (maxHi < 0) maxHi = 100;  // no explicit level_intervals → default end
  boundaries.add(maxHi + 1);
  const points = [...boundaries].sort((a, b) => a - b);

  const captures: Capture[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const lo = points[i]!;
    const hi = points[i + 1]! - 1;
    if (hi < lo) continue;
    captures.push({
      id: genCapId(),
      levelRange: [lo, hi],
      name: null,
      description: '',
      ascendancy,
      passives: entriesAtLevel(passives, hi).map((e) => {
        const o: Allocation = { id: e.id, set: e.set || 'main' };
        if (e.note) o.note = e.note;
        if (e.attrVariantId) o.attrVariantId = e.attrVariantId;
        if (typeof e.level === 'number') o.level = e.level;
        return o;
      }),
      skills: entriesAtLevel(skills, hi).map((e) => {
        const o: Skill = {
          id: e.id, level: e.level, quality: e.quality, set: e.set || 'main',
          supports: (e.supports || []).map((s) => ({ ...s })),
        };
        if (e.note) o.note = e.note;
        return o;
      }),
      items: entriesAtLevel(items, hi).map((e) => {
        const o: Item = { inventoryId: e.inventoryId, slotX: e.slotX, slotY: e.slotY };
        if (e.uniqueName) o.uniqueName = e.uniqueName;
        if (e.note) o.note = e.note;
        return o;
      }),
    });
  }
  return captures.length > 0 ? captures : [{
    id: genCapId(),
    levelRange: [1, maxHi],
    name: null,
    description: '',
    ascendancy,
    passives: [], skills: [], items: [],
  }];
}

// An entry is present at level L iff:
//   * it has no level_interval (bare string ⇒ always present), OR
//   * level_interval[0] <= L <= level_interval[1].
export function entriesAtLevel<E extends { level_interval?: [number, number] }>(
  entries: E[], level: number,
): E[] {
  return entries.filter((e) => {
    if (!e.level_interval) return true;
    return level >= e.level_interval[0] && level <= e.level_interval[1];
  });
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
    if (accept) inp.accept = accept;
    inp.onchange = () => { resolve((inp.files && inp.files[0]) || null); };
    inp.click();
  });
}

export function readJsonFile(file: File): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try { resolve(JSON.parse(reader.result as string)); }
      catch (e) { reject(new Error('Invalid JSON: ' + (e as Error).message)); }
    };
    reader.onerror = () => reject(new Error('Read failed'));
    reader.readAsText(file);
  });
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

export function doExportBuild(): void {
  const meta = readBuildMeta();
  if (!meta.name) {
    alert('Set a build name in the sidebar (section 1 — Identity) before exporting.');
    buildNameInput.focus();
    return;
  }
  // Push pending sidebar edits + tree state into the chrome plan
  // so the export sees the freshest in-memory state.
  flushPersistNow();  // sync — wait until typed notes have landed in the plan before reading
  // The chrome's PoE2Plan.get() returns the canonical Plan; the
  // standalone fallback returns the LegacyPlanSnapshot shape. Cast
  // to Plan at the export-pipeline boundary — planToGGGBuild reads
  // `captures`/`patch`, both absent on the legacy shape, so without
  // the chrome the legacy snapshot path will only emit name + desc.
  const plan = window.PoE2Plan
    ? window.PoE2Plan.get()
    : (snapshotPlan(meta) as unknown as Plan);
  // (Pre-export connectivity check was tied to the old delta-captures
  // shape and is currently dead. Step 3 re-introduces a captures-aware
  // validator that walks each capture's passives via the connectivity
  // BFS already used in the live planner.)
  const build = planToGGGBuild(plan, meta);
  const err = validateGGGBuild(build);
  if (err) { alert('Refusing to export — output failed validation: ' + err); return; }
  downloadJsonFile(safeFilename(meta.name) + '.build', build);
}

export function doExportPlan(): void {
  const meta = readBuildMeta();
  const name = meta.name || 'untitled';
  flushPersistNow();  // sync — wait until typed notes have landed in the plan before reading
  const plan = window.PoE2Plan
    ? JSON.parse(JSON.stringify(window.PoE2Plan.get()))
    : snapshotPlan({ name, description: meta.description });
  // Stamp identity meta in case the user typed it but persist hasn't
  // flushed yet (debounced 300ms).
  plan.name = meta.name || plan.name || '';
  plan.description = meta.description || plan.description || '';
  downloadJsonFile(safeFilename(name) + '.poe2plan.json', plan);
}

export async function doImportBuild(): Promise<void> {
  const file = await pickFile('.build,application/json,.json');
  if (!file) return;
  try {
    const data = await readJsonFile(file);
    const err = validateGGGBuild(data);
    if (err) { alert('Not a valid .build file: ' + err); return; }
    // validateGGGBuild succeeded, so `data` matches GGGBuild's shape.
    const plan = gggBuildToPlan(data as GGGBuild);
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
};

export async function doImportPlan(): Promise<void> {
  const file = await pickFile('.json,.poe2plan,application/json');
  if (!file) return;
  try {
    const data = await readJsonFile(file);
    const err = validatePlan(data);
    if (err) { alert('Not a valid plan file: ' + err); return; }
    // validatePlan succeeded, so `data` matches one of the
    // ImportedPlan shapes (canonical Plan or legacy flat-allocations).
    loadPlanData(data as ImportedPlan);
  } catch (e) { alert((e as Error).message); }
}

