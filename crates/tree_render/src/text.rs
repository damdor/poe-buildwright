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
