// Share-code encoder / decoder.
//
// Encodes a `poe2-planner-plan` JSON object into a compact URL-safe
// string by gzipping it and base64url-encoding the bytes. Decoders
// reverse the process. Native CompressionStream / DecompressionStream
// — no third-party libs.
//
// Format: identical on both ends, the recipient verifies the embedded
// `format` + `version` fields before installing. Schema version
// mismatches refuse cleanly rather than corrupting state.

import type { Plan } from "../../types/poe2.d.ts";

async function encode(plan: Plan): Promise<string> {
  const json = JSON.stringify(plan);
  const blob = new Blob([json]);
  const stream = blob.stream().pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return base64UrlEncode(new Uint8Array(buf));
}

async function decode(code: string): Promise<Plan> {
  if (typeof code !== "string" || code.length === 0) {
    throw new Error("empty share code");
  }
  const bytes = base64UrlDecode(code);
  const blob = new Blob([bytes]);
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(stream).text();
  return JSON.parse(text) as Plan;
}

// Standard base64url alphabet — `-` and `_` instead of `+` and `/`,
// padding `=` stripped (browsers handle missing padding on atob if
// we add it back during decode).
function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    // noUncheckedIndexedAccess flags bytes[i] as possibly-undefined;
    // we're iterating up to bytes.length so it's actually safe, but
    // the explicit fallback satisfies the checker without runtime cost.
    bin += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Return type is the narrow Uint8Array<ArrayBuffer> instead of the
// default Uint8Array<ArrayBufferLike> — the latter can be backed by
// SharedArrayBuffer, which BlobPart doesn't accept. `new Uint8Array(n)`
// is always backed by a plain ArrayBuffer, so the narrowing is honest.
function base64UrlDecode(str: string): Uint8Array<ArrayBuffer> {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// Build a full share URL (origin + /share + #code=...). Caller can
// override `origin` for testing.
async function buildUrl(plan: Plan, origin?: string): Promise<string> {
  const code = await encode(plan);
  return (origin || location.origin) + "/share.html#code=" + code;
}

// Expose to the global namespace for the classic-<script> wizard pages
// that consume this. window.PoE2Share is typed via types/poe2.d.ts.
window.PoE2Share = { encode, decode, buildUrl };
