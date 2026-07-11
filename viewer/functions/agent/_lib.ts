// Shared engine for the agent endpoints (/agent/validate and
// /agent/build). The leading underscore keeps Cloudflare Pages from
// routing this file — it is imported by the two endpoint modules.
//
// Everything here is pure static-asset compute: the graph, catalogues
// and bases are read through the deployment's own ASSETS binding, so
// any deploy of this project validates against exactly the data it
// serves.

export interface AssetsLite { fetch(req: Request | string): Promise<Response> }
export interface Env { ASSETS: AssetsLite }
export interface PagesCtx { request: Request; env: Env }

export interface Graph {
  classes: Record<string, number>;
  asc_starts: Record<string, number>;
  nodes: Record<string, { k: string; n?: string; a?: string; uc?: string }>;
  edges: [number, number][];
}
export type Target = string | number | { node: string | number; note?: string };
export interface AgentGearIn { slot?: string; name?: string; base?: string; rarity?: string; mods?: string[]; note?: string }
export interface AgentCapture { level?: number; name?: string; notes?: string; respec?: boolean; remove?: Target[]; targets?: Target[]; skills?: AgentSkillIn[]; gear?: AgentGearIn[] }
export interface AgentSkillIn { gem?: string; level?: number; supports?: string[]; note?: string }
export interface AgentPlanIn {
  format?: string; name?: string; notes?: string; description?: string; class?: string; ascendancy?: string;
  targets?: Target[]; skills?: AgentSkillIn[]; gear?: AgentGearIn[]; captures?: AgentCapture[];
}
export interface CatGem { id: string; name: string; skill_types?: string[]; require_skill_types?: string[]; exclude_skill_types?: string[]; req_level?: number; natural_max_level?: number }

export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/** Every agent endpoint responds JSON — success, failure, or garbage
 *  in. An HTML response from these routes is by definition a broken
 *  deployment (this was the top item of the first agent audit). */
export function out(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 1), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}

export function b64urlDecode(s: string): string | null {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "===".slice((b64.length + 3) % 4);
    return decodeURIComponent(escape(atob(pad)));
  } catch { return null; }
}

export function b64urlEncode(s: string): string {
  return btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Same RPN evaluator as the in-browser importer (agent_import.ts).
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

/** Parse the plan from a request (POST body or ?plan= b64url). */
export async function readPlan(req: Request): Promise<AgentPlanIn | null> {
  let raw: string | null = null;
  if (req.method === "POST") raw = await req.text();
  else {
    const p = new URL(req.url).searchParams.get("plan");
    raw = p ? b64urlDecode(p) : null;
  }
  try {
    const plan = raw ? JSON.parse(raw) as AgentPlanIn : null;
    return plan && plan.format === "poe2-agent-plan" ? plan : null;
  } catch { return null; }
}

export interface CapReport {
  points: number;
  asc_points: number;
  resolved: number;
  unresolved: string[];
  allocated_notables: string[];
  /** Per-target marginal cost the greedy router charged — "target X
   *  added about N points". 0 = subsumed by an earlier target's path. */
  target_costs: { target: string; added_points: number }[];
  /** Every ascendancy node allocated (including auto-pathed travel
   *  nodes) — explains why asc_points can exceed the targeted count. */
  asc_allocated: string[];
}

/** One capture's machine-usable state beyond the human report:
 *  the exact allocated node ids (for Plan construction) and the
 *  marginal path cost the greedy router charged each target (for
 *  budget repair hints). nodeId/note let /agent/build re-attach
 *  target annotations to the resolved allocation. */
export interface CapDetail {
  allocated: string[];
  targetCosts: { target: string; points: number; nodeId: string | null; note?: string }[];
}

/** Machine-readable diagnostic mirroring an entry-level failure —
 *  agents branch on `code`, humans read `message`. */
export interface Diagnostic {
  code: string;
  severity: "error" | "warning";
  message: string;
  [extra: string]: unknown;
}

export interface ValidationResult {
  report: Record<string, unknown>;  // the JSON body /agent/validate returns
  ok: boolean;
  klass: string | null;
  asc: string | null;
  capReports: CapReport[];
  capDetails: CapDetail[];
  catalogue: CatGem[];
}

const MAIN_CAP = 99;

/** Run the full resolution + pathing + grounding validation. This is
 *  the exact engine /agent/validate exposes; /agent/build reuses it
 *  and then constructs the importable plan from capDetails. */
export async function runValidation(
  plan: AgentPlanIn,
  assets: AssetsLite,
  origin: string,
): Promise<ValidationResult> {
  const fail = (report: Record<string, unknown>): ValidationResult =>
    ({ report, ok: false, klass: null, asc: null, capReports: [], capDetails: [], catalogue: [] });

  // ---- Load the graph + gem catalogue from our own static assets ----
  const gRes = await assets.fetch(origin + "/assets/agent/graph.json");
  if (!gRes.ok) return fail({ ok: false, error: "graph data unavailable on this deployment" });
  const graph = await gRes.json() as Graph;
  let cat: CatGem[] = [];
  try {
    const cRes = await assets.fetch(origin + "/assets/skill_catalogue.json");
    if (cRes.ok) cat = ((await cRes.json()) as { gems?: CatGem[] }).gems ?? [];
  } catch { /* gem checks degrade */ }

  const problems: string[] = [];

  // ---- Class / ascendancy ----
  const klass = Object.keys(graph.classes).find(c => c.toLowerCase() === (plan.class || "").toLowerCase().trim());
  if (!klass) {
    return fail({ ok: false, error: "unknown class '" + plan.class + "'", classes: Object.keys(graph.classes) });
  }
  const hub = String(graph.classes[klass]);
  let asc: string | null = null;
  if (plan.ascendancy) {
    asc = Object.keys(graph.asc_starts).find(a => a.toLowerCase() === plan.ascendancy!.toLowerCase().trim()) ?? null;
    if (!asc) problems.push("ascendancy '" + plan.ascendancy + "' not found");
  }
  const ascStart = asc ? String(graph.asc_starts[asc]) : null;

  // ---- Adjacency + name index over the pathable set ----
  const pathable = (id: string): boolean => {
    const n = graph.nodes[id];
    if (!n) return false;
    if (n.a && n.a !== asc) return false;
    if (n.uc && n.uc !== asc) return false;
    return true;
  };
  const adj = new Map<string, string[]>();
  for (const [a, b] of graph.edges) {
    const sa = String(a), sb = String(b);
    (adj.get(sa) ?? adj.set(sa, []).get(sa)!).push(sb);
    (adj.get(sb) ?? adj.set(sb, []).get(sb)!).push(sa);
  }
  const nameIdx = new Map<string, string[]>();
  for (const id in graph.nodes) {
    const n = graph.nodes[id]!;
    if (!n.n || !pathable(id)) continue;
    const k = n.n.toLowerCase();
    (nameIdx.get(k) ?? nameIdx.set(k, []).get(k)!).push(id);
  }
  const bfsNearest = (from: Set<string>, goals: Set<string>): string[] | null => {
    const prev = new Map<string, string | null>();
    const q: string[] = [];
    for (const s of from) { prev.set(s, null); q.push(s); }
    let qi = 0;
    while (qi < q.length) {
      const cur = q[qi++]!;
      if (goals.has(cur) && !from.has(cur)) {
        const path: string[] = [];
        let w: string | null = cur;
        while (w && !from.has(w)) { path.push(w); w = prev.get(w) ?? null; }
        return path.reverse();
      }
      for (const nb of adj.get(cur) ?? []) {
        if (!prev.has(nb) && pathable(nb)) { prev.set(nb, cur); q.push(nb); }
      }
    }
    return null;
  };

  // ---- Captures (same cumulative/respec semantics as the importer) ----
  const capsIn: AgentCapture[] = plan.captures?.length
    ? plan.captures
    : [{ targets: plan.targets, skills: plan.skills }];
  const roots = (): Set<string> => {
    const s = new Set<string>([hub]);
    if (ascStart) s.add(ascStart);
    return s;
  };
  let carry = roots();
  const capReports: CapReport[] = [];
  const capDetails: CapDetail[] = [];
  for (const c of capsIn) {
    if (c.respec) carry = roots();
    else if (c.remove?.length) {
      // Partial respec: deallocate + orphan-prune (mirror the importer).
      for (const raw2 of c.remove) {
        const t = typeof raw2 === "object" && raw2 !== null ? raw2.node : raw2;
        const ids = (typeof t === "number" || /^\d+$/.test(String(t)))
          ? [String(t)]
          : nameIdx.get(String(t).toLowerCase().trim()) ?? [];
        const hit = ids.find(id => carry.has(id));
        if (hit) carry.delete(hit);
        else problems.push("remove target '" + String(t) + "' wasn't allocated");
      }
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
    }
    const unresolved: string[] = [];
    const goals: { label: string; ids: Set<string>; note?: string }[] = [];
    for (const raw2 of c.targets ?? []) {
      const isObj = typeof raw2 === "object" && raw2 !== null;
      const t = isObj ? raw2.node : raw2;
      const note = isObj ? raw2.note : undefined;
      if (typeof t === "number" || /^\d+$/.test(String(t))) {
        const id = String(t);
        if (graph.nodes[id]) goals.push({ label: id, ids: new Set([id]), note });
        else unresolved.push(String(t));
        continue;
      }
      const ids = nameIdx.get(String(t).toLowerCase().trim());
      if (ids && ids.length) goals.push({ label: String(t), ids: new Set(ids), note });
      else unresolved.push(String(t));
    }
    // Greedy nearest-target routing. The path each target gets charged
    // is its MARGINAL cost given everything routed before it — exactly
    // the "removing this saves ~N points" number repair hints need.
    // The path's final node IS the goal copy that got picked; keep it
    // so target notes can be re-attached to the resolved allocation.
    const targetCosts: { target: string; points: number; nodeId: string | null; note?: string }[] = [];
    const remaining = goals.slice();
    while (remaining.length) {
      // A target already swallowed by an earlier target's path is
      // RESOLVED at zero marginal cost, not unreachable.
      for (let i = remaining.length - 1; i >= 0; i--) {
        const hit = [...remaining[i]!.ids].find(id => carry.has(id));
        if (hit) {
          targetCosts.push({ target: remaining[i]!.label, points: 0, nodeId: hit, note: remaining[i]!.note });
          remaining.splice(i, 1);
        }
      }
      if (!remaining.length) break;
      let best: { idx: number; path: string[] } | null = null;
      for (let i = 0; i < remaining.length; i++) {
        const path = bfsNearest(carry, remaining[i]!.ids);
        if (path && (!best || path.length < best.path.length)) best = { idx: i, path };
      }
      if (!best) { for (const r of remaining) unresolved.push(r.label + " (unreachable)"); break; }
      for (const id of best.path) carry.add(id);
      targetCosts.push({
        target: remaining[best.idx]!.label,
        points: best.path.length,
        nodeId: best.path[best.path.length - 1] ?? null,
        note: remaining[best.idx]!.note,
      });
      remaining.splice(best.idx, 1);
    }
    let points = 0, ascPoints = 0;
    for (const id of carry) {
      if (id === hub || id === ascStart) continue;
      if (graph.nodes[id]?.a) ascPoints++;
      else points++;
    }
    // Structured "sight": the notables/keystones the USER will actually
    // see allocated for this snapshot — lets a text-only agent verify
    // the rendered outcome (including nearest-copy picks) without eyes.
    const allocatedNotables: string[] = [];
    for (const id of carry) {
      const n = graph.nodes[id];
      if (n && (n.k === "notable" || n.k === "keystone" || n.k === "asc_notable") && n.n) {
        allocatedNotables.push(n.n + (n.a ? " (asc)" : ""));
      }
    }
    allocatedNotables.sort();
    // Ascendancy breakdown: every asc node the pathing allocated,
    // including auto-pathed travel nodes — the answer to "I targeted
    // 2 asc notables, why 6 asc points?"
    const ascAllocated: string[] = [];
    for (const id of carry) {
      if (id === ascStart) continue;
      const n = graph.nodes[id];
      if (n?.a) ascAllocated.push(n.n ?? id);
    }
    ascAllocated.sort();
    capReports.push({
      points, asc_points: ascPoints, resolved: goals.length, unresolved,
      allocated_notables: allocatedNotables,
      target_costs: targetCosts.map(t => ({ target: t.target, added_points: t.points })),
      asc_allocated: ascAllocated,
    });
    capDetails.push({ allocated: [...carry].filter(id => id !== hub && id !== ascStart), targetCosts });
  }

  // ---- Leveling realism: per-capture gem/gear availability ----
  const byNameL = new Map(cat.map(g => [g.name.toLowerCase(), g]));
  let baseLvl = new Map<string, number>();
  try {
    const bRes = await assets.fetch(origin + "/assets/agent/bases.json");
    if (bRes.ok) {
      const bd = await bRes.json() as { bases?: { name: string; lvl?: number }[] };
      baseLvl = new Map((bd.bases ?? []).map(b => [b.name.toLowerCase(), b.lvl ?? 0]));
    }
  } catch { /* degrade */ }
  const levelingProblems: string[] = [];
  for (let ci = 0; ci < capsIn.length; ci++) {
    const c = capsIn[ci]!;
    const lvl = typeof c.level === "number" ? c.level : 100;
    const tag = "capture " + (ci + 1) + " (level " + lvl + ")";
    for (const sk of c.skills ?? []) {
      const names = [sk.gem, ...(sk.supports ?? [])];
      for (const nm of names) {
        if (!nm) continue;
        const g = byNameL.get(nm.toLowerCase());
        if (g?.req_level && g.req_level > lvl) {
          levelingProblems.push(tag + ": '" + nm + "' requires level " + g.req_level);
        }
      }
      if (typeof sk.level === "number" && sk.level > lvl) {
        levelingProblems.push(tag + ": gem level " + sk.level + " exceeds character level");
      }
    }
    for (const g of c.gear ?? []) {
      if (g.base) {
        const bl = baseLvl.get(g.base.toLowerCase());
        if (bl && bl > lvl) {
          levelingProblems.push(tag + ": base '" + g.base + "' drops at level " + bl);
        }
      }
    }
  }

  // ---- Gem checks ----
  const byName = new Map(cat.map(g => [g.name.toLowerCase(), g]));
  const byId = new Map(cat.map(g => [g.id, g]));
  const gemProblems: string[] = [];
  const allSkills: AgentSkillIn[] = capsIn.flatMap(c => c.skills ?? []);
  for (const s of allSkills) {
    if (!s.gem) continue;
    const active = byId.get(s.gem) ?? byName.get(s.gem.toLowerCase());
    if (cat.length && !active) { gemProblems.push("gem '" + s.gem + "' not found"); continue; }
    const types = new Set(active?.skill_types ?? []);
    for (const supName of s.supports ?? []) {
      const sup = byId.get(supName) ?? byName.get(supName.toLowerCase());
      if (cat.length && !sup) { gemProblems.push("support '" + supName + "' not found"); continue; }
      if (sup && types.size > 0) {  // empty types = compat unknown, allow
        const req = sup.require_skill_types;
        const bad = (req && req.length > 0 && !evalTypeExpr(req, types)) || evalTypeExpr(sup.exclude_skill_types, types);
        if (bad) gemProblems.push("support '" + supName + "' incompatible with '" + s.gem + "'");
      }
    }
  }

  // ---- Gear grounding: bases strictly, unique-looking names softly ----
  const gearProblems: string[] = [];
  const allGear: AgentGearIn[] = [
    ...(plan.gear ?? []),
    ...capsIn.flatMap(c => c.gear ?? []),
  ];
  if (allGear.length) {
    let baseNames = new Set<string>();
    let uniqueNames = new Set<string>();
    try {
      const bRes = await assets.fetch(origin + "/assets/agent/bases.json");
      if (bRes.ok) {
        const bd = await bRes.json() as { bases?: { name: string }[] };
        baseNames = new Set((bd.bases ?? []).map(b => b.name.toLowerCase()));
      }
      const uRes = await assets.fetch(origin + "/assets/item_catalogue.json");
      if (uRes.ok) {
        const ud = await uRes.json() as { uniques?: { name: string }[] };
        uniqueNames = new Set((ud.uniques ?? []).map(u => u.name.toLowerCase()));
      }
    } catch { /* grounding degrades */ }
    for (const g of allGear) {
      if (g.base && baseNames.size && !baseNames.has(g.base.toLowerCase())) {
        gearProblems.push("gear base '" + g.base + "' not found in bases.json");
      }
      // A short TitleCase name that isn't a known unique is probably a
      // misspelled unique (freetext descriptions are longer/lowercase).
      if (g.name && uniqueNames.size && !uniqueNames.has(g.name.toLowerCase())
          && g.name.length < 30 && !/\b(any|with|rare|magic)\b/i.test(g.name)) {
        gearProblems.push("gear name '" + g.name + "' is not a known unique (freetext is allowed; check spelling if a unique was intended)");
      }
      // Rarity follows mod count: 3+ mods = rare, 1-2 mods = at least
      // magic, 0 mods = normal is fine. Stating a rarity ABOVE the
      // floor is fine ("rare, these 2 priority mods").
      if (g.base && g.rarity) {
        const n = (g.mods ?? []).length;
        const r = g.rarity.toLowerCase();
        if (n > 2 && r !== "rare") {
          gearProblems.push("gear '" + g.base + "': " + n + " mods make an item rare, not " + r);
        } else if (n > 0 && r === "normal") {
          gearProblems.push("gear '" + g.base + "': an item with mods can't be normal rarity (1-2 = magic, 3+ = rare)");
        }
      }
    }
  }

  // ---- Budget + repair hints ----
  const last = capReports[capReports.length - 1];
  const lastDetail = capDetails[capDetails.length - 1];
  const mainPoints = last?.points ?? 0;
  const over = Math.max(0, mainPoints - MAIN_CAP);
  const budget: Record<string, unknown> = {
    main: mainPoints,
    cap: MAIN_CAP,
    note: "keep main ≤ " + MAIN_CAP + "; 40-70 is a typical leveling build",
  };
  const budgetProblems: string[] = [];
  const diagnostics: Diagnostic[] = [];
  if (over > 0 && lastDetail) {
    // Most expensive targets first: dropping these saves the most.
    // Marginal costs are order-dependent (greedy), so present them as
    // estimates, not exact refunds.
    const costly = [...lastDetail.targetCosts]
      .filter(t => t.points > 0)
      .sort((a, b) => b.points - a.points)
      .slice(0, 5)
      .map(t => ({ target: t.target, saves_about: t.points }));
    budget.over_by = over;
    budget.suggest_remove = costly;
    // The failure must be visible in BOTH channels: problems[] (so
    // ok:false never comes with an empty problems list) and a coded
    // diagnostic (so agents branch without string-matching).
    budgetProblems.push(
      "main points " + mainPoints + " exceed the " + MAIN_CAP + "-point cap (over by " + over + ") — see budget.suggest_remove");
    diagnostics.push({
      code: "budget.main_over_cap", severity: "error",
      message: "main points " + mainPoints + "/" + MAIN_CAP + ", over by " + over,
      over_by: over, suggest_remove: costly,
    });
  }
  for (const c of capReports) {
    for (const u of c.unresolved) {
      diagnostics.push({ code: "target.unresolved", severity: "error", message: u, target: u.replace(/ \(unreachable\)$/, "") });
    }
  }

  const ok = problems.length === 0 && gemProblems.length === 0 && gearProblems.length === 0
    && levelingProblems.length === 0 && capReports.every(c => c.unresolved.length === 0)
    && over === 0;

  return {
    report: {
      ok,
      class: klass,
      ascendancy: asc,
      captures: capReports,
      total_points: mainPoints,
      total_asc_points: last?.asc_points ?? 0,
      budget,
      problems: [...problems, ...gemProblems, ...gearProblems, ...levelingProblems, ...budgetProblems],
      diagnostics,
    },
    ok,
    klass,
    asc,
    capReports,
    capDetails,
    catalogue: cat,
  };
}
