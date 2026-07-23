//! Parser for Path of Building's hand-curated unique-item lists
//! (`Export/Uniques/*.lua`). This is the *one* dataset GGG doesn't ship
//! in the client bundles — the per-unique mod recipe is applied
//! server-side at item generation, so every tool (PoB, poe2db, this one)
//! sources the list from PoB's community-maintained files. See
//! `docs/native-data-miner.md` § Uniques.
//!
//! We parse only the *structure* here — name, base, variants, and the
//! mod **ids** each unique grants. Those mod ids (`UniqueMovementVelocity6`
//! …) are GGG's own `Mods.Id` values, so the actual stat ranges + text are
//! then resolved against **our** first-party `mods.tsv` + stat
//! descriptions, not PoB's. That keeps PoB to a single, pinned, plain-text
//! seam: the list of which mods belong to which unique.
//!
//! Grammar (one `[[ … ]]` Lua long-string block per unique):
//! ```text
//! <name>
//! <base>
//! (Variant: <label>)*        // 0+ variant labels
//! (Source:/League:/Sockets:/Requires: … )*   // metadata we skip
//! (Implicits: <n>)?          // first n mod lines are implicits
//! (<mod line>)+
//! ```
//! A mod line is `[{variant:1,3}]<ModId>[[lo,hi]]` — an optional
//! variant mask, the mod id, and an optional roll-range override.

/// One granted mod of a unique.
#[derive(Debug, Clone, PartialEq)]
pub struct UniqueMod {
    /// 1-based variant indices this mod applies to; empty = all variants.
    pub variants: Vec<u32>,
    pub mod_id: String,
    /// Roll override `[lo,hi]` when present (else use the mod's own range).
    pub roll: Option<(i64, i64)>,
    /// True for the leading `Implicits:` block.
    pub implicit: bool,
    /// Verbatim stat text for the handful of uniques (timeless jewels,
    /// watchstones) whose lines are display text, not resolvable mod ids.
    /// When set, [`mod_id`](Self::mod_id) is empty and the text is emitted
    /// as-is instead of resolved against the mod pool.
    pub literal: Option<String>,
}

/// One unique item as PoB lists it.
#[derive(Debug, Clone, PartialEq)]
pub struct Unique {
    pub name: String,
    pub base: String,
    /// Passive-tree effect radius declared by PoB's item recipe
    /// (`Radius: Small`, `Radius: Very Large`, …). This is item
    /// metadata rather than a rollable mod, but the planner needs it
    /// to draw the correct in-tree radius.
    pub radius: Option<String>,
    /// Variant labels in order (1-based indexing matches the masks).
    pub variants: Vec<String>,
    pub mods: Vec<UniqueMod>,
}

/// Parse one `Export/Uniques/<slot>.lua` file into its uniques.
pub fn parse(text: &str) -> Vec<Unique> {
    let mut out = Vec::new();
    // Each unique is a Lua long-string block `[[ … ]]`.
    let bytes = text.as_bytes();
    let mut i = 0;
    while let Some(open) = find_from(bytes, b"[[", i) {
        let start = open + 2;
        let Some(close) = find_from(bytes, b"]]", start) else {
            break;
        };
        if let Some(u) = parse_block(&text[start..close]) {
            out.push(u);
        }
        i = close + 2;
    }
    out
}

fn find_from(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    hay.get(from..)?
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

fn parse_block(block: &str) -> Option<Unique> {
    let lines: Vec<&str> = block
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let name = lines.first()?.to_string();
    // PoB1 may put influence headers before the base (`Shaper Item`),
    // and may list a different base per historical variant:
    //   {variant:1,2}Siege Helmet
    //   {variant:3}Royal Burgonet
    // The final variant is the current one, so the last leading base
    // declaration is the catalogue base we ground against GGG data.
    let mut base = String::new();
    let mut body_start = 1usize;
    for (i, line) in lines.iter().enumerate().skip(1) {
        if line.starts_with("Variant:") || line.starts_with("Implicits:") || is_metadata(line) {
            body_start = i;
            break;
        }
        let clean = strip_brace_tag(line);
        if clean.ends_with(" Item") {
            body_start = i + 1;
            continue;
        }
        // The first non-header line is always a base. Further leading
        // {variant:...} lines are alternate bases; an untagged token
        // after a base is the first mod id and starts the body.
        if base.is_empty() || line.starts_with("{variant:") {
            base = clean.to_string();
            body_start = i + 1;
            continue;
        }
        body_start = i;
        break;
    }
    if name.is_empty() || base.is_empty() {
        return None;
    }

    let mut variants = Vec::new();
    let mut mods = Vec::new();
    let mut radius = None;
    let mut implicits_left = 0usize;
    for line in &lines[body_start..] {
        if let Some(label) = line.strip_prefix("Variant:") {
            variants.push(label.trim().to_string());
        } else if let Some(n) = line.strip_prefix("Implicits:") {
            implicits_left = n.trim().parse().unwrap_or(0);
        } else if let Some(value) = line.strip_prefix("Radius:") {
            radius = Some(value.trim().to_string());
        } else if is_metadata(line) {
            // Source / League / Sockets / Requires / LevelReq / etc.
        } else if let Some(m) = parse_mod_line(line, implicits_left > 0) {
            implicits_left = implicits_left.saturating_sub(1);
            mods.push(m);
        }
    }
    Some(Unique {
        name,
        base,
        radius,
        variants,
        mods,
    })
}

/// Strip one leading PoB brace annotation (`{variant:...}`, `{tags:...}`)
/// from a human-readable base declaration.
fn strip_brace_tag(line: &str) -> &str {
    line.strip_prefix('{')
        .and_then(|rest| rest.find('}').map(|end| &rest[end + 1..]))
        .unwrap_or(line)
        .trim()
}

/// Metadata / item-property lines we don't turn into mods. Covers both
/// `Key: value` headers and the bare capitalised item flags PoB emits
/// (`Corrupted`, `Mirrored`, `Historic`, …), which otherwise look exactly
/// like a mod id.
fn is_metadata(line: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "Source:",
        "League:",
        "Sockets:",
        "Requires ",
        "Requires:",
        "LevelReq:",
        "Upgrade:",
        "Has Alt Variant",
        "Selected ", // Selected Variant / Selected Alt Variant [Two|Three]:
        "Prefixes:",
        "Suffixes:",
        "Limited to:",
        "Radius:",
        "Note:",
        "Talisman Tier:",
        "Rune:",
    ];
    // Bare single-word item flags — not stats.
    const FLAGS: &[&str] = &[
        "Corrupted",
        "Mirrored",
        "Historic",
        "Fractured",
        "Synthesised",
        "Synthesized",
        "Unmodifiable",
        "Mirror",
        "Eldritch",
        "Split",
        "Duplicated",
    ];
    PREFIXES.iter().any(|k| line.starts_with(k)) || FLAGS.contains(&line) || line.starts_with("--")
}

fn parse_mod_line(line: &str, implicit: bool) -> Option<UniqueMod> {
    // Optional leading `{variant:1,3,4}` mask.
    let (variants, rest) = if let Some(stripped) = line.strip_prefix("{variant:") {
        let end = stripped.find('}')?;
        let mask = stripped[..end]
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();
        (mask, stripped[end + 1..].trim())
    } else if line.starts_with('{') {
        // Some other brace tag (e.g. {tags:…}, {fractured}); strip it.
        let end = line.find('}')?;
        (Vec::new(), line[end + 1..].trim())
    } else {
        (Vec::new(), line)
    };
    if rest.is_empty() {
        return None;
    }

    // `<ModId>` then optional `[lo,hi]` override.
    let (id, roll) = match rest.find('[') {
        Some(b) => {
            let id = rest[..b].trim();
            let inner = rest[b + 1..].trim_end_matches(']');
            let mut it = inner.split(',').map(|s| s.trim().parse::<i64>());
            let roll = match (it.next(), it.next()) {
                (Some(Ok(lo)), Some(Ok(hi))) => Some((lo, hi)),
                _ => None,
            };
            (id, roll)
        }
        None => (rest.trim(), None),
    };
    // A resolvable mod id is a single `[A-Za-z0-9_]+` token. Anything with
    // spaces or other punctuation is verbatim display text (timeless-jewel
    // seeds, watchstone lines) — keep it as a literal, don't resolve it.
    if !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
        Some(UniqueMod {
            variants,
            mod_id: id.to_string(),
            roll,
            implicit,
            literal: None,
        })
    } else {
        Some(UniqueMod {
            variants,
            mod_id: String::new(),
            roll: None,
            implicit,
            literal: Some(rest.to_string()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
return {
-- Amulet
[[
The Anvil
Bloodstone Amulet
Variant: Pre 0.2.0
Variant: Current
Implicits: 1
AmuletImplicitIncreasedLife1
UniqueMovementVelocity6
{variant:1}UniqueBlockChanceIncrease1[20,20]
{variant:2}UniqueBlockChanceIncrease1
]],[[
Astramentis
Stellar Amulet
UniqueAllAttributes3[80,100]
]],[[
Kalandra's Touch
Ring
UniqueDuplicatesRingStats1
Mirrored
]],[[
Heroic Tragedy
Timeless Jewel
Limited to: 1 Historic
Radius: Very Large
Passives in radius are Conquered by the Kalguur
Historic
]],
}
"#;

    #[test]
    fn parses_two_uniques() {
        let u = parse(SAMPLE);
        assert_eq!(u.len(), 4);

        let anvil = &u[0];
        assert_eq!(anvil.name, "The Anvil");
        assert_eq!(anvil.base, "Bloodstone Amulet");
        assert_eq!(anvil.variants, vec!["Pre 0.2.0", "Current"]);
        // implicit + 3 mods
        assert_eq!(anvil.mods.len(), 4);
        assert!(anvil.mods[0].implicit);
        assert_eq!(anvil.mods[0].mod_id, "AmuletImplicitIncreasedLife1");
        assert!(!anvil.mods[1].implicit);
        // variant mask + roll override
        let block = &anvil.mods[2];
        assert_eq!(block.mod_id, "UniqueBlockChanceIncrease1");
        assert_eq!(block.variants, vec![1]);
        assert_eq!(block.roll, Some((20, 20)));
        // same mod, other variant, no override
        assert_eq!(anvil.mods[3].variants, vec![2]);
        assert_eq!(anvil.mods[3].roll, None);

        assert_eq!(u[1].name, "Astramentis");
        assert_eq!(u[1].mods[0].roll, Some((80, 100)));

        // Bare item flags (`Mirrored`) are dropped, not read as mod ids —
        // so only the real mod survives.
        let kalandra = &u[2];
        assert_eq!(kalandra.mods.len(), 1);
        assert_eq!(kalandra.mods[0].mod_id, "UniqueDuplicatesRingStats1");

        // Timeless-jewel display text is kept verbatim as a literal; the
        // `Limited to:` / `Radius:` headers and bare `Historic` flag are
        // dropped.
        let jewel = &u[3];
        assert_eq!(jewel.radius.as_deref(), Some("Very Large"));
        assert_eq!(jewel.mods.len(), 1);
        assert_eq!(jewel.mods[0].mod_id, "");
        assert_eq!(
            jewel.mods[0].literal.as_deref(),
            Some("Passives in radius are Conquered by the Kalguur")
        );
    }

    #[test]
    fn picks_current_variant_base_and_skips_influence_headers() {
        let sample = r#"
return {
[[
The Formless Flame
{variant:1,2}Siege Helmet
{variant:3}Royal Burgonet
Variant: Pre 3.16.0
Variant: Pre 3.21.0
Variant: Current
LocalIncreasedPhysicalDamageReductionRatingPercentUnique__26
]],[[
Echoes of Creation
Shaper Item
Royal Burgonet
Requires Level 65, 148 Str
IncreasedLifeUniqueHelmetStrDex5
]],
}
"#;
        let parsed = parse(sample);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].base, "Royal Burgonet");
        assert_eq!(parsed[0].mods.len(), 1);
        assert_eq!(parsed[1].base, "Royal Burgonet");
        assert_eq!(parsed[1].mods.len(), 1);
    }
}
