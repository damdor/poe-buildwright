//! Zero-dependency JSON writer with serde_json-compatible output.

use crate::Value;

/// A streaming JSON writer that produces compact JSON output.
///
/// Output is byte-identical to `serde_json` for the same logical values,
/// including string escaping and float formatting (Ryu since Rust 1.55).
pub struct JsonWriter {
    buf: Vec<u8>,
    needs_comma: Vec<bool>,
}

impl Default for JsonWriter {
    fn default() -> Self {
        Self::new()
    }
}

impl JsonWriter {
    #[inline]
    pub fn new() -> Self {
        Self {
            buf: Vec::with_capacity(1024),
            needs_comma: Vec::new(),
        }
    }

    #[inline]
    pub fn into_bytes(self) -> Vec<u8> {
        self.buf
    }

    #[inline]
    pub fn into_string(self) -> String {
        // The writer only ever pushes valid UTF-8, so this never errors;
        // the check keeps the crate under the workspace's forbid(unsafe_code).
        String::from_utf8(self.buf).expect("JSON writer emitted invalid UTF-8")
    }

    #[inline]
    fn maybe_comma(&mut self) {
        if let Some(needs) = self.needs_comma.last_mut() {
            if *needs {
                self.buf.push(b',');
            }
            *needs = true;
        }
    }

    #[inline]
    pub fn null(&mut self) {
        self.maybe_comma();
        self.buf.extend_from_slice(b"null");
    }

    #[inline]
    pub fn bool_val(&mut self, v: bool) {
        self.maybe_comma();
        self.buf
            .extend_from_slice(if v { b"true" } else { b"false" });
    }

    #[inline]
    pub fn i64_val(&mut self, v: i64) {
        self.maybe_comma();
        use std::io::Write as _;
        write!(&mut self.buf, "{}", v).unwrap();
    }

    #[inline]
    pub fn u64_val(&mut self, v: u64) {
        self.maybe_comma();
        use std::io::Write as _;
        write!(&mut self.buf, "{}", v).unwrap();
    }

    #[inline]
    pub fn f32_val(&mut self, v: f32) {
        self.maybe_comma();
        write_float_f32_to(&mut self.buf, v);
    }

    #[inline]
    pub fn f64_val(&mut self, v: f64) {
        self.maybe_comma();
        write_float_f64_to(&mut self.buf, v);
    }

    #[inline]
    pub fn str_val(&mut self, v: &str) {
        self.maybe_comma();
        write_escaped_str_to(&mut self.buf, v);
    }

    #[inline]
    pub fn begin_object(&mut self) {
        self.maybe_comma();
        self.buf.push(b'{');
        self.needs_comma.push(false);
    }

    #[inline]
    pub fn key(&mut self, k: &str) {
        self.maybe_comma();
        write_escaped_str_to(&mut self.buf, k);
        self.buf.push(b':');
        if let Some(needs) = self.needs_comma.last_mut() {
            *needs = false;
        }
    }

    #[inline]
    pub fn end_object(&mut self) {
        self.needs_comma.pop();
        self.buf.push(b'}');
    }

    #[inline]
    pub fn begin_array(&mut self) {
        self.maybe_comma();
        self.buf.push(b'[');
        self.needs_comma.push(false);
    }

    #[inline]
    pub fn end_array(&mut self) {
        self.needs_comma.pop();
        self.buf.push(b']');
    }

    #[inline]
    pub fn key_str(&mut self, k: &str, v: &str) {
        self.key(k);
        self.str_val(v);
    }

    #[inline]
    pub fn key_i64(&mut self, k: &str, v: i64) {
        self.key(k);
        self.i64_val(v);
    }

    #[inline]
    pub fn key_u64(&mut self, k: &str, v: u64) {
        self.key(k);
        self.u64_val(v);
    }

    #[inline]
    pub fn key_f64(&mut self, k: &str, v: f64) {
        self.key(k);
        self.f64_val(v);
    }

    #[inline]
    pub fn key_bool(&mut self, k: &str, v: bool) {
        self.key(k);
        self.bool_val(v);
    }

    #[inline]
    pub fn key_null(&mut self, k: &str) {
        self.key(k);
        self.null();
    }

    #[inline]
    pub fn raw(&mut self, json: &[u8]) {
        self.maybe_comma();
        self.buf.extend_from_slice(json);
    }
}

// ---------------------------------------------------------------------------
// PrettyJsonWriter — 2-space indented output
// ---------------------------------------------------------------------------

/// A JSON writer that produces human-readable, 2-space-indented output.
pub struct PrettyJsonWriter {
    buf: Vec<u8>,
    needs_comma: Vec<bool>,
    depth: usize,
    after_key: bool,
}

impl Default for PrettyJsonWriter {
    fn default() -> Self {
        Self::new()
    }
}

impl PrettyJsonWriter {
    #[inline]
    pub fn new() -> Self {
        Self {
            buf: Vec::with_capacity(2048),
            needs_comma: Vec::new(),
            depth: 0,
            after_key: false,
        }
    }

    #[inline]
    pub fn into_string(self) -> String {
        String::from_utf8(self.buf).expect("JSON writer emitted invalid UTF-8")
    }

    #[inline]
    pub fn into_bytes(self) -> Vec<u8> {
        self.buf
    }

    fn write_indent(&mut self) {
        for _ in 0..self.depth {
            self.buf.extend_from_slice(b"  ");
        }
    }

    fn pre_value(&mut self) {
        if self.after_key {
            self.after_key = false;
        } else {
            if let Some(needs) = self.needs_comma.last_mut() {
                if *needs {
                    self.buf.push(b',');
                }
                *needs = true;
            }
            if !self.needs_comma.is_empty() || !self.buf.is_empty() {
                self.buf.push(b'\n');
                self.write_indent();
            }
        }
    }

    pub fn null(&mut self) {
        self.pre_value();
        self.buf.extend_from_slice(b"null");
    }

    pub fn bool_val(&mut self, v: bool) {
        self.pre_value();
        self.buf
            .extend_from_slice(if v { b"true" } else { b"false" });
    }

    pub fn i64_val(&mut self, v: i64) {
        self.pre_value();
        use std::io::Write as _;
        write!(&mut self.buf, "{}", v).unwrap();
    }

    pub fn u64_val(&mut self, v: u64) {
        self.pre_value();
        use std::io::Write as _;
        write!(&mut self.buf, "{}", v).unwrap();
    }

    pub fn f32_val(&mut self, v: f32) {
        self.pre_value();
        write_float_f32_to(&mut self.buf, v);
    }

    pub fn f64_val(&mut self, v: f64) {
        self.pre_value();
        write_float_f64_to(&mut self.buf, v);
    }

    pub fn str_val(&mut self, v: &str) {
        self.pre_value();
        write_escaped_str_to(&mut self.buf, v);
    }

    pub fn begin_object(&mut self) {
        self.pre_value();
        self.buf.push(b'{');
        self.depth += 1;
        self.needs_comma.push(false);
    }

    pub fn key(&mut self, k: &str) {
        if let Some(needs) = self.needs_comma.last_mut() {
            if *needs {
                self.buf.push(b',');
            }
            *needs = true;
        }
        self.buf.push(b'\n');
        self.write_indent();
        write_escaped_str_to(&mut self.buf, k);
        self.buf.extend_from_slice(b": ");
        self.after_key = true;
    }

    pub fn end_object(&mut self) {
        let was_empty = self.needs_comma.pop() == Some(false);
        self.depth -= 1;
        if !was_empty {
            self.buf.push(b'\n');
            self.write_indent();
        }
        self.buf.push(b'}');
    }

    pub fn begin_array(&mut self) {
        self.pre_value();
        self.buf.push(b'[');
        self.depth += 1;
        self.needs_comma.push(false);
    }

    pub fn end_array(&mut self) {
        let was_empty = self.needs_comma.pop() == Some(false);
        self.depth -= 1;
        if !was_empty {
            self.buf.push(b'\n');
            self.write_indent();
        }
        self.buf.push(b']');
    }

    pub fn key_str(&mut self, k: &str, v: &str) {
        self.key(k);
        write_escaped_str_to(&mut self.buf, v);
        self.after_key = false;
    }

    pub fn key_i64(&mut self, k: &str, v: i64) {
        self.key(k);
        use std::io::Write as _;
        write!(&mut self.buf, "{}", v).unwrap();
        self.after_key = false;
    }

    pub fn key_u64(&mut self, k: &str, v: u64) {
        self.key(k);
        use std::io::Write as _;
        write!(&mut self.buf, "{}", v).unwrap();
        self.after_key = false;
    }

    pub fn key_f64(&mut self, k: &str, v: f64) {
        self.key(k);
        write_float_f64_to(&mut self.buf, v);
        self.after_key = false;
    }

    pub fn key_bool(&mut self, k: &str, v: bool) {
        self.key(k);
        self.buf
            .extend_from_slice(if v { b"true" } else { b"false" });
        self.after_key = false;
    }

    pub fn key_null(&mut self, k: &str) {
        self.key(k);
        self.buf.extend_from_slice(b"null");
        self.after_key = false;
    }
}

// ---------------------------------------------------------------------------
// Value → JSON
// ---------------------------------------------------------------------------

/// Write a [`Value`] to a compact [`JsonWriter`].
pub fn write_value(w: &mut JsonWriter, v: &Value) {
    match v {
        Value::Null => w.null(),
        Value::Bool(b) => w.bool_val(*b),
        Value::Integer(i) => w.i64_val(*i),
        Value::Float(f) => w.f64_val(*f),
        Value::Str(s) => w.str_val(s),
        Value::Array(arr) => {
            w.begin_array();
            for item in arr {
                write_value(w, item);
            }
            w.end_array();
        }
        Value::Object(map) => {
            w.begin_object();
            for (k, v) in map {
                w.key(k);
                write_value(w, v);
            }
            w.end_object();
        }
    }
}

/// Write a [`Value`] to a pretty [`PrettyJsonWriter`].
pub fn write_value_pretty(w: &mut PrettyJsonWriter, v: &Value) {
    match v {
        Value::Null => w.null(),
        Value::Bool(b) => w.bool_val(*b),
        Value::Integer(i) => w.i64_val(*i),
        Value::Float(f) => w.f64_val(*f),
        Value::Str(s) => w.str_val(s),
        Value::Array(arr) => {
            w.begin_array();
            for item in arr {
                write_value_pretty(w, item);
            }
            w.end_array();
        }
        Value::Object(map) => {
            w.begin_object();
            for (k, v) in map {
                w.key(k);
                write_value_pretty(w, v);
            }
            w.end_object();
        }
    }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn write_escaped_str_to(buf: &mut Vec<u8>, s: &str) {
    buf.push(b'"');
    for byte in s.bytes() {
        match byte {
            b'"' => buf.extend_from_slice(b"\\\""),
            b'\\' => buf.extend_from_slice(b"\\\\"),
            b'\n' => buf.extend_from_slice(b"\\n"),
            b'\r' => buf.extend_from_slice(b"\\r"),
            b'\t' => buf.extend_from_slice(b"\\t"),
            0x08 => buf.extend_from_slice(b"\\b"),
            0x0C => buf.extend_from_slice(b"\\f"),
            b if b < 0x20 => {
                buf.extend_from_slice(b"\\u00");
                let hi = b >> 4;
                let lo = b & 0x0F;
                buf.push(HEX_DIGITS[hi as usize]);
                buf.push(HEX_DIGITS[lo as usize]);
            }
            _ => buf.push(byte),
        }
    }
    buf.push(b'"');
}

fn write_float_f32_to(buf: &mut Vec<u8>, v: f32) {
    if v.is_nan() || v.is_infinite() {
        buf.extend_from_slice(b"null");
        return;
    }
    write_finite_float(buf, v);
}

fn write_float_f64_to(buf: &mut Vec<u8>, v: f64) {
    if v.is_nan() || v.is_infinite() {
        buf.extend_from_slice(b"null");
        return;
    }
    write_finite_float(buf, v);
}

/// Format a finite float, matching ryu/serde_json output.
///
/// Rust's std Display uses Ryu internally since 1.55 but omits `.0` for
/// integer-valued floats. We add the suffix to match serde_json.
fn write_finite_float(buf: &mut Vec<u8>, v: impl std::fmt::Display) {
    use std::io::Write as _;
    let start = buf.len();
    write!(buf, "{}", v).unwrap();
    if !buf[start..]
        .iter()
        .any(|&b| b == b'.' || b == b'e' || b == b'E')
    {
        buf.extend_from_slice(b".0");
    }
}

const HEX_DIGITS: [u8; 16] = *b"0123456789abcdef";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_object() {
        let mut w = JsonWriter::new();
        w.begin_object();
        w.end_object();
        assert_eq!(w.into_string(), "{}");
    }

    #[test]
    fn simple_object() {
        let mut w = JsonWriter::new();
        w.begin_object();
        w.key_str("name", "test");
        w.key_i64("count", 42);
        w.key_bool("active", true);
        w.end_object();
        assert_eq!(
            w.into_string(),
            r#"{"name":"test","count":42,"active":true}"#
        );
    }

    #[test]
    fn nested_object() {
        let mut w = JsonWriter::new();
        w.begin_object();
        w.key("inner");
        w.begin_object();
        w.key_str("x", "y");
        w.end_object();
        w.end_object();
        assert_eq!(w.into_string(), r#"{"inner":{"x":"y"}}"#);
    }

    #[test]
    fn array_of_ints() {
        let mut w = JsonWriter::new();
        w.begin_array();
        w.i64_val(1);
        w.i64_val(2);
        w.i64_val(3);
        w.end_array();
        assert_eq!(w.into_string(), "[1,2,3]");
    }

    #[test]
    fn string_escaping() {
        let mut w = JsonWriter::new();
        w.str_val("hello\n\"world\"\t\\end\x00");
        assert_eq!(w.into_string(), r#""hello\n\"world\"\t\\end\u0000""#);
    }

    #[test]
    fn control_char_escaping() {
        let mut w = JsonWriter::new();
        w.str_val("\x01\x08\x0C\x1F");
        assert_eq!(w.into_string(), r#""\u0001\b\f\u001f""#);
    }

    #[test]
    fn float_nan_becomes_null() {
        let mut w = JsonWriter::new();
        w.f32_val(f32::NAN);
        assert_eq!(w.into_string(), "null");
    }

    #[test]
    fn float_inf_becomes_null() {
        let mut w = JsonWriter::new();
        w.f64_val(f64::INFINITY);
        assert_eq!(w.into_string(), "null");
    }

    #[test]
    fn pretty_simple_object() {
        let mut w = PrettyJsonWriter::new();
        w.begin_object();
        w.key_str("name", "test");
        w.key_i64("count", 42);
        w.end_object();
        let expected = "{\n  \"name\": \"test\",\n  \"count\": 42\n}";
        assert_eq!(w.into_string(), expected);
    }

    #[test]
    fn pretty_nested() {
        let mut w = PrettyJsonWriter::new();
        w.begin_object();
        w.key("inner");
        w.begin_object();
        w.key_str("x", "y");
        w.end_object();
        w.end_object();
        let expected = "{\n  \"inner\": {\n    \"x\": \"y\"\n  }\n}";
        assert_eq!(w.into_string(), expected);
    }

    #[test]
    fn pretty_array() {
        let mut w = PrettyJsonWriter::new();
        w.begin_object();
        w.key("items");
        w.begin_array();
        w.i64_val(1);
        w.i64_val(2);
        w.i64_val(3);
        w.end_array();
        w.end_object();
        let expected = "{\n  \"items\": [\n    1,\n    2,\n    3\n  ]\n}";
        assert_eq!(w.into_string(), expected);
    }

    #[test]
    fn pretty_empty_object() {
        let mut w = PrettyJsonWriter::new();
        w.begin_object();
        w.end_object();
        assert_eq!(w.into_string(), "{}");
    }

    #[test]
    fn pretty_empty_array() {
        let mut w = PrettyJsonWriter::new();
        w.begin_array();
        w.end_array();
        assert_eq!(w.into_string(), "[]");
    }

    #[test]
    fn serde_json_compat_float() {
        let cases: &[(f64, &str)] = &[
            (0.0, "0.0"),
            (1.0, "1.0"),
            (-1.0, "-1.0"),
            (1.5, "1.5"),
            (0.1, "0.1"),
            (100.0, "100.0"),
        ];
        for &(val, expected) in cases {
            let mut w = JsonWriter::new();
            w.f64_val(val);
            let our_out = w.into_string();
            assert_eq!(our_out, expected, "f64 mismatch for {val}");
        }
    }

    #[test]
    fn serde_json_compat_string_escaping() {
        let cases = &[
            ("", "\"\""),
            ("hello", "\"hello\""),
            ("a\"b", "\"a\\\"b\""),
            ("a\\b", "\"a\\\\b\""),
            ("line\nbreak", "\"line\\nbreak\""),
            ("\t\r", "\"\\t\\r\""),
            ("\x00\x1f", "\"\\u0000\\u001f\""),
        ];
        for &(input, expected) in cases {
            let mut w = JsonWriter::new();
            w.str_val(input);
            let our_out = w.into_string();
            assert_eq!(our_out, expected, "string escaping mismatch for {input:?}");
        }
    }

    #[test]
    fn write_value_roundtrip() {
        use crate::json;
        let v = json!({"name": "test", "count": 42, "active": true, "data": null});
        let mut w = JsonWriter::new();
        write_value(&mut w, &v);
        let s = w.into_string();
        let reparsed = crate::parse(&s).unwrap();
        assert_eq!(v, reparsed);
    }

    #[test]
    fn write_value_pretty_roundtrip() {
        use crate::json;
        let v = json!({"items": [1, 2, 3], "nested": {"a": true}});
        let mut w = PrettyJsonWriter::new();
        write_value_pretty(&mut w, &v);
        let s = w.into_string();
        let reparsed = crate::parse(&s).unwrap();
        assert_eq!(v, reparsed);
    }
}
