// ============================================================================
// === Lazy per-class ascendancy art ========================================
// ============================================================================
// The heavy per-class sprites (portrait, ascendancy panel backgrounds,
// asc node icons — the bulk of the sprite payload) are NOT part of the
// boot preload; only the default class's art is (01_image_preload
// tags ownership). This module fetches the rest:
//
//  * on demand, the moment a class is selected (refreshAscOptions),
//  * and ahead of time via an idle prefetch that starts shortly after
//    first paint, so by the time a user reaches for the class picker
//    the art is usually already resident and the switch costs nothing.
//
// Late arrival is safe by construction: buildStaticGeometry() skips
// any sprite missing from texCache, and re-running it after upload
// bakes the new textures in — the same rebuild that lock toggles
// already trigger on every click, so the cost is interactive-speed.

import { imgCache, lazyClassUrls, preload } from "./01_image_preload.ts";
import { state } from "./02_state.ts";
import { uploadOne } from "./04a_webgl_setup.ts";
import { buildStaticGeometry } from "./04d_static_geom.ts";
import { requestRender } from "./04f_render.ts";

// Classes whose art is resident (the default class is added on first
// ensure — lazyClassUrls has no entry for it, its art came with boot).
const loaded = new Set<string>();
const inflight = new Map<string, Promise<void>>();

/// Fetch, decode, and GPU-upload one class's art, then rebuild the
/// static geometry so it appears. Idempotent and coalescing: repeat
/// calls while a fetch is in flight return the same promise.
export function ensureClassArt(klass: string | null): Promise<void> {
  if (!klass || loaded.has(klass)) return Promise.resolve();
  const urls = lazyClassUrls().get(klass);
  if (!urls || urls.length === 0) {
    loaded.add(klass); // default class (eager) or class with no exclusive art
    return Promise.resolve();
  }
  const pending = inflight.get(klass);
  if (pending) return pending;
  const p = preload(urls).then(() => {
    for (const url of urls) {
      const bitmap = imgCache.get(url);
      if (!bitmap) continue; // fetch failed: renderer skips it, same as boot
      uploadOne(url, bitmap);
      try { bitmap.close(); } catch (e) { /* GPU has its copy */ }
      imgCache.delete(url);
    }
    loaded.add(klass);
    inflight.delete(klass);
    // Bake the new textures in. Guarded: during boot the initial
    // buildStaticGeometry hasn't run yet and will include these.
    if (state.geomReady) {
      buildStaticGeometry();
      requestRender();
    }
  });
  inflight.set(klass, p);
  return p;
}

/// Warm every remaining class sequentially (one class's files fetch in
/// parallel, classes queue behind each other) so a user interaction
/// mid-prefetch only ever competes with one class's worth of downloads
/// — and ensureClassArt() for the clicked class runs immediately in
/// parallel anyway, it never waits for this queue.
export function prefetchRemainingClasses(): void {
  let chain = Promise.resolve();
  for (const klass of lazyClassUrls().keys()) {
    chain = chain.then(() => ensureClassArt(klass));
  }
}
