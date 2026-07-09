//! Reader + renderer for GGG's `.csd` stat-description files — the rules
//! that turn a `(stat_id, value)` pair into display text like
//! `"15% increased Damage with Hits against Blinded Enemies"`.
//!
//! `data/statdescriptions/*.csd` are UTF-16LE text. Grammar (English
//! only — `lang "…"` blocks are skipped):
//!
//! ```text
//! description
//!   <n> <stat_id_1> … <stat_id_n>      one line covers n stats
//!   <rule_count>
//!     <range_1> … <range_n> "<fmt>" [handler idx]…
//!     …
//! ```
//!
//! A rule applies when every stat value falls in its range; `<fmt>` has
//! `{}` / `{0}` / `{0:+d}` placeholders, optionally transformed by a
//! *handler* (`divide_by_one_hundred`, `milliseconds_to_seconds`, …)
//! keyed by 1-based stat index. GGG inline markup `[a|b]` renders as `b`,
//! `[a]` as `a`; `\n`/`\t` collapse to spaces.
//!
//! Validated against the passive tree: rendering `PassiveSkills` stats
//! reproduces 98% of the PoB-derived node text (the rest is PoB's own
//! line-ordering + a few patch-delta stats).

use std::collections::HashMap;

/// One value range for a single stat in a rule.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Range {
    /// `#` — matches anything.
    Any,
    /// `N` — exactly N.
    Eq(i64),
    /// `!N` — anything but N.
    Ne(i64),
    /// `lo|hi` — inclusive; `#` on either side means unbounded.
    Between(Option<i64>, Option<i64>),
}

impl Range {
    fn parse(tok: &str) -> Range {
        if tok == "#" {
            Range::Any
        } else if let Some(rest) = tok.strip_prefix('!') {
            rest.parse().map(Range::Ne).unwrap_or(Range::Any)
        } else if let Some((lo, hi)) = tok.split_once('|') {
            let lo = if lo == "#" { None } else { lo.parse().ok() };
            let hi = if hi == "#" { None } else { hi.parse().ok() };
            Range::Between(lo, hi)
        } else {
            tok.parse().map(Range::Eq).unwrap_or(Range::Any)
        }
    }
    fn matches(&self, v: i64) -> bool {
        match self {
            Range::Any => true,
            Range::Eq(n) => v == *n,
            Range::Ne(n) => v != *n,
            Range::Between(lo, hi) => lo.is_none_or(|l| v >= l) && hi.is_none_or(|h| v <= h),
        }
    }
}

#[derive(Debug, Clone)]
struct Rule {
    ranges: Vec<Range>,
    fmt: String,
    /// 1-based stat index → handler name (transform applied before format).
    handlers: Vec<(usize, String)>,
}

#[derive(Debug, Clone)]
struct Description {
    ids: Vec<String>,
    rules: Vec<Rule>,
}

/// Parsed stat descriptions from one or more `.csd` files. Later files
/// (e.g. the passive override) replace earlier definitions of the same
/// stat set — call [`StatDescriptions::parse`] in include order.
#[derive(Default)]
pub struct StatDescriptions {
    descs: Vec<Description>,
    /// stat id → indices of descriptions mentioning it.
    by_stat: HashMap<String, Vec<usize>>,
}

impl StatDescriptions {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decode a UTF-16LE `.csd` payload (BOM tolerated) to text.
    pub fn decode_utf16(bytes: &[u8]) -> String {
        let start = if bytes.starts_with(&[0xFF, 0xFE]) {
            2
        } else {
            0
        };
        let units: Vec<u16> = bytes[start..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    }

    /// Parse a `.csd` document, accumulating its descriptions.
    pub fn parse(&mut self, text: &str) {
        let lines: Vec<&str> = text.lines().collect();
        let mut i = 0;
        while i < lines.len() {
            if lines[i].trim() != "description" {
                i += 1;
                continue;
            }
            i += 1;
            // "<n> id1 id2 …"
            let Some(head) = lines.get(i) else { break };
            let mut it = head.split_whitespace();
            let Some(n) = it.next().and_then(|s| s.parse::<usize>().ok()) else {
                i += 1;
                continue;
            };
            let ids: Vec<String> = it.take(n).map(str::to_string).collect();
            i += 1;
            // rule count (English), then that many rule lines.
            let Some(rc) = lines.get(i).and_then(|s| s.trim().parse::<usize>().ok()) else {
                continue;
            };
            i += 1;
            let mut rules = Vec::with_capacity(rc);
            for _ in 0..rc {
                if let Some(line) = lines.get(i) {
                    if let Some(r) = parse_rule(line, n) {
                        rules.push(r);
                    }
                    i += 1;
                }
            }
            if ids.len() == n && !ids.is_empty() {
                self.upsert(Description { ids, rules });
            }
            // Remaining lang blocks are skipped by the outer loop (it only
            // acts on `description`).
        }
    }

    fn upsert(&mut self, d: Description) {
        // Replace an existing identical stat-set description (override).
        if let Some(pos) = self.descs.iter().position(|e| e.ids == d.ids) {
            self.descs[pos] = d;
            return;
        }
        let idx = self.descs.len();
        for id in &d.ids {
            self.by_stat.entry(id.clone()).or_default().push(idx);
        }
        self.descs.push(d);
    }

    /// Render a node/item's ordered `(stat_id, value)` list into display
    /// lines. Multi-stat descriptions are matched first (longest), each
    /// consuming its stats; lines come back in first-stat order.
    pub fn render(&self, stats: &[(String, i64)]) -> Vec<String> {
        let mut used = vec![false; stats.len()];
        // Candidate descriptions: any mentioning a present stat, longest
        // first (so a 2-stat line wins over its 1-stat parts), stable.
        let mut cands: Vec<usize> = Vec::new();
        for (i, (id, _)) in stats.iter().enumerate() {
            let _ = i;
            if let Some(list) = self.by_stat.get(id) {
                cands.extend(list.iter().copied());
            }
        }
        cands.sort_unstable();
        cands.dedup();
        cands.sort_by_key(|&d| std::cmp::Reverse(self.descs[d].ids.len()));

        let mut out: Vec<(usize, String)> = Vec::new();
        for d in cands {
            let desc = &self.descs[d];
            // Find an unused position for each id, in order.
            let mut pos = Vec::with_capacity(desc.ids.len());
            let mut ok = true;
            for id in &desc.ids {
                match stats
                    .iter()
                    .enumerate()
                    .position(|(k, (sid, _))| sid == id && !used[k] && !pos.contains(&k))
                {
                    Some(k) => pos.push(k),
                    None => {
                        ok = false;
                        break;
                    }
                }
            }
            if !ok {
                continue;
            }
            let vals: Vec<i64> = pos.iter().map(|&p| stats[p].1).collect();
            if let Some(text) = render_rule(desc, &vals) {
                let first = *pos.iter().min().unwrap();
                for p in pos {
                    used[p] = true;
                }
                out.push((first, text));
            }
        }
        out.sort_by_key(|(p, _)| *p);
        out.into_iter().map(|(_, t)| t).collect()
    }

    /// Like [`render`], but each stat carries a `lo..=hi` roll range. The
    /// placeholder renders as `(lo-hi)` when the ends differ (or a single
    /// value when equal) — the form unique items are displayed in, e.g.
    /// `+(30-40) to maximum Life`. The rule is selected by the low value
    /// (a mod's range never straddles a rule boundary).
    pub fn render_ranges(&self, stats: &[(String, i64, i64)]) -> Vec<String> {
        let mut used = vec![false; stats.len()];
        let mut out: Vec<(usize, String)> = Vec::new();
        // Strict pass: descriptions whose every stat is present.
        self.match_ranges_pass(stats, &mut used, &mut out, false);
        // Partial pass: a multi-stat description whose only *absent* stats are
        // guard/flag stats (default 0, not shown by the format) — e.g.
        // `local_physical_damage_+%` sits beside `local_weapon_no_physical_damage`,
        // whose `0` value selects the "increased Physical Damage" rule.
        self.match_ranges_pass(stats, &mut used, &mut out, true);
        out.sort_by_key(|(p, _)| *p);
        out.into_iter().map(|(_, t)| t).collect()
    }

    fn match_ranges_pass(
        &self,
        stats: &[(String, i64, i64)],
        used: &mut [bool],
        out: &mut Vec<(usize, String)>,
        partial: bool,
    ) {
        let mut cands: Vec<usize> = Vec::new();
        for (id, _, _) in stats {
            if let Some(list) = self.by_stat.get(id) {
                cands.extend(list.iter().copied());
            }
        }
        cands.sort_unstable();
        cands.dedup();
        cands.sort_by_key(|&d| std::cmp::Reverse(self.descs[d].ids.len()));

        for d in cands {
            let desc = &self.descs[d];
            // Align each desc id to a present+unused stat, or None (absent).
            let mut slot: Vec<Option<usize>> = Vec::with_capacity(desc.ids.len());
            for id in &desc.ids {
                let k = stats.iter().enumerate().position(|(k, (sid, _, _))| {
                    sid == id && !used[k] && !slot.contains(&Some(k))
                });
                slot.push(k);
            }
            let present: Vec<usize> = slot.iter().flatten().copied().collect();
            if partial {
                // Need ≥1 present and ≥1 absent (fully-present ⇒ strict pass).
                if present.is_empty() || slot.iter().all(Option::is_some) {
                    continue;
                }
            } else if slot.iter().any(Option::is_none) {
                continue;
            }
            // Absent stats default to 0 (their identity) for rule selection.
            let los: Vec<i64> = slot.iter().map(|o| o.map_or(0, |k| stats[k].1)).collect();
            let his: Vec<i64> = slot.iter().map(|o| o.map_or(0, |k| stats[k].2)).collect();
            // Select the rule by the low end; if a `0..N` span sits on a rule
            // boundary (the `1|#` "increased" rule excludes 0), fall back to
            // the high end, then the midpoint, so the span still renders.
            let mids: Vec<i64> = los.iter().zip(&his).map(|(&l, &h)| (l + h) / 2).collect();
            let cand_vals: [&[i64]; 3] = [&los, &his, &mids];
            let Some(rule) = cand_vals.iter().find_map(|vals| {
                desc.rules
                    .iter()
                    .find(|r| r.ranges.iter().zip(vals.iter()).all(|(rg, &v)| rg.matches(v)))
            }) else {
                continue;
            };
            if partial {
                // Safe only if the format never displays an absent stat.
                let present_ids: std::collections::HashSet<usize> = slot
                    .iter()
                    .enumerate()
                    .filter_map(|(i, o)| o.map(|_| i))
                    .collect();
                if !placeholder_indices(&rule.fmt)
                    .iter()
                    .all(|i| present_ids.contains(i))
                {
                    continue;
                }
            }
            let text = strip_markup(&apply_rule_range(rule, &los, &his));
            let first = *present.iter().min().unwrap();
            for &k in &present {
                used[k] = true;
            }
            out.push((first, text));
        }
    }
}

/// Parse one rule line: `<ranges…> "<fmt>" <handler idx>…`.
fn parse_rule(line: &str, nstats: usize) -> Option<Rule> {
    let open = line.find('"')?;
    let close = line.rfind('"')?;
    if close <= open {
        return None;
    }
    let ranges: Vec<Range> = line[..open]
        .split_whitespace()
        .take(nstats)
        .map(Range::parse)
        .collect();
    let fmt = line[open + 1..close].to_string();
    // handlers: (name, index) pairs after the string.
    let mut handlers = Vec::new();
    let toks: Vec<&str> = line[close + 1..].split_whitespace().collect();
    let mut j = 0;
    while j + 1 < toks.len() {
        if let Ok(idx) = toks[j + 1].parse::<usize>() {
            handlers.push((idx, toks[j].to_string()));
            j += 2;
        } else {
            j += 1;
        }
    }
    Some(Rule {
        ranges,
        fmt,
        handlers,
    })
}

/// Apply a value handler (returns the transformed value). GGG suffixes the
/// same operation with display-precision hints (`_0dp`/`_1dp`/`_2dp`/
/// `_if_required`) that don't change the value, so we match on the
/// *operation prefix*. Compound ops (`…_and_negate`, `…_then_double`) are
/// checked before their bases. Unknown / index-lookup handlers
/// (`passive_hash`, `canonical_line`, …) pass the value through.
fn apply_handler(name: &str, v: f64) -> f64 {
    // Compound operations first (they contain a base op as a prefix).
    if name.starts_with("divide_by_one_hundred_and_negate") {
        return -v / 100.0;
    }
    if name.starts_with("divide_by_twenty_then_double") {
        return v / 10.0; // /20 then ×2
    }
    if name.starts_with("negate_and_double") {
        return -v * 2.0;
    }
    // Unit conversions.
    if name.starts_with("per_minute_to_per_second") {
        return v / 60.0;
    }
    if name.starts_with("milliseconds_to_seconds") {
        return v / 1000.0;
    }
    if name.starts_with("deciseconds_to_seconds") {
        return v / 10.0;
    }
    // Plain divisors — longer number-words before their prefixes
    // (`twenty`/`twelve` before `two`, `fifteen`/`fifty` before `five`).
    if name.starts_with("divide_by_one_hundred") {
        return v / 100.0;
    }
    if name.starts_with("divide_by_fifteen") {
        return v / 15.0;
    }
    if name.starts_with("divide_by_fifty") {
        return v / 50.0;
    }
    if name.starts_with("divide_by_five") {
        return v / 5.0;
    }
    if name.starts_with("divide_by_twelve") {
        return v / 12.0;
    }
    if name.starts_with("divide_by_twenty") {
        return v / 20.0;
    }
    if name.starts_with("divide_by_two") {
        return v / 2.0;
    }
    if name.starts_with("divide_by_ten") {
        return v / 10.0;
    }
    if name.starts_with("divide_by_six") {
        return v / 6.0;
    }
    if name.starts_with("divide_by_four") {
        return v / 4.0;
    }
    if name.starts_with("divide_by_three") {
        return v / 3.0;
    }
    match name {
        "negate" => -v,
        "double" => v * 2.0,
        "times_twenty" => v * 20.0,
        "times_one_point_five" => v * 1.5,
        "add_one" => v + 1.0,
        "subtract_one" => v - 1.0,
        "plus_two_hundred" => v + 200.0,
        _ => v,
    }
}

/// Format a number: integer when whole, else up to 2 trimmed decimals.
fn fmt_num(v: f64) -> String {
    if (v - v.round()).abs() < 1e-9 {
        format!("{}", v.round() as i64)
    } else {
        let s = format!("{v:.2}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

/// Render a rule against its stat values, or `None` if the ranges don't
/// match. Applies handlers, substitutes placeholders, strips GGG markup.
fn render_rule(desc: &Description, vals: &[i64]) -> Option<String> {
    let rule = desc
        .rules
        .iter()
        .find(|r| r.ranges.iter().zip(vals).all(|(rg, &v)| rg.matches(v)))?;

    // Per-index display values after handlers.
    let mut disp: Vec<f64> = vals.iter().map(|&v| v as f64).collect();
    for (idx, name) in &rule.handlers {
        if *idx >= 1 && *idx <= disp.len() {
            disp[*idx - 1] = apply_handler(name, disp[*idx - 1]);
        }
    }
    let out = substitute(&rule.fmt, &disp);
    Some(strip_markup(&out))
}

/// Apply a known rule to a `lo..=hi` span: run handlers on both ends and
/// substitute the `(lo-hi)` placeholders. A `negate` (or other
/// sign-flipping) handler reverses the ends, which `substitute_range`
/// re-sorts. Markup is stripped by the caller.
fn apply_rule_range(rule: &Rule, los: &[i64], his: &[i64]) -> String {
    let mut lo: Vec<f64> = los.iter().map(|&v| v as f64).collect();
    let mut hi: Vec<f64> = his.iter().map(|&v| v as f64).collect();
    for (idx, name) in &rule.handlers {
        if *idx >= 1 && *idx <= lo.len() {
            lo[*idx - 1] = apply_handler(name, lo[*idx - 1]);
            hi[*idx - 1] = apply_handler(name, hi[*idx - 1]);
        }
    }
    substitute_range(&rule.fmt, &lo, &hi)
}

/// The stat indices a format string actually displays, via `{i}` or bare
/// `{}` (which auto-increments like `substitute`). Used to guard partial
/// matches: a rule that would show an absent stat is rejected.
fn placeholder_indices(fmt: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let mut auto = 0usize;
    let bytes = fmt.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{'
            && let Some(close) = fmt[i..].find('}')
        {
            let inner = &fmt[i + 1..i + close];
            let idx_s = inner.split(':').next().unwrap_or("");
            let idx = if idx_s.is_empty() {
                let a = auto;
                auto += 1;
                a
            } else {
                idx_s.parse().unwrap_or(0)
            };
            out.push(idx);
            i += close + 1;
            continue;
        }
        i += 1;
    }
    out
}

/// Like [`substitute`], but each index has a `(lo, hi)` pair rendered as
/// `(lo-hi)` (ascending, ends re-sorted) or a single value when equal.
fn substitute_range(fmt: &str, lo: &[f64], hi: &[f64]) -> String {
    let mut out = String::with_capacity(fmt.len());
    let mut auto = 0usize;
    let bytes = fmt.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{'
            && let Some(close) = fmt[i..].find('}')
        {
            let inner = &fmt[i + 1..i + close];
            let (idx_s, spec) = match inner.split_once(':') {
                Some((a, b)) => (a, b),
                None => (inner, ""),
            };
            let idx = if idx_s.is_empty() {
                let a = auto;
                auto += 1;
                a
            } else {
                idx_s.parse().unwrap_or(0)
            };
            let a = lo.get(idx).copied().unwrap_or(0.0);
            let b = hi.get(idx).copied().unwrap_or(0.0);
            let (mn, mx) = if a <= b { (a, b) } else { (b, a) };
            let signed = spec.contains('+');
            if (mn - mx).abs() < 1e-9 {
                // Single value.
                if signed && mn >= 0.0 {
                    out.push('+');
                }
                out.push_str(&fmt_num(mn));
            } else if mn < 0.0 && mx <= 0.0 {
                // Fully non-positive span: factor the minus out
                // (`-(6-12)%`) rather than emit a double-minus.
                out.push('-');
                out.push('(');
                out.push_str(&fmt_num(-mx));
                out.push('-');
                out.push_str(&fmt_num(-mn));
                out.push(')');
            } else {
                // A `{:+d}` span always shows its sign, even when it
                // straddles zero (`+(-1-1)`), matching item display.
                if signed {
                    out.push('+');
                }
                out.push('(');
                out.push_str(&fmt_num(mn));
                out.push('-');
                out.push_str(&fmt_num(mx));
                out.push(')');
            }
            i += close + 1;
            continue;
        }
        let ch = fmt[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Substitute `{}` / `{i}` / `{i:+d}` placeholders. Empty `{}` auto-
/// increments the index like Python's `str.format`.
fn substitute(fmt: &str, disp: &[f64]) -> String {
    let mut out = String::with_capacity(fmt.len());
    let mut auto = 0usize;
    let bytes = fmt.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{'
            && let Some(close) = fmt[i..].find('}')
        {
            let inner = &fmt[i + 1..i + close];
            let (idx_s, spec) = match inner.split_once(':') {
                Some((a, b)) => (a, b),
                None => (inner, ""),
            };
            let idx = if idx_s.is_empty() {
                let a = auto;
                auto += 1;
                a
            } else {
                idx_s.parse().unwrap_or(0)
            };
            let v = disp.get(idx).copied().unwrap_or(0.0);
            if spec.contains('+') {
                let n = v.round() as i64;
                if n >= 0 {
                    out.push('+');
                }
                out.push_str(&n.to_string());
            } else {
                out.push_str(&fmt_num(v));
            }
            i += close + 1;
            continue;
        }
        // copy one char (respecting UTF-8 boundaries)
        let ch = fmt[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// `[a|b]` → `b`, `[a]` → `a`; collapse literal `\n`/`\t` to spaces.
fn strip_markup(s: &str) -> String {
    let s = s
        .replace("\\n", " ")
        .replace("\\t", " ")
        .replace(['\n', '\t'], " ");
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '[' {
            let mut inner = String::new();
            for d in chars.by_ref() {
                if d == ']' {
                    break;
                }
                inner.push(d);
            }
            match inner.split_once('|') {
                Some((_, b)) => out.push_str(b),
                None => out.push_str(&inner),
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "description\n\t1 hit_damage_+%_vs_blinded_enemies\n\t1\n\t\t# \"{0}% increased Damage with Hits against Blinded [Enemies|Enemies]\"\n\ndescription\n\t1 base_life_regeneration_rate_per_minute\n\t1\n\t\t# \"Regenerate {0} Life per second\" per_minute_to_per_second 1\n\ndescription\n\t1 devotion\n\t2\n\t\t1|# \"{0:+d} to Devotion\"\n\t\t#|-1 \"{0:+d} to Devotion\" negate 1\n";

    fn descs() -> StatDescriptions {
        let mut d = StatDescriptions::new();
        d.parse(SAMPLE);
        d
    }

    #[test]
    fn renders_simple_percent() {
        let d = descs();
        let out = d.render(&[("hit_damage_+%_vs_blinded_enemies".into(), 15)]);
        assert_eq!(
            out,
            vec!["15% increased Damage with Hits against Blinded Enemies"]
        );
    }

    #[test]
    fn applies_per_minute_handler() {
        let d = descs();
        // 360 per minute → 6 per second.
        let out = d.render(&[("base_life_regeneration_rate_per_minute".into(), 360)]);
        assert_eq!(out, vec!["Regenerate 6 Life per second"]);
    }

    #[test]
    fn signed_and_negate_range() {
        let d = descs();
        assert_eq!(d.render(&[("devotion".into(), 5)]), vec!["+5 to Devotion"]);
        // negative value picks the negate rule → "+5" via negate handler.
        assert_eq!(d.render(&[("devotion".into(), -5)]), vec!["+5 to Devotion"]);
    }

    #[test]
    fn renders_roll_range() {
        let d = descs();
        // A span renders as (lo-hi); the +d rule keeps its sign.
        let out = d.render_ranges(&[("devotion".into(), 3, 7)]);
        assert_eq!(out, vec!["+(3-7) to Devotion"]);
        // Equal ends collapse to a single value.
        let out = d.render_ranges(&[("devotion".into(), 5, 5)]);
        assert_eq!(out, vec!["+5 to Devotion"]);
        // negate flips a negative span and the ends re-sort ascending.
        let out = d.render_ranges(&[("devotion".into(), -7, -3)]);
        assert_eq!(out, vec!["+(3-7) to Devotion"]);
    }

    #[test]
    fn partial_match_fills_absent_guard_stat() {
        // A 2-stat description where the second stat is a guard flag that
        // defaults to 0 and isn't shown. Present only the first stat.
        let mut d = StatDescriptions::new();
        d.parse(
            "description\n\t2 local_physical_damage_+% local_weapon_no_physical_damage\n\t2\n\t\t# 1|# \"No Physical Damage\"\n\t\t1|# 0 \"{0}% increased Physical Damage\" canonical_line\n",
        );
        // Only the % stat present → the guard defaults to 0 → "increased" rule.
        let out = d.render_ranges(&[("local_physical_damage_+%".into(), 80, 120)]);
        assert_eq!(out, vec!["(80-120)% increased Physical Damage"]);
    }

    #[test]
    fn suffixed_handlers_still_divide() {
        // `_1dp_if_required` etc. are precision hints on the same op.
        let mut d = StatDescriptions::new();
        d.parse(
            "description\n\t1 life_regeneration_per_minute_per_maximum_energy_shield\n\t1\n\t\t# \"Regenerate {0} Life per second per Maximum Energy Shield\" per_minute_to_per_second_2dp_if_required 1\n",
        );
        let out = d.render_ranges(&[(
            "life_regeneration_per_minute_per_maximum_energy_shield".into(),
            3,
            3,
        )]);
        // 3 per minute → 0.05 per second (was passing through as 3 before).
        assert_eq!(out, vec!["Regenerate 0.05 Life per second per Maximum Energy Shield"]);
    }

    #[test]
    fn zero_low_span_falls_back_to_high_end() {
        // A `0..N` roll: the low end (0) matches neither the `1|#` increased
        // rule nor the `#|-1` reduced rule, so selection falls back to the
        // high end and the span still renders.
        let mut d = StatDescriptions::new();
        d.parse(
            "description\n\t1 critical_strike_chance_+%\n\t2\n\t\t1|# \"{0}% increased Critical Hit Chance\"\n\t\t#|-1 \"{0}% reduced Critical Hit Chance\" negate 1\n",
        );
        let out = d.render_ranges(&[("critical_strike_chance_+%".into(), 0, 30)]);
        assert_eq!(out, vec!["(0-30)% increased Critical Hit Chance"]);
    }

    #[test]
    fn multi_stat_order_and_join() {
        let mut d = StatDescriptions::new();
        d.parse(SAMPLE);
        let out = d.render(&[
            ("devotion".into(), 3),
            ("hit_damage_+%_vs_blinded_enemies".into(), 10),
        ]);
        // Emitted in stat order.
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], "+3 to Devotion");
        assert!(out[1].starts_with("10% increased"));
    }
}
