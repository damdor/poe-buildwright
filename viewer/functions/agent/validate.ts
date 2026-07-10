// Cloudflare Pages Function: headless agent-plan validation.
//
//   GET  /agent/validate?plan=<base64url agent-plan JSON>
//   POST /agent/validate            body: the agent-plan JSON
//
// Returns the same resolution + pathing result the in-browser importer
// produces — resolved/unresolved targets, per-capture allocated point
// counts, gem name checks — so agents can self-check a plan BEFORE
// handing the user a URL (the #1 ask from the fresh-agent audits).
// Pure static-asset compute: reads /assets/agent/graph.json and
// /assets/skill_catalogue.json via the deployment's own ASSETS binding.
// No KV needed; works on any deploy of this project.

interface AssetsLite { fetch(req: Request | string): Promise<Response> }
interface Env { ASSETS: AssetsLite }
interface PagesCtx { request: Request; env: Env }

interface Graph {
  classes: Record<string, number>;
  asc_starts: Record<string, number>;
  nodes: Record<string, { k: string; n?: string; a?: string; uc?: string }>;
  edges: [number, number][];
}
type Target = string | number | { node: string | number; note?: string };
interface AgentGearIn { slot?: string; name?: string; base?: string; rarity?: string; mods?: string[] }
interface AgentCapture { level?: number; respec?: boolean; remove?: Target[]; targets?: Target[]; skills?: AgentSkillIn[]; gear?: AgentGearIn[] }
interface AgentSkillIn { gem?: string; level?: number; supports?: string[] }
interface AgentPlanIn {
  format?: string; class?: string; ascendancy?: string;
  targets?: Target[]; skills?: AgentSkillIn[]; gear?: AgentGearIn[]; captures?: AgentCapture[];
}
interface CatGem { id: string; name: string; skill_types?: string[]; require_skill_types?: string[]; exclude_skill_types?: string[]; req_level?: number; natural_max_level?: number }

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
function out(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 1), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
export async function onRequestOptions(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS });
}

function b64urlDecode(s: string): string | null {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "===".slice((b64.length + 3) % 4);
    return decodeURIComponent(escape(atob(pad)));
  } catch { return null; }
}

// Same RPN evaluator as the in-browser importer (agent_import.ts).
function evalTypeExpr(expr: string[] | undefined, types: Set<string>): boolean {
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

export async function onRequestGet(ctx: PagesCtx): Promise<Response> { return handle(ctx); }
export async function onRequestPost(ctx: PagesCtx): Promise<Response> { return handle(ctx); }

async function handle(ctx: PagesCtx): Promise<Response> {
  // ---- Parse the plan (query param or POST body) ----
  let raw: string | null = null;
  if (ctx.request.method === "POST") raw = await ctx.request.text();
  else {
    const p = new URL(ctx.request.url).searchParams.get("plan");
    raw = p ? b64urlDecode(p) : null;
  }
  let plan: AgentPlanIn | null = null;
  try { plan = raw ? JSON.parse(raw) as AgentPlanIn : null; } catch { /* handled */ }
  if (!plan || plan.format !== "poe2-agent-plan") {
    return out(400, { ok: false, error: "expected an agent plan (format poe2-agent-plan) via ?plan=<b64url> or POST body" });
  }

  // ---- Load the graph + gem catalogue from our own static assets ----
  const origin = new URL(ctx.request.url).origin;
  const gRes = await ctx.env.ASSETS.fetch(origin + "/assets/agent/graph.json");
  if (!gRes.ok) return out(500, { ok: false, error: "graph data unavailable on this deployment" });
  const graph = await gRes.json() as Graph;
  let cat: CatGem[] = [];
  try {
    const cRes = await ctx.env.ASSETS.fetch(origin + "/assets/skill_catalogue.json");
    if (cRes.ok) cat = ((await cRes.json()) as { gems?: CatGem[] }).gems ?? [];
  } catch { /* gem checks degrade */ }

  const problems: string[] = [];

  // ---- Class / ascendancy ----
  const klass = Object.keys(graph.classes).find(c => c.toLowerCase() === (plan.class || "").toLowerCase().trim());
  if (!klass) return out(200, { ok: false, error: "unknown class '" + plan.class + "'", classes: Object.keys(graph.classes) });
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
  const capReports: { points: number; asc_points: number; resolved: number; unresolved: string[]; allocated_notables: string[] }[] = [];
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
    const goals: { label: string; ids: Set<string> }[] = [];
    for (const raw2 of c.targets ?? []) {
      const t = typeof raw2 === "object" && raw2 !== null ? raw2.node : raw2;
      if (typeof t === "number" || /^\d+$/.test(String(t))) {
        const id = String(t);
        if (graph.nodes[id]) goals.push({ label: id, ids: new Set([id]) });
        else unresolved.push(String(t));
        continue;
      }
      const ids = nameIdx.get(String(t).toLowerCase().trim());
      if (ids && ids.length) goals.push({ label: String(t), ids: new Set(ids) });
      else unresolved.push(String(t));
    }
    const remaining = goals.slice();
    while (remaining.length) {
      let best: { idx: number; path: string[] } | null = null;
      for (let i = 0; i < remaining.length; i++) {
        const path = bfsNearest(carry, remaining[i]!.ids);
        if (path && (!best || path.length < best.path.length)) best = { idx: i, path };
      }
      if (!best) { for (const r of remaining) unresolved.push(r.label + " (unreachable)"); break; }
      for (const id of best.path) carry.add(id);
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
    capReports.push({ points, asc_points: ascPoints, resolved: goals.length, unresolved, allocated_notables: allocatedNotables });
  }

  // ---- Leveling realism: per-capture gem/gear availability ----
  // A capture at level L can only run gems obtainable by L, gem levels
  // that L supports, and gear bases that drop by L.
  const byNameL = new Map(cat.map(g => [g.name.toLowerCase(), g]));
  let baseLvl = new Map<string, number>();
  try {
    const bRes = await ctx.env.ASSETS.fetch(origin + "/assets/agent/bases.json");
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
      const bRes = await ctx.env.ASSETS.fetch(origin + "/assets/agent/bases.json");
      if (bRes.ok) {
        const bd = await bRes.json() as { bases?: { name: string }[] };
        baseNames = new Set((bd.bases ?? []).map(b => b.name.toLowerCase()));
      }
      const uRes = await ctx.env.ASSETS.fetch(origin + "/assets/item_catalogue.json");
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

  const last = capReports[capReports.length - 1];
  return out(200, {
    ok: problems.length === 0 && gemProblems.length === 0 && gearProblems.length === 0 && levelingProblems.length === 0 && capReports.every(c => c.unresolved.length === 0),
    class: klass,
    ascendancy: asc,
    captures: capReports,
    total_points: last?.points ?? 0,
    total_asc_points: last?.asc_points ?? 0,
    point_budget: { max_main: 99, note: "keep total_points ≤ 99; 40-70 is a typical leveling build" },
    problems: [...problems, ...gemProblems, ...gearProblems, ...levelingProblems],
  });
}
