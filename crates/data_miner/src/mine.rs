//! Systematic table extraction — the repeatable "GGG table → TSV" core.
//!
//! Given a parsed [`Dat`] + its [`TableSchema`], [`export_tsv`] writes a
//! clean, deterministic TSV of every *named* column. Two things make the
//! output self-describing:
//!
//! - **Array expansion** — array cells become `[a;b;c]` of their
//!   elements (each `element_type.width()` bytes at the cell's var
//!   offset), not a `[array]` placeholder.
//! - **Reference resolution** — a `foreignrow` resolves to the target
//!   table's `Id` string via a [`RefMap`], instead of an opaque row
//!   index. Unresolved refs render as `#<rowid>` so coverage gaps are
//!   visible; nulls render empty.
//!
//! The CLI (`buildwright mine`) fetches the export set + every table
//! they reference, builds the [`RefMap`] with [`id_column`], and drives
//! this in a loop; the same manifest/verify path then hashes the output.

use std::collections::HashMap;

use crate::dat::{ColumnType, Dat, NULL_ROW, TableSchema};

/// table name → its `Id` string per row index, used to resolve
/// `foreignrow` references to a readable id.
pub type RefMap = HashMap<String, Vec<String>>;

/// The `Id` (or first named string column) value of every row — the
/// lookup a [`RefMap`] entry is built from.
pub fn id_column(dat: &Dat, schema: &TableSchema) -> Vec<String> {
    let col = schema.column("Id").or_else(|| {
        schema
            .columns
            .iter()
            .position(|c| c.name.is_some() && !c.array && c.ctype == ColumnType::String)
    });
    match col {
        Some(c) => (0..dat.row_count())
            .map(|r| dat.string(r, c).unwrap_or_default())
            .collect(),
        None => (0..dat.row_count()).map(|r| r.to_string()).collect(),
    }
}

/// Resolve a foreign row id against the RefMap. Falls back to `#<rowid>`
/// when the target table wasn't loaded or the row is out of range.
fn resolve(refs: &RefMap, table: Option<&str>, rid: u64) -> String {
    if let Some(t) = table
        && let Some(ids) = refs.get(t)
        && let Some(id) = ids.get(rid as usize)
        && !id.is_empty()
    {
        return id.clone();
    }
    format!("#{rid}")
}

/// Render one cell to raw semantic text (unquoted). Foreign refs resolve
/// via `refs`; arrays expand. Callers emitting TSV must sanitise (see
/// [`export_tsv`]).
pub fn render_cell(
    dat: &Dat,
    schema: &TableSchema,
    row: usize,
    col: usize,
    refs: &RefMap,
) -> String {
    let c = &schema.columns[col];
    if c.array {
        return render_array(dat, schema, row, col, refs);
    }
    let fallback = |r: Result<String, crate::dat::DatError>| r.unwrap_or_else(|e| format!("<{e}>"));
    match c.ctype {
        ColumnType::String => fallback(dat.string(row, col)),
        ColumnType::Bool => fallback(dat.bool(row, col).map(|b| b.to_string())),
        ColumnType::ForeignRow | ColumnType::Row => match dat.foreign(row, col) {
            Ok(Some(rid)) => resolve(refs, c.references.as_deref(), rid),
            Ok(None) => String::new(),
            Err(e) => format!("<{e}>"),
        },
        ColumnType::U8 | ColumnType::I8 => fallback(dat.u8(row, col).map(|v| v.to_string())),
        ColumnType::U16 | ColumnType::I16 => fallback(dat.u16(row, col).map(|v| v.to_string())),
        ColumnType::I32 => fallback(dat.i32(row, col).map(|v| v.to_string())),
        ColumnType::U32 | ColumnType::EnumRow => fallback(dat.u32(row, col).map(|v| v.to_string())),
        ColumnType::F32 => fallback(dat.f32(row, col).map(|v| v.to_string())),
        ColumnType::U64 | ColumnType::I64 => fallback(dat.u64(row, col).map(|v| v.to_string())),
        ColumnType::Array => "[array]".to_string(),
    }
}

/// Expand an array cell into `[e0;e1;…]`. Elements are `ctype.width()`
/// bytes each at the cell's var offset.
fn render_array(dat: &Dat, schema: &TableSchema, row: usize, col: usize, refs: &RefMap) -> String {
    let c = &schema.columns[col];
    let Ok((count, offset)) = dat.array_ref(row, col) else {
        return "[?]".to_string();
    };
    let var = dat.var();
    let stride = c.ctype.width();
    let rd = |o: usize, n: usize| -> Option<&[u8]> { var.get(o..o + n) };
    let u64_at = |o: usize| rd(o, 8).map(|b| u64::from_le_bytes(b.try_into().unwrap()));
    let u32_at = |o: usize| rd(o, 4).map(|b| u32::from_le_bytes(b.try_into().unwrap()));
    let u16_at = |o: usize| rd(o, 2).map(|b| u16::from_le_bytes(b.try_into().unwrap()));

    let mut out = String::from("[");
    for i in 0..count {
        if i > 0 {
            out.push(';');
        }
        let eo = offset + i * stride;
        let elem = match c.ctype {
            ColumnType::String => u64_at(eo)
                .and_then(|so| dat.string_at(so as usize).ok())
                .unwrap_or_default(),
            ColumnType::ForeignRow | ColumnType::Row => match u64_at(eo) {
                Some(rid) if rid != NULL_ROW => resolve(refs, c.references.as_deref(), rid),
                _ => String::new(),
            },
            ColumnType::I32 => u32_at(eo)
                .map(|v| (v as i32).to_string())
                .unwrap_or_default(),
            ColumnType::U32 | ColumnType::EnumRow => {
                u32_at(eo).map(|v| v.to_string()).unwrap_or_default()
            }
            ColumnType::F32 => u32_at(eo)
                .map(|v| f32::from_bits(v).to_string())
                .unwrap_or_default(),
            ColumnType::U16 | ColumnType::I16 => {
                u16_at(eo).map(|v| v.to_string()).unwrap_or_default()
            }
            ColumnType::U8 | ColumnType::I8 => {
                var.get(eo).map(|b| b.to_string()).unwrap_or_default()
            }
            ColumnType::U64 | ColumnType::I64 => {
                u64_at(eo).map(|v| v.to_string()).unwrap_or_default()
            }
            ColumnType::Bool => var
                .get(eo)
                .map(|b| (*b != 0).to_string())
                .unwrap_or_default(),
            ColumnType::Array => "[array]".to_string(),
        };
        out.push_str(&elem);
    }
    out.push(']');
    out
}

/// TSV-safe: strip characters that would break a `\t`-delimited,
/// `\n`-terminated row. Game strings occasionally carry newlines.
fn sanitize(cell: &str) -> String {
    if cell.contains(['\t', '\n', '\r']) {
        cell.replace(['\t', '\n', '\r'], " ")
    } else {
        cell.to_string()
    }
}

/// Export a whole table to a deterministic TSV: a header of the named
/// columns, then one row per record. `refs` resolves foreign ids.
pub fn export_tsv(dat: &Dat, schema: &TableSchema, refs: &RefMap) -> String {
    let named: Vec<usize> = (0..schema.columns.len())
        .filter(|&i| schema.columns[i].name.is_some())
        .collect();

    let mut out = String::with_capacity(dat.row_count() * named.len() * 8 + 64);
    for (j, &c) in named.iter().enumerate() {
        if j > 0 {
            out.push('\t');
        }
        out.push_str(schema.columns[c].name.as_deref().unwrap_or("?"));
    }
    out.push('\n');
    for r in 0..dat.row_count() {
        for (j, &c) in named.iter().enumerate() {
            if j > 0 {
                out.push('\t');
            }
            out.push_str(&sanitize(&render_cell(dat, schema, r, c, refs)));
        }
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dat::{Column, ColumnType, TableSchema};

    #[test]
    fn exports_named_columns_with_resolution() {
        // schema: id(string), _pad(unnamed i32), ref(foreignrow → "T")
        let schema = TableSchema::new(vec![
            Column::new("id", ColumnType::String),
            Column::unnamed(ColumnType::I32),
            Column::from_parts(
                Some("ref".into()),
                ColumnType::ForeignRow,
                false,
                false,
                Some("T".into()),
            ),
        ]);
        // one row: id@8 "Hi", pad 0, ref → rowid 1 (+pad)
        let mut var = vec![0xBBu8; 8];
        var.extend_from_slice(&[0x48, 0x00, 0x69, 0x00, 0x00, 0x00]); // "Hi"
        let mut data = Vec::new();
        data.extend_from_slice(&1u32.to_le_bytes()); // row_count
        data.extend_from_slice(&8u64.to_le_bytes()); // id offset
        data.extend_from_slice(&0i32.to_le_bytes()); // pad
        data.extend_from_slice(&1u64.to_le_bytes()); // ref rowid
        data.extend_from_slice(&0u64.to_le_bytes()); // ref pad
        data.extend_from_slice(&var);

        let dat = Dat::parse(&data, &schema).expect("parse");
        let mut refs = RefMap::new();
        refs.insert("T".into(), vec!["Zero".into(), "One".into()]);
        assert_eq!(export_tsv(&dat, &schema, &refs), "id\tref\nHi\tOne\n");

        // Without the RefMap, the ref falls back to #rowid.
        assert_eq!(
            export_tsv(&dat, &schema, &RefMap::new()),
            "id\tref\nHi\t#1\n"
        );
    }
}
