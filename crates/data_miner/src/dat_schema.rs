//! Load the community `dat-schema` JSON into [`TableSchema`]s, so we
//! don't hand-write column layouts.
//!
//! Source: <https://github.com/poe-tool-dev/dat-schema> `schema.min.json`.
//! Each table entry has a `validFor` (1 = PoE1, 2 = PoE2, 3 = both) and
//! a `columns` array of `{ name?, type, array, interval, references }`.
//! We keep the PoE2-relevant tables (`validFor` 2 or 3), preferring a
//! PoE2-specific (`2`) definition over a shared (`3`) one when both
//! exist.
//!
//! The schema is only a *claim* about layout; [`crate::dat::Dat::parse`]
//! validates it against the file's `0xBB` boundary, so a stale schema
//! fails loudly instead of mis-reading.

use std::collections::HashMap;

use crate::dat::{Column, ColumnType, TableSchema};

#[derive(Debug)]
pub enum SchemaError {
    Json(json::Error),
    /// The JSON didn't have the expected shape.
    Shape(&'static str),
    /// A column used a `type` we don't model.
    UnknownType {
        table: String,
        ty: String,
    },
}

impl std::fmt::Display for SchemaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Json(e) => write!(f, "dat-schema: {e}"),
            Self::Shape(w) => write!(f, "dat-schema: unexpected shape ({w})"),
            Self::UnknownType { table, ty } => {
                write!(f, "dat-schema: unknown column type {ty:?} in table {table}")
            }
        }
    }
}

impl std::error::Error for SchemaError {}

/// All PoE2 table layouts parsed from a dat-schema document.
pub struct SchemaSet {
    tables: HashMap<String, TableSchema>,
    /// dat-schema document version (provenance).
    pub version: i64,
}

impl SchemaSet {
    /// Parse a `schema.min.json` document.
    pub fn from_json(src: &str) -> Result<Self, SchemaError> {
        let root = json::parse(src).map_err(SchemaError::Json)?;
        let version = root.get("version").and_then(|v| v.as_i64()).unwrap_or(0);
        let tables_v = root
            .get("tables")
            .and_then(|v| v.as_array())
            .ok_or(SchemaError::Shape("no `tables` array"))?;

        // name -> (validFor, schema); keep validFor==2 over ==3 on clash.
        let mut chosen: HashMap<String, (i64, TableSchema)> = HashMap::new();

        for t in tables_v {
            let valid_for = t.get("validFor").and_then(|v| v.as_i64()).unwrap_or(0);
            if valid_for != 2 && valid_for != 3 {
                continue; // PoE1-only
            }
            let name = t
                .get("name")
                .and_then(|v| v.as_str())
                .ok_or(SchemaError::Shape("table without name"))?
                .to_string();
            let cols_v = t
                .get("columns")
                .and_then(|v| v.as_array())
                .ok_or(SchemaError::Shape("table without columns"))?;

            let mut columns = Vec::with_capacity(cols_v.len());
            for c in cols_v {
                let cname = c.get("name").and_then(|v| v.as_str()).map(str::to_string);
                let ty = c
                    .get("type")
                    .and_then(|v| v.as_str())
                    .ok_or(SchemaError::Shape("column without type"))?;
                let ctype =
                    ColumnType::from_schema(ty).ok_or_else(|| SchemaError::UnknownType {
                        table: name.clone(),
                        ty: ty.to_string(),
                    })?;
                let array = c.get("array").and_then(|v| v.as_bool()).unwrap_or(false);
                let interval = c.get("interval").and_then(|v| v.as_bool()).unwrap_or(false);
                // `references` is `{ "table": "X", ... }` or null.
                let references = c
                    .get("references")
                    .and_then(|v| v.get("table"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                columns.push(Column::from_parts(
                    cname, ctype, array, interval, references,
                ));
            }

            let schema = TableSchema::new(columns);
            match chosen.get(&name) {
                // A PoE2-specific def already won; don't overwrite with a shared one.
                Some((2, _)) => {}
                _ => {
                    chosen.insert(name, (valid_for, schema));
                }
            }
        }

        let tables = chosen.into_iter().map(|(k, (_, s))| (k, s)).collect();
        Ok(Self { tables, version })
    }

    pub fn table(&self, name: &str) -> Option<&TableSchema> {
        self.tables.get(name)
    }

    pub fn len(&self) -> usize {
        self.tables.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tables.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINI: &str = r#"{
        "version": 7,
        "tables": [
            { "name": "OnlyPoE1", "validFor": 1, "columns": [
                { "name": "Id", "type": "string", "array": false }
            ]},
            { "name": "Sample", "validFor": 2, "columns": [
                { "name": "Id",    "type": "string",     "array": false },
                { "name": "Count", "type": "i32",        "array": false },
                { "name": "Stats", "type": "foreignrow", "array": true  },
                { "name": "Range", "type": "i32", "array": false, "interval": true },
                { "name": "Ref",   "type": "foreignrow", "array": false }
            ]}
        ]
    }"#;

    #[test]
    fn parses_poe2_tables_only() {
        let set = SchemaSet::from_json(MINI).expect("parse");
        assert_eq!(set.version, 7);
        assert_eq!(set.len(), 1); // OnlyPoE1 excluded
        assert!(set.table("OnlyPoE1").is_none());

        let s = set.table("Sample").expect("Sample");
        // widths: string 8 + i32 4 + array 16 + interval(i32) 8 + foreignrow 16 = 52
        assert_eq!(s.row_width(), 52);
        assert_eq!(s.column("Id"), Some(0));
        assert_eq!(s.column("Ref"), Some(4));
    }

    #[test]
    fn unknown_type_is_flagged() {
        let bad = r#"{"version":1,"tables":[
            {"name":"T","validFor":2,"columns":[{"name":"x","type":"quaternion","array":false}]}
        ]}"#;
        assert!(matches!(
            SchemaSet::from_json(bad),
            Err(SchemaError::UnknownType { .. })
        ));
    }

    /// Real schema × real table: load PassiveSkills from dat-schema,
    /// parse the live table, and confirm the MasteryGroup column reads.
    /// Gated: DAT_SCHEMA=<schema.min.json> DAT_TESTDIR=<dir with
    /// passiveskills.datc64>.
    #[test]
    fn real_passiveskills_mastery_group() {
        let (Ok(schema_path), Ok(dir)) =
            (std::env::var("DAT_SCHEMA"), std::env::var("DAT_TESTDIR"))
        else {
            eprintln!("skipped: set DAT_SCHEMA and DAT_TESTDIR");
            return;
        };
        let set = SchemaSet::from_json(&std::fs::read_to_string(schema_path).unwrap()).unwrap();
        let schema = set.table("PassiveSkills").expect("PassiveSkills schema");
        let bytes = std::fs::read(format!("{dir}/passiveskills.datc64")).unwrap();
        let dat = crate::dat::Dat::parse(&bytes, schema).expect("parse passiveskills");

        let mg = schema.column("MasteryGroup").expect("MasteryGroup column");
        let with_group = (0..dat.row_count())
            .filter(|&r| dat.foreign(r, mg).unwrap().is_some())
            .count();
        eprintln!(
            "PassiveSkills rows={} with MasteryGroup={}",
            dat.row_count(),
            with_group
        );
        assert_eq!(with_group, 1188, "nodes carrying a MasteryGroup");
    }
}
