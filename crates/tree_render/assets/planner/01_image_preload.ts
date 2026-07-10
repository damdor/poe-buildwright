// ============================================================================
// === Image preloading =====================================================
// ============================================================================
// imgCache holds the decoded ImageBitmap for each sprite URL until the
// GPU texture is uploaded (uploadAllTextures). After that the GPU has
// its own copy in texCache and we never need the bitmap again.
export const imgCache: Map<string, ImageBitmap> = new Map();
export const texCache: Map<string, WebGLTexture> = new Map();

// The boot-time default class (alphabetically first — the same rule
// initDefaultClass applies to the sidebar select). Its ascendancy art
// rides the eager preload below so the class a first-time visitor
// lands on is complete at first paint; every other class's art is
// deferred and fetched by 04g_lazy_art.ts. Single source of truth:
// if the default-class rule ever changes, the eager set follows.
export function defaultClassName(): string | null {
  const sorted = [...TREE.classes].sort((a, b) => a.name.localeCompare(b.name));
  return sorted[0]?.name ?? null;
}

// Which class exclusively owns an ascendancy. Variants (Abyssal Lich)
// resolve through their parent panel's class; asc_internal is the
// fallback mapping. null = unknown → treated as shared, loads eagerly.
function classOfAsc(asc: string): string | null {
  for (const c of TREE.classes) if (c.asc.includes(asc)) return c.name;
  const parent = TREE.asc_variants?.[asc]?.parent;
  if (parent) for (const c of TREE.classes) if (c.asc.includes(parent)) return c.name;
  return TREE.asc_internal?.[asc]?.class ?? null;
}

// Every sprite URL → the single class that owns it, or null when the
// main tree or more than one class references it. Shared chrome (the
// generic AscendancyFrame* sprites, connectors, backgrounds) ends up
// null and must be present at first paint; per-class art (portraits,
// panel backgrounds, asc node icons) carries its class name so it can
// be deferred.
function collectOwnedUrls(): Map<string, string | null> {
  const owners = new Map<string, string | null>();
  const add = (url: string | undefined, owner: string | null): void => {
    if (!url) return;
    if (!owners.has(url)) {
      owners.set(url, owner);
    } else if (owners.get(url) !== owner) {
      owners.set(url, null); // referenced from two owners → shared
    }
  };
  for (const id in TREE.nodes) {
    const n = TREE.nodes[id];
    if (!n) continue;  // noUncheckedIndexedAccess: TREE.nodes[id] is possibly undefined
    const owner = n.a ? classOfAsc(n.a) : null;
    add(n.i, owner);
    add(n.f0, owner);
    add(n.f1, owner);
    add(n.me, owner);
    if (n.o) for (const o of n.o) add(o.i, owner);
  }
  for (const cn in TREE.class_portraits) add(TREE.class_portraits[cn], cn);
  for (const an in TREE.asc_panels) add(TREE.asc_panels[an]?.p, classOfAsc(an));
  // Variant-ascendancy override icons (Abyssal Lich) — referenced only
  // via TREE.asc_variants, so the node loop above never sees them.
  // Without this they're absent from texCache and the panel bake
  // silently skips them (nodes render frameless/iconless).
  for (const v in (TREE.asc_variants ?? {})) {
    const owner = classOfAsc(v);
    const nodes = TREE.asc_variants![v]!.nodes;
    for (const id in nodes) {
      add(nodes[id]!.i, owner);
    }
  }
  add(TREE.bgtree, null);
  add(TREE.bgtree_active, null);
  add(TREE.bg_tile, null);
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
        add("/assets/sprites/" + prefix + "_orbit_" + stateName + idx + ".png", null);
      }
    }
  }
  return owners;
}

// Eager set: main tree, shared chrome, and the default class's art.
// This is what boot blocks first paint on.
export function collectSpriteUrls(): string[] {
  const def = defaultClassName();
  const urls: string[] = [];
  for (const [url, owner] of collectOwnedUrls()) {
    if (owner === null || owner === def) urls.push(url);
  }
  return urls;
}

// Deferred art grouped by owning class (the default class is excluded
// — its art rides the eager path above). Consumed by 04g_lazy_art.ts.
export function lazyClassUrls(): Map<string, string[]> {
  const def = defaultClassName();
  const map = new Map<string, string[]>();
  for (const [url, owner] of collectOwnedUrls()) {
    if (owner === null || owner === def) continue;
    let arr = map.get(owner);
    if (!arr) {
      arr = [];
      map.set(owner, arr);
    }
    arr.push(url);
  }
  return map;
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
