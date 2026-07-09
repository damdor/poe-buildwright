//! Frame-sprite name resolution + on-canvas target-size lookup per node
//! kind. The actual size table mirrors PoB (PassiveTree.lua:748-805) —
//! GGG ships nothing for this in tree.json.

use crate::model::{Node, NodeSize};

/// Pick the right frame sprite for a node based on its kind + ascendancy.
/// Returns the sprite NAME (unsanitized) which the manifest will map to a PNG.
/// `state` is one of "Unallocated", "Allocated", "CanAllocate" (non-asc)
/// or "Normal", "Allocated", "CanAllocate" (ascendancies).
/// Pick the (unallocated, allocated) frame sprite names for a node.
/// Prefers GGG's per-node nodeOverlay; falls back to kind-based synth.
pub(crate) fn pick_frame_names(n: &Node) -> (Option<String>, Option<String>) {
    // PoB View.lua:864-868 hard-codes the ascendancy-start glyph as
    // "AscendancyMiddle" regardless of which ascendancy — the
    // per-ascendancy frame sprites (e.g. PathfinderFrameLargeAllocated)
    // are for notables, NOT for the central asc-start node.
    if n.kind == "asc_start" {
        return (
            Some("AscendancyMiddle".to_string()),
            Some("AscendancyMiddle".to_string()),
        );
    }
    if !n.node_overlay.is_empty() {
        // Format: "alloc|path|unalloc"
        let parts: Vec<&str> = n.node_overlay.split('|').collect();
        if parts.len() >= 3 {
            let alloc = parts[0].trim();
            let unalloc = parts[2].trim();
            let off = if unalloc.is_empty() {
                None
            } else {
                Some(unalloc.to_string())
            };
            let on = if alloc.is_empty() {
                None
            } else {
                Some(alloc.to_string())
            };
            return (off, on);
        }
    }
    let off = frame_name(&n.kind, &n.ascendancy, false);
    let on = frame_name(&n.kind, &n.ascendancy, true);
    (off, on)
}

/// Target on-tree draw size (icon, frame) per node kind. Mirrors PoB's
/// `GetNodeTargetSize` lookup (PassiveTree.lua:748-805). GGG's tree.json
/// does NOT carry these — PoB hard-codes them based on node type. Atlas
/// pixel dimensions are unrelated to draw size (the atlas slices are
/// larger). Either value can be 0 to signal "no glyph at this layer".
///
///   Notable (tree)             icon 54  frame 80
///   Notable (ascendancy)       icon 54  frame 100
///   Keystone (tree)            icon 82  frame 120
///   Small (tree/attr/switch)   icon 37  frame 54
///   Small (ascendancy)         icon 37  frame 80
///   Jewel socket               icon 76  frame 76
///   Mastery (OnlyImage)        icon 380 frame 0    (radial pattern only)
///   AscendancyStart            icon 0   frame 50
///   ClassStart                 icon 16  frame 24
pub(crate) fn target_size(n: &Node) -> NodeSize {
    // PoB's DrawAsset (PassiveTreeView.lua:1230) doubles every asset:
    //   `DrawImage(... , x - w, y - h, w * 2, h * 2 ...)`
    // The "width" returned by GetNodeTargetSize (PassiveTree.lua:748)
    // is therefore HALF the rendered tree-coord size. We multiply by
    // 2 here so the node sizes match what shows up in-game / in PoB.
    // (Background sprites are already doubled at their callsites —
    // BGTree at 4000, class portrait at 3000 — so they were correct;
    // nodes weren't, which is why they looked ~half-size relative to
    // the central BGTree frame.)
    const S: f64 = 2.0;
    let asc = !n.ascendancy.is_empty();
    match (n.kind.as_str(), asc) {
        ("asc_start", _) => NodeSize {
            icon: 0.0,
            frame: 50.0 * S,
        },
        ("class_start", _) => NodeSize {
            icon: 37.0 * S,
            frame: 0.0,
        },
        ("mastery", _) => NodeSize {
            icon: 0.0,
            frame: 0.0,
        },
        ("jewel", _) => NodeSize {
            icon: 76.0 * S,
            frame: 76.0 * S,
        },
        ("notable", true) => NodeSize {
            icon: 54.0 * S,
            frame: 100.0 * S,
        },
        ("notable", false) => NodeSize {
            icon: 54.0 * S,
            frame: 80.0 * S,
        },
        ("keystone", true) => NodeSize {
            icon: 54.0 * S,
            frame: 100.0 * S,
        },
        ("keystone", false) => NodeSize {
            icon: 82.0 * S,
            frame: 120.0 * S,
        },
        ("asc_notable", _) => NodeSize {
            icon: 54.0 * S,
            frame: 100.0 * S,
        },
        ("asc_small", _) => NodeSize {
            icon: 37.0 * S,
            frame: 80.0 * S,
        },
        // small / attribute / switchable / multichoice / multichoice_opt
        (_, true) => NodeSize {
            icon: 37.0 * S,
            frame: 80.0 * S,
        },
        (_, false) => NodeSize {
            icon: 37.0 * S,
            frame: 54.0 * S,
        },
    }
}

/// GGG's per-ascendancy "portrait" frames — currently only Oracle's
/// Unseen-Path nodes (node_overlay `OracleFrame{Allocated|CanAllocate|
/// Unallocated}`) — are stored in the sprite atlas under a different
/// convention: `{Asc}Frame{Large|Small}{Normal|Allocated|CanAllocate}`,
/// where the size follows the node kind and `Unallocated` becomes
/// `Normal`. When the verbatim overlay name misses the atlas, this
/// returns the aliased name to try instead. Generic frames (Notable,
/// Keystone, Jewel, AscendancyFrame*) and single-size bespoke frames
/// (Blighted, JewelSocketAlt) have no Large/Small variant, so callers
/// only USE this alias when it actually resolves in the atlas.
pub(crate) fn portrait_frame_alias(name: &str, kind: &str) -> Option<String> {
    let (base, state) = if let Some(b) = name.strip_suffix("Unallocated") {
        (b, "Normal")
    } else if let Some(b) = name.strip_suffix("CanAllocate") {
        (b, "CanAllocate")
    } else if let Some(b) = name.strip_suffix("Allocated") {
        (b, "Allocated")
    } else {
        return None;
    };
    if !base.ends_with("Frame") {
        return None;
    }
    let size = match kind {
        "notable" | "keystone" | "asc_notable" => "Large",
        _ => "Small",
    };
    Some(format!("{base}{size}{state}"))
}

pub(crate) fn frame_name(kind: &str, ascendancy: &str, allocated: bool) -> Option<String> {
    let is_asc = !ascendancy.is_empty();
    let state_nonasc = if allocated {
        "Allocated"
    } else {
        "Unallocated"
    };
    let state_asc = if allocated { "Allocated" } else { "Normal" };
    Some(match (kind, is_asc) {
        ("notable", false) => format!("NotableFrame{}", state_nonasc),
        ("notable", true) => format!("{}FrameLarge{}", ascendancy, state_asc),
        ("keystone", _) => format!("KeystoneFrame{}", state_nonasc),
        ("jewel", _) => format!("JewelFrame{}", state_nonasc),
        ("asc_small", _) => format!("{}FrameSmall{}", ascendancy, state_asc),
        ("asc_notable", _) => format!("{}FrameLarge{}", ascendancy, state_asc),
        ("asc_start", _) => format!("{}FrameLarge{}", ascendancy, state_asc),
        ("small", _) => format!("PSSkillFrame{}", if allocated { "Active" } else { "" }),
        // attribute / switchable / multichoice nodes use the same frame
        // as `small` (a plain ornate ring). Previously fell into the
        // None branch → frame missing → user saw 293+ bare icons with
        // no border around the gold "+" cross. PSSkillFrame is what PoB
        // shows for these per the PassiveTree.lua frame table.
        ("attribute", _) | ("switchable", _) | ("multichoice", _) | ("multichoice_opt", _) => {
            format!("PSSkillFrame{}", if allocated { "Active" } else { "" })
        }
        _ => return None,
    })
}
