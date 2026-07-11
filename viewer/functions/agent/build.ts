// Cloudflare Pages Function: the one-shot agent finish line.
//
//   POST /agent/build       body: a poe2-agent-plan JSON
//
// Validate → construct the importable plan → return BOTH final URLs:
//
//   {
//     "ok": true,
//     "share_url": "https://…/share.html#code=…",   // preferred deliverable
//     "agent_url": "https://…/planner.html#agent=…", // interactive import
//     "points": { "main": 97, "asc": 8 },
//     "warnings": [],
//     "validation": { …full /agent/validate report… }
//   }
//
// This exists because the first agent audit showed the last mile was
// interactive-only: an agent could author and validate a plan but had
// to drive a browser to mint the shareable link. Plan in, share URL
// out — no browser required.
//
// On validation failure it returns ok:false with the full report
// (including budget repair hints) and NO URLs, so an agent can repair
// and retry instead of shipping a broken build.

import { CORS, b64urlEncode, out, readPlan, runValidation, supportNames } from "./_lib.ts";
import type { AgentCapture, AgentPlanIn, CatGem, PagesCtx } from "./_lib.ts";

export async function onRequestOptions(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost(ctx: PagesCtx): Promise<Response> {
  const plan = await readPlan(ctx.request);
  if (!plan) {
    return out(400, { ok: false, error: "expected an agent plan (format poe2-agent-plan) as the POST body" });
  }
  const origin = new URL(ctx.request.url).origin;
  const result = await runValidation(plan, ctx.env.ASSETS, origin);
  if (!result.ok) {
    return out(200, { ok: false, error: "plan does not validate — fix and retry", validation: result.report });
  }

  // ---- Construct the importable internal plan --------------------------
  // Mirrors the browser importer's output shape (poe2-planner-plan v2).
  // The share page's normalizePlan mints ids/names for anything absent,
  // so we only fill what the agent plan actually specifies.
  const capsIn: AgentCapture[] = plan.captures?.length
    ? plan.captures
    : [{ targets: plan.targets, skills: plan.skills, gear: plan.gear }];
  const byName = new Map(result.catalogue.map(g => [g.name.toLowerCase(), g]));
  const byId = new Map(result.catalogue.map(g => [g.id, g]));
  const gemId = (nm: string | undefined): string | null => {
    if (!nm) return null;
    return (byId.get(nm) ?? byName.get(nm.toLowerCase()))?.id ?? null;
  };

  // NOTES SURVIVE THE CONVERSION. The first version of this endpoint
  // dropped every annotation on the floor (build notes, capture
  // notes, target {node, note}) — the audit agent's second run
  // caught its share links arriving bare. Mapping:
  //   plan.notes            → plan description
  //   capture.name/notes    → capture name/description
  //   target {node, note}   → Allocation.note on the RESOLVED node
  //                           (capDetails carries the picked copy)
  //   gear.note             → item note
  let targetNotesIn = 0;
  let targetNotesPreserved = 0;
  const captures = [];
  let lo = 1;
  for (let i = 0; i < capsIn.length; i++) {
    const c = capsIn[i]!;
    const hi = typeof c.level === "number" ? c.level : 100;
    const detail = result.capDetails[i]!;
    // Cumulative snapshots from the validator: a set tag or note from
    // an earlier capture stays on the node in every later capture.
    const noteByNode = new Map<string, string>(detail.notes);
    const setForNode = new Map<string, "set1" | "set2">(detail.sets);
    for (const t of detail.targetCosts) {
      if (t.note) {
        targetNotesIn++;
        if (t.nodeId) targetNotesPreserved++;
      }
    }
    captures.push({
      id: "agent-cap-" + (i + 1),
      levelRange: [Math.min(lo, hi), hi] as [number, number],
      name: c.name || null,
      description: c.notes || "",
      ascendancy: result.asc,
      passives: detail.allocated.map(id => {
        const note = noteByNode.get(id);
        const set = setForNode.get(id) ?? ("main" as const);
        return note ? { id, set, note } : { id, set };
      }),
      // Skill groups without a resolvable active gem are dropped —
      // validate tolerates them (grounding may be degraded) but a
      // Plan skill with an empty id would render as a broken slot.
      skills: (c.skills ?? [])
        .filter(sk => gemId(sk.gem) !== null)
        .map(sk => ({
          id: gemId(sk.gem)!,
          level: typeof sk.level === "number" ? sk.level : 1,
          quality: 0,
          // Skill weapon-set binding: the skill is used while that
          // weapon set is equipped (the tree's set-tagged nodes swap
          // in with it).
          set: sk.set === "set1" || sk.set === "set2" ? sk.set : ("main" as const),
          ...(sk.note ? { note: sk.note } : {}),
          supports: supportNames(sk).map(sup => ({
            id: gemId(sup) ?? sup, level: 1, quality: 0,
          })),
        })),
      items: (c.gear ?? []).map(g => ({
        slot: g.slot, base: g.base, name: g.name, rarity: g.rarity,
        mods: g.mods,
        ...(g.note ? { note: g.note } : {}),
      })),
    });
    lo = hi + 1;
  }
  const internalPlan = {
    format: "poe2-planner-plan",
    version: 2,
    name: plan.name || "Agent build",
    description: plan.notes || plan.description || "",
    class: result.klass,
    activeSet: "main",
    captures,
    activeCapture: captures.length - 1,
  };

  // ---- Encode both deliverables ----------------------------------------
  // Share code: gzip + base64url of the plan JSON. Format parity with
  // viewer/assets/share_codec.ts (PoE2Share.encode) — keep in sync.
  const json = JSON.stringify(internalPlan);
  const gz = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
  const buf = new Uint8Array(await new Response(gz).arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i] ?? 0);
  const code = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const agentUrl = origin + "/planner.html#agent=" + b64urlEncode(JSON.stringify(plan));
  // Structured warnings: agents branch on `code`, humans read `message`.
  const warnings: { code: string; severity: "warning"; message: string }[] = [];
  const budget = (result.report as { budget?: { main?: number } }).budget;
  if (budget?.main !== undefined && budget.main > 90) {
    warnings.push({
      code: "budget.near_cap", severity: "warning",
      message: "main points " + budget.main + "/99 — very close to the cap",
    });
  }
  const captureNotes = capsIn.filter(c => c.notes).length;
  if (targetNotesIn > targetNotesPreserved) {
    warnings.push({
      code: "notes.partially_preserved", severity: "warning",
      message: (targetNotesIn - targetNotesPreserved) + " target note(s) could not be attached (target unresolved)",
    });
  }

  return out(200, {
    ok: true,
    share_url: origin + "/share.html#code=" + code,
    agent_url: agentUrl,
    points: {
      main: result.capReports[result.capReports.length - 1]?.points ?? 0,
      asc: result.capReports[result.capReports.length - 1]?.asc_points ?? 0,
    },
    // Annotation accounting — "6/6 target notes preserved" at a glance.
    note_counts: {
      build_note: Boolean(plan.notes || plan.description),
      capture_notes: captureNotes,
      target_notes_in: targetNotesIn,
      target_notes_preserved: targetNotesPreserved,
    },
    warnings,
    validation: result.report,
  });
}
