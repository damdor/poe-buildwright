// ============================================================================
// === Codified GGG .build schema — versioned, frozen ========================
// ============================================================================
// The GGG .build field mapping lives HERE and nowhere else. Both sides
// of the interop boundary derive from these tables:
//
//   * import: validateGGGBuild (build_io) runs the walker in
//     'import' mode — lenient on unknown fields (GGG may add some),
//     strict on the types of fields we know.
//   * export: planToGGGBuild runs the walker in 'export' mode over its
//     own output and THROWS on any mismatch — an unknown field, a
//     missing required field, a deprecated alias, a short-form
//     interval. The exporter physically cannot drift from the schema
//     without failing the moment anyone exports.
//
// VERSIONING POLICY — revisions are append-only:
//   * V1 below is FROZEN (deep-frozen at runtime, too). Never edit it.
//   * When GGG changes the format, add a V2 table, point
//     GGG_BUILD_SCHEMA_CURRENT at it, and keep V1 so old files keep
//     validating against the revision they were written under.
//   * Fields WE add beyond GGG's schema are marked `ours: true` —
//     legal to emit, documented as extensions. Fields our old exports
//     used that GGG never had are `importAlias: true` — accepted on
//     import, forbidden on export.
//
// The prose companion (with citations + change log) is
// docs/build_planner_format.md.

// ---------------------------------------------------------------------------
// Spec vocabulary
// ---------------------------------------------------------------------------

/** Leaf field types the walker understands. */
export type GGGFieldType =
  | 'string'      // JSON string
  | 'id'          // GGG table id: export emits strings; import tolerates numbers
  | 'uint'        // non-negative integer
  | 'interval'    // GGG's "(array of uint, or uint)"; export pins [lo, hi]
  | 'weapon_set'  // literal 1 | 2
  | { arrayOf: string; bareIds?: 'string' | 'string-or-number' };

export interface GGGFieldSpec {
  type: GGGFieldType;
  /** 'always': both directions need it (ids the importer dereferences).
   *  'export': our emitter must write it, but a foreign file missing
   *  it still imports (e.g. root `name` — the client falls back to
   *  the filename, and so do we). */
  required?: 'always' | 'export';
  /** Our extension — not in GGG's schema; the client ignores it. */
  ours?: boolean;
  /** Legacy alias: accepted on import, forbidden on export. */
  importAlias?: boolean;
}

export interface GGGObjectSpec {
  fields: Record<string, GGGFieldSpec>;
}

export interface GGGBuildSchema {
  rev: number;
  /** What this mapping was verified against, and when. */
  verifiedAgainst: string;
  root: GGGObjectSpec;
  objects: Record<string, GGGObjectSpec>;
}

// ---------------------------------------------------------------------------
// Revision 1 — FROZEN. Do not edit; add a V2 instead.
// ---------------------------------------------------------------------------

const V1: GGGBuildSchema = {
  rev: 1,
  verifiedAgainst:
    'pathofexile.com/developer/docs "Version 1 (Experimental)" + 0.5.1-0.5.4 ' +
    'patch notes, audited 2026-07-10 at game patch 0.5.4',
  root: {
    fields: {
      name:            { type: 'string', required: 'export' },
      author:          { type: 'string' },
      link:            { type: 'string' }, // 0.5.3+, whitelisted domains render a button
      description:     { type: 'string' },
      ascendancy:      { type: 'string' },
      patch:           { type: 'string', ours: true },
      passives:        { type: { arrayOf: 'BuildPassive', bareIds: 'string-or-number' } },
      skills:          { type: { arrayOf: 'BuildSkill' } },
      inventory_slots: { type: { arrayOf: 'InventorySlot' } },
      items:           { type: { arrayOf: 'InventorySlot' }, importAlias: true },
    },
  },
  objects: {
    BuildPassive: {
      fields: {
        id:              { type: 'id', required: 'always' },
        weapon_set:      { type: 'weapon_set' },
        level_interval:  { type: 'interval' },
        additional_text: { type: 'string' },
      },
    },
    BuildSkill: {
      fields: {
        id:              { type: 'string', required: 'always' },
        level:           { type: 'uint', ours: true },
        quality:         { type: 'uint', ours: true },
        weapon_set:      { type: 'weapon_set', ours: true },
        level_interval:  { type: 'interval' },
        additional_text: { type: 'string' },
        support_skills:  { type: { arrayOf: 'BuildSupport', bareIds: 'string' } },
      },
    },
    BuildSupport: {
      fields: {
        id:              { type: 'string', required: 'always' },
        level:           { type: 'uint', ours: true },
        quality:         { type: 'uint', ours: true },
        level_interval:  { type: 'interval' },
        additional_text: { type: 'string' },
      },
    },
    InventorySlot: {
      fields: {
        inventory_id:    { type: 'string', required: 'always' },
        slot_x:          { type: 'uint' },
        slot_y:          { type: 'uint' },
        x:               { type: 'uint', importAlias: true },
        y:               { type: 'uint', importAlias: true },
        unique_name:     { type: 'string' },
        level_interval:  { type: 'interval' },
        additional_text: { type: 'string' },
      },
    },
  },
};

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(obj);
  }
  return obj;
}

/** All known schema revisions, frozen. Append-only. */
export const GGG_BUILD_SCHEMAS: Readonly<Record<number, GGGBuildSchema>> =
  deepFreeze({ 1: V1 });

/** The revision the exporter targets today. */
export const GGG_BUILD_SCHEMA_CURRENT = 1;

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

export type GGGCheckMode = 'import' | 'export';

/** Check `d` against schema revision `rev`. Returns a human-readable
 *  problem description, or null when conformant.
 *
 *  import mode: unknown fields ignored, `required` not enforced (we
 *  degrade gracefully), numbers accepted for 'id', all documented
 *  interval short-forms accepted.
 *
 *  export mode: unknown fields are errors, `required` enforced,
 *  importAlias fields are errors, ids must be strings, intervals must
 *  be exactly the two-element [lo, hi] form our exporter promises. */
export function checkGGGBuild(d: unknown, rev: number, mode: GGGCheckMode): string | null {
  const schema = GGG_BUILD_SCHEMAS[rev];
  if (!schema) return 'unknown .build schema revision ' + rev;
  return checkObject(d, schema.root, schema, mode, '');
}

function checkObject(
  value: unknown,
  spec: GGGObjectSpec,
  schema: GGGBuildSchema,
  mode: GGGCheckMode,
  path: string,
): string | null {
  const at = path || 'root';
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return at + ' must be a JSON object';
  }
  const r = value as Record<string, unknown>;
  if (mode === 'export') {
    for (const key of Object.keys(r)) {
      const f = spec.fields[key];
      if (!f) return at + ': unexpected field "' + key + '" (not in schema)';
      if (f.importAlias) return at + ': "' + key + '" is an import-only legacy alias';
    }
  }
  for (const [key, f] of Object.entries(spec.fields)) {
    const missing = r[key] === undefined;
    if (!missing) continue;
    if (f.required === 'always' || (f.required === 'export' && mode === 'export')) {
      return at + ': missing required "' + key + '"';
    }
  }
  for (const [key, f] of Object.entries(spec.fields)) {
    const v = r[key];
    if (v === undefined) continue;
    const err = checkField(v, f, schema, mode, path ? path + '.' + key : key);
    if (err) return err;
  }
  return null;
}

function checkField(
  v: unknown,
  f: GGGFieldSpec,
  schema: GGGBuildSchema,
  mode: GGGCheckMode,
  path: string,
): string | null {
  const t = f.type;
  if (t === 'string') {
    return typeof v === 'string' ? null : path + ' must be a string';
  }
  if (t === 'id') {
    if (typeof v === 'string') return null;
    if (mode === 'import' && typeof v === 'number') return null;
    return path + ' must be an id string' + (mode === 'import' ? ' or number' : '');
  }
  if (t === 'uint') {
    if (typeof v !== 'number') return path + ' must be a number';
    if (mode === 'export' && (!Number.isInteger(v) || v < 0)) {
      return path + ' must be a non-negative integer';
    }
    return null;
  }
  if (t === 'interval') {
    if (mode === 'export') {
      // Our exporter promises the canonical two-element form.
      if (!Array.isArray(v) || v.length !== 2
          || !Number.isInteger(v[0]) || !Number.isInteger(v[1])
          || (v[0] as number) < 0 || (v[1] as number) < (v[0] as number)) {
        return path + ' must be [lo, hi] with 0 <= lo <= hi on export';
      }
      return null;
    }
    if (typeof v === 'number') return null;
    if (Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === 'number')) return null;
    return path + ' must be [low, high], [low], or a number';
  }
  if (t === 'weapon_set') {
    return v === 1 || v === 2 ? null : path + ' must be 1 or 2';
  }
  // Array of schema objects, optionally with bare-id entries.
  if (!Array.isArray(v)) return path + ' must be an array';
  const entrySpec = schema.objects[t.arrayOf];
  if (!entrySpec) return path + ': schema bug — unknown object "' + t.arrayOf + '"';
  for (let i = 0; i < v.length; i++) {
    const entry = v[i];
    if (typeof entry === 'string' && t.bareIds) continue;
    if (typeof entry === 'number' && t.bareIds === 'string-or-number') {
      if (mode === 'export') return path + '[' + i + ']: export emits string ids, got number';
      continue;
    }
    const err = checkObject(entry, entrySpec, schema, mode, path + '[' + i + ']');
    if (err) return err;
  }
  return null;
}
