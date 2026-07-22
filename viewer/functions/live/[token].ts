// Cloudflare Pages Function: the live build channel (docs/agent-builds.md §3).
//
//   PUT /live/<token>   store a plan revision   (agent / sharing side)
//   GET /live/<token>   fetch latest, ETag'd    (viewer side, polls)
//
// The token is a capability: knowing the URL is the permission. No
// accounts. Bodies are size-capped, TTL'd, and never listed.
//
// ONE-TIME SETUP (not yet done): create a KV namespace and bind it to
// this Pages project as LIVE_KV (Dashboard → Pages → project →
// Settings → Functions → KV bindings, or `wrangler pages project` +
// `wrangler kv namespace create LIVE_KV`). Until bound, endpoints
// return 503 so the static site is unaffected.

// Minimal ambient types — this file is compiled by wrangler's esbuild
// (no local deno typecheck), but keep it honest without pulling in
// @cloudflare/workers-types.
interface KVNamespaceLite {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}
interface Env { LIVE_KV?: KVNamespaceLite }
interface PagesCtx {
  request: Request;
  env: Env;
  params: { token?: string | string[] };
}

const MAX_BODY = 256 * 1024;          // 256 KB cap
const TTL_SECONDS = 48 * 60 * 60;     // 48 h channel lifetime
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
  "Access-Control-Expose-Headers": "ETag",
};
function resp(status: number, body: string | null, extra?: Record<string, string>): Response {
  return new Response(body, { status, headers: { ...CORS, "Content-Type": "application/json", ...extra } });
}

export async function onRequestOptions(): Promise<Response> {
  return resp(204, null);
}

export async function onRequestGet(ctx: PagesCtx): Promise<Response> {
  const kv = ctx.env.LIVE_KV;
  if (!kv) return resp(503, '{"error":"live channel not configured"}');
  const token = String(ctx.params.token ?? "");
  if (!TOKEN_RE.test(token)) return resp(400, '{"error":"bad token"}');
  const stored = await kv.get("live:" + token);
  if (!stored) return resp(404, '{"error":"no such channel (expired or never written)"}');
  // rev doubles as the ETag so pollers can If-None-Match cheaply.
  let rev = "0";
  try { rev = String((JSON.parse(stored) as { rev?: number }).rev ?? 0); } catch { /* keep 0 */ }
  const etag = 'W/"r' + rev + '"';
  if (ctx.request.headers.get("If-None-Match") === etag) return resp(304, null, { ETag: etag });
  return resp(200, stored, { ETag: etag });
}

export async function onRequestPut(ctx: PagesCtx): Promise<Response> {
  const kv = ctx.env.LIVE_KV;
  if (!kv) return resp(503, '{"error":"live channel not configured"}');
  const token = String(ctx.params.token ?? "");
  if (!TOKEN_RE.test(token)) return resp(400, '{"error":"bad token (16-64 chars of [A-Za-z0-9_-])"}');
  const text = await ctx.request.text();
  if (text.length > MAX_BODY) return resp(413, '{"error":"body over 256KB"}');
  let body: { rev?: number; plan?: { format?: string; game?: string } };
  try { body = JSON.parse(text) as typeof body; } catch { return resp(400, '{"error":"body must be JSON"}'); }
  const fmt = body.plan?.format;
  if (fmt !== "poe2-agent-plan" && fmt !== "buildwright-agent-plan" &&
      fmt !== "poe2-planner-plan" && fmt !== "buildwright-planner-plan") {
    return resp(422, '{"error":"body.plan.format must be a supported Buildwright agent or planner plan"}');
  }
  if (body.plan?.game && body.plan.game !== "poe2") {
    return resp(422, '{"error":"this live endpoint is PoE2-only"}');
  }
  const rev = typeof body.rev === "number" ? body.rev : 0;
  const existing = await kv.get("live:" + token);
  if (existing) {
    try {
      const prev = (JSON.parse(existing) as { rev?: number }).rev ?? 0;
      if (rev <= prev) return resp(409, '{"error":"rev must increase (current ' + prev + ')"}');
    } catch { /* unreadable prior state — allow overwrite */ }
  }
  await kv.put("live:" + token, text, { expirationTtl: TTL_SECONDS });
  return resp(200, '{"ok":true,"rev":' + rev + "}");
}
