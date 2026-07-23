// ============================================================================
// === Wizard <-> planner sync (localStorage-backed) =======================
// ============================================================================
// Plan / Capture sync — the chrome (wizard_chrome.ts) owns the plan
// record and the per-section capture lists. The planner hydrates its
// tree state from the active passives capture on boot + on capture
// switches, and pushes diffs back through window.PoE2Plan.captures on
// every edit. All localStorage I/O lives in the chrome.
// ============================================================================

// Per-allocation metadata pushed back through PoE2Plan.data.commit().
// Mirrors viewer/assets/wizard_chrome.ts's CommitMeta. Kept local to
// avoid an import cycle through the closure-IIFE bundling.

import { allocModeSel, ascSel, buildDescInput, buildNameInput, classSel, state , ascDisplayName, resolveAscName} from "./state.ts";
import { requestRender } from "./render.ts";
import { updatePreview } from "./pathfind.ts";
import { applyAsc, refreshAscOptions, syncModeBadge, updateSelectionUI } from "./sidebar.ts";
import type { Capture, Item, Plan, Skill } from "../../../../types/shared.d.ts";

export interface CommitMeta {
  notes?: string;
  attrVariantId?: string;
  level?: number;
}

export let wizardBuildId: string | null = null;
export let wizardSaveTimer: ReturnType<typeof setTimeout> | null = null;

export function syncFromWizardStore(): void {
  if (!window.PoE2Plan) return;
  wizardBuildId = window.PoE2Plan.buildId();
  const data = window.PoE2Plan.get();
  if (!data) return;
  // Identity / class / asc / activeSet are global on the plan —
  // hydrate the sidebar inputs and tree state from them.
  if (buildNameInput) buildNameInput.value = data.name || "";
  if (buildDescInput) buildDescInput.value = data.description || "";
  // Default to the first alphabetical class when the plan has none —
  // the user always lands on a populated tree instead of an empty
  // "pick a class" prompt. The dropdown is already sorted
  // alphabetically server-side, so classSel.options[0] is the right
  // default.
  if (!data.class && classSel && classSel.options.length > 0) {
    data.class = classSel.options[0]!.value;
    window.PoE2Plan.save();
  }
  if (data.class && data.class !== state.klass) {
    classSel.value = data.class;
    refreshAscOptions();
  }
  state.klass = data.class || null;
  // Per-capture ascendancy: read from the active capture, not from a
  // top-level plan field (the captures-era spec moved asc per-capture
  // so the build can level as one asc and respec into another at a
  // snapshot boundary).
  const activeCap = window.PoE2Plan.captures.active();
  const ascendancyValue = activeCap && activeCap.ascendancy;
  if (ascendancyValue) {
    const opt = [...ascSel.options].find(o => o.value === ascendancyValue);
    if (opt) { ascSel.value = ascendancyValue; applyAsc(); }
  }
  {
    const r = resolveAscName(ascendancyValue || null);
    state.asc = r.panel;
    state.ascVariant = r.variant;
  }
  if (data.activeSet && allocModeSel) {
    allocModeSel.value = data.activeSet;
    state.activeSet = data.activeSet;
    syncModeBadge();
  }
  // Passives — pull effective state from the chrome's active capture.
  hydrateFromActiveCapture();
}

// Replace state.selected with the given effective allocation Map (the
// active capture's passives, as a Map<id, set>).
export function applyEffectiveAlloc(eff: Map<string, string> | null): void {
  state.selected = new Map();
  state.allocationMeta = new Map();
  state.pickedAttrs = new Map();
  state.popoutId = null;
  state.searchHighlight = new Set();
  state.pathSwapTarget = null;
  state.pathSwapIndex = 0;
  if (eff) {
    for (const [id, set] of eff) {
      if (!TREE.nodes[id]) continue;
      state.selected.set(String(id), set);
    }
  }
  // Pull per-allocation metadata out of the active capture:
  //   * note          → state.allocationMeta[id].notes
  //   * attrVariantId → state.pickedAttrs[id] (mapped back to name)
  //   * level         → state.allocationMeta[id].level (asc + set only)
  if (window.PoE2Plan) {
    const active = window.PoE2Plan.captures.active();
    for (const a of (active && active.passives) || []) {
      if (!a || a.id == null) continue;
      const sid = String(a.id);
      if (!state.selected.has(sid)) continue;
      const meta = state.allocationMeta.get(sid) || {};
      if (a.note) meta.notes = a.note;
      if (typeof a.level === "number") meta.level = a.level;
      if (meta.notes || typeof meta.level === "number") {
        state.allocationMeta.set(sid, meta);
      }
      if (a.attrVariantId) {
        const parent = TREE.nodes[sid];
        if (parent && parent.o) {
          const opt = parent.o.find(o => String(o.id) === String(a.attrVariantId));
          if (opt) state.pickedAttrs.set(sid, opt.n);
        }
      }
    }
  }
  state.selDirty = true;
  updatePreview();
  requestRender();
  updateSelectionUI();
}
export function hydrateFromActiveCapture(): void {
  if (!window.PoE2Plan) return;
  const eff = window.PoE2Plan.data.effective("passives");
  // effective() can return Map (passives) | Skill[] | Item[] | null;
  // narrow to the passives Map shape here at the boundary.
  if (eff instanceof Map) applyEffectiveAlloc(eff);
}

export function flushPersistNow(): void {
  if (!window.PoE2Plan) return;
  // Belt-and-suspenders: replay mode means state.selected holds a
  // slider-derived view, NOT authored content. Committing it to the
  // active capture would overwrite real authored data. The autosave
  // tick already skips on replayActive; this guard catches other call
  // sites (chip click, snapshot button, export) that flush
  // synchronously before checking replay state.
  if (state.replayActive) return;
  if (wizardSaveTimer) { clearTimeout(wizardSaveTimer); wizardSaveTimer = null; }
  const plan = window.PoE2Plan.get();
  plan.name        = buildNameInput ? buildNameInput.value.trim() : (plan.name || "");
  plan.description = buildDescInput ? buildDescInput.value.trim() : (plan.description || "");
  plan.class       = state.klass || null;
  plan.activeSet   = state.activeSet || "main";
  // Ascendancy is per-capture — set on the active capture.
  window.PoE2Plan.captures.setAscendancy(
    window.PoE2Plan.captures.activeIndex(),
    ascDisplayName() || null,
  );
  // state.selected preserves INSERTION ORDER. That order is what the
  // planner displays as "Lv 2 / Lv 3 / …" hints, but GGG's .build
  // format doesn't ask for a per-point level_interval — the bare-
  // string form is the default and the object form is only needed
  // when the author wants metadata on THIS specific node. So we DON'T
  // auto-emit level_interval here. Only user-authored notes
  // (additional_text) ride along on each entry.
  const eff = new Map<string, string>();
  const metaForCommit = new Map<string, CommitMeta>();
  for (const [id, set] of state.selected) {
    const sid = String(id);
    eff.set(sid, set);
    const m: CommitMeta = {};
    const userMeta = state.allocationMeta.get(sid);
    if (userMeta && userMeta.notes) m.notes = userMeta.notes;
    // Per-allocation authoring level — only stamped on asc + weapon-
    // set entries (mains derive level from position in the capture's
    // main-subset). Off-curve allocations would otherwise lose their
    // "taken at level X" timing inside a wide capture range.
    if (userMeta && typeof userMeta.level === "number") m.level = userMeta.level;
    // Resolve the picked attribute variant (Str/Dex/Int) to its own
    // passive id — that's what GGG's .build references when an
    // attribute node is allocated with a specific variant.
    const pickName = state.pickedAttrs.get(sid);
    if (pickName) {
      const parent = TREE.nodes[sid];
      if (parent && parent.o) {
        const opt = parent.o.find(o => o.n === pickName);
        if (opt && opt.id != null) m.attrVariantId = String(opt.id);
      }
    }
    if (Object.keys(m).length > 0) metaForCommit.set(sid, m);
  }
  window.PoE2Plan.data.commit(eff, "passives", metaForCommit);
  // The commit only persists when PASSIVES changed — but this flush
  // also carries name/description/class mutations. Save explicitly so
  // "type a name, allocate nothing yet" still persists and the chrome
  // refreshes its top-bar name (the Summary step gates on plan.name).
  window.PoE2Plan.save();
  // Dynamic graph owners (currently PoE1 cluster jewels) need the
  // committed allocation map, not the pre-save snapshot. A generated
  // child socket becoming allocated can materialise another nested
  // graph; deallocation can remove one and cascade its orphaned ids.
  window.dispatchEvent(new CustomEvent("buildwright-passives-change"));
}
export function persistToWizardStore(): void {
  if (!window.PoE2Plan) return;
  if (wizardSaveTimer) clearTimeout(wizardSaveTimer);
  wizardSaveTimer = setTimeout(flushPersistNow, 300);
}

// Hook auto-save into the state mutations that change allocations.
// We patch them at the end of boot so all initial state-loading code
// (which legitimately mutates state) doesn't trigger spurious saves.
setTimeout(function start() {
  // wizardBuildId is only set once syncFromWizardStore has run (boot
  // waits for the chrome's PoE2Plan to exist). A hard return here
  // killed the ENTIRE autosave loop when this timer won the race —
  // tree edits still persisted through direct commit paths, but
  // input-only changes (build name, description) were silently lost.
  // Retry until the sync has happened instead.
  if (!wizardBuildId) { setTimeout(start, 120); return; }
  // Selection / picked-attribute / allocation-meta change touches
  // state.selDirty. Watch that as a coarse trigger.
  //
  // No simple hook — instead piggyback on the cmd+k commit, sidebar
  // remove, reset-all, and class/asc change paths. Easiest reliable
  // signal is a render request following a state mutation; we
  // shouldn't save on EVERY render (background pan etc.), so we
  // detect changes by comparing snapshot hashes.
  let lastHash = quickPlanHash();
  function maybeSave(): void {
    // CRITICAL: never autosave while the level slider has put us in
    // replay mode. Replay constantly mutates state.selected to show a
    // derived view of the build; without this guard the autosave
    // would silently overwrite the active capture with whatever the
    // slider was showing, corrupting authored data on every slide.
    if (state.replayActive) return;
    const h = quickPlanHash();
    if (h !== lastHash) {
      lastHash = h;
      persistToWizardStore();
    }
  }
  // Re-check after every animation frame — cheap (a small string
  // concat + compare), and gives us a one-frame debounce.
  function tick(): void {
    maybeSave();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}, 0);

// Tiny stable hash of "what would the plan look like right now" so
// the auto-save tick can detect mutations without re-snapshotting
// every frame. Just concatenates ids+sets and picks counts.
export function quickPlanHash(): string {
  let s = (state.klass || "") + "|" + (state.asc || "") + "|" + state.activeSet + "|";
  s += (buildNameInput ? buildNameInput.value : "") + "|";
  s += (buildDescInput ? buildDescInput.value : "") + "|";
  s += state.selected.size + ",";
  // Sort keys so order changes don't trip the diff
  const ids = [...state.selected.keys()].sort();
  for (const id of ids) s += id + ":" + state.selected.get(id) + ";";
  for (const [id, pick] of state.pickedAttrs) s += id + "=" + pick + ";";
  // Notes — without these, typing in a textarea would never trip
  // the dirty check and notes would never get persisted into the
  // active capture's passives entries.
  for (const [id, meta] of state.allocationMeta) {
    if (meta.notes) s += id + "N" + meta.notes + ";";
  }
  return s;
}
