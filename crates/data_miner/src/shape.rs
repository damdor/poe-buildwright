//! Per-dataset shapers — join raw GGG tables into the site's schemas.
//!
//! Where [`crate::mine`] dumps one table per file (self-describing but
//! flat), a *shaper* joins several tables into one of the datasets the
//! planner consumes (e.g. `items/bases.tsv` = `BaseItemTypes` plus the
//! stat/requirement tables keyed by it). This is deliberately one shape
//! at a time; more land incrementally.
//!
//! ## Performance
//!
//! [`TableSet`] holds each needed table's decompressed bytes + schema
//! once. Joins are O(1): a forward `foreignrow` is a direct row index
//! into the target; a *reverse* join (find the row keyed by this base)
//! uses a [`TableSet::reverse_index`] `HashMap` built in a single pass.
//! A shaper is then one linear scan of its primary table.

use std::collections::HashMap;

use crate::dat::{Dat, NULL_ROW, TableSchema};

#[derive(Debug)]
pub enum ShapeError {
    /// A table the shaper needs wasn't loaded into the [`TableSet`].
    MissingTable(&'static str),
    /// The table's schema is missing a column the shaper reads (schema
    /// drift — surfaced rather than silently emitting blanks).
    MissingColumn(&'static str, &'static str),
}

impl std::fmt::Display for ShapeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingTable(t) => write!(f, "shape: required table {t} not loaded"),
            Self::MissingColumn(t, c) => write!(f, "shape: {t} has no column {c}"),
        }
    }
}

impl std::error::Error for ShapeError {}

/// A set of decompressed tables (bytes + schema) available to a shaper.
#[derive(Default)]
pub struct TableSet {
    tables: HashMap<String, (Vec<u8>, TableSchema)>,
}

impl TableSet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, name: &str, bytes: Vec<u8>, schema: TableSchema) {
        self.tables.insert(name.to_string(), (bytes, schema));
    }

    pub fn has(&self, name: &str) -> bool {
        self.tables.contains_key(name)
    }

    /// Parse a loaded table (cheap — validates the magic + slices; no
    /// per-row work). Returns `None` if the table wasn't loaded or the
    /// schema doesn't fit it.
    pub fn dat(&self, name: &str) -> Option<Dat<'_>> {
        let (b, s) = self.tables.get(name)?;
        Dat::parse(b, s).ok()
    }

    pub fn schema(&self, name: &str) -> Option<&TableSchema> {
        self.tables.get(name).map(|(_, s)| s)
    }

    /// `Id` (or first string column) per row index — for resolving
    /// foreign references to a readable id.
    pub fn id_list(&self, name: &str) -> Vec<String> {
        match (self.dat(name), self.schema(name)) {
            (Some(d), Some(s)) => crate::mine::id_column(&d, s),
            _ => Vec::new(),
        }
    }

    /// Reverse join: `foreign-column value → first row` for `table`.
    /// e.g. `reverse_index("ArmourTypes", "BaseItemType")` maps a base's
    /// row id → its ArmourTypes row. Built in one pass.
    pub fn reverse_index(&self, table: &str, col: &str) -> HashMap<u64, usize> {
        let mut idx = HashMap::new();
        if let (Some(d), Some(s)) = (self.dat(table), self.schema(table))
            && let Some(c) = s.column(col)
        {
            for r in 0..d.row_count() {
                if let Ok(Some(v)) = d.foreign(r, c) {
                    idx.entry(v).or_insert(r);
                }
            }
        }
        idx
    }
}

/// Every row's value of a named string column, indexed by row — for
/// resolving a foreign row to a specific field (not just its `Id`).
fn column_strings(ts: &TableSet, table: &str, col: &str) -> Vec<String> {
    match (ts.dat(table), ts.schema(table).and_then(|s| s.column(col))) {
        (Some(d), Some(c)) => (0..d.row_count())
            .map(|r| d.string(r, c).unwrap_or_default())
            .collect(),
        _ => Vec::new(),
    }
}

/// Read an i32 from a reverse-joined stat table, empty if the base has
/// no such row or the table/column is absent.
fn joined_i32(
    dat: &Option<Dat<'_>>,
    schema: Option<&TableSchema>,
    idx: &HashMap<u64, usize>,
    base_row: usize,
    col: &str,
) -> String {
    if let (Some(d), Some(s)) = (dat, schema)
        && let Some(&r) = idx.get(&(base_row as u64))
        && let Some(c) = s.column(col)
    {
        return d.i32(r, c).map(|v| v.to_string()).unwrap_or_default();
    }
    String::new()
}

/// Raw referenced row ids of a foreignrow-array cell (nulls dropped) —
/// for joins where we index the target ourselves rather than resolve to
/// a string.
fn array_foreign_rows(dat: &Dat<'_>, row: usize, col: usize) -> Vec<u64> {
    let Ok((count, offset)) = dat.array_ref(row, col) else {
        return Vec::new();
    };
    let var = dat.var();
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let eo = offset + i * 16; // foreignrow element = u64 rowid + u64 pad
        if let Some(b) = var.get(eo..eo + 8) {
            let rid = u64::from_le_bytes(b.try_into().unwrap());
            if rid != NULL_ROW {
                out.push(rid);
            }
        }
    }
    out
}

/// Elements of an `i32[]` array cell (4 bytes each) — e.g. the weights
/// that run parallel to a foreignrow-tag array.
fn array_i32(dat: &Dat<'_>, row: usize, col: usize) -> Vec<i32> {
    let Ok((count, offset)) = dat.array_ref(row, col) else {
        return Vec::new();
    };
    let var = dat.var();
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let eo = offset + i * 4;
        if let Some(b) = var.get(eo..eo + 4) {
            out.push(i32::from_le_bytes(b.try_into().unwrap()));
        }
    }
    out
}

/// Row index of the first element of a foreignrow-array cell (or None if
/// empty). Used to follow a gem's primary `GemEffects[0]` into the skill
/// tables. Element layout mirrors `array_ids`: u64 rowid + u64 pad.
fn first_arr_row(dat: &Dat<'_>, row: usize, col: usize) -> Option<usize> {
    let (count, offset) = dat.array_ref(row, col).ok()?;
    if count == 0 {
        return None;
    }
    let b = dat.var().get(offset..offset + 8)?;
    Some(u64::from_le_bytes(b.try_into().ok()?) as usize)
}

/// All row indices of a foreignrow-array cell (element layout as in
/// `array_ids`: u64 rowid + u64 pad).
fn arr_rows(dat: &Dat<'_>, row: usize, col: usize) -> Vec<usize> {
    let Ok((count, offset)) = dat.array_ref(row, col) else {
        return Vec::new();
    };
    let var = dat.var();
    (0..count)
        .filter_map(|i| {
            let b = var.get(offset + i * 16..offset + i * 16 + 8)?;
            Some(u64::from_le_bytes(b.try_into().ok()?) as usize)
        })
        .collect()
}

/// Expand a foreignrow-array column into `a|b|c` of resolved ids.
fn array_ids(dat: &Dat<'_>, row: usize, col: usize, ids: &[String]) -> String {
    let Ok((count, offset)) = dat.array_ref(row, col) else {
        return String::new();
    };
    let var = dat.var();
    let mut parts = Vec::with_capacity(count);
    for i in 0..count {
        let eo = offset + i * 16; // foreignrow element = u64 rowid + u64 pad
        if let Some(b) = var.get(eo..eo + 8) {
            let rid = u64::from_le_bytes(b.try_into().unwrap()) as usize;
            match ids.get(rid) {
                Some(id) if !id.is_empty() => parts.push(id.clone()),
                _ => parts.push(format!("#{rid}")),
            }
        }
    }
    parts.join("|")
}

/// `items/bases.tsv` (first-party): `BaseItemTypes` joined to the stat
/// and requirement tables keyed by it. One row per base item.
pub fn shape_bases(ts: &TableSet) -> Result<String, ShapeError> {
    let bit = ts
        .dat("BaseItemTypes")
        .ok_or(ShapeError::MissingTable("BaseItemTypes"))?;
    let bs = ts
        .schema("BaseItemTypes")
        .ok_or(ShapeError::MissingTable("BaseItemTypes"))?;
    let col = |n: &'static str| {
        bs.column(n)
            .ok_or(ShapeError::MissingColumn("BaseItemTypes", n))
    };
    let c_id = col("Id")?;
    let c_name = col("Name")?;
    let c_class = col("ItemClass")?;
    let c_w = col("Width")?;
    let c_h = col("Height")?;
    let c_drop = col("DropLevel")?;
    let c_corrupt = col("IsCorrupted")?;
    let c_tags = col("Tags")?;
    let c_impl = col("Implicit_Mods")?;
    let c_iv = col("ItemVisualIdentity")?;
    // Base inventory art: BaseItemType → ItemVisualIdentity.DDSFile —
    // the same chain that resolves 100% of gems.
    let iv = ts.dat("ItemVisualIdentity");
    let iv_dds = ts
        .schema("ItemVisualIdentity")
        .and_then(|sch| sch.column("DDSFile"));

    let class_ids = ts.id_list("ItemClasses");
    let tag_ids = ts.id_list("Tags");
    let mod_ids = ts.id_list("Mods");

    // Reverse joins to the stat tables (all keyed by BaseItemType).
    let armour_i = ts.reverse_index("ArmourTypes", "BaseItemType");
    let req_i = ts.reverse_index("AttributeRequirements", "BaseItemType");
    let weapon_i = ts.reverse_index("WeaponTypes", "BaseItemType");
    let flask_i = ts.reverse_index("Flasks", "BaseItemType");
    let shield_i = ts.reverse_index("ShieldTypes", "BaseItemType");
    let (d_armour, s_armour) = (ts.dat("ArmourTypes"), ts.schema("ArmourTypes"));
    let (d_req, s_req) = (
        ts.dat("AttributeRequirements"),
        ts.schema("AttributeRequirements"),
    );
    let (d_weapon, s_weapon) = (ts.dat("WeaponTypes"), ts.schema("WeaponTypes"));
    let (d_flask, s_flask) = (ts.dat("Flasks"), ts.schema("Flasks"));
    let (d_shield, s_shield) = (ts.dat("ShieldTypes"), ts.schema("ShieldTypes"));

    let mut out = String::with_capacity(bit.row_count() * 128);
    out.push_str(
        "id\tname\titem_class\twidth\theight\tdrop_level\tcorrupted\ttags\timplicit_mods\t\
         req_str\treq_dex\treq_int\tarmour\tevasion\tenergy_shield\tward\tblock\t\
         crit_chance\tattack_speed\tdamage_min\tdamage_max\tweapon_range\t\
         flask_life\tflask_mana\tflask_recovery\ticon_dds\n",
    );

    let g = |r: Result<String, crate::dat::DatError>| r.unwrap_or_default();
    for row in 0..bit.row_count() {
        let class = match bit.foreign(row, c_class) {
            Ok(Some(rid)) => class_ids.get(rid as usize).cloned().unwrap_or_default(),
            _ => String::new(),
        };
        let fields = [
            g(bit.string(row, c_id)),
            g(bit.string(row, c_name)),
            class,
            g(bit.i32(row, c_w).map(|v| v.to_string())),
            g(bit.i32(row, c_h).map(|v| v.to_string())),
            g(bit.i32(row, c_drop).map(|v| v.to_string())),
            g(bit.bool(row, c_corrupt).map(|b| b.to_string())),
            array_ids(&bit, row, c_tags, &tag_ids),
            array_ids(&bit, row, c_impl, &mod_ids),
            joined_i32(&d_req, s_req, &req_i, row, "ReqStr"),
            joined_i32(&d_req, s_req, &req_i, row, "ReqDex"),
            joined_i32(&d_req, s_req, &req_i, row, "ReqInt"),
            joined_i32(&d_armour, s_armour, &armour_i, row, "Armour"),
            joined_i32(&d_armour, s_armour, &armour_i, row, "Evasion"),
            joined_i32(&d_armour, s_armour, &armour_i, row, "EnergyShield"),
            joined_i32(&d_armour, s_armour, &armour_i, row, "Ward"),
            joined_i32(&d_shield, s_shield, &shield_i, row, "Block"),
            joined_i32(&d_weapon, s_weapon, &weapon_i, row, "CritChance"),
            joined_i32(&d_weapon, s_weapon, &weapon_i, row, "Speed"),
            joined_i32(&d_weapon, s_weapon, &weapon_i, row, "DamageMin"),
            joined_i32(&d_weapon, s_weapon, &weapon_i, row, "DamageMax"),
            joined_i32(&d_weapon, s_weapon, &weapon_i, row, "RangeMax"),
            joined_i32(&d_flask, s_flask, &flask_i, row, "LifePerUse"),
            joined_i32(&d_flask, s_flask, &flask_i, row, "ManaPerUse"),
            joined_i32(&d_flask, s_flask, &flask_i, row, "RecoveryTime"),
            match (&iv, iv_dds, bit.foreign(row, c_iv)) {
                (Some(iv), Some(c), Ok(Some(ivr))) => {
                    iv.string(ivr as usize, c).unwrap_or_default()
                }
                _ => String::new(),
            },
        ];
        // Sanitise + join (fields never contain tabs; ids/names may not
        // contain newlines, but be safe).
        for (j, field) in fields.iter().enumerate() {
            if j > 0 {
                out.push('\t');
            }
            if field.contains(['\t', '\n', '\r']) {
                out.push_str(&field.replace(['\t', '\n', '\r'], " "));
            } else {
                out.push_str(field);
            }
        }
        out.push('\n');
    }
    Ok(out)
}

/// Tables `shape_bases` needs loaded in its [`TableSet`].
pub const BASES_TABLES: &[&str] = &[
    "BaseItemTypes",
    "ItemClasses",
    "Tags",
    "Mods",
    "ArmourTypes",
    "AttributeRequirements",
    "WeaponTypes",
    "Flasks",
    "ShieldTypes",
    "ItemVisualIdentity",
];

/// GGG gem colour → PoB-style attribute code.
fn gem_colour_name(c: i32) -> &'static str {
    match c {
        1 => "str",
        2 => "dex",
        3 => "int",
        _ => "",
    }
}

/// `skills/gems.tsv` (first-party): `SkillGems` (gem-specific data)
/// joined forward to its `BaseItemTypes` row (the gem item — id, name,
/// tags). One row per gem.
pub fn shape_gems(ts: &TableSet) -> Result<String, ShapeError> {
    let sg = ts
        .dat("SkillGems")
        .ok_or(ShapeError::MissingTable("SkillGems"))?;
    let ss = ts
        .schema("SkillGems")
        .ok_or(ShapeError::MissingTable("SkillGems"))?;
    let scol = |n: &'static str| {
        ss.column(n)
            .ok_or(ShapeError::MissingColumn("SkillGems", n))
    };
    let c_base = scol("BaseItemType")?;
    let c_str = scol("StrengthRequirementPercent")?;
    let c_dex = scol("DexterityRequirementPercent")?;
    let c_int = scol("IntelligenceRequirementPercent")?;
    let c_colour = scol("GemColour")?;
    let c_type = scol("GemType")?;
    let c_tier = scol("Tier")?;
    let c_minlvl = scol("MinLevelReq")?;
    let c_vaal = scol("IsVaalVariant")?;
    let c_effects = scol("GemEffects")?;

    let bit = ts
        .dat("BaseItemTypes")
        .ok_or(ShapeError::MissingTable("BaseItemTypes"))?;
    let bs = ts
        .schema("BaseItemTypes")
        .ok_or(ShapeError::MissingTable("BaseItemTypes"))?;
    let bcol = |n: &'static str| {
        bs.column(n)
            .ok_or(ShapeError::MissingColumn("BaseItemTypes", n))
    };
    let b_id = bcol("Id")?;
    let b_name = bcol("Name")?;
    let b_tags = bcol("Tags")?;
    let b_iv = bcol("ItemVisualIdentity")?;
    // Gem inventory art: BaseItemType → ItemVisualIdentity.DDSFile
    // (resolves for 100% of gems — the audit-proven chain).
    let iv = ts.dat("ItemVisualIdentity");
    let iv_dds = ts
        .schema("ItemVisualIdentity")
        .and_then(|sch| sch.column("DDSFile"));

    let tag_ids = ts.id_list("Tags");
    let effect_ids = ts.id_list("GemEffects");

    // Gem → primary skill link: the gem's first GemEffect names a
    // GrantedEffect (the skill it grants). The wizard's support-
    // compatibility filter joins on this id against active_skills /
    // support_skills. Best-effort — a gem with no effects has none.
    let ge = ts.dat("GemEffects");
    let ge_granted_col = ts
        .schema("GemEffects")
        .and_then(|s| s.column("GrantedEffect"));
    let granted_ids = ts.id_list("GrantedEffects");
    let granted_row_of = |row: usize| -> Option<usize> {
        let (ge, gc) = (ge.as_ref()?, ge_granted_col?);
        first_arr_row(&sg, row, c_effects)
            .and_then(|ger| ge.foreign(ger, gc).ok().flatten())
            .map(|grr| grr as usize)
    };
    let granted_of = |row: usize| -> String {
        granted_row_of(row)
            .and_then(|grr| granted_ids.get(grr).cloned())
            .unwrap_or_default()
    };

    // Display PARTS of a skill: a granted effect can have several stat
    // sets, each with its own label — "Projectile" + "Explosion" for
    // Firebolt, "Acidic Burst" for Acidic Concoction. The in-game gem
    // popup shows these as separate stat sections; we surface the
    // labels so consumers can say what a gem actually consists of.
    // Join: GrantedEffectStatSetsPerLevel (GemLevel=1 rows) → StatSet →
    // Label → GrantedEffectLabels.Text, grouped by the row's
    // GrantedEffects array. Best-effort — column stays empty if the
    // three tables weren't loaded.
    let mut parts_of: std::collections::HashMap<usize, Vec<String>> =
        std::collections::HashMap::new();
    if let (Some(sspl), Some(sspl_s), Some(sets), Some(sets_s), Some(lab), Some(lab_s)) = (
        ts.dat("GrantedEffectStatSetsPerLevel"),
        ts.schema("GrantedEffectStatSetsPerLevel"),
        ts.dat("GrantedEffectStatSets"),
        ts.schema("GrantedEffectStatSets"),
        ts.dat("GrantedEffectLabels"),
        ts.schema("GrantedEffectLabels"),
    ) && let (Some(c_ss), Some(c_lvl), Some(c_ge2), Some(c_label), Some(c_text)) = (
        sspl_s.column("StatSet"),
        sspl_s.column("GemLevel"),
        sspl_s.column("GrantedEffects"),
        sets_s.column("Label"),
        lab_s.column("Text"),
    ) {
        let mut seen: std::collections::HashSet<(usize, usize)> =
            std::collections::HashSet::new();
        for row in 0..sspl.row_count() {
            if sspl.i32(row, c_lvl).unwrap_or(0) != 1 {
                continue;
            }
            let Ok(Some(ssr)) = sspl.foreign(row, c_ss) else { continue };
            let ssr = ssr as usize;
            let text = sets
                .foreign(ssr, c_label)
                .ok()
                .flatten()
                .and_then(|lr| lab.string(lr as usize, c_text).ok())
                .unwrap_or_default();
            if text.is_empty() || text == "Hidden" || text == "Shown" {
                continue;
            }
            for grr in arr_rows(&sspl, row, c_ge2) {
                if seen.insert((grr, ssr)) {
                    parts_of.entry(grr).or_default().push(text.clone());
                }
            }
        }
    }

    let mut out = String::with_capacity(sg.row_count() * 96);
    out.push_str(
        "id\tname\ttags\tgem_colour\tcolour_name\tgem_type\ttier\tmin_level\t\
         req_str_pct\treq_dex_pct\treq_int_pct\tis_vaal\tgem_effects\tgranted_effect_id\ticon_dds\tparts\n",
    );

    let g = |r: Result<String, crate::dat::DatError>| r.unwrap_or_default();
    for row in 0..sg.row_count() {
        // Forward join to the gem's base item (id / name / tags / art).
        let (id, name, tags, icon_dds) = match sg.foreign(row, c_base) {
            Ok(Some(br)) => {
                let br = br as usize;
                let dds = match (&iv, iv_dds, bit.foreign(br, b_iv)) {
                    (Some(iv), Some(c), Ok(Some(ivr))) => {
                        iv.string(ivr as usize, c).unwrap_or_default()
                    }
                    _ => String::new(),
                };
                (
                    g(bit.string(br, b_id)),
                    g(bit.string(br, b_name)),
                    array_ids(&bit, br, b_tags, &tag_ids),
                    dds,
                )
            }
            _ => (String::new(), String::new(), String::new(), String::new()),
        };
        let colour = sg.i32(row, c_colour).unwrap_or(0);
        let fields = [
            id,
            name,
            tags,
            colour.to_string(),
            gem_colour_name(colour).to_string(),
            g(sg.i32(row, c_type).map(|v| v.to_string())),
            g(sg.i32(row, c_tier).map(|v| v.to_string())),
            g(sg.i32(row, c_minlvl).map(|v| v.to_string())),
            g(sg.i32(row, c_str).map(|v| v.to_string())),
            g(sg.i32(row, c_dex).map(|v| v.to_string())),
            g(sg.i32(row, c_int).map(|v| v.to_string())),
            g(sg.bool(row, c_vaal).map(|b| b.to_string())),
            array_ids(&sg, row, c_effects, &effect_ids),
            granted_of(row),
            icon_dds,
            granted_row_of(row)
                .and_then(|grr| parts_of.get(&grr))
                .map(|v| v.join("|"))
                .unwrap_or_default(),
        ];
        for (j, field) in fields.iter().enumerate() {
            if j > 0 {
                out.push('\t');
            }
            if field.contains(['\t', '\n', '\r']) {
                out.push_str(&field.replace(['\t', '\n', '\r'], " "));
            } else {
                out.push_str(field);
            }
        }
        out.push('\n');
    }
    Ok(out)
}

/// Tables `shape_gems` needs loaded in its [`TableSet`].
pub const GEMS_TABLES: &[&str] = &[
    "SkillGems",
    "BaseItemTypes",
    "Tags",
    "GemEffects",
    "GrantedEffectStatSets",
    "GrantedEffectStatSetsPerLevel",
    "GrantedEffectLabels",
    "GrantedEffects",
    "ItemVisualIdentity",
];

/// Expand a foreignrow-array column at a fixed cell into `a|b|c`. Same
/// as [`array_ids`] but takes the column index (used across tables).
#[inline]
fn resolve_array(dat: &Dat<'_>, row: usize, col: usize, ids: &[String]) -> String {
    array_ids(dat, row, col, ids)
}

/// `skills/active_skills.tsv` (first-party): `ActiveSkills`, with cast
/// time reverse-joined from the skill's `GrantedEffects` row.
pub fn shape_active_skills(ts: &TableSet) -> Result<String, ShapeError> {
    let a = ts
        .dat("ActiveSkills")
        .ok_or(ShapeError::MissingTable("ActiveSkills"))?;
    let sa = ts
        .schema("ActiveSkills")
        .ok_or(ShapeError::MissingTable("ActiveSkills"))?;
    let col = |n: &'static str| {
        sa.column(n)
            .ok_or(ShapeError::MissingColumn("ActiveSkills", n))
    };
    let c_id = col("Id")?;
    let c_name = col("DisplayedName")?;
    let c_desc = col("Description")?;
    let c_types = col("ActiveSkillTypes")?;
    let c_wreq = col("WeaponRequirements")?;
    let c_manual = col("IsManuallyCasted")?;
    let c_hidden = col("HideOnWebsite")?;

    let type_ids = ts.id_list("ActiveSkillType");
    let wreq_ids = ts.id_list("ActiveSkillWeaponRequirement");
    // Cast time lives on the GrantedEffects row that points back here.
    let ge_by_active = ts.reverse_index("GrantedEffects", "ActiveSkill");
    let (d_ge, s_ge) = (ts.dat("GrantedEffects"), ts.schema("GrantedEffects"));
    // The id of that GrantedEffects row — the wizard joins a gem's
    // `granted_effect_id` (from shape_gems) against this, so its
    // support-compatibility filter can read the skill's types.
    let granted_ids = ts.id_list("GrantedEffects");

    let mut out = String::with_capacity(a.row_count() * 128);
    out.push_str(
        "skill_id\tname\tdescription\tcast_time\tskill_types\tweapon_req\t\
         is_manually_casted\thidden\tcategory\tgranted_effect_id\n",
    );
    let g = |r: Result<String, crate::dat::DatError>| r.unwrap_or_default();
    for row in 0..a.row_count() {
        let weapon_req = match a.foreign(row, c_wreq) {
            Ok(Some(rid)) => wreq_ids.get(rid as usize).cloned().unwrap_or_default(),
            _ => String::new(),
        };
        let granted_effect_id = ge_by_active
            .get(&(row as u64))
            .and_then(|&gr| granted_ids.get(gr).cloned())
            .unwrap_or_default();
        let fields = [
            g(a.string(row, c_id)),
            g(a.string(row, c_name)),
            g(a.string(row, c_desc)),
            joined_i32(&d_ge, s_ge, &ge_by_active, row, "CastTime"),
            resolve_array(&a, row, c_types, &type_ids),
            weapon_req,
            g(a.bool(row, c_manual).map(|b| b.to_string())),
            g(a.bool(row, c_hidden).map(|b| b.to_string())),
            "active".to_string(),
            granted_effect_id,
        ];
        push_row(&mut out, &fields);
    }
    Ok(out)
}

/// Tables `shape_active_skills` needs.
pub const ACTIVE_SKILLS_TABLES: &[&str] = &[
    "ActiveSkills",
    "ActiveSkillType",
    "ActiveSkillWeaponRequirement",
    "GrantedEffects",
];

/// `skills/buffs.tsv` (first-party): visible buff definitions carrying a
/// display name + tooltip description. Feeds granted-buff tooltips — a
/// tree node that reads "Grants X" / "grant X Auras" (Chronomancer's
/// Sands of Time, Tactician's Embankment Auras, Acolyte's Unravelling,
/// Gemling's Thaumaturgical Dynamism) resolves X against the buff names
/// here. Invisible/nameless/textless buffs are dropped — they carry no
/// user-facing text. Descriptions keep GGG's raw inline markup; the
/// consumer strips it (same convention as active_skills.tsv).
pub fn shape_buffs(ts: &TableSet) -> Result<String, ShapeError> {
    let d = ts
        .dat("BuffDefinitions")
        .ok_or(ShapeError::MissingTable("BuffDefinitions"))?;
    let s = ts
        .schema("BuffDefinitions")
        .ok_or(ShapeError::MissingTable("BuffDefinitions"))?;
    let col = |n: &'static str| {
        s.column(n)
            .ok_or(ShapeError::MissingColumn("BuffDefinitions", n))
    };
    let c_id = col("Id")?;
    let c_name = col("Name")?;
    let c_desc = col("Description")?;
    let c_inv = col("Invisible")?;
    let g = |r: Result<String, crate::dat::DatError>| r.unwrap_or_default();

    let mut out = String::with_capacity(d.row_count() * 64);
    out.push_str("buff_id\tname\tdescription\n");
    for row in 0..d.row_count() {
        // Invisible buffs have no tooltip presence in-game.
        if d.bool(row, c_inv).unwrap_or(false) {
            continue;
        }
        let name = g(d.string(row, c_name));
        let desc = g(d.string(row, c_desc));
        if name.trim().is_empty() || desc.trim().is_empty() {
            continue;
        }
        push_row(&mut out, &[g(d.string(row, c_id)), name, desc]);
    }
    Ok(out)
}

/// Tables `shape_buffs` needs.
pub const BUFFS_TABLES: &[&str] = &["BuffDefinitions"];

/// `tree/asc_overrides.tsv`: variant-ascendancy node CONTENT overrides
/// (currently Abyssal Lich). GGG's tree exports carry no nodes for
/// variant ascendancies — the game reuses the parent panel and swaps
/// node content in place per `AscendancyPassiveSkillOverrides`. One row
/// per override: which base node id shows what name/stats/icon when the
/// variant is the character's ascendancy.
pub fn shape_asc_overrides(
    ts: &TableSet,
    sd: &crate::csd::StatDescriptions,
) -> Result<String, String> {
    let ov = ts
        .dat("AscendancyPassiveSkillOverrides")
        .ok_or("AscendancyPassiveSkillOverrides missing")?;
    let ovs = ts.schema("AscendancyPassiveSkillOverrides").unwrap();
    let ps = ts.dat("PassiveSkills").ok_or("PassiveSkills missing")?;
    let pss = ts.schema("PassiveSkills").unwrap();
    let asc = ts.dat("Ascendancy").ok_or("Ascendancy missing")?;
    let ascs = ts.schema("Ascendancy").unwrap();
    let col = |s: &TableSchema, n: &str, t: &str| -> Result<usize, String> {
        s.column(n).ok_or_else(|| format!("{t}.{n} missing"))
    };
    let (o_asc, o_base, o_over) = (
        col(ovs, "AscendancyToOverrideFor", "ov")?,
        col(ovs, "SkillToOverride", "ov")?,
        col(ovs, "Override", "ov")?,
    );
    let (p_gid, p_name, p_stats, p_icon, p_notable, p_asc) = (
        col(pss, "PassiveSkillGraphId", "ps")?,
        col(pss, "Name", "ps")?,
        col(pss, "Stats", "ps")?,
        col(pss, "Icon_DDSFile", "ps")?,
        col(pss, "IsNotable", "ps")?,
        col(pss, "Ascendancy", "ps")?,
    );
    let value_cols: Vec<Option<usize>> = (1..=5)
        .map(|i| pss.column(&format!("Stat{i}Value")))
        .collect();
    let (a_name, a_char) = (col(ascs, "Name", "asc")?, col(ascs, "Character", "asc")?);
    let stat_ids = ts.id_list("Stats");
    // Class display names (Characters.Name — the id_list gives metadata
    // paths, not names).
    let char_names: Vec<String> = {
        let ch = ts.dat("Characters").ok_or("Characters missing")?;
        let chs = ts.schema("Characters").unwrap();
        let c_n = col(chs, "Name", "Characters")?;
        (0..ch.row_count())
            .map(|r| ch.string(r, c_n).unwrap_or_default())
            .collect()
    };

    // Render a PassiveSkills row's stats via CSD (same approach as
    // shape_tree's node text).
    let render = |row: usize| -> String {
        let Ok((count, offset)) = ps.array_ref(row, p_stats) else {
            return String::new();
        };
        let var = ps.var();
        let pairs: Vec<(String, i64)> = (0..count)
            .filter_map(|i| {
                let eo = offset + i * 16;
                let b = var.get(eo..eo + 8)?;
                let rid = u64::from_le_bytes(b.try_into().ok()?) as usize;
                let id = stat_ids.get(rid)?.clone();
                let v = value_cols
                    .get(i)
                    .and_then(|c| *c)
                    .and_then(|c| ps.i32(row, c).ok())
                    .unwrap_or(0) as i64;
                Some((id, v))
            })
            .collect();
        sd.render(&pairs).join("; ")
    };
    let asc_disp = |r: usize| -> (String, String) {
        let name = asc.string(r, a_name).unwrap_or_default();
        let class = asc
            .foreign(r, a_char)
            .ok()
            .flatten()
            .and_then(|c| char_names.get(c as usize).cloned())
            .unwrap_or_default();
        (name, class)
    };

    let mut out = String::from(
        "variant\tclass\tparent\tbase_node_id\toverride_node_id\tname\tstats\ticon\tkind\n",
    );
    for row in 0..ov.row_count() {
        let (Ok(Some(a_r)), Ok(Some(base_r)), Ok(Some(over_r))) = (
            ov.foreign(row, o_asc),
            ov.foreign(row, o_base),
            ov.foreign(row, o_over),
        ) else {
            continue;
        };
        let (variant, class) = asc_disp(a_r as usize);
        let base_row = base_r as usize;
        let over_row = over_r as usize;
        // Parent panel = the BASE node's ascendancy display name.
        let parent = ps
            .foreign(base_row, p_asc)
            .ok()
            .flatten()
            .map(|r| asc_disp(r as usize).0)
            .unwrap_or_default();
        let base_gid = ps.u16(base_row, p_gid).unwrap_or(0);
        let over_gid = ps.u16(over_row, p_gid).unwrap_or(0);
        let name = ps.string(over_row, p_name).unwrap_or_default();
        let stats = render(over_row);
        let icon = ps.string(over_row, p_icon).unwrap_or_default();
        let kind = if ps.bool(over_row, p_notable).unwrap_or(false) {
            "asc_notable"
        } else {
            "asc_small"
        };
        out.push_str(&format!(
            "{variant}\t{class}\t{parent}\t{base_gid}\t{over_gid}\t{name}\t{stats}\t{icon}\t{kind}\n"
        ));
    }
    Ok(out)
}


/// Map each support `GrantedEffects` row → the display name of the gem
/// item that grants it. A support has no `ActiveSkill`; its name lives on
/// the gem's `BaseItemTypes.Name`, reached by walking every gem's
/// `GemEffects[]` to the `GemEffects.GrantedEffect` it points at. (In 0.5
/// the name fields *on* `GemEffects` are unused — only this chain works.)
fn support_names(ts: &TableSet) -> HashMap<u64, String> {
    let mut out = HashMap::new();
    let (Some(sg), Some(ssch)) = (ts.dat("SkillGems"), ts.schema("SkillGems")) else {
        return out;
    };
    let (Some(fx), Some(fsch)) = (ts.dat("GemEffects"), ts.schema("GemEffects")) else {
        return out;
    };
    let (Some(bit), Some(bsch)) = (ts.dat("BaseItemTypes"), ts.schema("BaseItemTypes")) else {
        return out;
    };
    let (Some(c_base), Some(c_effs)) = (ssch.column("BaseItemType"), ssch.column("GemEffects"))
    else {
        return out;
    };
    let (Some(c_grant), Some(c_name)) = (fsch.column("GrantedEffect"), bsch.column("Name")) else {
        return out;
    };
    for sr in 0..sg.row_count() {
        let name = match sg.foreign(sr, c_base) {
            Ok(Some(brow)) => bit.string(brow as usize, c_name).unwrap_or_default(),
            _ => continue,
        };
        if name.is_empty() {
            continue;
        }
        for fx_row in array_foreign_rows(&sg, sr, c_effs) {
            if let Ok(Some(ge_row)) = fx.foreign(fx_row as usize, c_grant) {
                out.entry(ge_row).or_insert_with(|| name.clone());
            }
        }
    }
    out
}

/// `skills/support_skills.tsv` (first-party): the support half of
/// `GrantedEffects` (`IsSupport`). A support has no `ActiveSkill`, so its
/// name comes from the granting gem item ([`support_names`]) and its
/// reminder text from `GemEffects.SupportText`.
pub fn shape_support_skills(ts: &TableSet) -> Result<String, ShapeError> {
    let ge = ts
        .dat("GrantedEffects")
        .ok_or(ShapeError::MissingTable("GrantedEffects"))?;
    let sg = ts
        .schema("GrantedEffects")
        .ok_or(ShapeError::MissingTable("GrantedEffects"))?;
    let col = |n: &'static str| {
        sg.column(n)
            .ok_or(ShapeError::MissingColumn("GrantedEffects", n))
    };
    let c_id = col("Id")?;
    let c_support = col("IsSupport")?;
    let c_cast = col("CastTime")?;
    let c_allowed = col("AllowedActiveSkillTypes")?;
    let c_added = col("AddedActiveSkillTypes")?;
    let c_excluded = col("ExcludedActiveSkillTypes")?;
    let c_only = col("SupportsGemsOnly")?;
    let c_cannot = col("CannotBeSupported")?;
    let c_ignore = col("IgnoreMinionTypes")?;

    let name_by_ge = support_names(ts);
    // Reminder text: SupportText on the GemEffects row granting this GE.
    let fx_by_grant = ts.reverse_index("GemEffects", "GrantedEffect");
    let fx = ts.dat("GemEffects");
    let fx_text = ts
        .schema("GemEffects")
        .and_then(|s| s.column("SupportText"));
    let type_ids = ts.id_list("ActiveSkillType");

    let mut out = String::with_capacity(ge.row_count() * 96);
    out.push_str(
        "skill_id\tname\tdescription\tcast_time\tskill_types\tadd_skill_types\t\
         exclude_skill_types\tsupports_gems_only\tcannot_be_supported\t\
         ignore_minion_types\tcategory\n",
    );
    let g = |r: Result<String, crate::dat::DatError>| r.unwrap_or_default();
    for row in 0..ge.row_count() {
        if !ge.bool(row, c_support).unwrap_or(false) {
            continue;
        }
        let name = name_by_ge.get(&(row as u64)).cloned().unwrap_or_default();
        let desc = match (&fx, fx_by_grant.get(&(row as u64)), fx_text) {
            (Some(d), Some(&er), Some(c)) => g(d.string(er, c)),
            _ => String::new(),
        };
        let fields = [
            g(ge.string(row, c_id)),
            name,
            desc,
            g(ge.i32(row, c_cast).map(|v| v.to_string())),
            resolve_array(&ge, row, c_allowed, &type_ids),
            resolve_array(&ge, row, c_added, &type_ids),
            resolve_array(&ge, row, c_excluded, &type_ids),
            g(ge.bool(row, c_only).map(|b| b.to_string())),
            g(ge.bool(row, c_cannot).map(|b| b.to_string())),
            g(ge.bool(row, c_ignore).map(|b| b.to_string())),
            "support".to_string(),
        ];
        push_row(&mut out, &fields);
    }
    Ok(out)
}

/// `skills/skill_levels.tsv` (first-party): per-level skill data from
/// `GrantedEffectsPerLevel` (cost, cooldown, actor level) joined to
/// `GrantedEffectStatSetsPerLevel` (crit chance). Mana cost is the
/// `CostAmounts[]` entry whose parallel `GrantedEffects.CostTypes[]` is
/// `Mana`. One row per (skill, level).
pub fn shape_skill_levels(ts: &TableSet) -> Result<String, ShapeError> {
    let gepl = ts
        .dat("GrantedEffectsPerLevel")
        .ok_or(ShapeError::MissingTable("GrantedEffectsPerLevel"))?;
    let s = ts
        .schema("GrantedEffectsPerLevel")
        .ok_or(ShapeError::MissingTable("GrantedEffectsPerLevel"))?;
    let col = |n: &'static str| {
        s.column(n)
            .ok_or(ShapeError::MissingColumn("GrantedEffectsPerLevel", n))
    };
    let c_ge = col("GrantedEffect")?;
    let c_level = col("Level")?;
    let c_cooldown = col("Cooldown")?;
    let c_costs = col("CostAmounts")?;
    let c_actor = col("ActorLevel")?;
    let c_reserv = col("Reservation")?;

    let ge_ids = ts.id_list("GrantedEffects"); // GrantedEffects row → Id

    // Which CostAmounts index is Mana, per GrantedEffects row. CostTypes[]
    // (on GrantedEffects) runs parallel to CostAmounts[] (per level).
    let cost_ids = ts.id_list("CostTypes");
    let mut mana_idx: HashMap<u64, usize> = HashMap::new();
    if let (Some(gf), Some(sgf)) = (ts.dat("GrantedEffects"), ts.schema("GrantedEffects"))
        && let Some(c_ct) = sgf.column("CostTypes")
    {
        for r in 0..gf.row_count() {
            let types = array_foreign_rows(&gf, r, c_ct);
            if let Some(i) = types
                .iter()
                .position(|&t| cost_ids.get(t as usize).map(String::as_str) == Some("Mana"))
            {
                mana_idx.insert(r as u64, i);
            }
        }
    }

    // Crit chance per (GrantedEffects row, level) from the stat sets.
    let mut crit: HashMap<(u64, i32), i32> = HashMap::new();
    if let (Some(ss), Some(sss)) = (
        ts.dat("GrantedEffectStatSetsPerLevel"),
        ts.schema("GrantedEffectStatSetsPerLevel"),
    ) && let (Some(c_ge2), Some(c_lvl2)) = (sss.column("GrantedEffects"), sss.column("GemLevel"))
    {
        let c_spell = sss.column("SpellCritChance");
        let c_attack = sss.column("AttackCritChance");
        for r in 0..ss.row_count() {
            if let (Ok(Some(gid)), Ok(lvl)) = (ss.foreign(r, c_ge2), ss.i32(r, c_lvl2)) {
                let cc = c_spell
                    .and_then(|c| ss.i32(r, c).ok())
                    .filter(|&v| v != 0)
                    .or_else(|| c_attack.and_then(|c| ss.i32(r, c).ok()))
                    .unwrap_or(0);
                crit.entry((gid, lvl)).or_insert(cc);
            }
        }
    }

    let mut out = String::with_capacity(gepl.row_count() * 48);
    out.push_str(
        "skill_id\tlevel\tlevel_requirement\tactor_level\tmana_cost\t\
         spirit_reservation_flat\tspirit_reservation_pct\tcrit_chance\tcooldown\n",
    );
    let g = |r: Result<String, crate::dat::DatError>| r.unwrap_or_default();
    for row in 0..gepl.row_count() {
        let ge_row = match gepl.foreign(row, c_ge) {
            Ok(Some(r)) => r,
            _ => continue,
        };
        let skill_id = ge_ids.get(ge_row as usize).cloned().unwrap_or_default();
        if skill_id.is_empty() {
            continue;
        }
        let level = gepl.i32(row, c_level).unwrap_or(0);
        let mana = mana_idx
            .get(&ge_row)
            .map(|&i| array_i32(&gepl, row, c_costs).get(i).copied().unwrap_or(0))
            .map(|v| v.to_string())
            .unwrap_or_default();
        // Crit is stored ×100 (permyriad-ish); PoB shows the plain %.
        let cc = crit.get(&(ge_row, level)).copied().unwrap_or(0);
        let crit_s = if cc != 0 {
            format!("{}", cc as f64 / 100.0)
        } else {
            String::new()
        };
        // Actor level is only meaningful when it exceeds the gem level
        // (a higher character-level requirement); PoB leaves it blank
        // otherwise.
        let actor = gepl.f32(row, c_actor).map(|v| v as i32).unwrap_or(0);
        let reserv = gepl.i32(row, c_reserv).unwrap_or(0);
        let fields = [
            skill_id,
            level.to_string(),
            String::new(), // level_requirement — not in these tables
            if actor > level {
                actor.to_string()
            } else {
                String::new()
            },
            mana,
            if reserv != 0 {
                reserv.to_string()
            } else {
                String::new()
            },
            String::new(), // spirit_reservation_pct — not modelled yet
            crit_s,
            g(gepl
                .i32(row, c_cooldown)
                .map(|v| if v != 0 { v.to_string() } else { String::new() })),
        ];
        push_row(&mut out, &fields);
    }
    Ok(out)
}

/// Tables `shape_skill_levels` needs.
pub const SKILL_LEVELS_TABLES: &[&str] = &[
    "GrantedEffectsPerLevel",
    "GrantedEffects",
    "CostTypes",
    "GrantedEffectStatSetsPerLevel",
];

/// Zip a foreignrow-array of stats with a parallel `i32[]` of values into
/// `statid:value|…` (the same `mods.tsv`-style encoding).
fn stat_value_pairs(
    dat: &Dat<'_>,
    row: usize,
    stat_col: usize,
    val_col: usize,
    ids: &[String],
) -> String {
    let stats = array_foreign_rows(dat, row, stat_col);
    let vals = array_i32(dat, row, val_col);
    let mut out = String::new();
    for (i, sid) in stats.iter().enumerate() {
        let Some(id) = ids.get(*sid as usize) else {
            continue;
        };
        if id.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push('|');
        }
        out.push_str(&format!("{id}:{}", vals.get(i).copied().unwrap_or(0)));
    }
    out
}

/// `items/soul_cores.tsv` (first-party): PoE2 socketables (runes, soul
/// cores, idols, abyssal eyes, congealed mist) — one row per
/// (socketable, socket context). `SoulCoreStats` primary, joined to
/// `SoulCores` (base/level/type) by row, with the granted + bonded stats
/// as `statid:value` pairs.
pub fn shape_soul_cores(ts: &TableSet) -> Result<String, ShapeError> {
    let scs = ts
        .dat("SoulCoreStats")
        .ok_or(ShapeError::MissingTable("SoulCoreStats"))?;
    let ss = ts
        .schema("SoulCoreStats")
        .ok_or(ShapeError::MissingTable("SoulCoreStats"))?;
    let col = |n: &'static str| {
        ss.column(n)
            .ok_or(ShapeError::MissingColumn("SoulCoreStats", n))
    };
    let c_core = col("SoulCore")?;
    let c_cat = col("StatCategory")?;
    let c_stats = col("Stats")?;
    let c_vals = col("StatsValues")?;
    let c_bstats = col("BondedStats")?;
    let c_bvals = col("BondedStatsValues")?;

    // SoulCores holds base/level/type, addressed by the SoulCore row ref.
    let sc = ts.dat("SoulCores");
    let scsch = ts.schema("SoulCores");
    let (c_base, c_level, c_type) = match scsch {
        Some(s) => (
            s.column("BaseItemType"),
            s.column("RequiredLevel"),
            s.column("Type"),
        ),
        None => (None, None, None),
    };
    let base_names = column_strings(ts, "BaseItemTypes", "Name");
    let type_ids = ts.id_list("SoulCoreTypes");
    let cat_ids = ts.id_list("SoulCoreStatCategories");
    let stat_ids = ts.id_list("Stats");

    let mut out = String::with_capacity(scs.row_count() * 96);
    out.push_str("id\tname\ttype\trequired_level\tcategory\tsocket_stats\tbonded_stats\n");
    for row in 0..scs.row_count() {
        let core = scs.foreign(row, c_core).ok().flatten();
        let (id, name, level, ty) = match (&sc, core) {
            (Some(d), Some(cr)) => {
                let cr = cr as usize;
                let brow = c_base.and_then(|c| d.foreign(cr, c).ok().flatten());
                let name = brow
                    .and_then(|b| base_names.get(b as usize).cloned())
                    .unwrap_or_default();
                let level = c_level.and_then(|c| d.i32(cr, c).ok()).unwrap_or(0);
                let ty = c_type
                    .and_then(|c| d.foreign(cr, c).ok().flatten())
                    .and_then(|t| type_ids.get(t as usize).cloned())
                    .unwrap_or_default();
                (cr.to_string(), name, level, ty)
            }
            _ => (String::new(), String::new(), 0, String::new()),
        };
        let category = scs
            .foreign(row, c_cat)
            .ok()
            .flatten()
            .and_then(|c| cat_ids.get(c as usize).cloned())
            .unwrap_or_default();
        let fields = [
            id,
            name,
            ty,
            level.to_string(),
            category,
            stat_value_pairs(&scs, row, c_stats, c_vals, &stat_ids),
            stat_value_pairs(&scs, row, c_bstats, c_bvals, &stat_ids),
        ];
        push_row(&mut out, &fields);
    }
    Ok(out)
}

/// Tables `shape_soul_cores` needs.
pub const SOUL_CORES_TABLES: &[&str] = &[
    "SoulCoreStats",
    "SoulCores",
    "SoulCoreTypes",
    "SoulCoreStatCategories",
    "BaseItemTypes",
    "Stats",
];

/// `skills/gem_quality.tsv` (first-party): a skill's quality bonus, from
/// `GrantedEffectQualityStats`. Values are stored per-mille; we emit the
/// bonus at 20 % quality (`permille × 20 / 1000`), the usual display.
pub fn shape_gem_quality(ts: &TableSet) -> Result<String, ShapeError> {
    let q = ts
        .dat("GrantedEffectQualityStats")
        .ok_or(ShapeError::MissingTable("GrantedEffectQualityStats"))?;
    let s = ts
        .schema("GrantedEffectQualityStats")
        .ok_or(ShapeError::MissingTable("GrantedEffectQualityStats"))?;
    let col = |n: &'static str| {
        s.column(n)
            .ok_or(ShapeError::MissingColumn("GrantedEffectQualityStats", n))
    };
    let c_ge = col("GrantedEffect")?;
    let c_stats = col("Stats")?;
    let c_vals = col("StatsValuesPermille")?;
    let c_add = s.column("AddTypes");

    let ge_ids = ts.id_list("GrantedEffects");
    let stat_ids = ts.id_list("Stats");
    let type_ids = ts.id_list("ActiveSkillType");

    let mut out = String::with_capacity(q.row_count() * 80);
    out.push_str("skill_id\tquality_stats\tadd_skill_types\n");
    for row in 0..q.row_count() {
        let skill = q
            .foreign(row, c_ge)
            .ok()
            .flatten()
            .and_then(|r| ge_ids.get(r as usize).cloned())
            .unwrap_or_default();
        if skill.is_empty() {
            continue;
        }
        // stats zipped with the 20%-quality value.
        let stats = array_foreign_rows(&q, row, c_stats);
        let vals = array_i32(&q, row, c_vals);
        let mut qs = String::new();
        for (i, sid) in stats.iter().enumerate() {
            let Some(id) = stat_ids.get(*sid as usize) else {
                continue;
            };
            if id.is_empty() {
                continue;
            }
            let v = vals.get(i).copied().unwrap_or(0) as f64 * 20.0 / 1000.0;
            if !qs.is_empty() {
                qs.push('|');
            }
            let vs = if (v - v.round()).abs() < 1e-9 {
                format!("{}", v.round() as i64)
            } else {
                format!("{v:.2}")
            };
            qs.push_str(&format!("{id}:{vs}"));
        }
        let add = c_add
            .map(|c| array_ids(&q, row, c, &type_ids))
            .unwrap_or_default();
        push_row(&mut out, &[skill, qs, add]);
    }
    Ok(out)
}

/// Tables `shape_gem_quality` needs.
pub const GEM_QUALITY_TABLES: &[&str] = &[
    "GrantedEffectQualityStats",
    "GrantedEffects",
    "Stats",
    "ActiveSkillType",
];

/// Tables `shape_support_skills` needs.
pub const SUPPORT_SKILLS_TABLES: &[&str] = &[
    "GrantedEffects",
    "GemEffects",
    "SkillGems",
    "BaseItemTypes",
    "ActiveSkillType",
];

/// `items/unique_art.tsv` (first-party): unique NAME → inventory art.
/// A unique's fixed mod list has no GGG table (stays PoB-derived), but
/// its ART does: `UniqueStashLayout` keys every unique's display name
/// (`WordsKey` → `Words.Text`) to its `ItemVisualIdentity.DDSFile`.
/// One row per name; alternate-art rows lose to the original.
pub fn shape_unique_art(ts: &TableSet) -> Result<String, ShapeError> {
    let usl = ts
        .dat("UniqueStashLayout")
        .ok_or(ShapeError::MissingTable("UniqueStashLayout"))?;
    let us = ts
        .schema("UniqueStashLayout")
        .ok_or(ShapeError::MissingTable("UniqueStashLayout"))?;
    let ucol = |n: &'static str| {
        us.column(n)
            .ok_or(ShapeError::MissingColumn("UniqueStashLayout", n))
    };
    let c_words = ucol("WordsKey")?;
    let c_iv = ucol("ItemVisualIdentityKey")?;
    let c_alt = ucol("IsAlternateArt")?;

    let words = ts.dat("Words").ok_or(ShapeError::MissingTable("Words"))?;
    let w_text = ts
        .schema("Words")
        .and_then(|s| s.column("Text"))
        .ok_or(ShapeError::MissingColumn("Words", "Text"))?;
    let iv = ts
        .dat("ItemVisualIdentity")
        .ok_or(ShapeError::MissingTable("ItemVisualIdentity"))?;
    let iv_dds = ts
        .schema("ItemVisualIdentity")
        .and_then(|s| s.column("DDSFile"))
        .ok_or(ShapeError::MissingColumn("ItemVisualIdentity", "DDSFile"))?;

    // name → dds, first non-alternate-art row wins.
    let mut seen: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for row in 0..usl.row_count() {
        let alt = usl.bool(row, c_alt).unwrap_or(false);
        let Ok(Some(wr)) = usl.foreign(row, c_words) else { continue };
        let name = words.string(wr as usize, w_text).unwrap_or_default();
        if name.is_empty() || (alt && seen.contains_key(&name)) {
            continue;
        }
        let Ok(Some(ivr)) = usl.foreign(row, c_iv) else { continue };
        let dds = iv.string(ivr as usize, iv_dds).unwrap_or_default();
        if dds.is_empty() {
            continue;
        }
        if seen.insert(name.clone(), dds).is_none() {
            order.push(name);
        }
    }

    let mut out = String::with_capacity(order.len() * 96);
    out.push_str("name\ticon_dds\n");
    for name in &order {
        let dds = &seen[name];
        out.push_str(&name.replace(['\t', '\n', '\r'], " "));
        out.push('\t');
        out.push_str(&dds.replace(['\t', '\n', '\r'], " "));
        out.push('\n');
    }
    Ok(out)
}

/// Tables `shape_unique_art` needs loaded in its [`TableSet`].
pub const UNIQUE_ART_TABLES: &[&str] = &["UniqueStashLayout", "Words", "ItemVisualIdentity"];

/// `Mods.Domain` enum → readable (indexing=1; item/jewel/flask matter
/// most). Exotic domains fall back to their raw index, flagged not hidden.
fn mod_domain(v: i32) -> String {
    match v {
        1 => "item",
        2 => "flask",
        3 => "monster",
        4 => "chest",
        5 => "area",
        // PoE2 shifted these vs PoE1: verified 4.5.4.3 — domain 10
        // carries the *Crafted bench mods, domain 11 carries every
        // Jewel* mod (incl. JewelRadiusImplicit, a jewel implicit).
        10 => "crafted",
        11 => "jewel",
        13 => "abyss_jewel",
        14 => "map_device",
        34 => "tincture",
        37 => "idol",
        _ => return v.to_string(),
    }
    .to_string()
}

/// `Mods.GenerationType` enum → readable (indexing=1).
fn mod_generation(v: i32) -> String {
    match v {
        1 => "prefix",
        2 => "suffix",
        3 => "unique",
        4 => "nemesis",
        5 => "corrupted",
        10 => "enchantment",
        11 => "essence",
        _ => return v.to_string(),
    }
    .to_string()
}

/// `items/mods.tsv` (first-party): the `Mods` table — every rollable
/// modifier with its stat ranges, the tags that gate where it can roll
/// (`SpawnWeight_Tags`/`_Values`), and a derived tier (rank within its
/// `ModType` affix ladder by required level). This is the pool the site
/// needs for "what can roll, and at what tier"; the fixed mod lists of
/// *specific* uniques aren't in any GGG table (they stay PoB-derived).
pub fn shape_mods(ts: &TableSet) -> Result<String, ShapeError> {
    let m = ts.dat("Mods").ok_or(ShapeError::MissingTable("Mods"))?;
    let sm = ts.schema("Mods").ok_or(ShapeError::MissingTable("Mods"))?;
    let col = |n: &'static str| sm.column(n).ok_or(ShapeError::MissingColumn("Mods", n));
    let c_id = col("Id")?;
    let c_name = col("Name")?;
    let c_domain = col("Domain")?;
    let c_gen = col("GenerationType")?;
    let c_level = col("Level")?;
    let c_modtype = col("ModType")?;
    let c_families = col("Families")?;
    let c_tags = col("Tags")?;
    let c_sw_tags = col("SpawnWeight_Tags")?;
    let c_sw_vals = col("SpawnWeight_Values")?;
    // Stat slots run Stat1..Stat6 with parallel Stat1Value..Stat6Value.
    let stat_cols: Vec<(usize, usize)> = (1..=6)
        .filter_map(|i| {
            Some((
                sm.column(&format!("Stat{i}"))?,
                sm.column(&format!("Stat{i}Value"))?,
            ))
        })
        .collect();

    let modtype_names = ts.id_list("ModType");
    let family_ids = ts.id_list("ModFamily");
    let tag_ids = ts.id_list("Tags");
    let stat_ids = ts.id_list("Stats");

    // Derived tier: within each ModType affix ladder, rank by required
    // level (highest level = tier 1). Same level → same tier.
    let tier_of = mod_tiers(&m, c_modtype, c_level);

    let mut out = String::with_capacity(m.row_count() * 160);
    out.push_str(
        "id\tname\tdomain\tgeneration_type\ttier\trequired_level\tmod_type\t\
         families\tstats\tspawn_weights\ttags\n",
    );
    let g = |r: Result<String, crate::dat::DatError>| r.unwrap_or_default();
    for row in 0..m.row_count() {
        let mod_type = match m.foreign(row, c_modtype) {
            Ok(Some(rid)) => modtype_names.get(rid as usize).cloned().unwrap_or_default(),
            _ => String::new(),
        };
        // stats: "statid:lo:hi" per non-null slot.
        let mut stats = String::new();
        for &(sc, vc) in &stat_cols {
            if let Ok(Some(sid)) = m.foreign(row, sc) {
                let name = stat_ids.get(sid as usize).cloned().unwrap_or_default();
                if name.is_empty() {
                    continue;
                }
                let (lo, hi) = m.i32_interval(row, vc).unwrap_or((0, 0));
                if !stats.is_empty() {
                    stats.push('|');
                }
                stats.push_str(&format!("{name}:{lo}:{hi}"));
            }
        }
        // spawn weights: "tag:weight" — what item tags this can roll on.
        let sw_tags = array_foreign_rows(&m, row, c_sw_tags);
        let sw_vals = array_i32(&m, row, c_sw_vals);
        let mut spawn = String::new();
        for (i, tid) in sw_tags.iter().enumerate() {
            let tag = tag_ids.get(*tid as usize).cloned().unwrap_or_default();
            if tag.is_empty() {
                continue;
            }
            let w = sw_vals.get(i).copied().unwrap_or(0);
            if !spawn.is_empty() {
                spawn.push('|');
            }
            spawn.push_str(&format!("{tag}:{w}"));
        }
        let fields = [
            g(m.string(row, c_id)),
            g(m.string(row, c_name)),
            mod_domain(m.i32(row, c_domain).unwrap_or(0)),
            mod_generation(m.i32(row, c_gen).unwrap_or(0)),
            tier_of.get(&row).map(|t| t.to_string()).unwrap_or_default(),
            g(m.i32(row, c_level).map(|v| v.to_string())),
            mod_type,
            array_ids(&m, row, c_families, &family_ids),
            stats,
            spawn,
            array_ids(&m, row, c_tags, &tag_ids),
        ];
        push_row(&mut out, &fields);
    }
    Ok(out)
}

/// Rank every mod within its `ModType` affix ladder by required level
/// (highest level = tier 1, ties share a tier). Mods with no `ModType`
/// get no tier.
fn mod_tiers(m: &Dat<'_>, c_modtype: usize, c_level: usize) -> HashMap<usize, i32> {
    let mut by_type: HashMap<u64, Vec<(usize, i32)>> = HashMap::new();
    for r in 0..m.row_count() {
        if let Ok(Some(mt)) = m.foreign(r, c_modtype) {
            let lvl = m.i32(r, c_level).unwrap_or(0);
            by_type.entry(mt).or_default().push((r, lvl));
        }
    }
    let mut tier_of = HashMap::new();
    for rows in by_type.values() {
        let mut levels: Vec<i32> = rows.iter().map(|(_, l)| *l).collect();
        levels.sort_unstable_by(|a, b| b.cmp(a));
        levels.dedup();
        let rank: HashMap<i32, i32> = levels
            .iter()
            .enumerate()
            .map(|(i, l)| (*l, (i + 1) as i32))
            .collect();
        for (r, l) in rows {
            tier_of.insert(*r, rank[l]);
        }
    }
    tier_of
}

/// Tables `shape_mods` needs.
pub const MODS_TABLES: &[&str] = &["Mods", "ModType", "ModFamily", "Stats", "Tags"];

/// Stable PoE2 passive-tree geometry constants (orbit radii + slots per
/// orbit). These are fundamental to the layout, not per-patch data; the
/// `.psg` reader and this shaper both rely on them, and they're emitted
/// into `meta.tsv` so downstream reads them from one place.
pub const ORBIT_RADII: [f32; 10] = [
    0.0, 82.0, 162.0, 335.0, 493.0, 662.0, 846.0, 251.0, 1080.0, 1322.0,
];
/// Slots on each orbit; PoE2 angles are uniform (`360°/slots`).
pub const SKILLS_PER_ORBIT: [u16; 10] = [1, 12, 24, 24, 72, 72, 72, 24, 72, 144];

/// The three TSVs the tree renderer consumes.
pub struct TreeTsv {
    pub nodes: String,
    pub edges: String,
    pub meta: String,
}

/// Final render position of a node from its group centre + orbit slot.
/// PoE orbits put slot 0 at 12 o'clock, going clockwise; SVG y is down.
fn node_xy(g: &crate::psg::Group, orbit: u8, orbit_index: u16) -> (f32, f32) {
    let (o, oi) = (orbit as usize, orbit_index as f32);
    if o >= ORBIT_RADII.len() {
        return (g.x, g.y);
    }
    let r = ORBIT_RADII[o];
    let n = SKILLS_PER_ORBIT[o].max(1) as f32;
    let a = 2.0 * std::f32::consts::PI * oi / n;
    (g.x + r * a.sin(), g.y - r * a.cos())
}

/// `tree/{nodes,edges,meta}.tsv` (first-party): the passive tree, joining
/// the `.psg` graph (geometry + topology + connections) with
/// `PassiveSkills` metadata (name, icon, kind flags, ascendancy) keyed by
/// `PassiveSkillGraphId` = node id.
///
/// Stat *text* (the `stats` column) needs `statdescriptions/*.csd` and is
/// left empty for now — a documented follow-on. PoB-only presentation
/// columns (`node_overlay`, `active_effect`, `node_options`,
/// `connection_art`, `unlock_constraint`) are emitted empty so the schema
/// matches; the renderer already tolerates blanks.
pub fn shape_tree(
    graph: &crate::psg::Graph,
    ts: &TableSet,
    sd: &crate::csd::StatDescriptions,
) -> Result<TreeTsv, ShapeError> {
    let ps = ts
        .dat("PassiveSkills")
        .ok_or(ShapeError::MissingTable("PassiveSkills"))?;
    let sps = ts
        .schema("PassiveSkills")
        .ok_or(ShapeError::MissingTable("PassiveSkills"))?;
    // Columns we join on / read (all optional except the graph id — a
    // missing flag column just means that kind can't be detected).
    let c_gid = sps
        .column("PassiveSkillGraphId")
        .ok_or(ShapeError::MissingColumn(
            "PassiveSkills",
            "PassiveSkillGraphId",
        ))?;
    let col = |n: &str| sps.column(n);
    let (c_name, c_icon) = (col("Name"), col("Icon_DDSFile"));
    let c_keystone = col("IsKeystone");
    let c_notable = col("IsNotable");
    let c_jewel = col("IsJewelSocket");
    let c_attr = col("IsAttribute");
    let c_justicon = col("IsJustIcon");
    let c_asc = col("Ascendancy");
    let c_ascstart = col("IsAscendancyStartingNode");
    let c_mchoice = col("IsMultipleChoice");
    let c_mchoiceopt = col("IsMultipleChoiceOption");
    // Stats[] (foreignrow → Stats) + parallel value columns, for the
    // rendered `stats` text.
    let c_stats = col("Stats");
    let stat_ids = ts.id_list("Stats");
    let value_cols: Vec<Option<usize>> = [
        "Stat1Value",
        "Stat2Value",
        "Stat3Value",
        "Stat4Value",
        "Stat5Value",
        "StatValue6",
        "StatValue7",
    ]
    .iter()
    .map(|n| col(n))
    .collect();

    // Render a node's stat lines from its Stats[] ids + parallel values.
    let render_stats = |row: usize| -> String {
        let Some(cs) = c_stats else {
            return String::new();
        };
        let rows = array_foreign_rows(&ps, row, cs);
        if rows.is_empty() {
            return String::new();
        }
        let pairs: Vec<(String, i64)> = rows
            .iter()
            .enumerate()
            .filter_map(|(k, &rid)| {
                let id = stat_ids.get(rid as usize)?.clone();
                if id.is_empty() {
                    return None;
                }
                let v = value_cols
                    .get(k)
                    .and_then(|c| *c)
                    .and_then(|c| ps.i32(row, c).ok())
                    .unwrap_or(0) as i64;
                Some((id, v))
            })
            .collect();
        sd.render(&pairs).join("; ")
    };

    // PassiveSkillGraphId → PassiveSkills row.
    let mut by_gid: HashMap<u16, usize> = HashMap::with_capacity(ps.row_count());
    for r in 0..ps.row_count() {
        if let Ok(g) = ps.u16(r, c_gid) {
            by_gid.entry(g).or_insert(r);
        }
    }
    let asc_ids = ts.id_list("Ascendancy"); // foreign → readable ascendancy id
    // Class names per Characters row (a class-start node lists the classes
    // it serves via Characters[]; the hub serves a PoE1 + PoE2 pair).
    let char_names: Vec<String> = column_strings(ts, "Characters", "Name");
    let c_chars = col("Characters");
    let klass_of = |row: usize| -> String {
        match c_chars {
            Some(c) => array_foreign_rows(&ps, row, c)
                .iter()
                .filter_map(|&r| char_names.get(r as usize).cloned())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("|"),
            None => String::new(),
        }
    };
    // Mastery radial pattern: node → MasteryGroup → Art →
    // PassiveSkillTreeMasteryArt.ActiveEffectImage (the sprite behind a
    // mastery node). The table stores the path without an extension.
    let mg_dat = ts.dat("PassiveSkillMasteryGroups");
    let mg_art_col = ts
        .schema("PassiveSkillMasteryGroups")
        .and_then(|s| s.column("Art"));
    let art_effect = column_strings(ts, "PassiveSkillTreeMasteryArt", "ActiveEffectImage");
    let c_mg = col("MasteryGroup");
    let active_effect_of = |row: usize| -> String {
        let (Some(mg), Some(c_mgcol), Some(c_art)) = (&mg_dat, c_mg, mg_art_col) else {
            return String::new();
        };
        let path = ps
            .foreign(row, c_mgcol)
            .ok()
            .flatten()
            .and_then(|grp| mg.foreign(grp as usize, c_art).ok().flatten())
            .and_then(|art| art_effect.get(art as usize).cloned())
            .unwrap_or_default();
        if path.is_empty() {
            String::new()
        } else {
            format!("{path}.png")
        }
    };

    let boolc = |row: usize, c: Option<usize>| c.is_some_and(|c| ps.bool(row, c).unwrap_or(false));
    let strc = |row: usize, c: Option<usize>| {
        c.map(|c| ps.string(row, c).unwrap_or_default())
            .unwrap_or_default()
    };
    // Kind, mirroring the renderer's classification order.
    let kind_of = |row: usize| -> &'static str {
        let has_asc = c_asc
            .and_then(|c| ps.foreign(row, c).ok().flatten())
            .is_some();
        if boolc(row, c_ascstart) {
            "asc_start"
        } else if boolc(row, c_jewel) {
            "jewel"
        } else if boolc(row, c_justicon) {
            // A mastery *node* is icon-only. A node that merely *belongs*
            // to a mastery group (MasteryGroup set) is a normal cluster
            // node, not a mastery — so don't key on MasteryGroup here.
            "mastery"
        } else if has_asc {
            if boolc(row, c_notable) {
                "asc_notable"
            } else {
                "asc_small"
            }
        } else if boolc(row, c_keystone) {
            "keystone"
        } else if boolc(row, c_notable) {
            "notable"
        } else if boolc(row, c_attr) {
            "attribute"
        } else if boolc(row, c_mchoice) {
            "multichoice"
        } else if boolc(row, c_mchoiceopt) {
            "multichoice_opt"
        } else {
            "small"
        }
    };

    // --- nodes.tsv ---
    let mut nodes = String::with_capacity(graph.nodes.len() * 96);
    nodes.push_str(
        "id\tx\ty\tkind\tklass\tascendancy\tname\tstats\tgroup\torbit\t\
         orbit_index\ticon\tnode_overlay\tactive_effect\tnode_options\t\
         connection_art\tunlock_constraint\n",
    );
    // Legacy (PoE1) ascendancies — Templar/Marauder/Duelist/Shadow and
    // deprecated slots (Ranger2 = Piscator, …) persist in the graph but are
    // cut from the live tree. GGG marks each with a "[DNT-UNUSED]" Name, so
    // the valid set is every ascendancy whose Name lacks that tag; drop the
    // rest so the node set matches the shipped tree (same rule the
    // `asc_internal` meta rows already use).
    let valid_asc: std::collections::HashSet<String> = {
        let mut s = std::collections::HashSet::new();
        if let (Some(asc), Some(sasc)) = (ts.dat("Ascendancy"), ts.schema("Ascendancy"))
            && let (Some(cid), Some(cname)) = (sasc.column("Id"), sasc.column("Name"))
        {
            for r in 0..asc.row_count() {
                let name = asc.string(r, cname).unwrap_or_default();
                if !name.is_empty()
                    && !name.contains("DNT-UNUSED")
                    && let Ok(id) = asc.string(r, cid)
                {
                    s.insert(id);
                }
            }
        }
        s
    };
    let asc_of = |n: &crate::psg::Node| -> String {
        by_gid
            .get(&n.id)
            .and_then(|&row| c_asc.and_then(|c| ps.foreign(row, c).ok().flatten()))
            .and_then(|rid| asc_ids.get(rid as usize).cloned())
            .unwrap_or_default()
    };
    let skip: std::collections::HashSet<u16> = graph
        .nodes
        .iter()
        .filter(|n| {
            let a = asc_of(n);
            !a.is_empty() && !valid_asc.contains(&a)
        })
        .map(|n| n.id)
        .collect();

    let (mut min_x, mut min_y, mut max_x, mut max_y) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for n in &graph.nodes {
        if skip.contains(&n.id) {
            continue;
        }
        let g = &graph.groups[n.group];
        let (x, y) = node_xy(g, n.orbit, n.orbit_index);
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x);
        max_y = max_y.max(y);
        let (kind, name, icon, ascend, stats, klass, active_effect) = match by_gid.get(&n.id) {
            Some(&row) => {
                let asc = c_asc
                    .and_then(|c| ps.foreign(row, c).ok().flatten())
                    .and_then(|rid| asc_ids.get(rid as usize).cloned())
                    .unwrap_or_default();
                // GGG stores .dds; the site's sprite manifest keys use
                // .png (converted at asset-extraction time). Normalise so
                // node icons resolve against the same keys.
                let icon = strc(row, c_icon);
                let icon = icon
                    .strip_suffix(".dds")
                    .map(|s| format!("{s}.png"))
                    .unwrap_or(icon);
                (
                    kind_of(row),
                    strc(row, c_name),
                    icon,
                    asc,
                    render_stats(row),
                    klass_of(row),
                    active_effect_of(row),
                )
            }
            None => (
                "small",
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
            ),
        };
        let fields = [
            n.id.to_string(),
            format!("{x:.2}"),
            format!("{y:.2}"),
            kind.to_string(),
            klass,
            ascend,
            name,
            stats,
            n.group.to_string(),
            n.orbit.to_string(),
            n.orbit_index.to_string(),
            icon,
            String::new(), // node_overlay (PoB-only)
            active_effect, // mastery radial pattern (first-party)
            String::new(), // node_options (PoB-only)
            String::new(), // connection_art (PoB-only)
            String::new(), // unlock_constraint (PoB-only)
        ];
        push_row(&mut nodes, &fields);
    }

    // --- edges.tsv --- (dedup undirected; keep the source→target order)
    let mut edges = String::with_capacity(graph.nodes.len() * 16);
    edges.push_str("from\tto\torbit\n");
    let mut seen: std::collections::HashSet<(u16, u16)> = std::collections::HashSet::new();
    for n in &graph.nodes {
        if skip.contains(&n.id) {
            continue;
        }
        for c in &n.connections {
            if skip.contains(&c.target) {
                continue;
            }
            let key = (n.id.min(c.target), n.id.max(c.target));
            if !seen.insert(key) {
                continue;
            }
            let orbit = if c.orbit == crate::psg::STRAIGHT {
                0
            } else {
                c.orbit
            };
            push_row(
                &mut edges,
                &[n.id.to_string(), c.target.to_string(), orbit.to_string()],
            );
        }
    }

    // --- meta.tsv --- (bounds, orbit constants, group centres)
    let mut meta = String::new();
    if min_x <= max_x {
        meta.push_str(&format!("min_x\t{min_x:.4}\n"));
        meta.push_str(&format!("max_x\t{max_x:.4}\n"));
        meta.push_str(&format!("min_y\t{min_y:.4}\n"));
        meta.push_str(&format!("max_y\t{max_y:.4}\n"));
    }
    meta.push_str(
        &("orbit_radii\t".to_string()
            + &ORBIT_RADII
                .iter()
                .map(|r| format!("{}", *r as i64))
                .collect::<Vec<_>>()
                .join("|")
            + "\n"),
    );
    meta.push_str(
        &("skills_per_orbit\t".to_string()
            + &SKILLS_PER_ORBIT
                .iter()
                .map(|n| n.to_string())
                .collect::<Vec<_>>()
                .join("|")
            + "\n"),
    );
    for (i, g) in graph.groups.iter().enumerate() {
        // group 0 is the synthetic preamble origin; skip it.
        if i == 0 {
            continue;
        }
        meta.push_str(&format!("group\t{i}\t{:.4}\t{:.4}\n", g.x, g.y));
    }

    // Classes + ascendancies: group the Ascendancy table by its class.
    // `class <ClassName> <asc1|asc2|…>` and
    // `asc_internal <DisplayName> <InternalId> <ClassName>`.
    if let (Some(asc), Some(sasc)) = (ts.dat("Ascendancy"), ts.schema("Ascendancy")) {
        let a_col = |n: &str| sasc.column(n);
        if let (Some(c_id), Some(c_name), Some(c_char)) =
            (a_col("Id"), a_col("Name"), a_col("Character"))
        {
            // `PassiveTreeImage` is the per-ascendancy backdrop illustration
            // (Art/2DArt/BaseClassIllustrations/<Name>Ascendancy.dds); the
            // sprites step decodes it + places it on the cluster.
            let c_img = a_col("PassiveTreeImage");
            // class name per Characters row (Character foreign → Characters).
            let mut by_class: std::collections::BTreeMap<String, Vec<String>> = Default::default();
            let mut internals: Vec<(String, String, String, String)> = Vec::new();
            for r in 0..asc.row_count() {
                let disp = asc.string(r, c_name).unwrap_or_default();
                let id = asc.string(r, c_id).unwrap_or_default();
                let class = asc
                    .foreign(r, c_char)
                    .ok()
                    .flatten()
                    .and_then(|cr| char_names.get(cr as usize).cloned())
                    .unwrap_or_default();
                // Skip GGG's unshipped placeholder ascendancies (the
                // "[DNT-UNUSED]" fishing-joke set); classes left with none
                // are PoE1 legacy and drop out naturally.
                if disp.is_empty() || class.is_empty() || disp.contains("DNT-UNUSED") {
                    continue;
                }
                let img = c_img
                    .and_then(|c| asc.string(r, c).ok())
                    .unwrap_or_default();
                by_class
                    .entry(class.clone())
                    .or_default()
                    .push(disp.clone());
                internals.push((disp, id, class, img));
            }
            for (class, ascs) in &by_class {
                meta.push_str(&format!("class\t{class}\t{}\n", ascs.join("|")));
            }
            for (disp, id, class, img) in &internals {
                meta.push_str(&format!("asc_internal\t{disp}\t{id}\t{class}\t{img}\n"));
            }
        }
    }

    Ok(TreeTsv { nodes, edges, meta })
}

/// Tables `shape_tree` needs (besides the `.psg` graph + `.csd` stat
/// descriptions).
pub const TREE_TABLES: &[&str] = &[
    "PassiveSkills",
    "Ascendancy",
    "Stats",
    "Characters",
    "PassiveSkillMasteryGroups",
    "PassiveSkillTreeMasteryArt",
];

/// The `.csd` files `shape_tree` renders stat text from, in include
/// order (the master first, then the passive override).
pub const TREE_STAT_CSD: &[&str] = &[
    "data/statdescriptions/stat_descriptions.csd",
    "data/statdescriptions/passive_skill_stat_descriptions.csd",
];

/// Append `fields` as one TSV row (tabs between, newline after),
/// sanitising any embedded tabs/newlines in a field.
fn push_row(out: &mut String, fields: &[String]) {
    for (j, field) in fields.iter().enumerate() {
        if j > 0 {
            out.push('\t');
        }
        if field.contains(['\t', '\n', '\r']) {
            out.push_str(&field.replace(['\t', '\n', '\r'], " "));
        } else {
            out.push_str(field);
        }
    }
    out.push('\n');
}

/// Foreignrow-array cell → referenced row indices (the row-id twin of
/// `array_ids`).
fn array_rows(dat: &Dat<'_>, row: usize, col: usize) -> Vec<usize> {
    let Ok((count, offset)) = dat.array_ref(row, col) else {
        return Vec::new();
    };
    let var = dat.var();
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let eo = offset + i * 16; // foreignrow element = u64 rowid + u64 pad
        if let Some(b) = var.get(eo..eo + 8) {
            out.push(u64::from_le_bytes(b.try_into().unwrap()) as usize);
        }
    }
    out
}

/// `items/grants.tsv` — base items that GRANT things while equipped:
/// Spirit (ItemSpirit) and/or skills (Implicit_Mods → ModGrantedSkills
/// → SkillGems → gem display name). Downstream, the agent bases.json
/// merges these fields so "Shrine Sceptre grants Purity of Fire and
/// carries 100 Spirit" is data, not string folklore.
pub fn shape_item_grants(ts: &TableSet) -> Result<String, ShapeError> {
    let bit = ts
        .dat("BaseItemTypes")
        .ok_or(ShapeError::MissingTable("BaseItemTypes"))?;
    let bs = ts
        .schema("BaseItemTypes")
        .ok_or(ShapeError::MissingTable("BaseItemTypes"))?;
    let col = |n: &'static str| {
        bs.column(n)
            .ok_or(ShapeError::MissingColumn("BaseItemTypes", n))
    };
    let c_id = col("Id")?;
    let c_name = col("Name")?;
    let c_impl = col("Implicit_Mods")?;

    // ItemSpirit: BaseItemType row → SpiritGranted.
    let mut spirit: std::collections::HashMap<usize, i32> = std::collections::HashMap::new();
    if let (Some(isd), Some(iss)) = (ts.dat("ItemSpirit"), ts.schema("ItemSpirit")) {
        if let (Some(c_b), Some(c_s)) = (iss.column("BaseItemType"), iss.column("SpiritGranted")) {
            for row in 0..isd.row_count() {
                if let Ok(Some(bit_row)) = isd.foreign(row, c_b) {
                    let sp = isd.i32(row, c_s).unwrap_or(0);
                    if sp > 0 {
                        spirit.insert(bit_row as usize, sp);
                    }
                }
            }
        }
    }

    // ModGrantedSkills: Mod row → granted gem's display name
    // (SkillGems row → its BaseItemType → Name).
    let mut mod_grants: std::collections::HashMap<usize, String> = std::collections::HashMap::new();
    if let (Some(mgd), Some(mgs), Some(sgd), Some(sgs)) = (
        ts.dat("ModGrantedSkills"),
        ts.schema("ModGrantedSkills"),
        ts.dat("SkillGems"),
        ts.schema("SkillGems"),
    ) {
        if let (Some(c_mod), Some(c_skill), Some(c_sbit)) = (
            mgs.column("Mod"),
            mgs.column("Skill"),
            sgs.column("BaseItemType"),
        ) {
            for row in 0..mgd.row_count() {
                let (Ok(Some(mod_row)), Ok(Some(sg_row))) =
                    (mgd.foreign(row, c_mod), mgd.foreign(row, c_skill))
                else {
                    continue;
                };
                if let Ok(Some(gbit)) = sgd.foreign(sg_row as usize, c_sbit) {
                    if let Ok(name) = bit.string(gbit as usize, c_name) {
                        if !name.is_empty() {
                            mod_grants.insert(mod_row as usize, name);
                        }
                    }
                }
            }
        }
    }

    // ItemInherentSkills: BaseItemType row → SkillsGranted (SkillGems
    // row array) → each gem's display name. This is how base sceptres
    // ("Grants Skill: Purity of Fire") and wands carry their skill —
    // NOT via Implicit_Mods (base sceptres have none).
    let mut inherent: std::collections::HashMap<usize, Vec<String>> =
        std::collections::HashMap::new();
    if let (Some(iid), Some(iis), Some(sgd), Some(sgs)) = (
        ts.dat("ItemInherentSkills"),
        ts.schema("ItemInherentSkills"),
        ts.dat("SkillGems"),
        ts.schema("SkillGems"),
    ) {
        if let (Some(c_b), Some(c_sk), Some(c_sbit)) = (
            iis.column("BaseItemType"),
            iis.column("SkillsGranted"),
            sgs.column("BaseItemType"),
        ) {
            for row in 0..iid.row_count() {
                let Ok(Some(bit_row)) = iid.foreign(row, c_b) else {
                    continue;
                };
                let names: Vec<String> = array_rows(&iid, row, c_sk)
                    .into_iter()
                    .filter_map(|sg_row| {
                        let gbit = sgd.foreign(sg_row, c_sbit).ok().flatten()?;
                        let name = bit.string(gbit as usize, c_name).ok()?;
                        (!name.is_empty()).then_some(name)
                    })
                    .collect();
                if !names.is_empty() {
                    inherent.insert(bit_row as usize, names);
                }
            }
        }
    }

    let mut out = String::with_capacity(4096);
    out.push_str("base_id\tname\tspirit\tgrants\n");
    for row in 0..bit.row_count() {
        let sp = spirit.get(&row).copied().unwrap_or(0);
        let mut grants: Vec<String> = inherent.get(&row).cloned().unwrap_or_default();
        grants.extend(
            array_rows(&bit, row, c_impl)
                .into_iter()
                .filter_map(|m| mod_grants.get(&m).cloned()),
        );
        if sp == 0 && grants.is_empty() {
            continue;
        }
        let fields = [
            bit.string(row, c_id).unwrap_or_default(),
            bit.string(row, c_name).unwrap_or_default(),
            if sp > 0 { sp.to_string() } else { String::new() },
            grants.join("|"),
        ];
        push_row(&mut out, &fields);
    }
    Ok(out)
}

/// Tables `shape_item_grants` needs.
pub const GRANTS_TABLES: &[&str] = &[
    "BaseItemTypes",
    "Mods",
    "ItemSpirit",
    "ItemInherentSkills",
    "ModGrantedSkills",
    "SkillGems",
];

/// Jewels: the radius geometry + jewel item radii, everything the
/// planner/agent jewel support needs from the dat side. Socket
/// POSITIONS are not here — they live in the shaped tree (nodes.tsv
/// kind=jewel); tree_render joins the two when emitting
/// assets/agent/jewels.json.
///
/// Output TSV (`tree/jewels.tsv`), one `kind` per row:
///   ring        name outer inner radius   — PassiveJewelRadii, tree units
///   base        name radius              — jewel bases with a radius
///                                           implicit (Time-Lost: 1000)
///   base        name 0                   — radius-less jewel bases
///   radius_add  name add                 — rollable "+N to radius" mods
///                                           (Medium +150, Large +300)
pub fn shape_jewels(ts: &TableSet) -> Result<String, ShapeError> {
    let mut out = String::with_capacity(2048);
    out.push_str("kind\tname\ta\tb\tc\n");

    // Rings.
    let rad = ts
        .dat("PassiveJewelRadii")
        .ok_or(ShapeError::MissingTable("PassiveJewelRadii"))?;
    let rs = ts
        .schema("PassiveJewelRadii")
        .ok_or(ShapeError::MissingTable("PassiveJewelRadii"))?;
    let rcol = |n: &'static str| rs.column(n).ok_or(ShapeError::MissingColumn("PassiveJewelRadii", n));
    let (r_id, r_out, r_in, r_r) = (rcol("ID")?, rcol("RingOuterRadius")?, rcol("RingInnerRadius")?, rcol("Radius")?);
    for row in 0..rad.row_count() {
        let fields = [
            "ring".to_string(),
            rad.string(row, r_id).unwrap_or_default(),
            rad.i32(row, r_out).unwrap_or(0).to_string(),
            rad.i32(row, r_in).unwrap_or(0).to_string(),
            rad.i32(row, r_r).unwrap_or(0).to_string(),
        ];
        push_row(&mut out, &fields);
    }

    // Mod → local_jewel_effect_base_radius value (implicits carry the
    // base radius; JewelRadius*Size mods carry rollable "+N" adds).
    let mods = ts.dat("Mods").ok_or(ShapeError::MissingTable("Mods"))?;
    let ms = ts.schema("Mods").ok_or(ShapeError::MissingTable("Mods"))?;
    let m_id = ms.column("Id").ok_or(ShapeError::MissingColumn("Mods", "Id"))?;
    let stat_ids = ts.id_list("Stats");
    let mut radius_of_mod: std::collections::HashMap<usize, i32> = std::collections::HashMap::new();
    for i in 1..=4usize {
        let (Some(cs), Some(cv)) = (
            ms.column(&format!("Stat{i}")),
            ms.column(&format!("Stat{i}Value")),
        ) else {
            continue;
        };
        for row in 0..mods.row_count() {
            let is_radius_stat = mods
                .foreign(row, cs)
                .ok()
                .flatten()
                .and_then(|sr| stat_ids.get(sr as usize))
                .is_some_and(|sid| sid == "local_jewel_effect_base_radius");
            if is_radius_stat {
                if let Ok(v) = mods.i32(row, cv) {
                    radius_of_mod.insert(row, v);
                }
            }
        }
    }

    // Jewel bases: ItemClass "Jewel"; base radius from Implicit_Mods.
    let bit = ts.dat("BaseItemTypes").ok_or(ShapeError::MissingTable("BaseItemTypes"))?;
    let bs = ts.schema("BaseItemTypes").ok_or(ShapeError::MissingTable("BaseItemTypes"))?;
    let bcol = |n: &'static str| bs.column(n).ok_or(ShapeError::MissingColumn("BaseItemTypes", n));
    let (b_id, b_name, b_class, b_impl) = (bcol("Id")?, bcol("Name")?, bcol("ItemClass")?, bcol("Implicit_Mods")?);
    let class_ids = ts.id_list("ItemClasses");
    for row in 0..bit.row_count() {
        let is_jewel = bit
            .foreign(row, b_class)
            .ok()
            .flatten()
            .and_then(|c| class_ids.get(c as usize))
            .is_some_and(|c| c == "Jewel");
        if !is_jewel {
            continue;
        }
        let id = bit.string(row, b_id).unwrap_or_default();
        if id.contains("Unique") {
            continue; // unique-only base variants: not player bases
        }
        let radius: i32 = array_rows(&bit, row, b_impl)
            .into_iter()
            .filter_map(|m| radius_of_mod.get(&m).copied())
            .max()
            .unwrap_or(0);
        let fields = [
            "base".to_string(),
            bit.string(row, b_name).unwrap_or_default(),
            radius.to_string(),
            String::new(),
            String::new(),
        ];
        push_row(&mut out, &fields);
    }

    // Rollable radius increases (suffix mods on Time-Lost jewels).
    for (row, add) in &radius_of_mod {
        let id = mods.string(*row, m_id).unwrap_or_default();
        let stripped = id.strip_prefix("Crafted").unwrap_or(&id);
        if let Some(size) = stripped.strip_prefix("JewelRadius").and_then(|s| s.strip_suffix("Size")) {
            let fields = [
                "radius_add".to_string(),
                size.to_string(),
                add.to_string(),
                String::new(),
                String::new(),
            ];
            push_row(&mut out, &fields);
        }
    }
    Ok(out)
}

/// Tables `shape_jewels` needs.
pub const JEWELS_TABLES: &[&str] = &["PassiveJewelRadii", "BaseItemTypes", "ItemClasses", "Mods", "Stats"];
