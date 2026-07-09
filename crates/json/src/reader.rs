//! Zero-dependency JSON parser.

use super::{Error, Map, Value};

/// Parse a JSON string into a [`Value`].
pub(crate) fn parse_str(input: &str) -> Result<Value, Error> {
    let mut parser = Parser::new(input.as_bytes());
    let val = parser.parse_value()?;
    parser.skip_whitespace();
    if parser.pos < parser.input.len() {
        return Err(parser.error("trailing data after JSON value"));
    }
    Ok(val)
}

struct Parser<'a> {
    input: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn new(input: &'a [u8]) -> Self {
        Self { input, pos: 0 }
    }

    fn error(&self, msg: &str) -> Error {
        Error {
            msg: msg.to_string(),
            pos: self.pos,
        }
    }

    fn peek(&self) -> Option<u8> {
        self.input.get(self.pos).copied()
    }

    fn advance(&mut self) -> Option<u8> {
        let b = self.input.get(self.pos).copied()?;
        self.pos += 1;
        Some(b)
    }

    fn expect(&mut self, expected: u8) -> Result<(), Error> {
        match self.advance() {
            Some(b) if b == expected => Ok(()),
            Some(b) => Err(self.error(&format!(
                "expected '{}', found '{}'",
                expected as char, b as char
            ))),
            None => Err(self.error(&format!("expected '{}', found EOF", expected as char))),
        }
    }

    fn skip_whitespace(&mut self) {
        while self.pos < self.input.len() {
            match self.input[self.pos] {
                b' ' | b'\t' | b'\n' | b'\r' => self.pos += 1,
                _ => break,
            }
        }
    }

    fn parse_value(&mut self) -> Result<Value, Error> {
        self.skip_whitespace();
        match self.peek() {
            Some(b'"') => self.parse_string().map(Value::Str),
            Some(b'{') => self.parse_object(),
            Some(b'[') => self.parse_array(),
            Some(b't') => self.parse_literal(b"true", Value::Bool(true)),
            Some(b'f') => self.parse_literal(b"false", Value::Bool(false)),
            Some(b'n') => self.parse_literal(b"null", Value::Null),
            Some(b'-') | Some(b'0'..=b'9') => self.parse_number(),
            Some(b) => Err(self.error(&format!("unexpected character '{}'", b as char))),
            None => Err(self.error("unexpected end of input")),
        }
    }

    fn parse_literal(&mut self, literal: &[u8], value: Value) -> Result<Value, Error> {
        for &expected in literal {
            match self.advance() {
                Some(b) if b == expected => {}
                _ => {
                    return Err(self.error(&format!(
                        "expected '{}'",
                        std::str::from_utf8(literal).unwrap_or("?")
                    )));
                }
            }
        }
        Ok(value)
    }

    fn parse_string(&mut self) -> Result<String, Error> {
        self.expect(b'"')?;
        let mut s = String::new();
        loop {
            match self.advance() {
                Some(b'"') => return Ok(s),
                Some(b'\\') => match self.advance() {
                    Some(b'"') => s.push('"'),
                    Some(b'\\') => s.push('\\'),
                    Some(b'/') => s.push('/'),
                    Some(b'n') => s.push('\n'),
                    Some(b'r') => s.push('\r'),
                    Some(b't') => s.push('\t'),
                    Some(b'b') => s.push('\x08'),
                    Some(b'f') => s.push('\x0C'),
                    Some(b'u') => {
                        let cp = self.parse_unicode_escape()?;
                        if (0xD800..=0xDBFF).contains(&cp) {
                            if self.advance() != Some(b'\\') || self.advance() != Some(b'u') {
                                return Err(
                                    self.error("expected low surrogate after high surrogate")
                                );
                            }
                            let low = self.parse_unicode_escape()?;
                            if !(0xDC00..=0xDFFF).contains(&low) {
                                return Err(self.error("invalid low surrogate"));
                            }
                            let combined = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
                            match char::from_u32(combined) {
                                Some(c) => s.push(c),
                                None => return Err(self.error("invalid surrogate pair")),
                            }
                        } else {
                            match char::from_u32(cp) {
                                Some(c) => s.push(c),
                                None => return Err(self.error("invalid unicode codepoint")),
                            }
                        }
                    }
                    Some(b) => return Err(self.error(&format!("invalid escape '\\{}'", b as char))),
                    None => return Err(self.error("unexpected EOF in string escape")),
                },
                Some(b) if b < 0x20 => {
                    return Err(self.error("unescaped control character in string"));
                }
                Some(b) => {
                    if b >= 0x80 {
                        // Multi-byte UTF-8 sequence.
                        self.pos -= 1;
                        let start = self.pos;
                        let width = utf8_char_width(b);
                        if self.pos + width > self.input.len() {
                            return Err(self.error("truncated UTF-8 sequence"));
                        }
                        let slice = &self.input[start..start + width];
                        match std::str::from_utf8(slice) {
                            Ok(ch) => {
                                s.push_str(ch);
                                self.pos += width;
                            }
                            Err(_) => return Err(self.error("invalid UTF-8 sequence")),
                        }
                    } else {
                        s.push(b as char);
                    }
                }
                None => return Err(self.error("unexpected EOF in string")),
            }
        }
    }

    fn parse_unicode_escape(&mut self) -> Result<u32, Error> {
        let mut val: u32 = 0;
        for _ in 0..4 {
            match self.advance() {
                Some(b) => {
                    let digit = match b {
                        b'0'..=b'9' => b - b'0',
                        b'a'..=b'f' => b - b'a' + 10,
                        b'A'..=b'F' => b - b'A' + 10,
                        _ => return Err(self.error("invalid hex digit in \\uXXXX")),
                    };
                    val = (val << 4) | digit as u32;
                }
                None => return Err(self.error("unexpected EOF in \\uXXXX escape")),
            }
        }
        Ok(val)
    }

    fn parse_number(&mut self) -> Result<Value, Error> {
        let start = self.pos;
        let mut is_float = false;

        if self.peek() == Some(b'-') {
            self.pos += 1;
        }

        match self.peek() {
            Some(b'0') => {
                self.pos += 1;
            }
            Some(b'1'..=b'9') => {
                self.pos += 1;
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.pos += 1;
                }
            }
            _ => return Err(self.error("expected digit")),
        }

        if self.peek() == Some(b'.') {
            is_float = true;
            self.pos += 1;
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(self.error("expected digit after decimal point"));
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }

        if matches!(self.peek(), Some(b'e') | Some(b'E')) {
            is_float = true;
            self.pos += 1;
            if matches!(self.peek(), Some(b'+') | Some(b'-')) {
                self.pos += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(self.error("expected digit in exponent"));
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }

        let num_str = std::str::from_utf8(&self.input[start..self.pos])
            .map_err(|_| self.error("invalid number encoding"))?;

        if is_float {
            num_str
                .parse::<f64>()
                .map(Value::Float)
                .map_err(|_| self.error("invalid float"))
        } else {
            match num_str.parse::<i64>() {
                Ok(i) => Ok(Value::Integer(i)),
                Err(_) => num_str
                    .parse::<f64>()
                    .map(Value::Float)
                    .map_err(|_| self.error("invalid number")),
            }
        }
    }

    fn parse_object(&mut self) -> Result<Value, Error> {
        self.expect(b'{')?;
        self.skip_whitespace();
        let mut map = Map::new();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(Value::Object(map));
        }
        loop {
            self.skip_whitespace();
            if self.peek() != Some(b'"') {
                return Err(self.error("expected string key in object"));
            }
            let key = self.parse_string()?;
            self.skip_whitespace();
            self.expect(b':')?;
            let val = self.parse_value()?;
            map.insert(key, val);
            self.skip_whitespace();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(Value::Object(map));
                }
                _ => return Err(self.error("expected ',' or '}' in object")),
            }
        }
    }

    fn parse_array(&mut self) -> Result<Value, Error> {
        self.expect(b'[')?;
        self.skip_whitespace();
        let mut items = Vec::new();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(Value::Array(items));
        }
        loop {
            let val = self.parse_value()?;
            items.push(val);
            self.skip_whitespace();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(b']') => {
                    self.pos += 1;
                    return Ok(Value::Array(items));
                }
                _ => return Err(self.error("expected ',' or ']' in array")),
            }
        }
    }
}

fn utf8_char_width(first_byte: u8) -> usize {
    match first_byte {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF7 => 4,
        _ => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_null() {
        assert_eq!(parse_str("null").unwrap(), Value::Null);
    }

    #[test]
    fn parse_bools() {
        assert_eq!(parse_str("true").unwrap(), Value::Bool(true));
        assert_eq!(parse_str("false").unwrap(), Value::Bool(false));
    }

    #[test]
    fn parse_integers() {
        assert_eq!(parse_str("0").unwrap(), Value::Integer(0));
        assert_eq!(parse_str("42").unwrap(), Value::Integer(42));
        assert_eq!(parse_str("-1").unwrap(), Value::Integer(-1));
        assert_eq!(
            parse_str("9223372036854775807").unwrap(),
            Value::Integer(i64::MAX)
        );
    }

    #[test]
    fn parse_floats() {
        assert_eq!(parse_str("1.5").unwrap(), Value::Float(1.5));
        assert_eq!(parse_str("-0.5").unwrap(), Value::Float(-0.5));
        assert_eq!(parse_str("1e10").unwrap(), Value::Float(1e10));
        assert_eq!(parse_str("1.5e-3").unwrap(), Value::Float(1.5e-3));
    }

    #[test]
    fn parse_strings() {
        assert_eq!(parse_str(r#""""#).unwrap(), Value::Str(String::new()));
        assert_eq!(parse_str(r#""hello""#).unwrap(), Value::Str("hello".into()));
        assert_eq!(
            parse_str(r#""a\"b\\c""#).unwrap(),
            Value::Str("a\"b\\c".into())
        );
        assert_eq!(
            parse_str(r#""\n\r\t""#).unwrap(),
            Value::Str("\n\r\t".into())
        );
    }

    #[test]
    fn parse_unicode_escape() {
        assert_eq!(parse_str(r#""\u0041""#).unwrap(), Value::Str("A".into()));
        assert_eq!(
            parse_str(r#""\uD83D\uDE00""#).unwrap(),
            Value::Str("\u{1F600}".into())
        );
    }

    #[test]
    fn parse_utf8_string() {
        assert_eq!(
            parse_str(r#""héllo wörld""#).unwrap(),
            Value::Str("héllo wörld".into())
        );
    }

    #[test]
    fn parse_empty_object() {
        assert_eq!(parse_str("{}").unwrap(), Value::Object(Map::new()));
    }

    #[test]
    fn parse_simple_object() {
        let v = parse_str(r#"{"a": 1, "b": "two"}"#).unwrap();
        assert_eq!(v.get("a").unwrap().as_i64(), Some(1));
        assert_eq!(v.get("b").unwrap().as_str(), Some("two"));
        assert!(v.get("c").is_none());
    }

    #[test]
    fn parse_empty_array() {
        assert_eq!(parse_str("[]").unwrap(), Value::Array(vec![]));
    }

    #[test]
    fn parse_mixed_array() {
        let v = parse_str(r#"[1, "two", true, null]"#).unwrap();
        let arr = v.as_array().unwrap();
        assert_eq!(arr.len(), 4);
        assert_eq!(arr[0].as_i64(), Some(1));
        assert_eq!(arr[1].as_str(), Some("two"));
        assert_eq!(arr[2].as_bool(), Some(true));
        assert!(arr[3].is_null());
    }

    #[test]
    fn parse_nested() {
        let v = parse_str(r#"{"a": {"b": [1, 2]}}"#).unwrap();
        let inner = v.get("a").unwrap().get("b").unwrap().as_array().unwrap();
        assert_eq!(inner.len(), 2);
    }

    #[test]
    fn parse_whitespace_variations() {
        let v = parse_str("  {  \"a\"  :  1  }  ").unwrap();
        assert_eq!(v.get("a").unwrap().as_i64(), Some(1));
    }

    #[test]
    fn parse_error_trailing_data() {
        assert!(parse_str("1 2").is_err());
    }

    #[test]
    fn parse_error_truncated() {
        assert!(parse_str("{\"a\":").is_err());
        assert!(parse_str("[1,").is_err());
        assert!(parse_str("\"hello").is_err());
    }

    #[test]
    fn roundtrip_parse_and_emit() {
        let inputs = &[
            r#"[1,2.5,"three",false,null,[]]"#,
            r#"{"nested":{"a":[1,2],"b":"hello"}}"#,
        ];
        for input in inputs {
            let parsed = parse_str(input).unwrap();
            let round_trip = crate::emit(&parsed);
            let reparsed = parse_str(&round_trip).unwrap();
            assert_eq!(parsed, reparsed, "roundtrip mismatch for {input}");
        }
    }
}
