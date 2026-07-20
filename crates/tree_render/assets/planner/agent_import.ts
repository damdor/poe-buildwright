// ============================================================================
// === Agent-plan importer (#agent=<base64url JSON>) =========================
// ============================================================================
// The plug-and-play entry point for AI agents (see docs/agent-builds.md
// and /llms.txt): an agent writes a GOAL-ORIENTED plan — class,
// ascendancy, target notables/keystones by NAME, gems, gear — and this
// module materializes it into a normal local plan. The hard part agents
// can't do (connecting targets across a ~5000-node graph) happens here:
// a greedy nearest-first multi-source BFS allocates the shortest path
// from the growing build to each target, deterministically.
//
// Failure posture: forgiving. Unknown names are skipped and REPORTED
// (flash summary), malformed payloads flash an error and the planner
// boots normally. A bad link never breaks the page.
// ============================================================================
import { ASC_VARIANT_PARENT, state } from "./state.ts";
import { fitToView } from "./viewport.ts";
import { requestRender } from "./render.ts";
import { adj } from "./pathfind.ts";
import { loadPlanData } from "./build_io.ts";
import type { Allocation, Capture, Item, Plan, Skill, TreeNode } from "../../../../types/shared.d.ts";

interface AgentSkill { gem?: string; level?: number; supports?: string[]; note?: string; set?: "set1" | "set2" }
/** Gear entry. Either a `name` (a unique from item_catalogue, or
 *  freetext), or a grounded rare/magic spec: `base` from
 *  /assets/agent/bases.json + `rarity` + the few `mods` that matter.
 *  The importer composes these into the slot's display name + note. */
interface AgentGear {
  slot?: string;
  name?: string;
  socket?: number;
  base?: string;
  rarity?: string;                     // "rare" | "magic" | "normal"
  mods?: string[];                     // most-important-first affix wishes
  note?: string;
}
/** A target is a bare name/id, or an object carrying an author note
 *  ("take this before the Act 3 boss") that lands on the node as a
 *  planner note (visible on hover, numbered on the timeline). */
type AgentTarget = string | number | { node: string | number; note?: string; set?: "set1" | "set2" };
/** One leveling snapshot. Cumulative by default — each capture keeps
 *  the previous capture's passives and paths to its ADDITIONAL targets.
 *  `remove` is the normal PARTIAL respec: pull those nodes first (plus
 *  any travel nodes orphaned by the removal — same cascade the planner
 *  does), then path to the new targets. `respec: true` is the rare
 *  full-clear escape hatch. skills/gear: omitted = inherit previous
 *  capture's; provided = replace. */
interface AgentCapture {
  level?: number;                      // levels up to (inclusive); default 100
  name?: string;                       // short label ("L1-35: totems")
  notes?: string;
  remove?: AgentTarget[];              // partial respec: deallocate these, prune orphans
  respec?: boolean;                    // full reset (rare)
  targets?: AgentTarget[];
  skills?: AgentSkill[];
  gear?: AgentGear[];
}
export interface AgentPlan {
  format?: string;
  version?: number;
  name?: string;
  class?: string;
  ascendancy?: string;
  targets?: AgentTarget[];
  skills?: AgentSkill[];
  gear?: AgentGear[];
  captures?: AgentCapture[];           // multi-snapshot form; when present, top-level targets/skills/gear are ignored
  notes?: string;
}

function b64urlDecode(s: string): string | null {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "===".slice((b64.length + 3) % 4);
    // UTF-8-safe decode (mirror of the encode snippet in llms.txt).
    return decodeURIComponent(escape(atob(pad)));
  } catch { return null; }
}
function b64urlEncode(s: string): string {
  return btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Gem catalogue (shared by import validation + agent-link export).
interface CatGem {
  id: string; name: string; gem_type?: string;
  skill_types?: string[]; require_skill_types?: string[]; exclude_skill_types?: string[];
}
let _cat: { gems: CatGem[]; byName: Map<string, CatGem>; byId: Map<string, CatGem> } | null = null;
async function fetchGemCatalogue(): Promise<typeof _cat> {
  if (_cat) return _cat;
  try {
    const r = await fetch("/assets/skill_catalogue.json");
    if (!r.ok) return null;
    const d = await r.json() as { gems?: CatGem[] };
    const gems = d.gems ?? [];
    _cat = {
      gems,
      byName: new Map(gems.map(g => [g.name.toLowerCase(), g])),
      byId: new Map(gems.map(g => [g.id, g])),
    };
    return _cat;
  } catch { return null; }
}
function resolveGem(cat: NonNullable<typeof _cat>, nameOrId: string): CatGem | null {
  return cat.byId.get(nameOrId) ?? cat.byName.get(nameOrId.toLowerCase().trim()) ?? null;
}

/** Evaluate GGG's postfix skill-type expression against a type set.
 *  require/exclude_skill_types are NOT flat sets — they are RPN with
 *  literal "AND"/"OR"/"NOT" operator tokens (e.g. Abiding Hex's exclude
 *  ends [...,"NOT","AND"]). Plain values push `types.has(v)`; leftover
 *  stack values reduce with OR (GGG's Allowed/ExcludedActiveSkillTypes
 *  are ANY-match lists — Heft requires [Damage, Attack,
 *  CrossbowAmmoSkill] and no skill carries all three, so ALL-match
 *  over-filters). Both the naive set-membership check AND the ALL
 *  reduction were caught by the fresh-agent audit. */
export function evalTypeExpr(expr: string[] | undefined, types: Set<string>): boolean {
  if (!expr || expr.length === 0) return false;
  const st: boolean[] = [];
  for (const t of expr) {
    if (t === "AND") { const b = st.pop() ?? true;  const a = st.pop() ?? true;  st.push(a && b); }
    else if (t === "OR")  { const b = st.pop() ?? false; const a = st.pop() ?? false; st.push(a || b); }
    else if (t === "NOT") { st.push(!(st.pop() ?? false)); }
    else st.push(types.has(t));
  }
  return st.some(Boolean);
}

/** Can `sup` socket into an active gem with `activeTypes`?
 *  require: empty = no constraint, else ANY-match must hit.
 *  exclude: ANY-match blocks. */
export function supportCompatible(
  sup: { require_skill_types?: string[]; exclude_skill_types?: string[] },
  activeTypes: Set<string>,
): boolean {
  // An active with NO recorded types = compatibility unknown (a data
  // gap, not "supports nothing") — don't flag anything against it.
  if (activeTypes.size === 0) return true;
  const req = sup.require_skill_types;
  if (req && req.length > 0 && !evalTypeExpr(req, activeTypes)) return false;
  return !evalTypeExpr(sup.exclude_skill_types, activeTypes);
}

// ---------------------------------------------------------------
// Graph resolution — traversal uses the SAME adjacency the click
// pathfinder uses (pathfind's `adj`, built from edges_for_sel,
// which includes the class-hub spokes edges_meta drops for drawing).
// ---------------------------------------------------------------
interface Ctx {
  pathable: (id: string) => boolean;
  nameIdx: Map<string, string[]>;      // lowercased name → node ids
}
function buildCtx(asc: string | null): Ctx {
  // Pathable = everything except masteries (not allocatable), nodes of
  // an ascendancy other than the chosen one, and locked (Unseen-Path
  // style) nodes whose gate doesn't match the chosen asc.
  const pathable = (id: string): boolean => {
    const n = TREE.nodes[id] as (TreeNode & { a?: string; uc?: { a: string } }) | undefined;
    if (!n) return false;
    if (n.k === "mastery") return false;
    if (n.a && n.a !== asc) return false;
    if (n.uc && n.uc.a !== asc) return false;
    return true;
  };
  const nameIdx = new Map<string, string[]>();
  for (const id in TREE.nodes) {
    const n = TREE.nodes[id] as TreeNode & { n?: string };
    if (!n || !n.n || !pathable(id)) continue;
    const key = n.n.toLowerCase();
    (nameIdx.get(key) ?? nameIdx.set(key, []).get(key)!).push(id);
  }
  // Variant node names (Umbral Well, ...) resolve to their BASE node ids
  // on the parent panel.
  for (const v in (TREE.asc_variants ?? {})) {
    if (TREE.asc_variants![v]!.parent !== asc) continue;
    const nodes = TREE.asc_variants![v]!.nodes;
    for (const id in nodes) {
      const key = nodes[id]!.n.toLowerCase();
      (nameIdx.get(key) ?? nameIdx.set(key, []).get(key)!).push(id);
    }
  }
  return { pathable, nameIdx };
}

/** Multi-source BFS from `from` to the nearest of `goals`; returns the
 *  path (excluding sources, including the goal) or null. */
function bfsNearest(ctx: Ctx, from: Set<string>, goals: Set<string>): string[] | null {
  const prev = new Map<string, string | null>();
  const queue: string[] = [];
  for (const s of from) { prev.set(s, null); queue.push(s); }
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++]!;
    if (goals.has(cur) && !from.has(cur)) {
      const path: string[] = [];
      let walk: string | null = cur;
      while (walk && !from.has(walk)) { path.push(walk); walk = prev.get(walk) ?? null; }
      return path.reverse();
    }
    for (const nb of adj.get(cur) ?? []) {
      if (!prev.has(nb) && ctx.pathable(nb)) { prev.set(nb, cur); queue.push(nb); }
    }
  }
  return null;
}

// ---------------------------------------------------------------
// Import
// ---------------------------------------------------------------
async function runImport(payload: string): Promise<void> {
  const raw = b64urlDecode(payload);
  let plan: AgentPlan | null = null;
  try { plan = raw ? JSON.parse(raw) as AgentPlan : null; } catch { /* reported below */ }
  if (!plan || plan.format !== "poe2-agent-plan") {
    window.PoE2Plan?.flash("Agent link was malformed — started a blank build instead", true);
    return;
  }
  await importAgentPlan(plan);
}

/** Materialize a decoded agent plan into the current build. Shared by
 *  the #agent= fragment path and the ?live= channel (live_channel).
 *  Returns a short human summary, or null if the plan was unusable. */
export async function importAgentPlan(plan: AgentPlan): Promise<string | null> {
  const problems: string[] = [];

  // Class: ground against TREE.classes (fuzzy: case-insensitive).
  const klassIn = (plan.class || "").trim();
  const klass = TREE.classes.find(c => c.name.toLowerCase() === klassIn.toLowerCase())?.name;
  if (!klass) {
    window.PoE2Plan?.flash(
      "Agent link: unknown class '" + klassIn + "' — started a blank build", true);
    return null;
  }
  // Ascendancy: must belong to the class (asc_panels keys are names;
  // the meta carries class per asc via TREE.asc_meta if present — fall
  // back to accepting any known panel name).
  let asc: string | null = null;        // persisted name (variant wins)
  let ascPanel: string | null = null;   // engine/pathing panel (parent)
  if (plan.ascendancy) {
    const want = plan.ascendancy.trim().toLowerCase();
    const names = [...Object.keys(TREE.asc_panels), ...Object.keys(TREE.asc_variants ?? {})];
    const match = names.find(a => a.toLowerCase() === want);
    if (match) {
      asc = match;
      ascPanel = ASC_VARIANT_PARENT[match] ?? match;
    } else problems.push("ascendancy '" + plan.ascendancy + "' not found");
  }

  const ctx = buildCtx(ascPanel);

  // Start: the chosen class's start hub — pathing begins at its
  // neighbours (the hub itself isn't an allocation).
  const hub = Object.keys(TREE.nodes).find(id => {
    const n = TREE.nodes[id] as TreeNode & { kl?: string };
    return n?.k === "class_start" && (n.kl || "").split("|").includes(klass);
  });
  if (!hub) {
    window.PoE2Plan?.flash("Agent link: no start hub for class " + klass, true);
    return null;
  }

  const ascStart = ascPanel
    ? Object.keys(TREE.nodes).find(id => {
        const n = TREE.nodes[id] as TreeNode & { a?: string };
        return n?.k === "asc_start" && n.a === ascPanel;
      })
    : null;

  // Resolve one capture's targets → goal sets (numeric id, name, or
  // {node, note} objects; a name shared by several copies resolves to
  // ALL of them and BFS picks the nearest).
  const resolveTargets = (targets: AgentTarget[] | undefined) => {
    const goalSets: { label: string; ids: Set<string>; note?: string; set?: "set1" | "set2" }[] = [];
    for (const raw of targets ?? []) {
      const isObj = typeof raw === "object" && raw !== null;
      const t = isObj ? (raw as { node: string | number }).node : raw;
      const note = isObj ? (raw as { note?: string }).note : undefined;
      const set = isObj ? (raw as { set?: "set1" | "set2" }).set : undefined;
      if (typeof t === "number" || /^\d+$/.test(String(t))) {
        const id = String(t);
        if (TREE.nodes[id]) goalSets.push({ label: id, ids: new Set([id]), note, set });
        else problems.push("target id " + id + " not found");
        continue;
      }
      const ids = ctx.nameIdx.get(String(t).toLowerCase().trim());
      if (ids && ids.length) goalSets.push({ label: String(t), ids: new Set(ids), note, set });
      else problems.push("target '" + t + "' not found");
    }
    return goalSets;
  };

  // Greedy nearest-first pathing from an existing allocation set;
  // mutates `allocated`, returns per-node notes for reached goals.
  const pathTargets = (
    allocated: Set<string>,
    goalSets: { label: string; ids: Set<string>; note?: string; set?: "set1" | "set2" }[],
  ): { notes: Map<string, string>; sets: Map<string, "set1" | "set2"> } => {
    const notes = new Map<string, string>();
    const sets = new Map<string, "set1" | "set2">();
    const remaining = goalSets.slice();
    while (remaining.length) {
      let best: { idx: number; path: string[] } | null = null;
      for (let i = 0; i < remaining.length; i++) {
        const path = bfsNearest(ctx, allocated, remaining[i]!.ids);
        if (path && (!best || path.length < best.path.length)) best = { idx: i, path };
      }
      if (!best) {
        for (const r of remaining) problems.push("target '" + r.label + "' unreachable");
        break;
      }
      for (const id of best.path) allocated.add(id);
      const goal = best.path[best.path.length - 1];
      const note = remaining[best.idx]!.note;
      if (goal && note) notes.set(goal, note);
      const setTag = remaining[best.idx]!.set;
      if (goal && setTag) sets.set(goal, setTag);
      remaining.splice(best.idx, 1);
    }
    return { notes, sets };
  };

  // Skills: ground gem names against the catalogue — resolve to the
  // canonical gem id (what the skills UI + .build export key on) and
  // VALIDATE support compatibility (require ⊆ active's skill_types,
  // exclude ∩ = ∅) so an agent's invalid pairing is called out rather
  // than silently kept. Catalogue fetch is best-effort: without it,
  // names pass through as-is and the UI still renders them.
  const cat = await fetchGemCatalogue();
  const buildSkills = (list: AgentSkill[] | undefined): Skill[] => {
    const skills: Skill[] = [];
    for (const s of list ?? []) {
      if (!s.gem) continue;
      const active = cat ? resolveGem(cat, s.gem) : null;
      if (cat && !active) problems.push("gem '" + s.gem + "' not found");
      const activeTypes = new Set(active?.skill_types ?? []);
      const supports: { id: string; level: number; quality: number; note: string }[] = [];
      for (const supName of (s.supports ?? []).slice(0, 5)) {
        const sup = cat ? resolveGem(cat, supName) : null;
        if (cat && !sup) { problems.push("support '" + supName + "' not found"); continue; }
        if (sup && active && !supportCompatible(sup, activeTypes)) {
          problems.push("support '" + supName + "' incompatible with '" + s.gem + "'");
        }
        supports.push({ id: sup?.id ?? supName, level: 1, quality: 0, note: "" });
      }
      if ((s.supports ?? []).length > 5) problems.push("'" + s.gem + "': max 5 supports (extra dropped)");
      skills.push({
        id: active?.id ?? s.gem,
        level: typeof s.level === "number" ? s.level : 1,
        quality: 0,
        // Weapon-set binding: the skill is used while that weapon set
        // is equipped; set-tagged tree nodes swap in alongside it.
        set: s.set === "set1" || s.set === "set2" ? s.set : "main",
        note: s.note ?? "",
        supports,
      } as unknown as Skill);
    }
    return skills;
  };
  // Gear: accept item_catalogue slot vocabulary as aliases (agents copy
  // slots straight from the uniques data — bow/mace/... are weapons,
  // shield/focus/quiver are offhands). A taken slot bumps to its pair
  // (weapon1→weapon2, ring1→ring2, ...).
  const SLOT_ALIAS: Record<string, string> = {
    bow: "weapon1", crossbow: "weapon1", mace: "weapon1", sceptre: "weapon1",
    spear: "weapon1", staff: "weapon1", wand: "weapon1", talisman: "amulet",
    shield: "offhand1", focus: "offhand1", quiver: "offhand1",
    ring: "ring1", weapon: "weapon1", offhand: "offhand1",
  };
  const BUMP: Record<string, string> = { weapon1: "weapon2", offhand1: "offhand2", ring1: "ring2" };
  const buildGear = (list: AgentGear[] | undefined): Item[] => {
    const items: Item[] = [];
    const takenSlots = new Set<string>();
    for (const g of list ?? []) {
      // Grounded rare/magic spec → compose "<Rarity> <Base>". Rarity
      // follows the game's mod-count floor: 3+ mods make an item rare
      // no matter what the plan said; 1-2 mods can't be normal. A
      // stated rarity ABOVE the floor stands ("rare, these 2 priority
      // mods" is how guides talk).
      let name = g.name;
      const note = g.note;
      let rarity: string | undefined;
      if (!name && g.base) {
        let rar = (g.rarity || "rare").toLowerCase();
        const n = (g.mods ?? []).length;
        if (n > 2) rar = "rare";
        else if (n > 0 && rar === "normal") rar = "magic";
        rarity = rar;
        name = rar === "normal"
          ? g.base
          : rar.charAt(0).toUpperCase() + rar.slice(1) + " " + g.base;
      }
      if (!g.slot || !name) continue;
      let slot = SLOT_ALIAS[g.slot.toLowerCase().trim()] ?? g.slot.toLowerCase().trim();
      // Jewels are multi-instance (one per tree socket) — every other
      // slot is single-occupancy (with the weapon/ring bump).
      if (slot !== "jewel") {
        if (takenSlots.has(slot) && BUMP[slot]) slot = BUMP[slot]!;
        if (takenSlots.has(slot)) { problems.push("gear slot '" + g.slot + "' already filled"); continue; }
        takenSlots.add(slot);
      }
      const it: Item = { slot, name };
      if (slot === "jewel" && typeof g.socket === "number") it.socket = g.socket;
      // Keep the grounded pieces — the gear strip resolves base art,
      // rarity color and mods-hover from them.
      if (g.base) it.base = g.base;
      if (rarity) it.rarity = rarity;
      if (g.mods?.length) it.mods = g.mods.slice();
      if (note) it.note = note;
      items.push(it);
    }
    return items;
  };

  // Capture loop. v1 plans (top-level targets/skills/gear) become one
  // capture; v2 plans walk captures[] cumulatively — each keeps the
  // previous allocation and paths to its additional targets, unless
  // `respec: true` restarts the tree from the class hub (the
  // level-as-X-then-rebuild pattern). Per-target notes land as planner
  // node-notes on the reached copy.
  const capsIn: AgentCapture[] = plan.captures?.length
    ? plan.captures
    : [{ level: 100, targets: plan.targets, skills: plan.skills, gear: plan.gear }];
  const roots = (): Set<string> => {
    const s = new Set<string>([hub]);
    if (ascStart) s.add(ascStart);
    return s;
  };
  // Partial respec: deallocate the given nodes, then prune everything
  // no longer connected to the roots — the same cascade the planner's
  // right-click dealloc applies, so the timeline diff reads naturally.
  const removeAndPrune = (carry: Set<string>, removeList: AgentTarget[]): void => {
    for (const raw2 of removeList) {
      const t = typeof raw2 === "object" && raw2 !== null ? raw2.node : raw2;
      const ids = (typeof t === "number" || /^\d+$/.test(String(t)))
        ? [String(t)]
        : ctx.nameIdx.get(String(t).toLowerCase().trim()) ?? [];
      const hit = ids.find(id => carry.has(id));
      if (hit) carry.delete(hit);
      else problems.push("remove target '" + String(t) + "' wasn't allocated");
    }
    // Keep only what's still reachable from the roots THROUGH carry.
    const keep = new Set<string>();
    const q = [...roots()].filter(id => carry.has(id));
    for (const r of q) keep.add(r);
    let qi = 0;
    while (qi < q.length) {
      for (const nb of adj.get(q[qi++]!) ?? []) {
        if (carry.has(nb) && !keep.has(nb)) { keep.add(nb); q.push(nb); }
      }
    }
    for (const id of [...carry]) if (!keep.has(id)) carry.delete(id);
  };

  let carry = roots();
  let prevSkills: Skill[] = [];
  let prevItems: Item[] = [];
  let prevHi = 0;
  const captures: Capture[] = [];
  let totalPoints = 0;
  for (let i = 0; i < capsIn.length; i++) {
    const c = capsIn[i]!;
    if (c.respec) carry = roots();
    else if (c.remove?.length) removeAndPrune(carry, c.remove);
    const { notes: noteById, sets: setById } = pathTargets(carry, resolveTargets(c.targets));
    const passives: Allocation[] = [...carry]
      .filter(id => id !== hub && id !== ascStart)
      .map(id => {
        // Weapon-set tag applies to the TARGET node itself (its travel
        // stays main — matching how swap-builds actually allocate).
        const a: Allocation = { id, set: setById.get(id) ?? ("main" as const) };
        const note = noteById.get(id);
        if (note) a.note = note;
        return a;
      });
    totalPoints = Math.max(totalPoints, passives.length);
    const skills = c.skills !== undefined ? buildSkills(c.skills) : prevSkills;
    const items = c.gear !== undefined ? buildGear(c.gear) : prevItems;
    prevSkills = skills;
    prevItems = items;
    const hi = typeof c.level === "number" && c.level > prevHi ? Math.min(c.level, 100) : Math.min(prevHi + 10, 100);
    captures.push({
      id: "agent-" + (i + 1),
      levelRange: [prevHi + 1, i === capsIn.length - 1 ? 100 : hi],
      name: c.name || null,
      passives,
      skills,
      items,
      ascendancy: asc,
      description: c.notes || "",
    });
    prevHi = hi;
  }

  const full: Plan = {
    name: plan.name || "Agent build",
    description: plan.notes || "",
    class: klass,
    patch: null,
    captures,
    activeCapture: captures.length - 1,
  };
  loadPlanData(full);
  // PoE2Plan.set (inside loadPlanData) persists but does NOT emit the
  // capture-change event — the skills/gear strips would render stale
  // without this.
  window.dispatchEvent(new CustomEvent("poe2-capture-change", { detail: { reason: "agent-import" } }));
  fitToView();
  requestRender();

  const last = captures[captures.length - 1]!;
  const summary =
    "Agent build imported: " + last.passives.length + " passives" +
    (captures.length > 1 ? " across " + captures.length + " snapshots" : "") +
    ", " + last.skills.length + " skills, " + last.items.length + " gear slots" +
    (problems.length ? " — " + problems.length + " unresolved: " + problems.slice(0, 3).join("; ") : "");
  window.PoE2Plan?.flash(summary, problems.length > 0);
  // Machine-readable import result: browser agents shouldn't have to
  // scrape the flash toast or the sidebar DOM to learn what happened.
  // Stable contract: <script id="poe2-agent-import-result"
  // type="application/json"> holding the same facts as the summary.
  {
    const blob = {
      ok: problems.length === 0,
      passives: last.passives.length,
      skills: last.skills.length,
      gear: last.items.length,
      snapshots: captures.length,
      class: klass,
      ascendancy: asc,
      unresolved: problems,
    };
    let el = document.getElementById("poe2-agent-import-result") as HTMLScriptElement | null;
    if (!el) {
      el = document.createElement("script");
      el.id = "poe2-agent-import-result";
      el.type = "application/json";
      document.body.appendChild(el);
    }
    el.textContent = JSON.stringify(blob);
  }
  // eslint-disable-next-line no-console
  if (problems.length) console.warn("[agent-import] unresolved:", problems);
  return summary;
}

// Boot: pick the payload out of the fragment once the chrome is up
// (loadPlanData needs window.PoE2Plan). Clear the hash after import so
// reloads don't re-import over the user's edits.
const m = /[#&]agent=([A-Za-z0-9_-]+)/.exec(location.hash);
// Plain-JSON variant: #plan=<url-encoded agent-plan JSON>. Chat
// assistants without tools can't gzip+base64, but they CAN write a
// URL — this makes "paste this link" a working build handoff.
const mj = /[#&]plan=([^&]+)/.exec(location.hash);
if (m || mj) {
  const tryRun = (): void => {
    if (window.PoE2Plan && state.geomReady) {
      if (m) {
        void runImport(m[1]!);
      } else {
        let plan: AgentPlan | null = null;
        try { plan = JSON.parse(decodeURIComponent(mj![1]!)) as AgentPlan; } catch { /* flash below */ }
        if (plan && plan.format === "poe2-agent-plan") void importAgentPlan(plan);
        else window.PoE2Plan?.flash("#plan= link was malformed — started a blank build instead", true);
      }
      history.replaceState(null, "", location.pathname + location.search);
    } else {
      setTimeout(tryRun, 150);
    }
  };
  tryRun();
}

// ---------------------------------------------------------------
// Export: current build → agent-plan URL (the READ direction — lets
// an agent inspect a human's build, or a human round-trip an agent's).
// Targets are the allocated notables/keystones only; travel nodes are
// re-derived on import, so the link stays small and intent-shaped.
// ---------------------------------------------------------------
export async function copyAgentLink(): Promise<void> {
  const cat = await fetchGemCatalogue();
  // Name-uniqueness map so targets export as readable names where
  // unambiguous, numeric ids where a name has copies.
  const nameCount = new Map<string, number>();
  for (const id in TREE.nodes) {
    const n = TREE.nodes[id] as TreeNode & { n?: string };
    if (n?.n) nameCount.set(n.n, (nameCount.get(n.n) ?? 0) + 1);
  }
  const targets: (string | number)[] = [];
  for (const id of state.selected.keys()) {
    const n = TREE.nodes[id] as (TreeNode & { n?: string }) | undefined;
    if (!n || !["notable", "keystone", "asc_notable"].includes(n.k)) continue;
    targets.push(n.n && nameCount.get(n.n) === 1 ? n.n : Number(id));
  }
  const cap = window.PoE2Plan?.captures.active();
  const gemName = (id: string): string => (cat ? resolveGem(cat, id)?.name ?? id : id);
  const skills = (cap?.skills ?? []).map(s => {
    const entry: AgentSkill = { gem: gemName(s.id) };
    if (s.level && s.level !== 1) entry.level = s.level;
    const sups = (s.supports ?? []).map(x => gemName(x.id));
    if (sups.length) entry.supports = sups;
    return entry;
  });
  const gear = (cap?.items ?? [])
    .filter(it => it.slot && it.name)
    .map(it => {
      const g: AgentGear = { slot: it.slot!, name: it.name! };
      if (it.note) g.note = it.note;
      return g;
    });
  const plan: AgentPlan = {
    format: "poe2-agent-plan",
    version: 1,
    name: (document.getElementById("build-name") as HTMLInputElement | null)?.value || "Untitled",
    class: state.klass || undefined,
    ascendancy: state.asc || undefined,
    targets,
    skills,
    gear,
    notes: (document.getElementById("build-description") as HTMLTextAreaElement | null)?.value || undefined,
  };
  const url = location.origin + "/planner.html#agent=" + b64urlEncode(JSON.stringify(plan));
  try {
    await navigator.clipboard.writeText(url);
    window.PoE2Plan?.flash("Agent link copied (" + targets.length + " targets, " + url.length + " chars)");
  } catch {
    prompt("Copy the agent link:", url);
  }
}
