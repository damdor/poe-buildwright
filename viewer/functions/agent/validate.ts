// Cloudflare Pages Function: headless agent-plan validation.
//
//   GET  /agent/validate?plan=<base64url agent-plan JSON>
//   POST /agent/validate            body: the agent-plan JSON
//
// Returns the same resolution + pathing result the in-browser importer
// produces — resolved/unresolved targets, per-capture allocated point
// counts, gem name checks, budget repair hints — so agents can
// self-check a plan BEFORE handing the user a URL. Every response is
// JSON, including errors. The engine lives in _lib.ts and is shared
// with /agent/build.

import { CORS, out, readPlan, runValidation } from "./_lib.ts";
import type { PagesCtx } from "./_lib.ts";

export async function onRequestOptions(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS });
}
export async function onRequestGet(ctx: PagesCtx): Promise<Response> { return handle(ctx); }
export async function onRequestPost(ctx: PagesCtx): Promise<Response> { return handle(ctx); }

async function handle(ctx: PagesCtx): Promise<Response> {
  const plan = await readPlan(ctx.request);
  if (!plan) {
    return out(400, { ok: false, error: "expected an agent plan (format poe2-agent-plan) via ?plan=<b64url> or POST body" });
  }
  const origin = new URL(ctx.request.url).origin;
  const result = await runValidation(plan, ctx.env.ASSETS, origin);
  return out(200, result.report);
}
