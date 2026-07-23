//! Reader for GGG's `.datc64` tables — the 64-bit `.dat` variant PoE2
//! ships (every table under `Data/` inside the bundles).
//!
//! ## Format
//!
//! ```text
//! u32                      row_count
//! row_count × row_width    fixed-width rows
//! 8 × 0xBB                  magic marking the start of the var section
//! bytes[..]                 variable-length data (strings, arrays)
//! ```
//!
//! `row_width` is not stored — it's the sum of the column widths from
//! the schema. We compute the fixed/var boundary as
//! `4 + row_count * row_width` and assert the 8×`0xBB` magic sits
//! there; a mismatch means the schema doesn't fit the file (usually an
//! outdated schema), caught loudly rather than mis-parsed.
//!
//! Columns are fixed-width in the row; variable-length values (strings,
//! arrays) store a `u64` byte offset into the var section. Offsets are
//! measured from the start of the var section (i.e. from the `0xBB`
//! magic). Strings are UTF-16LE, terminated by a `u16` `0x0000`.
//!
//! ## Scope
//!
//! This is the generic engine: it reads typed cells given a
//! [`TableSchema`]. [`crate::dat_schema`] builds those `TableSchema`s
//! from the community `dat-schema` JSON, so column layouts aren't
//! hand-written.

/// Null sentinel for `foreignrow` / `row` references.
pub const NULL_ROW: u64 = 0xFEFE_FEFE_FEFE_FEFE;

const VAR_MAGIC: [u8; 8] = [0xBB; 8];

/// A column's stored type. Widths are for the 64-bit (`datc64`)
/// variant: references and offsets are `u64`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnType {
    Bool,
    U8,
    I8,
    U16,
    I16,
    U32,
    I32,
    F32,
    U64,
    I64,
    /// UTF-16LE string; cell holds a `u64` offset into the var section.
    String,
    /// Reference into another table; cell holds `u64` row id + `u64`
    /// pad (16 bytes). `NULL_ROW` = no reference.
    ForeignRow,
    /// Reference into this same table; `u64` row id (8 bytes).
    Row,
    /// Enum value; stored as `i32`.
    EnumRow,
    /// Cell holds `u64` element count + `u64` offset into the var
    /// section (16 bytes), regardless of element type.
    Array,
}

impl ColumnType {
    /// Width in bytes of a non-array cell of this type.
    pub fn width(self) -> usize {
        match self {
            Self::Bool | Self::U8 | Self::I8 => 1,
            Self::U16 | Self::I16 => 2,
            Self::U32 | Self::I32 | Self::F32 | Self::EnumRow => 4,
            Self::U64 | Self::I64 | Self::String | Self::Row => 8,
            Self::ForeignRow | Self::Array => 16,
        }
    }

    /// Map a dat-schema `type` string to a [`ColumnType`]. Returns
    /// `None` for a type we don't model (so the schema loader can flag
    /// it rather than silently mis-size a column).
    pub fn from_schema(name: &str) -> Option<Self> {
        Some(match name {
            "bool" => Self::Bool,
            "u8" => Self::U8,
            "i8" => Self::I8,
            "u16" => Self::U16,
            "i16" => Self::I16,
            "u32" => Self::U32,
            "i32" => Self::I32,
            "f32" => Self::F32,
            "u64" => Self::U64,
            "i64" => Self::I64,
            "string" => Self::String,
            "foreignrow" => Self::ForeignRow,
            "row" => Self::Row,
            "enumrow" => Self::EnumRow,
            "array" => Self::Array,
            _ => return None,
        })
    }
}

/// One column. `name` is `None` for the schema's unnamed padding
/// columns (kept so offsets of later columns stay correct).
#[derive(Debug, Clone)]
pub struct Column {
    pub name: Option<String>,
    pub ctype: ColumnType,
    /// If set, the column is stored as an array reference (16 bytes)
    /// whose elements are `ctype`, regardless of `ctype`'s own width.
    pub array: bool,
    /// If set (and not an array), the column stores a `[lo, hi]` pair —
    /// two `ctype` values back to back, so twice the scalar width.
    pub interval: bool,
    /// For `foreignrow`/`row` columns: the table this references (from
    /// dat-schema). Lets a foreign id resolve to the target's `Id`.
    pub references: Option<String>,
}

impl Column {
    pub fn new(name: &str, ctype: ColumnType) -> Self {
        Self {
            name: Some(name.to_string()),
            ctype,
            array: false,
            interval: false,
            references: None,
        }
    }
    pub fn unnamed(ctype: ColumnType) -> Self {
        Self {
            name: None,
            ctype,
            array: false,
            interval: false,
            references: None,
        }
    }
    pub fn array(name: &str, ctype: ColumnType) -> Self {
        Self {
            name: Some(name.to_string()),
            ctype,
            array: true,
            interval: false,
            references: None,
        }
    }
    /// Full constructor used by the dat-schema loader.
    pub fn from_parts(
        name: Option<String>,
        ctype: ColumnType,
        array: bool,
        interval: bool,
        references: Option<String>,
    ) -> Self {
        Self {
            name,
            ctype,
            array,
            interval,
            references,
        }
    }
    fn width(&self) -> usize {
        if self.array {
            16
        } else if self.interval {
            2 * self.ctype.width()
        } else {
            self.ctype.width()
        }
    }
}

/// Column layout for one table, with precomputed per-column byte
/// offsets and the total row width.
#[derive(Debug, Clone)]
pub struct TableSchema {
    pub columns: Vec<Column>,
    offsets: Vec<usize>,
    row_width: usize,
}

impl TableSchema {
    pub fn new(columns: Vec<Column>) -> Self {
        let mut offsets = Vec::with_capacity(columns.len());
        let mut off = 0;
        for c in &columns {
            offsets.push(off);
            off += c.width();
        }
        Self {
            columns,
            offsets,
            row_width: off,
        }
    }

    pub fn row_width(&self) -> usize {
        self.row_width
    }

    /// Index of the named column, if present.
    pub fn column(&self, name: &str) -> Option<usize> {
        self.columns
            .iter()
            .position(|c| c.name.as_deref() == Some(name))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DatError {
    /// File shorter than a 4-byte row count.
    TooSmall,
    /// The 8×0xBB var-section magic wasn't where `4 + rows*row_width`
    /// put it — the schema's row width doesn't match the file.
    SchemaMismatch {
        row_count: usize,
        schema_row_width: usize,
        expected_boundary: usize,
    },
    /// A string/array offset pointed outside the var section.
    BadVarOffset { offset: usize, var_len: usize },
    /// A UTF-16 string didn't decode.
    BadString,
    /// Row or column index out of range for a typed accessor.
    OutOfRange,
}

impl std::fmt::Display for DatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooSmall => write!(f, "dat: file smaller than a row-count header"),
            Self::SchemaMismatch {
                row_count,
                schema_row_width,
                expected_boundary,
            } => write!(
                f,
                "dat: schema row width {schema_row_width} × {row_count} rows put the var \
                 section at {expected_boundary}, but the 0xBB magic isn't there \
                 (schema likely doesn't match this table version)",
            ),
            Self::BadVarOffset { offset, var_len } => {
                write!(
                    f,
                    "dat: var offset {offset} outside section of {var_len} bytes"
                )
            }
            Self::BadString => write!(f, "dat: invalid UTF-16 string"),
            Self::OutOfRange => write!(f, "dat: row/column index out of range"),
        }
    }
}

impl std::error::Error for DatError {}

/// A parsed table borrowing the decompressed file bytes and its schema.
pub struct Dat<'a> {
    schema: &'a TableSchema,
    row_count: usize,
    fixed: &'a [u8],
    var: &'a [u8],
}

impl<'a> Dat<'a> {
    /// Parse `data` (the decompressed `.datc64` payload) against
    /// `schema`. Validates the schema against the file via the var
    /// magic; a wrong schema errors rather than silently misreads.
    pub fn parse(data: &'a [u8], schema: &'a TableSchema) -> Result<Self, DatError> {
        if data.len() < 4 {
            return Err(DatError::TooSmall);
        }
        let row_count = u32::from_le_bytes(data[0..4].try_into().unwrap()) as usize;
        let boundary = 4 + row_count * schema.row_width;
        if data.len() < boundary + VAR_MAGIC.len() || data[boundary..boundary + 8] != VAR_MAGIC {
            return Err(DatError::SchemaMismatch {
                row_count,
                schema_row_width: schema.row_width,
                expected_boundary: boundary,
            });
        }
        Ok(Self {
            schema,
            row_count,
            fixed: &data[4..boundary],
            var: &data[boundary..],
        })
    }

    pub fn row_count(&self) -> usize {
        self.row_count
    }

    /// Bytes of one cell: `&fixed[row*row_width + col_offset ..]`.
    fn cell(&self, row: usize, col: usize) -> Result<&'a [u8], DatError> {
        if row >= self.row_count || col >= self.schema.offsets.len() {
            return Err(DatError::OutOfRange);
        }
        let base = row * self.schema.row_width + self.schema.offsets[col];
        self.fixed.get(base..).ok_or(DatError::OutOfRange)
    }

    pub fn u32(&self, row: usize, col: usize) -> Result<u32, DatError> {
        let c = self.cell(row, col)?;
        Ok(u32::from_le_bytes(
            c.get(..4).ok_or(DatError::OutOfRange)?.try_into().unwrap(),
        ))
    }

    pub fn i32(&self, row: usize, col: usize) -> Result<i32, DatError> {
        Ok(self.u32(row, col)? as i32)
    }

    /// An `interval` column's `(low, high)` pair — two `i32`s back to
    /// back (e.g. a mod's min/max roll for one stat).
    pub fn i32_interval(&self, row: usize, col: usize) -> Result<(i32, i32), DatError> {
        let c = self.cell(row, col)?;
        let lo = i32::from_le_bytes(c.get(..4).ok_or(DatError::OutOfRange)?.try_into().unwrap());
        let hi = i32::from_le_bytes(c.get(4..8).ok_or(DatError::OutOfRange)?.try_into().unwrap());
        Ok((lo, hi))
    }

    pub fn u16(&self, row: usize, col: usize) -> Result<u16, DatError> {
        let c = self.cell(row, col)?;
        Ok(u16::from_le_bytes(
            c.get(..2).ok_or(DatError::OutOfRange)?.try_into().unwrap(),
        ))
    }

    pub fn u64(&self, row: usize, col: usize) -> Result<u64, DatError> {
        let c = self.cell(row, col)?;
        Ok(u64::from_le_bytes(
            c.get(..8).ok_or(DatError::OutOfRange)?.try_into().unwrap(),
        ))
    }

    pub fn u8(&self, row: usize, col: usize) -> Result<u8, DatError> {
        Ok(*self.cell(row, col)?.first().ok_or(DatError::OutOfRange)?)
    }

    pub fn f32(&self, row: usize, col: usize) -> Result<f32, DatError> {
        Ok(f32::from_bits(self.u32(row, col)?))
    }

    pub fn bool(&self, row: usize, col: usize) -> Result<bool, DatError> {
        let c = self.cell(row, col)?;
        Ok(*c.first().ok_or(DatError::OutOfRange)? != 0)
    }

    /// A `foreignrow`/`row` reference: the referenced row id, or `None`
    /// for the null sentinel.
    pub fn foreign(&self, row: usize, col: usize) -> Result<Option<u64>, DatError> {
        let v = self.u64(row, col)?;
        Ok((v != NULL_ROW).then_some(v))
    }

    /// A UTF-16LE string value (follows the cell's `u64` var offset).
    pub fn string(&self, row: usize, col: usize) -> Result<String, DatError> {
        let off = self.u64(row, col)? as usize;
        read_utf16(self.var, off)
    }

    /// An array cell's `(element_count, byte_offset_into_var)`. The 16-byte
    /// cell is `count: u64` then `offset: u64` (verified against real
    /// tables). Elements live at `offset` in the var section, each
    /// `element_type.width()` bytes wide.
    pub fn array_ref(&self, row: usize, col: usize) -> Result<(usize, usize), DatError> {
        let c = self.cell(row, col)?;
        let count = u64::from_le_bytes(c.get(..8).ok_or(DatError::OutOfRange)?.try_into().unwrap())
            as usize;
        let offset = u64::from_le_bytes(
            c.get(8..16)
                .ok_or(DatError::OutOfRange)?
                .try_into()
                .unwrap(),
        ) as usize;
        // A real array's elements live inside the var section; a count
        // that can't fit is schema drift reading garbage bytes — reject
        // it rather than letting callers iterate a trillion elements.
        if offset > self.var.len() || count > self.var.len() - offset {
            return Err(DatError::OutOfRange);
        }
        Ok((count, offset))
    }

    /// The variable-length data section — for decoding array elements at
    /// the offset returned by [`array_ref`](Self::array_ref).
    pub fn var(&self) -> &[u8] {
        self.var
    }

    /// Read a UTF-16LE string at an absolute offset into the var section
    /// (array-of-string elements store such offsets).
    pub fn string_at(&self, var_offset: usize) -> Result<String, DatError> {
        read_utf16(self.var, var_offset)
    }
}

/// Tolerate trailing schema drift. The community dat-schema lags the live
/// game; a common drift is GGG appending a column, so the schema's row
/// width is a few bytes short and [`Dat::parse`] rejects the file. This
/// finds the real fixed/var boundary (the `0xBB` magic) and appends
/// unnamed `u8` padding until the width matches — safe for reading the
/// earlier (correctly-placed) columns. Returns the fixed schema, or
/// `None` if it can't reconcile (e.g. a mid-row change, not trailing).
pub fn autofit(data: &[u8], schema: &TableSchema) -> Option<TableSchema> {
    if Dat::parse(data, schema).is_ok() {
        return Some(schema.clone());
    }
    if data.len() < 12 {
        return None;
    }
    let rc = u32::from_le_bytes(data[0..4].try_into().ok()?) as usize;
    if rc == 0 {
        return None;
    }
    // The real boundary is the first 0xBB×8 at an offset consistent with
    // an integer row width.
    let mut pos = 4;
    let boundary = loop {
        let p = data.get(pos..)?.windows(8).position(|w| w == VAR_MAGIC)? + pos;
        if (p - 4) % rc == 0 {
            break p;
        }
        pos = p + 1;
    };
    let actual = (boundary - 4) / rc;
    let cur = schema.row_width();
    if actual > cur && actual - cur <= 128 {
        // Schema BEHIND the live table: pad trailing unknown columns
        // with unnamed bytes. Cap generous — only trailing bytes are
        // added and Dat::parse re-validates every offset, so a wrong
        // boundary can't slip through. (PoE1's BaseItemTypes is 48B
        // wider than the community schema's named columns.)
        let mut cols = schema.columns.clone();
        for _ in 0..(actual - cur) {
            cols.push(Column::unnamed(ColumnType::U8));
        }
        let fixed = TableSchema::new(cols);
        return if Dat::parse(data, &fixed).is_ok() {
            Some(fixed)
        } else {
            None
        };
    }
    if actual < cur && cur - actual <= 128 {
        // Schema AHEAD of the live table (the community schema tracks
        // the newest patch of each game; an older live table can be
        // narrower): drop trailing columns until we fit, then pad the
        // remainder with unnamed bytes. Only TRAILING columns are ever
        // dropped — if a shaper needs one of them by name it fails
        // loudly with MissingColumn instead of misreading offsets.
        let mut cols = schema.columns.clone();
        let mut width = cur;
        while width > actual {
            let last = cols.pop()?;
            width -= last.width();
        }
        for _ in 0..(actual - width) {
            cols.push(Column::unnamed(ColumnType::U8));
        }
        let fixed = TableSchema::new(cols);
        return if Dat::parse(data, &fixed).is_ok() {
            Some(fixed)
        } else {
            None
        };
    }
    None
}

/// Decode a NUL-terminated UTF-16LE string starting at `off` in `var`.
fn read_utf16(var: &[u8], off: usize) -> Result<String, DatError> {
    if off > var.len() {
        return Err(DatError::BadVarOffset {
            offset: off,
            var_len: var.len(),
        });
    }
    let mut units = Vec::new();
    let mut p = off;
    while p + 1 < var.len() {
        let u = u16::from_le_bytes([var[p], var[p + 1]]);
        if u == 0 {
            break;
        }
        units.push(u);
        p += 2;
    }
    String::from_utf16(&units).map_err(|_| DatError::BadString)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Assemble a synthetic datc64: two columns [u32 id, string name].
    fn synthetic() -> (Vec<u8>, TableSchema) {
        let schema = TableSchema::new(vec![
            Column::new("id", ColumnType::U32),
            Column::new("name", ColumnType::String),
        ]);
        // var: [0xBB*8] then "Hi\0" @8, "Yo\0" @14 (UTF-16LE).
        let mut var = vec![0xBBu8; 8];
        let hi_off = var.len() as u64;
        var.extend_from_slice(&[0x48, 0x00, 0x69, 0x00, 0x00, 0x00]); // "Hi"
        let yo_off = var.len() as u64;
        var.extend_from_slice(&[0x59, 0x00, 0x6F, 0x00, 0x00, 0x00]); // "Yo"

        let mut data = Vec::new();
        data.extend_from_slice(&2u32.to_le_bytes()); // row_count
        // row 0
        data.extend_from_slice(&7u32.to_le_bytes());
        data.extend_from_slice(&hi_off.to_le_bytes());
        // row 1
        data.extend_from_slice(&42u32.to_le_bytes());
        data.extend_from_slice(&yo_off.to_le_bytes());
        data.extend_from_slice(&var);
        (data, schema)
    }

    #[test]
    fn reads_scalars_and_strings() {
        let (data, schema) = synthetic();
        let dat = Dat::parse(&data, &schema).expect("parse");
        assert_eq!(dat.row_count(), 2);
        assert_eq!(dat.u32(0, 0).unwrap(), 7);
        assert_eq!(dat.string(0, 1).unwrap(), "Hi");
        assert_eq!(dat.u32(1, 0).unwrap(), 42);
        assert_eq!(dat.string(1, 1).unwrap(), "Yo");
    }

    #[test]
    fn wrong_schema_width_is_caught() {
        let (data, _) = synthetic();
        // A schema one byte too wide shifts the boundary off the magic.
        let bad = TableSchema::new(vec![
            Column::new("id", ColumnType::U64), // 8 instead of 4
            Column::new("name", ColumnType::String),
        ]);
        assert!(matches!(
            Dat::parse(&data, &bad),
            Err(DatError::SchemaMismatch { .. })
        ));
    }

    #[test]
    fn reads_i32_interval() {
        // one row, one interval column: [lo=-5, hi=12]
        let schema = TableSchema::new(vec![Column::from_parts(
            Some("Range".into()),
            ColumnType::I32,
            false,
            true,
            None,
        )]);
        let mut data = Vec::new();
        data.extend_from_slice(&1u32.to_le_bytes());
        data.extend_from_slice(&(-5i32).to_le_bytes());
        data.extend_from_slice(&12i32.to_le_bytes());
        data.extend_from_slice(&[0xBB; 8]);
        let dat = Dat::parse(&data, &schema).expect("parse");
        assert_eq!(dat.i32_interval(0, 0).unwrap(), (-5, 12));
    }

    #[test]
    fn foreignrow_null_and_value() {
        let schema = TableSchema::new(vec![Column::new("ref", ColumnType::ForeignRow)]);
        let mut data = Vec::new();
        data.extend_from_slice(&2u32.to_le_bytes());
        // row 0: rowid 5 + pad
        data.extend_from_slice(&5u64.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());
        // row 1: null sentinel + pad
        data.extend_from_slice(&NULL_ROW.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());
        data.extend_from_slice(&[0xBB; 8]);
        let dat = Dat::parse(&data, &schema).expect("parse");
        assert_eq!(dat.foreign(0, 0).unwrap(), Some(5));
        assert_eq!(dat.foreign(1, 0).unwrap(), None);
    }

    /// Known-answer test against real game tables. Point DAT_TESTDIR at
    /// a dir holding masteryart.datc64 / masterygroups.datc64 (fetch via
    /// `buildwright get data/balance/passiveskilltreemasteryart.datc64`).
    /// Skipped when unset — we don't vendor copyrighted game data.
    #[test]
    fn real_mastery_tables() {
        let Ok(dir) = std::env::var("DAT_TESTDIR") else {
            eprintln!("skipped: set DAT_TESTDIR to a dir with the mastery .datc64 files");
            return;
        };

        // PassiveSkillTreeMasteryArt: Id, InactiveIcon, ActiveIcon,
        // ActiveEffectImage — four strings (row width 32).
        let art_schema = TableSchema::new(vec![
            Column::new("Id", ColumnType::String),
            Column::new("InactiveIcon", ColumnType::String),
            Column::new("ActiveIcon", ColumnType::String),
            Column::new("ActiveEffectImage", ColumnType::String),
        ]);
        let art_bytes = std::fs::read(format!("{dir}/masteryart.datc64")).unwrap();
        let art = Dat::parse(&art_bytes, &art_schema).expect("masteryart");
        assert_eq!(art.row_count(), 82, "masteryart row count");
        assert_eq!(art.string(0, 0).unwrap(), "Accuracy");
        assert!(
            art.string(0, 3).unwrap().contains("MasteryAccuracyPattern"),
            "row 0 pattern image"
        );

        // PassiveSkillMasteryGroups: Id, MasteryEffects(fk), <bool>,
        // SoundEffect(fk), MasteryCountStat(fk), Art(fk → MasteryArt).
        let grp_schema = TableSchema::new(vec![
            Column::new("Id", ColumnType::String),
            Column::new("MasteryEffects", ColumnType::ForeignRow),
            Column::unnamed(ColumnType::Bool),
            Column::new("SoundEffect", ColumnType::ForeignRow),
            Column::new("MasteryCountStat", ColumnType::ForeignRow),
            Column::new("Art", ColumnType::ForeignRow),
        ]);
        let grp_bytes = std::fs::read(format!("{dir}/masterygroups.datc64")).unwrap();
        let grp = Dat::parse(&grp_bytes, &grp_schema).expect("masterygroups");
        assert!(grp.row_count() > 0);
        // Every group's Art fk must resolve into MasteryArt, and its Id
        // string must be non-empty — exercises fk + string end to end.
        let art_col = grp_schema.column("Art").unwrap();
        for r in 0..grp.row_count() {
            assert!(!grp.string(r, 0).unwrap().is_empty(), "group {r} Id");
            if let Some(art_id) = grp.foreign(r, art_col).unwrap() {
                assert!(
                    (art_id as usize) < art.row_count(),
                    "group {r} Art fk range"
                );
            }
        }
        eprintln!(
            "validated {} mastery groups against {} art rows",
            grp.row_count(),
            art.row_count()
        );
    }
}
