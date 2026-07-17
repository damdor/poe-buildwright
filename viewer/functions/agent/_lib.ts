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
export type WeaponSet = "set1" | "set2";
export type Target = string | number | { node: string | number; note?: string; set?: WeaponSet };
export interface AgentGearIn { slot?: string; name?: string; base?: string; rarity?: string; mods?: string[]; note?: string; socket?: number }
export interface AgentCapture { level?: number; name?: string; notes?: string; respec?: boolean; remove?: Target[]; targets?: Target[]; skills?: AgentSkillIn[]; gear?: AgentGearIn[] }
export interface AgentSkillIn { gem?: string; level?: number; supports?: string[]; note?: string; set?: WeaponSet }

/// The contract says supports are gem-name strings, but agents that
/// mirror the skills[] shape send {gem, level} objects — accept the
/// name from either rather than crashing (never 500 on plan shape).
export function supportNames(sk: AgentSkillIn): string[] {
  return (sk.supports ?? [])
    .map(s => typeof s === "string" ? s : (s && typeof (s as { gem?: unknown }).gem === "string" ? (s as { gem: string }).gem : ""))
    .filter(Boolean);
}
export interface AgentPlanIn {
  format?: string; name?: string; notes?: string; description?: string; class?: string; ascendancy?: string;
  targets?: Target[]; skills?: AgentSkillIn[]; gear?: AgentGearIn[]; captures?: AgentCapture[];
}
export interface CatGem { id: string; name: string; skill_types?: string[]; require_skill_types?: string[]; exclude_skill_types?: string[]; req_level?: number; natural_max_level?: number; tag_string?: string }

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
  /** Weapon-set point accounting: set-tagged nodes cost SET points
   *  (shared 24-point pool, quest-gated by level), not main points.
   *  Travel to them still costs main. */
  weapon_set_points: { set1: number; set2: number; used: number; cap: number; max: number };
  /** Spirit accounting: persistent buffs/auras reserve from a
   *  quest-earned base pool (conservative schedule; gear extends it,
   *  which is why overspend is a WARNING, not an error).
   *  unknown_reservations = HasReservation gems the dataset carries
   *  no ladder for — their cost is real but unquantified. */
  spirit: { reserved: number; base_available: number; gear_bonus: number; unknown_reservations: string[] };
  /** Skills granted for free by equipped uniques in this capture's
   *  gear — available to the build without a gem slot. */
  granted_skills: string[];
  /** Jewels placed in tree sockets this capture: where, effective
   *  radius, and which notables the radius covers. */
  jewels?: {
    name?: string; socket: number; socket_name?: string; radius?: number;
    passives_in_radius?: number; notables_in_radius?: string[];
    /** In-radius passives that are ALLOCATED this capture — what the
     *  jewel actually affects in this build. */
    allocated_in_radius?: string[];
  }[];
}

// Weapon-set passive points are quest rewards, earned gradually —
// KEEP IN SYNC with WEAPON_SET_REWARDS in planner/state.ts (source:
// PoB2 QuestRewards.lua aggregated by AreaLevel; +2 per quest, twin
// quests at 51/62 collapsed; 24 total at Lv 64+).
const WEAPON_SET_REWARDS: { lvl: number; pts: number }[] = [
  { lvl: 10, pts: 2 }, { lvl: 12, pts: 2 },
  { lvl: 25, pts: 2 }, { lvl: 28, pts: 2 },
  { lvl: 34, pts: 2 }, { lvl: 44, pts: 2 },
  { lvl: 51, pts: 4 },
  { lvl: 61, pts: 2 }, { lvl: 62, pts: 4 }, { lvl: 64, pts: 2 },
];
export function weaponSetCapAt(level: number): number {
  let cap = 0;
  for (const r of WEAPON_SET_REWARDS) {
    if (r.lvl <= level) cap += r.pts;
    else break;
  }
  return cap;
}
const MAX_SET_POINTS = 24;

/** One capture's machine-usable state beyond the human report:
 *  the exact allocated node ids (for Plan construction) and the
 *  marginal path cost the greedy router charged each target (for
 *  budget repair hints). nodeId/note let /agent/build re-attach
 *  target annotations to the resolved allocation. */
export interface CapDetail {
  allocated: string[];
  targetCosts: { target: string; points: number; nodeId: string | null; note?: string; set?: WeaponSet }[];
  /** CUMULATIVE node→set and node→note state at this capture —
   *  captures are snapshots, so a tag placed in capture 1 must still
   *  be on the node in capture 3 (until the node is removed). Plan
   *  construction reads these, NOT per-capture targetCosts. */
  sets: [string, WeaponSet][];
  notes: [string, string][];
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
  // Spirit economy + unique-granted skills — small deploy-generated
  // extracts (gen_agent_meta.mjs); both degrade to "not checked" when
  // absent.
  let spiritData: {
    base_schedule?: { lvl: number; pts: number }[];
    reservations?: Record<string, Record<string, number>>;
    support_cost_multipliers?: Record<string, Record<string, number>>;
  } = {};
  let grantedByUnique: Record<string, { grants?: string[]; spirit_bonus?: string; spirit_base?: number }> = {};
  let grantedByBase: Record<string, { grants?: string[]; spirit?: number }> = {};
  try {
    const sRes = await assets.fetch(origin + "/assets/agent/spirit.json");
    if (sRes.ok) spiritData = await sRes.json() as typeof spiritData;
  } catch { /* spirit checks degrade */ }
  try {
    const gRes2 = await assets.fetch(origin + "/assets/agent/granted_skills.json");
    if (gRes2.ok) {
      const gd = await gRes2.json() as { uniques?: typeof grantedByUnique; bases?: typeof grantedByBase };
      grantedByUnique = gd.uniques ?? {};
      grantedByBase = gd.bases ?? {};
    }
  } catch { /* granted-skill info degrades */ }
  const spiritCapAt = (level: number): number => {
    let cap = 0;
    for (const r of spiritData.base_schedule ?? []) if (r.lvl <= level) cap += r.pts;
    return cap;
  };
  // Ladder value at a level: the highest key <= level.
  const ladderAt = (ladder: Record<string, number> | undefined, level: number): number | null => {
    if (!ladder) return null;
    let best: number | null = null, bestK = -1;
    for (const k in ladder) {
      const kn = Number(k);
      if (kn <= level && kn > bestK) { bestK = kn; best = ladder[k] ?? null; }
    }
    return best;
  };
  const reservationAt = (gemName: string, level: number): number | null =>
    ladderAt(spiritData.reservations?.[gemName], level);

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
    : [{ targets: plan.targets, skills: plan.skills, gear: plan.gear }];
  const roots = (): Set<string> => {
    const s = new Set<string>([hub]);
    if (ascStart) s.add(ascStart);
    return s;
  };
  let carry = roots();
  // Which allocated node is paid for with a weapon-set point, and
  // which carries a target note (both persist across cumulative
  // captures; pruned with their node).
  const setByNode = new Map<string, WeaponSet>();
  const noteByNodeCum = new Map<string, string>();
  // Skills/gear are inherited when a capture omits them (the
  // documented cumulative semantics) — spirit and granted-skill
  // accounting must follow the EFFECTIVE lists, not the raw ones.
  const catByName = new Map(cat.map(g => [g.name.toLowerCase(), g]));
  let effSkills: AgentSkillIn[] = [];
  let effGear: AgentGearIn[] = [];
  const capReports: CapReport[] = [];
  const capDetails: CapDetail[] = [];
  for (const c of capsIn) {
    if (c.respec) { carry = roots(); setByNode.clear(); noteByNodeCum.clear(); }
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
      for (const id of [...carry]) if (!keep.has(id)) { carry.delete(id); setByNode.delete(id); noteByNodeCum.delete(id); }
    }
    const unresolved: string[] = [];
    const goals: { label: string; ids: Set<string>; note?: string; set?: WeaponSet }[] = [];
    for (const raw2 of c.targets ?? []) {
      const isObj = typeof raw2 === "object" && raw2 !== null;
      const t = isObj ? raw2.node : raw2;
      const note = isObj ? raw2.note : undefined;
      const set = isObj && (raw2.set === "set1" || raw2.set === "set2") ? raw2.set : undefined;
      if (typeof t === "number" || /^\d+$/.test(String(t))) {
        const id = String(t);
        if (graph.nodes[id]) goals.push({ label: id, ids: new Set([id]), note, set });
        else unresolved.push(String(t));
        continue;
      }
      const ids = nameIdx.get(String(t).toLowerCase().trim());
      if (ids && ids.length) goals.push({ label: String(t), ids: new Set(ids), note, set });
      else unresolved.push(String(t));
    }
    // Greedy nearest-target routing. The path each target gets charged
    // is its MARGINAL cost given everything routed before it — exactly
    // the "removing this saves ~N points" number repair hints need.
    // The path's final node IS the goal copy that got picked; keep it
    // so target notes can be re-attached to the resolved allocation.
    const targetCosts: { target: string; points: number; nodeId: string | null; note?: string; set?: WeaponSet }[] = [];
    const remaining = goals.slice();
    while (remaining.length) {
      // A target already swallowed by an earlier target's path is
      // RESOLVED at zero marginal cost, not unreachable.
      for (let i = remaining.length - 1; i >= 0; i--) {
        const hit = [...remaining[i]!.ids].find(id => carry.has(id));
        if (hit) {
          targetCosts.push({ target: remaining[i]!.label, points: 0, nodeId: hit, note: remaining[i]!.note, set: remaining[i]!.set });
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
        set: remaining[best.idx]!.set,
      });
      remaining.splice(best.idx, 1);
    }
    // Weapon-set tags and notes stick to the GOAL node (travel stays
    // main): both survive across captures via the cumulative maps,
    // mirroring the browser importer's semantics.
    for (const t of targetCosts) {
      if (t.set && t.nodeId) setByNode.set(t.nodeId, t.set);
      if (t.note && t.nodeId) noteByNodeCum.set(t.nodeId, t.note);
    }
    let points = 0, ascPoints = 0, set1 = 0, set2 = 0;
    for (const id of carry) {
      if (id === hub || id === ascStart) continue;
      if (graph.nodes[id]?.a) { ascPoints++; continue; }
      const st = setByNode.get(id);
      if (st === "set1") set1++;
      else if (st === "set2") set2++;
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
    const capLevel = typeof c.level === "number" ? c.level : 100;
    const setCap = weaponSetCapAt(capLevel);
    // Spirit: sum reservation ladders for this capture's EFFECTIVE
    // skills; HasReservation gems without a mined ladder are listed
    // as unknown instead of silently costing zero.
    if (c.skills) effSkills = c.skills;
    if (c.gear) effGear = c.gear;
    let spiritReserved = 0;
    const unknownResv: string[] = [];
    for (const sk of effSkills) {
      if (!sk.gem) continue;
      const gemLvl = typeof sk.level === "number" ? sk.level : 1;
      const r = reservationAt(sk.gem, gemLvl);
      if (r !== null) {
        // Each support multiplies its skill's reservation by
        // cost_multiplier/100 (product across supports).
        let mult = 1;
        for (const supName of supportNames(sk)) {
          const m = ladderAt(spiritData.support_cost_multipliers?.[supName], 1);
          if (m && m !== 100) mult *= m / 100;
        }
        spiritReserved += Math.round(r * mult);
      } else if ((catByName.get(sk.gem.toLowerCase())?.tag_string ?? "").includes("HasReservation")) {
        unknownResv.push(sk.gem);
      }
    }
    // Grants + spirit from gear: uniques by name, bases by base —
    // base spirit (sceptres) is exact mined data and extends the
    // available pool; unique +Spirit ranges use their LOW end.
    const grantedSkills: string[] = [];
    let gearSpirit = 0;
    for (const g of effGear) {
      const gu = g.name ? grantedByUnique[g.name] : undefined;
      for (const s of gu?.grants ?? []) grantedSkills.push(s + " (from " + g.name + ")");
      if (gu?.spirit_bonus) {
        const lo = parseInt(gu.spirit_bonus, 10);
        if (!isNaN(lo)) gearSpirit += lo;
      }
      // Exact Spirit carried by the unique's BASE (unique sceptres
      // still grant the sceptre's 100) — distinct from rolled bonuses.
      if (gu?.spirit_base) gearSpirit += gu.spirit_base;
      const gb = g.base ? grantedByBase[g.base] : undefined;
      for (const s of gb?.grants ?? []) grantedSkills.push(s + " (from " + g.base + ")");
      if (gb?.spirit) gearSpirit += gb.spirit;
    }
    capReports.push({
      points, asc_points: ascPoints, resolved: goals.length, unresolved,
      allocated_notables: allocatedNotables,
      target_costs: targetCosts.map(t => ({ target: t.target, added_points: t.points })),
      asc_allocated: ascAllocated,
      weapon_set_points: { set1, set2, used: set1 + set2, cap: setCap, max: MAX_SET_POINTS },
      spirit: {
        reserved: spiritReserved,
        base_available: spiritCapAt(capLevel),
        gear_bonus: gearSpirit,
        unknown_reservations: unknownResv,
      },
      granted_skills: grantedSkills,
    });
    if (set1 + set2 > setCap) {
      problems.push(
        "capture " + (capReports.length) + " (level " + capLevel + "): " + (set1 + set2) +
        " weapon-set points used but only " + setCap + " earned by that level (quest-gated; 24 total at Lv 64+)");
    }
    capDetails.push({
      allocated: [...carry].filter(id => id !== hub && id !== ascStart),
      targetCosts,
      sets: [...setByNode],
      notes: [...noteByNodeCum],
    });
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
      const names = [sk.gem, ...supportNames(sk)];
      for (const nm of names) {
        if (!nm || typeof nm !== "string") continue;
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
    for (const supName of supportNames(s)) {
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

  const diagnostics: Diagnostic[] = [];

  // ---- Jewels: socket grounding, occupancy, radius report ----
  // Sockets/rings/item radii from the deploy-generated jewels.json
  // (raw tree geometry precomputed into per-socket in-radius lists).
  interface JewelSocketData { id: number; name?: string; sinister?: boolean; special?: boolean; in_radius: Record<string, number[]> }
  interface JewelsData {
    rings?: Record<string, { outer: number; inner: number; radius: number }>;
    bases?: Record<string, { radius: number }>;
    radius_rolls?: Record<string, number>;
    uniques?: Record<string, { radius?: number; ring?: string }>;
    sockets?: JewelSocketData[];
  }
  let jd: JewelsData = {};
  try {
    const jRes = await assets.fetch(origin + "/assets/agent/jewels.json");
    if (jRes.ok) jd = await jRes.json() as JewelsData;
  } catch { /* jewel checks degrade */ }
  const sockById = new Map((jd.sockets ?? []).map(sk => [sk.id, sk]));
  const jewelProblems: string[] = [];
  if (sockById.size) {
    const radiusOf = (g: AgentGearIn): { r: number; inner: number } => {
      const uq = g.name ? jd.uniques?.[g.name] : undefined;
      if (uq?.radius) return { r: uq.radius, inner: 0 };
      if (uq?.ring) {
        const ring = jd.rings?.[uq.ring];
        return ring ? { r: ring.outer, inner: ring.inner } : { r: 0, inner: 0 };
      }
      let r = g.base ? (jd.bases?.[g.base]?.radius ?? 0) : 0;
      if (r > 0) {
        for (const m of g.mods ?? []) {
          // GGG's rollable radius mod: "Upgrades Radius to Medium/…"
          const up = /Upgrades\s+Radius\s+to\s+(\w+)/i.exec(m);
          if (up) {
            const add = jd.radius_rolls?.[up[1]!] ?? 0;
            if (add > 0) { r += add; continue; }
          }
          const mm = /\+\s*\(?(\d+)\)?\s*to\s+Radius/i.exec(m);
          if (mm) r += Number(mm[1]);
        }
      }
      return { r, inner: 0 };
    };
    let eg: AgentGearIn[] = plan.gear ?? [];
    for (let i = 0; i < capsIn.length; i++) {
      if (capsIn[i]!.gear) eg = capsIn[i]!.gear!;
      const jl = eg.filter(g => (g.slot ?? "").toLowerCase().trim() === "jewel");
      if (!jl.length) continue;
      const allocated = new Set(capDetails[i]?.allocated ?? []);
      const seen = new Map<number, string>();
      const jr: NonNullable<CapReport["jewels"]> = [];
      for (const g of jl) {
        const label = g.name || g.base || "jewel";
        if (typeof g.socket !== "number") {
          diagnostics.push({
            code: "jewel.unsocketed", severity: "warning",
            message: "capture " + (i + 1) + ": jewel '" + label + "' has no socket — pick one from jewels.json sockets[] ({\"slot\":\"jewel\",\"socket\":<node id>})",
            capture: i + 1, jewel: label,
          });
          continue;
        }
        const sock = sockById.get(g.socket);
        if (!sock) {
          jewelProblems.push("capture " + (i + 1) + ": '" + label + "' names socket " + g.socket +
            " which is not a jewel socket (valid ids in /assets/agent/jewels.json sockets[])");
          diagnostics.push({
            code: "jewel.bad_socket", severity: "error",
            message: "socket " + g.socket + " is not a jewel socket",
            capture: i + 1, jewel: label, socket: g.socket,
          });
          continue;
        }
        if (seen.has(g.socket)) {
          jewelProblems.push("capture " + (i + 1) + ": socket " + g.socket + " holds both '" +
            seen.get(g.socket) + "' and '" + label + "' — one jewel per socket");
          diagnostics.push({
            code: "jewel.socket_conflict", severity: "error",
            message: "two jewels in socket " + g.socket,
            capture: i + 1, socket: g.socket,
          });
          continue;
        }
        seen.set(g.socket, label);
        if (sock.sinister && !jl.some(x => (x.name ?? "") === "Voices")) {
          diagnostics.push({
            code: "jewel.sinister_needs_voices", severity: "warning",
            message: "capture " + (i + 1) + ": socket " + g.socket +
              " is a Sinister socket — it only activates while a Voices jewel enables it",
            capture: i + 1, socket: g.socket,
          });
        }
        if (!allocated.has(String(g.socket))) {
          diagnostics.push({
            code: "jewel.socket_unallocated", severity: "warning",
            message: "capture " + (i + 1) + ": jewel socket " + g.socket +
              " isn't allocated — add it to targets (travel costs points) or the jewel does nothing",
            capture: i + 1, socket: g.socket,
          });
        }
        const { r, inner } = radiusOf(g);
        const entry: NonNullable<CapReport["jewels"]>[number] = { name: label, socket: g.socket };
        if (sock.name) entry.socket_name = sock.name;
        if (r > 0) {
          entry.radius = r;
          const key = inner > 0 ? inner + "-" + r : String(r);
          let ids = sock.in_radius[key];
          if (!ids && inner === 0) {
            // nearest available radius at or below (conservative)
            const ks = Object.keys(sock.in_radius).filter(k => !k.includes("-")).map(Number).filter(k => k <= r);
            if (ks.length) ids = sock.in_radius[String(Math.max(...ks))];
          }
          if (ids) {
            entry.passives_in_radius = ids.length;
            entry.notables_in_radius = ids
              .map(id => graph.nodes[String(id)])
              .filter(n => n && (n.k === "notable" || n.k === "keystone") && n.n)
              .map(n => n!.n!) as string[];
            // The metric that matters: a radius jewel only buffs
            // passives you actually TOOK.
            entry.allocated_in_radius = ids
              .filter(id => allocated.has(String(id)))
              .map(id => graph.nodes[String(id)]?.n ?? String(id));
          }
        }
        jr.push(entry);
      }
      if (capReports[i]) capReports[i]!.jewels = jr;
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
  for (let i = 0; i < capReports.length; i++) {
    const w = capReports[i]!.weapon_set_points;
    if (w.used > w.cap) {
      diagnostics.push({
        code: "weapon_set.over_cap", severity: "error",
        message: "capture " + (i + 1) + ": " + w.used + "/" + w.cap + " weapon-set points at that level",
        capture: i + 1, used: w.used, cap: w.cap,
      });
    }
    // Spirit overspend is a WARNING: the base pool is a conservative
    // quest schedule, and +Spirit gear/sceptres legitimately extend
    // it. The agent should either lower reservations or spec gear
    // that covers the gap (and say so in a note).
    const sp = capReports[i]!.spirit;
    if (sp.reserved > sp.base_available + sp.gear_bonus) {
      diagnostics.push({
        code: "spirit.over_base", severity: "warning",
        message: "capture " + (i + 1) + ": " + sp.reserved + " spirit reserved vs " + sp.base_available +
          " base spirit at that level — needs +Spirit gear to work, or lower the reservations",
        capture: i + 1, reserved: sp.reserved, base_available: sp.base_available,
      });
    }
    if (sp.unknown_reservations.length) {
      diagnostics.push({
        code: "spirit.unknown_reservation", severity: "warning",
        message: "capture " + (i + 1) + ": no reservation data for " + sp.unknown_reservations.join(", ") +
          " — its spirit cost is real but unquantified in this dataset",
        capture: i + 1, gems: sp.unknown_reservations,
      });
    }
  }

  const ok = problems.length === 0 && gemProblems.length === 0 && gearProblems.length === 0
    && levelingProblems.length === 0 && jewelProblems.length === 0
    && capReports.every(c => c.unresolved.length === 0)
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
      problems: [...problems, ...gemProblems, ...gearProblems, ...levelingProblems, ...jewelProblems, ...budgetProblems],
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
