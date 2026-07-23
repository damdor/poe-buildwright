//! tree_tsv — THE shared tree-TSV contract.
//!
//! Three shapers emit the same `tree/{nodes,edges,meta,sprites}.tsv`
//! shape from three different sources:
//!
//!   * `tree_json::shape_tree_json` — PoE2, from GGG's data.json export
//!   * `shape::shape_tree`          — PoE2, from the bundle `.psg` graph
//!   * `buildwright poe1-tree`      — PoE1, from pathofexile.com's embed
//!
//! Everything that defines the CONTRACT between them and the consumer
//! (`tree_render`'s io.rs, which reads columns positionally and
//! hard-fails below `NODES_COLUMNS`) lives here, exactly once: the
//! header strings, the node-kind ladder, the orbit-angle rule, and the
//! cell sanitizer. A shaper keeps only what is genuinely its own —
//! source parsing, per-game filtering policy, art resolution.
//!
//! tree_render itself is std-only by design (no crate deps), so its
//! reader cannot import these constants — the unit tests below plus
//! the `verify` ship gate are what keep the two sides honest.

/// The 17-column `nodes.tsv` header. `tree_render/src/io.rs` reads
/// these positions (cols[0]..cols[16]) and errors below
/// [`NODES_COLUMNS`] — change either only in the same commit as the
/// other, plus all three shapers.
pub const NODES_HEADER: &str = "id\tx\ty\tkind\tklass\tascendancy\tname\tstats\tgroup\torbit\t\
     orbit_index\ticon\tnode_overlay\tactive_effect\tnode_options\t\
     connection_art\tunlock_constraint\n";
pub const NODES_COLUMNS: usize = 17;

/// `edges.tsv` header. The `orbit` column is the signed connection
/// orbit hint (0 = straight / derive-from-shared-orbit downstream).
pub const EDGES_HEADER: &str = "from\tto\torbit\n";

/// `sprites.tsv` header. NOTE the width/height semantics differ per
/// game — world units (px ÷ sheet zoom) for poe1, raw decoded pixels
/// for poe2 — and emit.rs relies on that (`data_sized`). The header is
/// shared; the meaning is the shaper's documented responsibility.
pub const SPRITES_HEADER: &str = "sprite_name\tpng\twidth\theight\n";

/// Source-agnostic node classification input. Each shaper fills this
/// from its own source's flags; [`node_kind`] applies the one canonical
/// precedence ladder.
#[derive(Default)]
pub struct KindFlags {
    pub class_start: bool,
    pub asc_start: bool,
    pub is_asc: bool,
    pub jewel: bool,
    pub mastery: bool,
    pub keystone: bool,
    pub notable: bool,
    pub attribute: bool,
    pub multichoice: bool,
    pub multichoice_opt: bool,
}

/// The canonical kind ladder. Precedence (highest first): asc_start,
/// class_start, jewel, mastery, ascendancy(notable|small), keystone,
/// notable, attribute, multichoice, multichoice_opt, small. Verified
/// output-identical against all flag combinations present in both the
/// PoE2 data.json export and the PoE1 3.26 embed (no node carries two
/// flags whose relative order differs between the pre-unification
/// ladders).
pub fn node_kind(f: &KindFlags) -> &'static str {
    if f.asc_start {
        "asc_start"
    } else if f.class_start {
        "class_start"
    } else if f.jewel {
        "jewel"
    } else if f.mastery {
        "mastery"
    } else if f.is_asc {
        if f.notable {
            "asc_notable"
        } else {
            "asc_small"
        }
    } else if f.keystone {
        "keystone"
    } else if f.notable {
        "notable"
    } else if f.attribute {
        "attribute"
    } else if f.multichoice {
        "multichoice"
    } else if f.multichoice_opt {
        "multichoice_opt"
    } else {
        "small"
    }
}

/// GGG's orbit-slot angle (skilltree.js `getOrbitAngle`): orbits with
/// 16 or 40 placements use hand-tuned tables — the 12-position clock
/// angles plus the four diagonals (16), or the clock angles with
/// 10°/15°/20° sub-steps (40); every other count is uniform
/// `2π·idx/slots`. PoE1's skillsPerOrbit is [1,6,16,16,40,72,72], so
/// orbits 2–4 need the tables; PoE2's orbit counts are currently all
/// uniform, but any future 16/40-slot orbit takes the correct angles
/// automatically. Final node position is
/// `(group.x + r·sin a, group.y − r·cos a)` in every shaper.
pub fn orbit_angle(oidx: f64, slots: f64) -> f64 {
    const DEG16: [f64; 16] = [
        0.0, 30.0, 45.0, 60.0, 90.0, 120.0, 135.0, 150.0, 180.0, 210.0, 225.0, 240.0, 270.0, 300.0,
        315.0, 330.0,
    ];
    const DEG40: [f64; 40] = [
        0.0, 10.0, 20.0, 30.0, 40.0, 45.0, 50.0, 60.0, 70.0, 80.0, 90.0, 100.0, 110.0, 120.0,
        130.0, 135.0, 140.0, 150.0, 160.0, 170.0, 180.0, 190.0, 200.0, 210.0, 220.0, 225.0, 230.0,
        240.0, 250.0, 260.0, 270.0, 280.0, 290.0, 300.0, 310.0, 315.0, 320.0, 330.0, 340.0, 350.0,
    ];
    let i = oidx as usize;
    if slots == 16.0 && i < 16 {
        DEG16[i].to_radians()
    } else if slots == 40.0 && i < 40 {
        DEG40[i].to_radians()
    } else {
        std::f64::consts::TAU * oidx / slots
    }
}

/// Append one TSV row, sanitizing every cell: embedded tab / newline /
/// CR become spaces so a stray character in source text can never
/// shift columns for the positional reader.
pub fn push_row(out: &mut String, fields: &[&str]) {
    for (i, f) in fields.iter().enumerate() {
        if i > 0 {
            out.push('\t');
        }
        if f.contains(['\t', '\n', '\r']) {
            out.push_str(&f.replace(['\t', '\n', '\r'], " "));
        } else {
            out.push_str(f);
        }
    }
    out.push('\n');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_matches_column_count() {
        assert_eq!(NODES_HEADER.trim_end().split('\t').count(), NODES_COLUMNS);
        assert_eq!(EDGES_HEADER.trim_end().split('\t').count(), 3);
        assert_eq!(SPRITES_HEADER.trim_end().split('\t').count(), 4);
    }

    #[test]
    fn orbit_angle_tables() {
        let d = |deg: f64| deg.to_radians();
        // 16-slot: clock angles + diagonals, NOT uniform 22.5° steps.
        assert_eq!(orbit_angle(1.0, 16.0), d(30.0));
        assert_eq!(orbit_angle(2.0, 16.0), d(45.0));
        assert_eq!(orbit_angle(15.0, 16.0), d(330.0));
        // 40-slot: 12-clock base with 10/15/20° sub-steps.
        assert_eq!(orbit_angle(5.0, 40.0), d(45.0));
        assert_eq!(orbit_angle(35.0, 40.0), d(315.0));
        // Everything else: uniform.
        assert!((orbit_angle(3.0, 12.0) - d(90.0)).abs() < 1e-12);
        assert!((orbit_angle(1.0, 6.0) - d(60.0)).abs() < 1e-12);
    }

    #[test]
    fn kind_ladder_precedence() {
        let k = |f: KindFlags| node_kind(&f);
        assert_eq!(
            k(KindFlags {
                asc_start: true,
                is_asc: true,
                ..Default::default()
            }),
            "asc_start"
        );
        assert_eq!(
            k(KindFlags {
                class_start: true,
                ..Default::default()
            }),
            "class_start"
        );
        assert_eq!(
            k(KindFlags {
                jewel: true,
                is_asc: true,
                ..Default::default()
            }),
            "jewel"
        );
        assert_eq!(
            k(KindFlags {
                is_asc: true,
                notable: true,
                ..Default::default()
            }),
            "asc_notable"
        );
        assert_eq!(
            k(KindFlags {
                is_asc: true,
                ..Default::default()
            }),
            "asc_small"
        );
        assert_eq!(
            k(KindFlags {
                keystone: true,
                ..Default::default()
            }),
            "keystone"
        );
        assert_eq!(k(KindFlags::default()), "small");
    }

    #[test]
    fn push_row_sanitizes_cells() {
        let mut out = String::new();
        push_row(&mut out, &["a", "b\tc", "d\ne"]);
        assert_eq!(out, "a\tb c\td e\n");
    }
}
