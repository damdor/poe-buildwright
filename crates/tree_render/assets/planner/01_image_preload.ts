// ============================================================================
// === Image preloading =====================================================
// ============================================================================
// imgCache holds the decoded ImageBitmap for each sprite URL until the
// GPU texture is uploaded (uploadAllTextures). After that the GPU has
// its own copy in texCache and we never need the bitmap again.
export const imgCache: Map<string, ImageBitmap> = new Map();
export const texCache: Map<string, WebGLTexture> = new Map();

export function collectSpriteUrls(): string[] {
  const urls = new Set<string>();
  for (const id in TREE.nodes) {
    const n = TREE.nodes[id];
    if (!n) continue;  // noUncheckedIndexedAccess: TREE.nodes[id] is possibly undefined
    if (n.i)  urls.add(n.i);
    if (n.f0) urls.add(n.f0);
    if (n.f1) urls.add(n.f1);
    if (n.me) urls.add(n.me);
    if (n.o) for (const o of n.o) if (o.i) urls.add(o.i);
  }
  for (const cn in TREE.class_portraits) {
    const url = TREE.class_portraits[cn];
    if (url) urls.add(url);
  }
  for (const an in TREE.asc_panels) {
    const panel = TREE.asc_panels[an];
    if (panel && panel.p) urls.add(panel.p);
  }
  // Variant-ascendancy override icons (Abyssal Lich) — referenced only
  // via TREE.asc_variants, so the node loop above never sees them.
  // Without this they're absent from texCache and the panel bake
  // silently skips them (nodes render frameless/iconless).
  for (const v in (TREE.asc_variants ?? {})) {
    const nodes = TREE.asc_variants![v]!.nodes;
    for (const id in nodes) {
      const i = nodes[id]!.i;
      if (i) urls.add(i);
    }
  }
  if (TREE.bgtree) urls.add(TREE.bgtree);
  if (TREE.bgtree_active) urls.add(TREE.bgtree_active);
  if (TREE.bg_tile) urls.add(TREE.bg_tile);
  // GGG-authored connector sprites: 3 prefixes × 10 orbits × 3 states
  // (normal = dim/unallocated, intermediateactive = allocated,
  // intermediate = hover preview) — exactly the 90 loose PNGs PoB
  // ships; most are <10 kB. There is no *_orbit_active*.png on disk:
  // the renderer's semantic 'active' state maps to the
  // intermediateactive file inside connectorUrl.
  const orbitFileSuffix: Record<number, number> = { 1: 9, 2: 8, 3: 6, 4: 5, 5: 4, 6: 3, 7: 7, 8: 2, 9: 1 };
  for (const prefix of ["Character", "CharacterPlanned", "CharacterAscendancy"]) {
    for (const stateName of ["normal", "intermediate", "intermediateactive"]) {
      for (let o = 0; o <= 9; o++) {
        const idx = o === 0 ? 0 : (orbitFileSuffix[o] ?? 0);
        urls.add("/assets/sprites/" + prefix + "_orbit_" + stateName + idx + ".png");
      }
    }
  }
  return [...urls];
}

// Fetch each URL, decode to ImageBitmap, store in cache. Browser HTTP
// cache hits on subsequent loads make this near-instant from second
// load. Failures are silently swallowed (a missing sprite just means
// that node's icon/frame won't render — better than blocking forever).
export function preload(urls: string[]): Promise<(void | undefined)[]> {
  return Promise.all(urls.map(async url => {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return;
      const blob = await resp.blob();
      const bitmap = await createImageBitmap(blob, { imageOrientation: "none", premultiplyAlpha: "premultiply" });
      imgCache.set(url, bitmap);
    } catch (e) {
      // Ignore — geometry builder skips sprites with no uploaded texture.
    }
  }));
}
