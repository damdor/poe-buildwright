// Cloudflare Pages Function: resolve one allowlisted pobb.in share.
//
// POST /pob/raw  {"url":"https://pobb.in/<code>"}
//
// This is intentionally not a generic proxy. The host, scheme, path shape,
// redirect behaviour, request size, response size, and timeout are fixed.

import {
  MAX_POBB_INPUT_BYTES, POBB_TIMEOUT_MS, resolvePobbCode,
} from "./_resolver.ts";

interface PagesCtx {
  request: Request;
}

const HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function out(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

export async function onRequestOptions(): Promise<Response> {
  return new Response(null, { status: 204, headers: HEADERS });
}

export async function onRequestPost(ctx: PagesCtx): Promise<Response> {
  const declared = Number(ctx.request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_POBB_INPUT_BYTES) {
    return out(413, { ok: false, error: "Request is too large." });
  }
  const raw = await ctx.request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_POBB_INPUT_BYTES) {
    return out(413, { ok: false, error: "Request is too large." });
  }
  let url: unknown;
  try {
    url = (JSON.parse(raw) as { url?: unknown }).url;
  } catch {
    return out(400, { ok: false, error: "Expected JSON containing url." });
  }
  if (typeof url !== "string") {
    return out(400, { ok: false, error: "Expected a pobb.in URL." });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), POBB_TIMEOUT_MS);
  try {
    const result = await resolvePobbCode(url, { signal: controller.signal });
    return out(200, { ok: true, ...result });
  } catch (error) {
    const message = controller.signal.aborted
      ? "pobb.in did not respond before the timeout."
      : error instanceof Error
      ? error.message
      : String(error);
    return out(422, { ok: false, error: message });
  } finally {
    clearTimeout(timeout);
  }
}
