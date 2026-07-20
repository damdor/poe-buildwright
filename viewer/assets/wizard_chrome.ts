// Shared wizard chrome — runs on every step page (Build, Summary).
//
// Responsibilities:
//   1. Resolve build id from ?build=<id> in URL (redirect to landing if
//      missing or invalid).
//   2. Build the top header DOM: title + step nav + actions + save badge.
//   3. Own the plan store (localStorage-backed, captures-based — see
//      docs/captures_data_model.md) and expose it via window.PoE2Plan.
//
// The wizard's per-step JS owns its OWN content area; this module only
// touches the header element + the window.PoE2Plan namespace.

import { decode as decodeShare } from "./share_codec.ts";
import type {
  Plan, Capture, Allocation, Skill, Item,
  CommitMeta, PlanIndexEntry, PoE2PlanAPI,
} from "../../types/shared.d.ts";

// Storage is namespaced per game so a PoE1 page never sees (or
// clobbers) PoE2 plans. Default base keeps every existing PoE2 key.
const STORE_BASE =
  window.PoE2Game && window.PoE2Game.id !== "poe2"
    ? `${window.PoE2Game.id}-planner`
    : "poe2-planner";
const KEY_PREFIX  = `${STORE_BASE}:plan:`;
const KEY_INDEX   = `${STORE_BASE}:index`;
const KEY_CURRENT = `${STORE_BASE}:current`;
const PLAN_FORMAT: "poe2-planner-plan" = "poe2-planner-plan";
// v2 = captures[] cumulative snapshots. v1 is unsupported — pre-launch
// we don't carry legacy data forward. loadPlan returns null for non-v2
// entries and the planner mints a fresh plan.
const PLAN_VERSION: 2 = 2;
const DEFAULT_MAX_LEVEL = 100;
const SECTIONS = ["passives", "skills", "items"] as const;
type Section = typeof SECTIONS[number];

// -------------------------------------------------------------------
// Capture + plan factories
// -------------------------------------------------------------------
function genCapId(): string {
  const chars = "abcdefghijklmnpqrstuvwxyz0123456789";
  let s = "cap_";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

interface NewCaptureOpts {
  id?: string;
  levelRange?: [number, number];
  name?: string | null;
  description?: string;
  ascendancy?: string | null;
  passives?: Allocation[];
  skills?: Skill[];
  items?: Item[];
}

function newCapture(opts?: NewCaptureOpts): Capture {
  const o = opts || {};
  return {
    id:          o.id || genCapId(),
    levelRange:  o.levelRange || [1, DEFAULT_MAX_LEVEL],
    name:        o.name ?? null,
    description: o.description || "",
    ascendancy:  o.ascendancy ?? null,
    passives:    o.passives || [],
    skills:      o.skills   || [],
    items:       o.items    || [],
  };
}

function newPlan(): Plan {
  return {
    format: PLAN_FORMAT, version: PLAN_VERSION,
    savedAt: new Date().toISOString(),
    // Game patch this plan was authored against (e.g., "0.4"). Set
    // from window.POE2_PATCH at mint time; reads back on load so we
    // can detect cross-patch builds and warn the user. May be null on
    // plans authored before this field existed.
    patch: window.POE2_PATCH || null,
    name: "", description: "",
    class: null,
    activeSet: "main",
    captures: [newCapture()],
    activeCapture: 0,
  };
}

// Steps in canonical order. Identity moved into the planner sidebar;
// skills + items edited via in-tree overlays (top-right strips). The
// wizard now shows two top-level destinations: Build (the planner)
// and Summary (the guide-generator).
interface Step { id: string; label: string; file: string; }
// The Summary page was retired in favor of the in-planner Build Guide
// (📖) — a floating, editable, hover-linked reading view. STEPS keeps
// the single Build step; the array stays so the chrome's step-nav
// machinery is unchanged if a future step lands.
const STEPS: Step[] = [
  { id: "passives", label: "Build",   file: "planner.html" },
];

// Defensive normalization for plans loaded from disk — ensures every
// capture has its arrays + a valid id + activeCapture is in range.
// Does NOT migrate from older formats; pre-v2 plans return null from
// loadPlan and the caller mints a fresh one.
function normalizePlan(p: Plan | null | undefined): Plan {
  if (!p || typeof p !== "object") return newPlan();
  if (!Array.isArray(p.captures) || p.captures.length === 0) {
    p.captures = [newCapture()];
  }
  // Preserve the patch the plan was authored against. Plans created
  // before this field existed get null and skip the cross-patch
  // warning (we can't know if they're stale, so don't false-alarm).
  if (typeof p.patch !== "string") p.patch = null;
  for (const c of p.captures) {
    if (!c.id) c.id = genCapId();
    if (!Array.isArray(c.levelRange) || c.levelRange.length !== 2) {
      c.levelRange = [1, DEFAULT_MAX_LEVEL];
    }
    if (!Array.isArray(c.passives)) c.passives = [];
    if (!Array.isArray(c.skills))   c.skills   = [];
    if (!Array.isArray(c.items))    c.items    = [];
    if (typeof c.description !== "string") c.description = "";
  }
  // Heal corrupted capture ranges. Without this, a plan from an
  // earlier buggy snapshot/range op could persist forever in
  // localStorage and re-corrupt every session. We enforce four
  // invariants in order (left-to-right walk):
  //   1. cap[0].lo == 1                    (build always starts at lvl 1)
  //   2. cap[i].lo == cap[i-1].hi + 1      (contiguous, no gaps/overlaps)
  //   3. cap[i].hi >= cap[i].lo            (positive range)
  //   4. cap[N-1].hi == DEFAULT_MAX_LEVEL  (working cap extends to max)
  // Captures whose hi <= prev cap's hi (would invert) are merged into
  // the prev — last-write-wins for passives/skills/items, since the
  // cumulative model means the later cap is a superset (or the user's
  // freshest state if it was the working cap).
  normalizeCapturesRanges(p);
  if (typeof p.activeCapture !== "number" ||
      p.activeCapture < 0 || p.activeCapture >= p.captures.length) {
    p.activeCapture = p.captures.length - 1;
  }
  return p;
}

// -------------------------------------------------------------------
// Plan store (localStorage-backed)
// -------------------------------------------------------------------
function loadPlan(id: string): Plan | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + id);
    if (!raw) return null;
    const data = JSON.parse(raw) as Plan;
    if (data.format !== PLAN_FORMAT) return null;
    if (data.version !== PLAN_VERSION) return null;
    return data;
  } catch (e) {
    return null;
  }
}
function savePlan(id: string, plan: Plan): void {
  plan.savedAt = new Date().toISOString();
  localStorage.setItem(KEY_PREFIX + id, JSON.stringify(plan));
  let idx: PlanIndexEntry[] = [];
  try { idx = JSON.parse(localStorage.getItem(KEY_INDEX) || "[]"); } catch (e) {}
  const existing = idx.findIndex(e => e.id === id);
  const active = plan.captures[plan.activeCapture] || plan.captures[0];
  const entry: PlanIndexEntry = {
    id,
    name: plan.name || "(untitled)",
    savedAt: plan.savedAt,
    class: plan.class || null,
    ascendancy: (active && active.ascendancy) || null,
    nodeCount: (active && active.passives ? active.passives.length : 0),
    captureCount: plan.captures.length,
  };
  if (existing >= 0) idx[existing] = entry; else idx.push(entry);
  localStorage.setItem(KEY_INDEX, JSON.stringify(idx));
  localStorage.setItem(KEY_CURRENT, id);
}

// -------------------------------------------------------------------
// Resolve build id from URL.
//   ?new=1           → mint a fresh id, drop the flag, replace URL.
//   ?build=<id>      → use it.
//   (no params)      → use KEY_CURRENT (last opened) if set, else
//                      bounce to the landing page.
// -------------------------------------------------------------------
function genId(): string {
  const chars = "abcdefghijklmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
const url = new URL(location.href);
let buildId: string | null = url.searchParams.get("build");
let freshlyMinted = false;
// An #agent= fragment (see docs/agent-builds.md) is an entry credential:
// it always mints a FRESH build — importing an agent plan must never
// clobber the user's last-opened build. The fragment itself survives
// the replaceState (url was built from location.href) so the importer
// module picks it up after boot.
const hasAgentPayload = /[#&]agent=/.test(location.hash) || url.searchParams.has("live");
if (url.searchParams.has("new") || (hasAgentPayload && !buildId)) {
  buildId = genId();
  freshlyMinted = true;
  url.searchParams.delete("new");
  url.searchParams.set("build", buildId);
  history.replaceState({}, "", url);
} else if (!buildId) {
  const lastId = localStorage.getItem(KEY_CURRENT);
  if (lastId) {
    url.searchParams.set("build", lastId);
    location.replace(url.toString());
    // Bail — page is navigating away. We use throw not return because
    // we're at module top-level (not inside a function) under TS.
    throw new Error("[wizard_chrome] redirecting; not initialising");
  }
  if (window.PoE2Game && window.PoE2Game.id !== "poe2") {
    // Tree-only games (PoE1) have no landing wizard to bounce to —
    // a first visit mints a fresh build in place, like ?new=1.
    buildId = genId();
    freshlyMinted = true;
    url.searchParams.set("build", buildId);
    history.replaceState({}, "", url);
  } else {
    location.replace("/");
    throw new Error("[wizard_chrome] redirecting; not initialising");
  }
}
// After the redirect bail, buildId is definitely a string.
const resolvedBuildId: string = buildId;

const storedPlan = loadPlan(resolvedBuildId);
let plan: Plan = normalizePlan(storedPlan || newPlan());
if (freshlyMinted) savePlan(resolvedBuildId, plan);

// Share-link RECIPIENTS: the canonical link is
// /planner.html?build=<id>#code=<code> (the code stays in the URL so
// the address bar is always re-shareable). A browser that has never
// seen <id> installs the code under it, then reloads once — after
// that the local copy wins and the hash is inert.
const codeM = /[#&]code=([A-Za-z0-9_-]+)/.exec(location.hash);
if (!storedPlan && !freshlyMinted && codeM) {
  void (async () => {
    try {
      const decoded = await decodeShare(codeM[1]!);
      if (decoded && decoded.format === PLAN_FORMAT && decoded.version === PLAN_VERSION) {
        savePlan(resolvedBuildId, normalizePlan(decoded));
        localStorage.setItem(KEY_CURRENT, resolvedBuildId);
        location.reload();
      }
    } catch { /* bad code → stay on the blank build */ }
  })();
}

// ===================================================================
// Section reads + writes for the active capture.
// ===================================================================
function activeCapture(): Capture {
  return plan.captures[plan.activeCapture] ?? plan.captures[0]!;
}

function effectiveAt(section: Section): Map<string, string> | Skill[] | Item[] | null {
  if (!SECTIONS.includes(section)) return null;
  const c = activeCapture();
  if (section === "passives") {
    const out = new Map<string, string>();
    for (const a of c.passives) {
      if (a && a.id != null) out.set(String(a.id), a.set || "main");
    }
    return out;
  }
  if (section === "skills") return c.skills.slice();
  if (section === "items")  return c.items.slice();
  return null;
}

// Sync the "shareable" fields (note + attrVariantId) from the active
// capture's passives onto every OTHER capture that has the same node
// allocated. POSITIVE PROPAGATION ONLY — we never implicitly clear
// a value on another capture just because the active one happened not
// to carry it.
//
// The implicit-delete version had a footgun: respec a noted node, then
// re-allocate it later (e.g. a path-find walks through it). The
// re-allocation's commit produced a fresh entry without a note;
// shareable[id].note was null; the old `else if (p.note != null)
// delete p.note` branch then wiped the note from the original snapshot.
// Authoring lost data on what looks like a routine click.
//
// Explicit removals still work — they go through clearNoteEverywhere
// (called by the trash icon in the inline note editor) which sweeps
// every capture by id.
function propagateShareableMeta(activeOut: Allocation[]): void {
  const shareable = new Map<string, { note: string | null; attrVariantId: string | null }>();
  for (const e of activeOut) {
    if (!e || e.id == null) continue;
    const note = e.note != null ? e.note : null;
    const attrVariantId = e.attrVariantId != null ? e.attrVariantId : null;
    if (note == null && attrVariantId == null) continue;
    shareable.set(String(e.id), { note, attrVariantId });
  }
  for (const other of plan.captures) {
    if (other === activeCapture()) continue;
    for (const p of other.passives) {
      if (!p || p.id == null) continue;
      const m = shareable.get(String(p.id));
      if (!m) continue;
      if (m.note != null) p.note = m.note;
      if (m.attrVariantId != null) p.attrVariantId = m.attrVariantId;
    }
  }
}

// Explicit "remove this note everywhere" — sweeps every capture's
// passives and strips the note field from any entry with the given
// node id. Wired up by the trash icon in the inline note editor.
// Doesn't touch attrVariantId; pick clearing is a separate concern.
function clearNoteEverywhere(id: string): void {
  const sid = String(id);
  for (const c of plan.captures) {
    for (const p of c.passives) {
      if (p && String(p.id) === sid && p.note != null) {
        delete p.note;
      }
    }
  }
  persistDebounced();
}

function commitEffective(
  section: Section,
  next: Map<string, string> | Skill[] | Item[],
  metaMap?: Map<string, CommitMeta>,
): void {
  const c = activeCapture();
  if (section === "passives") {
    const passivesMap = next as Map<string, string>;
    const existingById = new Map<string, Allocation>();
    for (const a of c.passives) {
      if (a && a.id != null) existingById.set(String(a.id), a);
    }
    const useMeta = metaMap instanceof Map;
    const out: Allocation[] = [];
    for (const [id, set] of passivesMap) {
      const sid = String(id);
      const prior = existingById.get(sid);
      const entry: Allocation = {
        id: sid,
        set: (set as Allocation["set"]) || "main",
      };
      let note: string | undefined;
      let attrVariantId: string | undefined;
      let level: number | undefined;
      if (useMeta) {
        const um = metaMap!.get(sid);
        note = um?.notes;
        attrVariantId = um?.attrVariantId;
        level = typeof um?.level === "number" ? um.level : undefined;
      } else {
        note = prior?.note;
        attrVariantId = prior?.attrVariantId;
        level = typeof prior?.level === "number" ? prior.level : undefined;
      }
      if (note) entry.note = note;
      if (attrVariantId) entry.attrVariantId = attrVariantId;
      if (typeof level === "number") entry.level = level;
      out.push(entry);
    }
    c.passives = out;
    propagateShareableMeta(out);
    persistDebounced();
    return;
  }
  if (section === "skills") { c.skills = (next as Skill[] || []).slice(); persistDebounced(); return; }
  if (section === "items")  { c.items  = (next as Item[]  || []).slice(); persistDebounced(); return; }
}

// ===================================================================
// Captures API (mutations + read helpers).
// ===================================================================
function dispatchCaptureChange(reason?: string): void {
  window.dispatchEvent(new CustomEvent("poe2-capture-change", {
    detail: { index: plan.activeCapture, reason: reason || "unknown" }
  }));
}
// Heal/enforce the four range invariants on plan.captures (see the
// doc-comment in normalizePlan). Mutates the plan in place. Safe to
// call after any cap-mutating op; idempotent on a sane plan.
function normalizeCapturesRanges(p: Plan): void {
  if (!Array.isArray(p.captures) || p.captures.length === 0) return;
  // Clamp + integer-coerce every value first so subsequent walks see
  // only sane numbers.
  for (const c of p.captures) {
    let lo = Number(c.levelRange[0]) | 0;
    let hi = Number(c.levelRange[1]) | 0;
    if (lo < 1) lo = 1;
    if (hi > DEFAULT_MAX_LEVEL) hi = DEFAULT_MAX_LEVEL;
    if (lo > DEFAULT_MAX_LEVEL) lo = DEFAULT_MAX_LEVEL;
    c.levelRange = [lo, hi];
  }
  // Walk LR, enforce contiguity + invert-merge any cap whose hi would
  // land before the new lo.
  p.captures[0]!.levelRange[0] = 1;
  for (let i = 1; i < p.captures.length; i++) {
    const expectedLo = p.captures[i - 1]!.levelRange[1] + 1;
    p.captures[i]!.levelRange[0] = expectedLo;
  }
  // Sweep RL, dropping any cap whose hi < lo (inverted, the result of
  // a snap-from-non-working-cap or duplicate snap that this walk's
  // contiguity-enforcement just flagged). The inverted cap's contents
  // take over the prev's slot (last-write wins — the more recent
  // state is the freshest user-authored data).
  for (let i = p.captures.length - 1; i > 0; i--) {
    const c = p.captures[i]!;
    if (c.levelRange[1] < c.levelRange[0]) {
      const prev = p.captures[i - 1]!;
      // Don't let merged hi blow past DEFAULT_MAX_LEVEL: clamp.
      prev.levelRange[1] = Math.min(
        DEFAULT_MAX_LEVEL,
        Math.max(prev.levelRange[1], c.levelRange[1], c.levelRange[0])
      );
      prev.passives = c.passives;
      prev.skills   = c.skills;
      prev.items    = c.items;
      // ascendancy / note kept as prev's — those are per-snapshot
      // intent and the inverted cap can't reasonably claim them.
      p.captures.splice(i, 1);
    }
  }
  // First cap: if its hi got below 1 somehow, give it the full range.
  if (p.captures[0]!.levelRange[1] < p.captures[0]!.levelRange[0]) {
    p.captures[0]!.levelRange = [1, DEFAULT_MAX_LEVEL];
  }
  // Working cap (last) always extends to DEFAULT_MAX_LEVEL — anything
  // less is meaningless (the cap covers "from snap point to end of
  // build" and the user has no way to push past the working cap).
  const last = p.captures[p.captures.length - 1]!;
  if (last.levelRange[1] < DEFAULT_MAX_LEVEL) {
    last.levelRange[1] = DEFAULT_MAX_LEVEL;
  }
}

function isWorkingCapture(idx: number): boolean {
  return idx === plan.captures.length - 1;
}

function setActiveCapture(idx: number): boolean {
  if (typeof idx !== "number" || idx < 0 || idx >= plan.captures.length) return false;
  if (idx === plan.activeCapture) return true;
  plan.activeCapture = idx;
  persistDebounced();
  dispatchCaptureChange("setActive");
  return true;
}
function setCaptureAscendancy(idx: number, asc: string | null): boolean {
  const c = plan.captures[idx];
  if (!c) return false;
  c.ascendancy = asc || null;
  persistDebounced();
  return true;
}
function setCaptureRange(idx: number, range: [number, number]): boolean {
  const c = plan.captures[idx];
  if (!c || !Array.isArray(range) || range.length !== 2) return false;
  const lo = Number(range[0]) | 0;
  const hi = Number(range[1]) | 0;
  if (lo < 1 || hi < 1 || lo > DEFAULT_MAX_LEVEL || hi > DEFAULT_MAX_LEVEL) return false;
  if (lo > hi) return false;
  c.levelRange = [lo, hi];
  // Re-enforce contiguity invariants — caller's range may have
  // created gaps/overlaps with neighbors.
  normalizeCapturesRanges(plan);
  persistDebounced();
  dispatchCaptureChange("setRange");
  return true;
}
function setCaptureName(idx: number, name: string | null): boolean {
  const c = plan.captures[idx];
  if (!c) return false;
  c.name = name || null;
  persistDebounced();
  return true;
}
function setCaptureDescription(idx: number, text: string): boolean {
  const c = plan.captures[idx];
  if (!c) return false;
  c.description = text || "";
  persistDebounced();
  return true;
}
function snapshotAt(level: number): number | false {
  // Validation. snapshotAt is the only path that grows the captures
  // array; everything else must hit a sane state. Without these
  // guards, snap-from-non-working-cap would silently corrupt
  // (active.hi gets mutated AND a new cap pushed at the END,
  // producing duplicate ranges + gaps — the [21,100]/[21,100] pattern
  // in user-reported plans).
  level = Number(level) | 0;
  if (level < 2 || level >= DEFAULT_MAX_LEVEL) return false;
  if (plan.activeCapture !== plan.captures.length - 1) {
    // Can only snap from the WORKING cap (the last one). If the user
    // navigated to a frozen chip first, the snap button is supposed
    // to be disabled — this is the belt-and-suspenders.
    return false;
  }
  const active = activeCapture();
  if (!active || level <= active.levelRange[0]) return false;
  active.levelRange[1] = level;
  const next = newCapture({
    levelRange: [level + 1, DEFAULT_MAX_LEVEL],
    ascendancy: active.ascendancy,
    // Deep-copy via JSON to avoid sharing array refs between captures.
    passives: JSON.parse(JSON.stringify(active.passives)),
    skills:   JSON.parse(JSON.stringify(active.skills)),
    items:    JSON.parse(JSON.stringify(active.items)),
  });
  plan.captures.push(next);
  plan.activeCapture = plan.captures.length - 1;
  // Defensive re-normalize — should be a no-op on a clean plan, but
  // if upstream state ever drifts (race, external mutation), this
  // catches it before it persists.
  normalizeCapturesRanges(plan);
  persistDebounced();
  dispatchCaptureChange("snapshot");
  return plan.activeCapture;
}
function removeCapture(idx: number): boolean {
  if (plan.captures.length <= 1) return false;
  if (typeof idx !== "number" || idx < 0 || idx >= plan.captures.length) return false;
  // Refuse deleting the WORKING capture (the last one). The working
  // cap holds the user's live editing state; removing it would either
  // lose those edits or silently promote a frozen cap into the
  // working slot with extended range. Either is surprising. To
  // "delete" the working cap, the user should clear it via the
  // sidebar "Clear" button instead.
  if (idx === plan.captures.length - 1) return false;
  const removed = plan.captures.splice(idx, 1)[0]!;
  // Merge rules — FORWARD (next cap absorbs the removed range by
  // extending its lo BACKWARDS). Previously we merged backward (prev
  // cap extended its hi forward), but that produced "dead zones" in
  // the slider: prev kept its own (smaller) passive count, so
  // scrubbing across the absorbed range revealed nothing past prev's
  // last passive. Forward-merge fixes it — the next cap has MORE
  // passives (it was a later snap), so the slider reveals them
  // progressively across the merged range.
  //
  // After splice, plan.captures[idx] is what USED TO BE
  // plan.captures[idx+1]. The working cap is undeletable (refused
  // above), so there's always a next-cap to absorb.
  const successor = plan.captures[idx];
  if (successor) {
    successor.levelRange[0] = removed.levelRange[0];
  }
  if (plan.activeCapture >= plan.captures.length) {
    plan.activeCapture = plan.captures.length - 1;
  } else if (plan.activeCapture > idx) {
    // The deleted cap was before active — shift down so we still
    // point at the same cap.
    plan.activeCapture--;
  } else if (plan.activeCapture === idx) {
    // Deleted the active cap — fall back to the absorbing next cap
    // (now at the same index after splice). Always safe since
    // working cap is undeletable.
    plan.activeCapture = idx;
  }
  normalizeCapturesRanges(plan);
  persistDebounced();
  dispatchCaptureChange("remove");
  return true;
}

// Diff between two captures' passive id sets — drives the slider's
// capture-boundary respec animation (consumed by future UI).
function diffCaptures(iA: number, iB: number):
  { added: Set<string>; removed: Set<string>; kept: Set<string> } | null {
  const a = plan.captures[iA], b = plan.captures[iB];
  if (!a || !b) return null;
  const A = new Set(a.passives.map(p => String(p.id)));
  const B = new Set(b.passives.map(p => String(p.id)));
  const added = new Set<string>(), removed = new Set<string>(), kept = new Set<string>();
  for (const id of B) (A.has(id) ? kept : added).add(id);
  for (const id of A) if (!B.has(id)) removed.add(id);
  return { added, removed, kept };
}
function pointBudgetFor(capture: Capture | null | undefined): number {
  // noUncheckedIndexedAccess: levelRange[1] is `number | undefined`.
  // `undefined - 1` would be NaN, then `| 0` clamps to 0 — same as the
  // original behaviour, but spelled explicitly so the checker is happy.
  const hi = capture?.levelRange?.[1] ?? 0;
  return (hi - 1) | 0;
}
function isFull(capture: Capture | null | undefined): boolean {
  return !!capture && capture.passives.length === pointBudgetFor(capture);
}

// -------------------------------------------------------------------
// Header DOM
// -------------------------------------------------------------------
const host = document.getElementById("wizard-chrome");
if (!host) {
  console.warn("wizard_chrome.ts: no #wizard-chrome element on this page");
  // Same bail trick as the redirect path — module top-level can't return.
  throw new Error("[wizard_chrome] no host element; abandoning init");
}
// `host` is narrowed to HTMLElement past this point.
const wizardHost: HTMLElement = host;
const currentStep = wizardHost.dataset.step || "passives";
if (!STEPS.find(s => s.id === currentStep)) {
  console.warn("wizard_chrome.ts: unknown step", currentStep);
}
const captureSection: string | null = wizardHost.dataset.captureSection || null;

wizardHost.classList.add("wizard-chrome");
wizardHost.innerHTML = `
  <div class="wc-row1">
    <div class="wc-title">
      <span class="wc-buildname placeholder" id="wc-buildname">(untitled)</span>
      <span class="wc-buildid">#${escHtml(resolvedBuildId)}</span>
    </div>
    <ol class="wc-steps">
      ${STEPS.map(s => `
        <li data-step="${s.id}" class="${s.id === currentStep ? "active" : ""}">
          <span class="wc-step-num">${STEPS.indexOf(s) + 1}</span>
          <span>${escHtml(s.label)}</span>
        </li>
      `).join("")}
    </ol>
    <div class="wc-actions">
      <span id="wc-save-status" hidden><span class="wc-save-msg"></span></span>
      <span class="wc-patch-badge" id="wc-patch-badge" title="PoE2 data version currently loaded" hidden></span>
      <a class="wc-gh" href="https://github.com/damdor/poe-buildwright" target="_blank" rel="noopener" title="Source on GitHub — issues &amp; contact"><svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg></a>
      <a href="/">← Builds</a>
    </div>
  </div>
`;
refreshBuildName();

// Fetch the current data patch from build_meta.json and surface it in
// the navbar badge. Async, non-blocking — the navbar renders
// immediately and the badge pops in once the fetch resolves. Also
// drives the stale-plan warning: if the loaded plan's patch doesn't
// match the live data patch, show a warning banner so the user knows
// their allocations might reference moved/removed nodes. Default cache
// mode (revalidate via ETag) instead of 'force-cache': after a deploy
// the user's browser may have an older build_meta.json cached that
// pre-dates the patch field; force-cache would keep using that stale
// copy and the badge would never appear. Standard revalidate catches
// the new file via 304 on hit, full download on miss.
interface BuildMeta { patch?: string; source?: string; }
// Per-game agent dir: the poe1 page's metadata lives under
// /assets/poe1-agent, and its badge must not claim to be PoE2 data.
const GAME_ID = window.PoE2Game?.id ?? "poe2";
const GAME_LABEL = GAME_ID === "poe2" ? "PoE2" : GAME_ID.replace("poe", "PoE");
const META_URL = window.PoE2Game?.agentBase
  ? window.PoE2Game.agentBase + "/build_meta.json"
  : "/assets/build_meta.json";
fetch(META_URL)
  .then(r => r.ok ? r.json() : null)
  .then((meta: BuildMeta | null) => {
    if (!meta || !meta.patch) return;
    window.POE2_PATCH = meta.patch;
    window.POE2_SOURCE = meta.source || "";
    const badge = document.getElementById("wc-patch-badge");
    if (badge) {
      // Append a small "preview" suffix when the data isn't from the
      // canonical PoB2 stable source (e.g. during the preview period
      // before PoB2 ships the new patch). Empty source = legacy
      // manifest without the field, treated as stable.
      const isPreview =
        GAME_ID === "poe2" && !!meta.source && meta.source !== "pob2-stable";
      // Patch labels for non-poe2 games carry the game prefix
      // ("poe1.3.26") — the badge already names the game, so drop it.
      const patchLabel = meta.patch.startsWith(GAME_ID + ".")
        ? meta.patch.slice(GAME_ID.length + 1)
        : meta.patch;
      badge.textContent = GAME_LABEL + " " + patchLabel + (isPreview ? " preview" : "");
      badge.title = isPreview
        ? "Preview data from " + meta.source + " — may differ from final patch"
        : GAME_LABEL + " data version currently loaded";
      badge.classList.toggle("wc-patch-badge-preview", isPreview);
      badge.hidden = false;
    }
    // Stamp the patch onto plans that pre-date this field. New plans
    // get it from window.POE2_PATCH in newPlan(); existing ones get
    // it set here so future edits don't false-alarm as cross-patch
    // on subsequent loads. Only stamp when plan.patch is null (the
    // "I don't know" sentinel) — if the plan already declares a
    // patch (even a different one), respect that.
    if (plan.patch == null) {
      plan.patch = meta.patch;
      persistDebounced();
    } else if (plan.patch !== meta.patch) {
      showStalePatchBanner(plan.patch, meta.patch);
    }
  })
  .catch(() => {});

// Render a dismissible banner ABOVE the wizard chrome warning the
// user the loaded plan was authored under a different patch. Some
// allocations may reference passive/skill ids that no longer exist
// — those silently drop on hydrate (applyEffectiveAlloc filters
// unknown ids), so the live tree may show fewer nodes than the saved
// plan technically contains. We don't auto-migrate or refuse to load;
// users keep what works and re-edit the rest.
function showStalePatchBanner(planPatch: string, currentPatch: string): void {
  if (document.getElementById("wc-stale-banner")) return;  // already shown
  const bar = document.createElement("div");
  bar.id = "wc-stale-banner";
  bar.className = "wc-stale-banner";
  bar.innerHTML =
    "<span>This build was authored for <b>PoE2 " + escHtml(planPatch) +
    "</b>. Loading in <b>PoE2 " + escHtml(currentPatch) +
    "</b>: allocations referencing moved or removed nodes may have been dropped.</span>" +
    '<button class="wc-stale-dismiss" type="button" aria-label="Dismiss">×</button>';
  wizardHost.parentNode?.insertBefore(bar, wizardHost.nextSibling);
  bar.querySelector(".wc-stale-dismiss")?.addEventListener("click", () => bar.remove());
}

wizardHost.querySelectorAll<HTMLElement>(".wc-steps li").forEach(li => {
  li.addEventListener("click", () => {
    const step = li.dataset.step;
    if (step) goToStep(step);
  });
});

function goToStep(target: string): void {
  const targetStep = STEPS.find(s => s.id === target);
  if (!targetStep) return;
  if (target === currentStep) return;
  if (!plan.name) {
    flashSave("Set a build name first (sidebar → Identity)", true);
    return;
  }
  location.href = "/" + targetStep.file + "?build=" + encodeURIComponent(resolvedBuildId);
}
document.querySelectorAll<HTMLElement>("[data-step-link]").forEach(el => {
  const target = el.dataset.stepLink;
  if (!target) return;
  const targetStep = STEPS.find(s => s.id === target);
  if (!targetStep) return;
  if (el.tagName === "A") {
    (el as HTMLAnchorElement).href =
      "/" + targetStep.file + "?build=" + encodeURIComponent(resolvedBuildId);
  }
  el.addEventListener("click", e => {
    e.preventDefault();
    goToStep(target);
  });
});

refreshBuildName();
function refreshBuildName(): void {
  const el = document.getElementById("wc-buildname");
  if (!el) return;
  if (plan.name && plan.name.trim()) {
    el.textContent = plan.name.trim();
    el.classList.remove("placeholder");
  } else {
    el.textContent = "(untitled)";
    el.classList.add("placeholder");
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function persistDebounced(): void {
  flashSave("Saving…");
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    savePlan(resolvedBuildId, plan);
    flashSave("Saved");
    refreshBuildName();
  }, 250);
}
let flashTimer: ReturnType<typeof setTimeout> | null = null;
function flashSave(msg: string, isError?: boolean): void {
  const wrap = document.getElementById("wc-save-status");
  const m    = wrap && wrap.querySelector<HTMLElement>(".wc-save-msg");
  if (!wrap || !m) return;
  m.textContent = msg;
  wrap.classList.toggle("is-error", !!isError);
  wrap.hidden = false;
  // Auto-hide: routine confirmations clear fast, errors linger long
  // enough to read. A new flash resets the clock.
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { wrap.hidden = true; }, isError ? 7000 : 2500);
}

// -------------------------------------------------------------------
// Public API.
// -------------------------------------------------------------------
const api: PoE2PlanAPI = {
  buildId: () => resolvedBuildId,
  get: () => plan,
  set: (next: Plan) => { plan = normalizePlan(next); persistDebounced(); refreshBuildName(); },
  save: () => persistDebounced(),
  flash: (msg, isError) => flashSave(msg, isError),
  step: () => currentStep,
  reload: () => {
    plan = normalizePlan(loadPlan(resolvedBuildId) || plan);
    refreshBuildName();
    return plan;
  },

  // Section accessor — reads/writes the ACTIVE capture's section.
  data: {
    section: () => captureSection,
    effective: (section?: string) => effectiveAt((section ?? captureSection) as Section),
    commit: (next, section, meta) =>
      commitEffective((section ?? captureSection) as Section, next, meta),
  },
  // Explicit removal helper for the inline editor's trash icon.
  // propagateShareableMeta no longer implicitly clears notes (that
  // dropped data on re-allocation), so removals need a dedicated
  // sweep across captures.
  clearNoteEverywhere: (id) => clearNoteEverywhere(id),

  // Captures API — see docs/captures_data_model.md.
  captures: {
    list:        () => plan.captures.slice(),
    count:       () => plan.captures.length,
    active:      () => activeCapture(),
    activeIndex: () => plan.activeCapture,
    // True iff the given index (or the active capture, if no arg) is
    // the WORKING cap (last in the array). UI uses this to gate
    // snap/edit operations that only make sense on the working state,
    // not on a frozen historical snapshot.
    isWorking:   (idx) => isWorkingCapture(typeof idx === "number" ? idx : plan.activeCapture),
    setActive:   (idx) => setActiveCapture(idx),
    snapshotAt:  (level) => snapshotAt(level),
    remove:      (idx) => removeCapture(idx),
    setRange:       (idx, range) => setCaptureRange(idx, range),
    setName:        (idx, name)  => setCaptureName(idx, name),
    setDescription: (idx, text)  => setCaptureDescription(idx, text),
    setAscendancy:  (idx, asc)   => setCaptureAscendancy(idx, asc),
    diff:           (iA, iB)     => diffCaptures(iA, iB),
    pointBudgetFor: (cap)        => pointBudgetFor(cap),
    isFull:         (cap)        => isFull(cap),
  },
};
window.PoE2Plan = api;

function escHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c
  ));
}
