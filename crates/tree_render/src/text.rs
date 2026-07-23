//! Small text-encoding helpers — HTML escape and a hand-rolled JSON-string
//! escape that lets us emit the tree-data blob without pulling in serde.

use std::fmt::Write as _;

pub(crate) fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// Minimal JSON string escape (we only emit strings + numbers + objects/arrays,
/// all assembled by hand — avoids needing serde).
pub(crate) fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Parse a `node_options` cell into `(name, icon_path, variant_id)` tuples.
///
/// Wire format per entry: `Name:IconPath[:VariantId]`. The variant id is
/// only set for attribute options (Str / Dex / Int sub-ids that PoE2's
/// .build format references in passives[] when an attribute node is
/// allocated with a specific variant chosen). Switchable nodes use the
/// same column for class-variant icons and don't carry a variant id —
/// for them the trailing `:` is omitted and variant_id is empty.
///
/// Empty input → empty Vec. Entries with no icon are kept (icon = "").
pub(crate) fn parse_node_options(s: &str) -> Vec<(String, String, String)> {
    if s.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for entry in s.split('|') {
        if entry.is_empty() {
            continue;
        }
        // Up to two ':' separators: Name : Icon (: VariantId).
        let mut it = entry.splitn(3, ':');
        let name = it.next().unwrap_or("").to_string();
        let icon = it.next().unwrap_or("").to_string();
        let variant_id = it.next().unwrap_or("").to_string();
        out.push((name, icon, variant_id));
    }
    out
}

/// Ownership-preserving JSON rewrite for files that TWO writers share.
///
/// `viewer/assets/agent/jewels.json` is written by tree_render (the
/// base: sockets/rings/bases/keystones) and then ENRICHED in place by
/// `scripts/gen_agent_meta.mjs` (the `uniques` radii catalogue, which
/// needs node + the items data tree_render never reads). A plain
/// rewrite from tree_render used to destroy the enrichment silently.
///
/// This splices every top-level key of `old` that `new` does NOT emit
/// into `new`, so the writers stay coherent in any run order: keys
/// tree_render emits are refreshed, keys another tool owns survive.
/// A later gen_agent_meta run still refreshes its own keys (it does
/// the mirror-image merge). Unparseable/absent `old` → `new` verbatim.
pub(crate) fn preserve_unknown_top_level(old: &str, new: String) -> String {
    let old_spans = top_level_spans(old);
    if old_spans.is_empty() {
        return new;
    }
    let new_keys: std::collections::HashSet<String> =
        top_level_spans(&new).into_iter().map(|(k, _)| k).collect();
    let mut extras = String::new();
    for (key, (vs, ve)) in old_spans {
        if !new_keys.contains(&key) {
            extras.push_str(&format!(",{}:{}", json_str(&key), &old[vs..ve]));
        }
    }
    if extras.is_empty() {
        return new;
    }
    // Insert before the root object's closing brace.
    let trimmed_len = new.trim_end().len();
    if trimmed_len == 0 || !new[..trimmed_len].ends_with('}') {
        return new; // not an object — refuse to guess
    }
    let mut out = String::with_capacity(new.len() + extras.len());
    out.push_str(&new[..trimmed_len - 1]);
    out.push_str(&extras);
    out.push_str(&new[trimmed_len - 1..]);
    out
}

/// Top-level `key → value byte-span` of a JSON object, via a minimal
/// scanner that honors strings and escapes. Returns empty on anything
/// that doesn't look like an object (callers treat that as "no merge").
fn top_level_spans(s: &str) -> Vec<(String, (usize, usize))> {
    let b = s.as_bytes();
    let mut i = match s.find('{') {
        Some(i) => i + 1,
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    let n = b.len();
    let skip_ws = |i: &mut usize| {
        while *i < n && (b[*i] as char).is_ascii_whitespace() {
            *i += 1
        }
    };
    loop {
        skip_ws(&mut i);
        if i >= n || b[i] == b'}' {
            return out;
        }
        if b[i] == b',' {
            i += 1;
            continue;
        }
        if b[i] != b'"' {
            return Vec::new(); // malformed — bail without guessing
        }
        // key string
        let ks = i + 1;
        i += 1;
        while i < n && b[i] != b'"' {
            if b[i] == b'\\' {
                i += 1;
            }
            i += 1;
        }
        if i >= n {
            return Vec::new();
        }
        let key = s[ks..i].to_string(); // raw (escapes intact) — fine as an identity
        i += 1;
        skip_ws(&mut i);
        if i >= n || b[i] != b':' {
            return Vec::new();
        }
        i += 1;
        skip_ws(&mut i);
        // value span: scan with depth over {} and [], honoring strings
        let vs = i;
        let mut depth = 0i32;
        let mut in_str = false;
        while i < n {
            let c = b[i];
            if in_str {
                if c == b'\\' {
                    i += 1;
                } else if c == b'"' {
                    in_str = false;
                }
            } else {
                match c {
                    b'"' => in_str = true,
                    b'{' | b'[' => depth += 1,
                    b'}' | b']' => {
                        if depth == 0 {
                            break;
                        } // root closing brace ends the value
                        depth -= 1;
                    }
                    b',' if depth == 0 => break,
                    _ => {}
                }
            }
            i += 1;
        }
        out.push((key, (vs, s[..i].trim_end().len().max(vs))));
    }
}

#[cfg(test)]
mod merge_tests {
    use super::*;

    #[test]
    fn preserves_keys_the_new_writer_does_not_emit() {
        let old = r#"{"a":1,"uniques":{"x":{"r":[1,2]},"s":"br{ace] \" ok"}}"#;
        let new = String::from("{\"a\":2,\"b\":[3]}\n");
        let merged = preserve_unknown_top_level(old, new);
        assert_eq!(
            merged,
            "{\"a\":2,\"b\":[3],\"uniques\":{\"x\":{\"r\":[1,2]},\"s\":\"br{ace] \\\" ok\"}}\n"
        );
    }

    #[test]
    fn owned_keys_are_refreshed_not_duplicated() {
        let old = r#"{"a":1}"#;
        let merged = preserve_unknown_top_level(old, String::from(r#"{"a":9}"#));
        assert_eq!(merged, r#"{"a":9}"#);
    }

    #[test]
    fn garbage_old_is_a_noop() {
        assert_eq!(
            preserve_unknown_top_level("not json", String::from("{}")),
            "{}"
        );
        assert_eq!(preserve_unknown_top_level("", String::from("{}")), "{}");
    }
}
