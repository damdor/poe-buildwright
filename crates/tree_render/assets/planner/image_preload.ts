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
// deferred and fetched by lazy_art.ts. Single source of truth:
// if the default-class rule ever changes, the eager set follows.
export function defaultClassName(): string | null {
  const sorted = [...TREE.classes].sort((a, b) => a.name.localeCompare(b.name));
  return sorted[0]?.name ?? null;
}

// Which class exclusively owns an ascendancy. Variants (Abyssal Lich)
// resolve through their parent panel's class; asc_internal is the
// fallback mapping. null = unknown → treated as shared, loads eagerly.
// In-place asc rendering (PoE1) shows every panel at boot, so no
// asc art can be deferred behind a class switch.
const IN_PLACE = window.PoE2Game?.features?.ascInPlace === true;
function classOfAsc(asc: string): string | null {
  if (IN_PLACE) return null;
  for (const c of TREE.classes) if (c.asc.includes(asc)) return c.name;
  const parent = TREE.asc_variants?.[asc]?.parent;
  if (parent) for (const c of TREE.classes) if (c.asc.includes(parent)) return c.name;
  return TREE.asc_internal?.[asc]?.class ?? null;
}

// Loading tier within the eager (boot-owned) set:
//   0 blocking — the tree skeleton: node frames, connectors,
//     backgrounds. First paint waits for these and nothing else.
//   1 icons — node/option icons. Streamed in immediately after first
//     paint (04g); each arrival is baked in by a throttled rebuild,
//     so the tree fills with icons over the first seconds.
//   2 flavor — mastery glow patterns, ascendancy panel art,
//     portraits. Visually rich but never load-bearing for starting a
//     build; loads after the icons.
// Everything still loads — the tiers change ordering, not fidelity.
export type SpriteTier = 0 | 1 | 2;

// Every sprite URL → the single class that owns it (null when the
// main tree or more than one class references it — shared chrome must
// live in the boot set) + the loading tier. A URL referenced from
// several places gets the most urgent tier any reference needs: a
// frame shared by main-tree and ascendancy nodes stays blocking.
function collectOwnedUrls(): Map<string, { owner: string | null; tier: SpriteTier }> {
  const meta = new Map<string, { owner: string | null; tier: SpriteTier }>();
  const add = (url: string | undefined, owner: string | null, tier: SpriteTier): void => {
    const m = url ? meta.get(url) : undefined;
    if (!url) return;
    if (!m) {
      meta.set(url, { owner, tier });
      return;
    }
    if (m.owner !== owner) m.owner = null; // referenced from two owners → shared
    if (tier < m.tier) m.tier = tier;
  };
  for (const id in TREE.nodes) {
    const n = TREE.nodes[id];
    if (!n) continue;  // noUncheckedIndexedAccess: TREE.nodes[id] is possibly undefined
    const owner = n.a ? classOfAsc(n.a) : null;
    // Ascendancy nodes live in the side panel — even for the default
    // class every sprite of theirs is flavor, including the heavy
    // shared AscendancyFrame* files (min-tier keeps anything the main
    // tree also uses in blocking).
    const t = (roleTier: SpriteTier): SpriteTier => (n.a ? 2 : roleTier);
    add(n.i, owner, t(1));
    add(n.f0, owner, t(0));
    add(n.f1, owner, t(0));
    add(n.me, owner, 2);
    if (n.o) for (const o of n.o) add(o.i, owner, t(1));
  }
  for (const cn in TREE.class_portraits) add(TREE.class_portraits[cn], cn, 2);
  for (const an in TREE.asc_panels) add(TREE.asc_panels[an]?.p, classOfAsc(an), 2);
  // Variant-ascendancy override icons (Abyssal Lich) — referenced only
  // via TREE.asc_variants, so the node loop above never sees them.
  // Without this they're absent from texCache and the panel bake
  // silently skips them (nodes render frameless/iconless).
  for (const v in (TREE.asc_variants ?? {})) {
    const owner = classOfAsc(v);
    const nodes = TREE.asc_variants![v]!.nodes;
    for (const id in nodes) {
      add(nodes[id]!.i, owner, 2);
    }
  }
  add(TREE.bgtree, null, 0);
  add(TREE.bgtree_active, null, 0);
  add(TREE.bg_tile, null, 0);
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
        add("/assets/sprites/" + prefix + "_orbit_" + stateName + idx + ".png", null, 0);
      }
    }
  }
  return meta;
}

// The boot-owned sprites (main tree, shared chrome, default class's
// art) split by loading tier. Boot blocks first paint on `blocking`
// only; `icons` then `flavor` stream in behind it (see boot).
export function collectSpriteTiers(): { blocking: string[]; icons: string[]; flavor: string[] } {
  const def = defaultClassName();
  const tiers = { blocking: [] as string[], icons: [] as string[], flavor: [] as string[] };
  for (const [url, m] of collectOwnedUrls()) {
    if (m.owner !== null && m.owner !== def) continue; // other classes: 04g lazy path
    (m.tier === 0 ? tiers.blocking : m.tier === 1 ? tiers.icons : tiers.flavor).push(url);
  }
  return tiers;
}

// Deferred art grouped by owning class (the default class is excluded
// — its art rides the boot tiers above). Consumed by lazy_art.ts.
export function lazyClassUrls(): Map<string, string[]> {
  const def = defaultClassName();
  const map = new Map<string, string[]>();
  for (const [url, m] of collectOwnedUrls()) {
    if (m.owner === null || m.owner === def) continue;
    let arr = map.get(m.owner);
    if (!arr) {
      arr = [];
      map.set(m.owner, arr);
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
