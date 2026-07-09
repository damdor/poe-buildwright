//! Zero-dependency JSON parser, emitter, and Value type.
//!
//! Provides [`Value`] for representing JSON data, [`parse`] for parsing JSON
//! strings, and [`emit`] (compact) / [`emit_pretty`] for rendering output.
//!
//! Fully safe (holds the workspace's `forbid(unsafe_code)`). Objects are
//! backed by a `BTreeMap`, so emit is deterministic (key-sorted) —
//! byte-stable output, which keeps manifests and their diffs clean.

use std::collections::BTreeMap;
use std::fmt;
use std::io::Read;

mod reader;
pub mod writer;

/// Ordered map type used for JSON objects.
///
/// Uses `BTreeMap` for deterministic key ordering in output.
pub type Map = BTreeMap<String, Value>;

/// Errors that occur during JSON parsing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub msg: String,
    pub pos: usize,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "JSON error at byte {}: {}", self.pos, self.msg)
    }
}

impl std::error::Error for Error {}

/// A parsed JSON value.
#[derive(Debug, Clone, PartialEq, Default)]
pub enum Value {
    /// JSON `null`.
    #[default]
    Null,
    /// JSON boolean.
    Bool(bool),
    /// JSON integer (fits in i64).
    Integer(i64),
    /// JSON floating-point number.
    Float(f64),
    /// JSON string.
    Str(String),
    /// JSON array.
    Array(Vec<Value>),
    /// JSON object (sorted by key).
    Object(Map),
}

// ---------------------------------------------------------------------------
// Accessor methods
// ---------------------------------------------------------------------------

impl Value {
    /// Get the value as a `&str` if it is a string.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }

    /// Get the value as an `i64` if it is an integer (or an exact integer float).
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Value::Integer(n) => Some(*n),
            Value::Float(f) => {
                let i = *f as i64;
                if (i as f64 - *f).abs() < f64::EPSILON {
                    Some(i)
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    /// Get the value as a `u64` if it is a non-negative integer.
    pub fn as_u64(&self) -> Option<u64> {
        match self {
            Value::Integer(n) if *n >= 0 => Some(*n as u64),
            Value::Float(f) if *f >= 0.0 => {
                let u = *f as u64;
                if (u as f64 - *f).abs() < f64::EPSILON {
                    Some(u)
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    /// Get the value as an `f64`.
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Float(f) => Some(*f),
            Value::Integer(i) => Some(*i as f64),
            _ => None,
        }
    }

    /// Get the value as a `bool`.
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            _ => None,
        }
    }

    /// Get the value as a slice of `Value` if it is an array.
    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Value::Array(a) => Some(a),
            _ => None,
        }
    }

    /// Get a mutable reference to the array contents.
    pub fn as_array_mut(&mut self) -> Option<&mut Vec<Value>> {
        match self {
            Value::Array(a) => Some(a),
            _ => None,
        }
    }

    /// Get the value as an object map reference.
    pub fn as_object(&self) -> Option<&Map> {
        match self {
            Value::Object(m) => Some(m),
            _ => None,
        }
    }

    /// Get a mutable reference to the object map.
    pub fn as_object_mut(&mut self) -> Option<&mut Map> {
        match self {
            Value::Object(m) => Some(m),
            _ => None,
        }
    }

    /// Look up a key in an object. Returns `None` if not an object or key absent.
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Object(map) => map.get(key),
            _ => None,
        }
    }

    /// Returns `true` if this is `Null`.
    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    /// Returns `true` if this is a `Bool`.
    pub fn is_boolean(&self) -> bool {
        matches!(self, Value::Bool(_))
    }

    /// Returns `true` if this is an `Integer` or `Float`.
    pub fn is_number(&self) -> bool {
        matches!(self, Value::Integer(_) | Value::Float(_))
    }

    /// Returns `true` if this is a `Str`.
    pub fn is_string(&self) -> bool {
        matches!(self, Value::Str(_))
    }

    /// Returns `true` if this is an `Array`.
    pub fn is_array(&self) -> bool {
        matches!(self, Value::Array(_))
    }

    /// Returns `true` if this is an `Object`.
    pub fn is_object(&self) -> bool {
        matches!(self, Value::Object(_))
    }
}

// ---------------------------------------------------------------------------
// Parse functions
// ---------------------------------------------------------------------------

/// Parse a JSON string into a [`Value`].
pub fn parse(input: &str) -> Result<Value, Error> {
    reader::parse_str(input)
}

/// Parse a JSON byte slice into a [`Value`].
pub fn parse_slice(bytes: &[u8]) -> Result<Value, Error> {
    let s = std::str::from_utf8(bytes).map_err(|e| Error {
        msg: format!("invalid UTF-8: {}", e),
        pos: 0,
    })?;
    reader::parse_str(s)
}

/// Parse JSON from a reader into a [`Value`].
pub fn parse_reader(mut r: impl Read) -> Result<Value, Error> {
    let mut buf = String::new();
    r.read_to_string(&mut buf).map_err(|e| Error {
        msg: format!("IO error: {}", e),
        pos: 0,
    })?;
    reader::parse_str(&buf)
}

// ---------------------------------------------------------------------------
// Emit functions
// ---------------------------------------------------------------------------

/// Render a [`Value`] as a compact JSON string (no whitespace).
pub fn emit(v: &Value) -> String {
    let mut w = writer::JsonWriter::new();
    writer::write_value(&mut w, v);
    w.into_string()
}

/// Render a [`Value`] as a pretty-printed JSON string (2-space indentation).
pub fn emit_pretty(v: &Value) -> String {
    let mut w = writer::PrettyJsonWriter::new();
    writer::write_value_pretty(&mut w, v);
    w.into_string()
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

impl fmt::Display for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&emit(self))
    }
}

// ---------------------------------------------------------------------------
// Index impls
// ---------------------------------------------------------------------------

impl<'a> std::ops::Index<&'a str> for Value {
    type Output = Value;
    fn index(&self, key: &'a str) -> &Value {
        static NULL: Value = Value::Null;
        self.get(key).unwrap_or(&NULL)
    }
}

impl std::ops::Index<usize> for Value {
    type Output = Value;
    fn index(&self, idx: usize) -> &Value {
        static NULL: Value = Value::Null;
        match self {
            Value::Array(a) => a.get(idx).unwrap_or(&NULL),
            _ => &NULL,
        }
    }
}

// ---------------------------------------------------------------------------
// PartialEq impls for ergonomic comparisons
// ---------------------------------------------------------------------------

impl PartialEq<&str> for Value {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == Some(*other)
    }
}

impl PartialEq<str> for Value {
    fn eq(&self, other: &str) -> bool {
        self.as_str() == Some(other)
    }
}

impl PartialEq<i64> for Value {
    fn eq(&self, other: &i64) -> bool {
        self.as_i64() == Some(*other)
    }
}

impl PartialEq<f64> for Value {
    fn eq(&self, other: &f64) -> bool {
        self.as_f64() == Some(*other)
    }
}

impl PartialEq<bool> for Value {
    fn eq(&self, other: &bool) -> bool {
        self.as_bool() == Some(*other)
    }
}

// ---------------------------------------------------------------------------
// From impls
// ---------------------------------------------------------------------------

impl From<&str> for Value {
    fn from(s: &str) -> Self {
        Value::Str(s.to_string())
    }
}

impl From<String> for Value {
    fn from(s: String) -> Self {
        Value::Str(s)
    }
}

impl From<&String> for Value {
    fn from(s: &String) -> Self {
        Value::Str(s.clone())
    }
}

impl From<bool> for Value {
    fn from(b: bool) -> Self {
        Value::Bool(b)
    }
}

impl From<i8> for Value {
    fn from(i: i8) -> Self {
        Value::Integer(i64::from(i))
    }
}

impl From<i16> for Value {
    fn from(i: i16) -> Self {
        Value::Integer(i64::from(i))
    }
}

impl From<i32> for Value {
    fn from(i: i32) -> Self {
        Value::Integer(i64::from(i))
    }
}

impl From<i64> for Value {
    fn from(i: i64) -> Self {
        Value::Integer(i)
    }
}

impl From<u8> for Value {
    fn from(i: u8) -> Self {
        Value::Integer(i64::from(i))
    }
}

impl From<u16> for Value {
    fn from(i: u16) -> Self {
        Value::Integer(i64::from(i))
    }
}

impl From<u32> for Value {
    fn from(i: u32) -> Self {
        Value::Integer(i64::from(i))
    }
}

impl From<u64> for Value {
    fn from(v: u64) -> Self {
        if v <= i64::MAX as u64 {
            Value::Integer(v as i64)
        } else {
            Value::Float(v as f64)
        }
    }
}

impl From<usize> for Value {
    fn from(i: usize) -> Self {
        Value::Integer(i as i64)
    }
}

impl From<f32> for Value {
    fn from(f: f32) -> Self {
        Value::Float(f64::from(f))
    }
}

impl From<f64> for Value {
    fn from(f: f64) -> Self {
        Value::Float(f)
    }
}

impl From<()> for Value {
    fn from(_: ()) -> Self {
        Value::Null
    }
}

impl<T: Into<Value>> From<Option<T>> for Value {
    fn from(opt: Option<T>) -> Self {
        match opt {
            Some(v) => v.into(),
            None => Value::Null,
        }
    }
}

impl<T: Into<Value>> From<Vec<T>> for Value {
    fn from(v: Vec<T>) -> Self {
        Value::Array(v.into_iter().map(Into::into).collect())
    }
}

impl From<Map> for Value {
    fn from(m: Map) -> Self {
        Value::Object(m)
    }
}

// ---------------------------------------------------------------------------
// json! macro
// ---------------------------------------------------------------------------

/// Construct a [`Value`] from a JSON literal.
///
/// ```
/// use json::json;
///
/// let v = json!({
///     "name": "test",
///     "count": 42,
///     "tags": ["a", "b"],
///     "active": true,
///     "data": null
/// });
/// assert_eq!(v["name"], "test");
/// assert_eq!(v["count"], 42);
/// ```
#[macro_export]
macro_rules! json {
    (null) => { $crate::Value::Null };
    (true) => { $crate::Value::Bool(true) };
    (false) => { $crate::Value::Bool(false) };
    ([]) => { $crate::Value::Array(::std::vec::Vec::new()) };
    ({}) => { $crate::Value::Object($crate::Map::new()) };
    ([ $($elems:tt),* $(,)? ]) => {
        $crate::Value::Array(
            <[_]>::into_vec(::std::boxed::Box::new([ $( $crate::json!($elems) ),* ]))
        )
    };
    ({ $($key:tt : $val:tt),* $(,)? }) => {{
        let mut _map = $crate::Map::new();
        $( _map.insert(($key).to_string(), $crate::json!($val)); )*
        $crate::Value::Object(_map)
    }};
    ($other:expr) => {
        $crate::Value::from($other)
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // --- json! macro ---

    #[test]
    fn json_null() {
        assert_eq!(json!(null), Value::Null);
    }

    #[test]
    fn json_bool() {
        assert_eq!(json!(true), Value::Bool(true));
        assert_eq!(json!(false), Value::Bool(false));
    }

    #[test]
    fn json_integer() {
        assert_eq!(json!(42), Value::Integer(42));
    }

    #[test]
    fn json_string() {
        assert_eq!(json!("hello"), Value::Str("hello".into()));
    }

    #[test]
    fn json_empty_array() {
        assert_eq!(json!([]), Value::Array(vec![]));
    }

    #[test]
    fn json_array() {
        let v = json!([1, 2, 3]);
        assert_eq!(v.as_array().unwrap().len(), 3);
        assert_eq!(v[0], 42 - 41); // test Index<usize>
    }

    #[test]
    fn json_empty_object() {
        assert_eq!(json!({}), Value::Object(Map::new()));
    }

    #[test]
    fn json_object() {
        let v = json!({"name": "test", "count": 42});
        assert_eq!(v["name"], "test");
        assert_eq!(v["count"], 42);
    }

    #[test]
    fn json_nested() {
        let v = json!({
            "a": {"b": 1},
            "c": [true, null, "x"]
        });
        assert_eq!(v["a"]["b"], 1);
        assert_eq!(v["c"][0], true);
        assert!(v["c"][1].is_null());
        assert_eq!(v["c"][2], "x");
    }

    #[test]
    fn json_trailing_comma() {
        let v = json!({
            "a": 1,
            "b": 2,
        });
        assert_eq!(v["a"], 1);
        assert_eq!(v["b"], 2);
    }

    #[test]
    fn json_with_variable() {
        let name = String::from("alice");
        let v = json!({"name": (name.clone())});
        assert_eq!(v["name"], "alice");
    }

    // --- parse/emit roundtrip ---

    #[test]
    fn parse_emit_roundtrip() {
        let input = r#"{"active":true,"count":42,"name":"test","tags":["a","b"]}"#;
        let parsed = parse(input).unwrap();
        let output = emit(&parsed);
        assert_eq!(input, output);
    }

    #[test]
    fn parse_emit_pretty() {
        let v = json!({"name": "test", "count": 42});
        let pretty = emit_pretty(&v);
        assert!(pretty.contains('\n'));
        let reparsed = parse(&pretty).unwrap();
        assert_eq!(v, reparsed);
    }

    #[test]
    fn parse_slice_works() {
        let bytes = b"[1,2,3]";
        let v = parse_slice(bytes).unwrap();
        assert_eq!(v.as_array().unwrap().len(), 3);
    }

    #[test]
    fn parse_reader_works() {
        let data = b"{\"a\":1}";
        let cursor = std::io::Cursor::new(data);
        let v = parse_reader(cursor).unwrap();
        assert_eq!(v["a"], 1);
    }

    // --- From impls ---

    #[test]
    fn from_impls() {
        assert_eq!(Value::from(42i32), Value::Integer(42));
        assert_eq!(Value::from(42u32), Value::Integer(42));
        assert_eq!(Value::from(42i64), Value::Integer(42));
        assert_eq!(Value::from(42u64), Value::Integer(42));
        assert_eq!(Value::from(1.5f64), Value::Float(1.5));
        assert_eq!(Value::from(1.5f32), Value::Float(1.5));
        assert_eq!(Value::from(true), Value::Bool(true));
        assert_eq!(Value::from("hello"), Value::Str("hello".into()));
        assert_eq!(Value::from(()), Value::Null);
    }

    #[test]
    fn from_option() {
        assert_eq!(Value::from(Some(42i32)), Value::Integer(42));
        assert_eq!(Value::from(None::<i32>), Value::Null);
    }

    #[test]
    fn from_u64_overflow() {
        let big: u64 = (i64::MAX as u64) + 1;
        match Value::from(big) {
            Value::Float(_) => {} // expected
            other => panic!("expected Float, got {:?}", other),
        }
    }

    // --- Index impls ---

    #[test]
    fn index_str_missing() {
        let v = json!({"a": 1});
        assert!(v["b"].is_null());
    }

    #[test]
    fn index_usize_out_of_bounds() {
        let v = json!([1, 2]);
        assert!(v[5].is_null());
    }

    #[test]
    fn index_on_wrong_type() {
        let v = json!(42);
        assert!(v["x"].is_null());
        assert!(v[0].is_null());
    }

    // --- PartialEq impls ---

    #[test]
    fn partial_eq_str() {
        let v = json!("hello");
        assert!(v == "hello");
    }

    #[test]
    fn partial_eq_i64() {
        let v = json!(42);
        assert!(v == 42i64);
    }

    #[test]
    fn partial_eq_f64() {
        let v = Value::Float(1.5);
        assert!(v == 1.5f64);
    }

    #[test]
    fn partial_eq_bool() {
        let v = json!(true);
        assert!(v == true);
    }

    // --- Display ---

    #[test]
    fn display_compact() {
        let v = json!({"a": 1});
        assert_eq!(format!("{}", v), r#"{"a":1}"#);
    }

    // --- Accessor methods ---

    #[test]
    fn as_u64_positive() {
        assert_eq!(Value::Integer(42).as_u64(), Some(42));
    }

    #[test]
    fn as_u64_negative() {
        assert_eq!(Value::Integer(-1).as_u64(), None);
    }

    #[test]
    fn predicates() {
        assert!(json!(null).is_null());
        assert!(json!(true).is_boolean());
        assert!(json!(42).is_number());
        assert!(Value::Float(1.5).is_number());
        assert!(json!("x").is_string());
        assert!(json!([]).is_array());
        assert!(json!({}).is_object());
    }

    #[test]
    fn mutable_accessors() {
        let mut v = json!({"items": [1, 2]});
        v.as_object_mut().unwrap().insert("new".into(), json!(3));
        assert_eq!(v["new"], 3);

        let mut arr = json!([1, 2]);
        arr.as_array_mut().unwrap().push(json!(3));
        assert_eq!(arr.as_array().unwrap().len(), 3);
    }

    // --- BTreeMap sorted key ordering ---

    #[test]
    fn object_keys_sorted() {
        let v = json!({"z": 1, "a": 2, "m": 3});
        let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
        assert_eq!(keys, vec!["a", "m", "z"]);
    }

    #[test]
    fn emit_sorted_keys() {
        let v = json!({"z": 1, "a": 2});
        assert_eq!(emit(&v), r#"{"a":2,"z":1}"#);
    }
}
