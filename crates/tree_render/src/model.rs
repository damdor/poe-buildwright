//! Shared data types: passive-tree nodes, edges, canvas/group metadata,
//! sprite manifest entries. Reads of these from disk live in `io.rs`.

use std::collections::HashMap;
use std::path::PathBuf;

pub(crate) struct Args {
    pub(crate) tree_dir: PathBuf,
    pub(crate) output: PathBuf,
    pub(crate) title: String,
    pub(crate) agent_subdir: String,
    pub(crate) game: String,
}

#[derive(Clone)]
pub(crate) struct Node {
    pub(crate) id: u32,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) kind: String,
    pub(crate) klass: String,
    pub(crate) ascendancy: String,
    pub(crate) name: String,
    pub(crate) stats: String,
    pub(crate) group: u32,
    pub(crate) orbit: u32,
    #[allow(dead_code)]
    pub(crate) orbit_index: u32,
    pub(crate) icon: String,
    /// Per-node frame override from GGG's data. Format: "alloc|path|unalloc"
    /// (split on '|'). Empty for nodes that use the top-level nodeOverlay
    /// derived from kind.
    pub(crate) node_overlay: String,
    /// Mastery's radial background pattern path (e.g.
    /// "Art/2DArt/UIImages/InGame/PassiveMastery/...").
    /// Empty for non-mastery nodes.
    pub(crate) active_effect: String,
    /// Variant manifest for isAttribute / isSwitchable nodes.
    /// Pipe-separated `Name:full/icon/path.dds` entries. Empty otherwise.
    ///   attribute: 3 entries (Strength, Dexterity, Intelligence) with icons.
    ///   switchable: 1+ entries keyed by class/ascendancy; icon may be empty
    ///     for variants that only differ in frame.
    pub(crate) node_options: String,
    /// Per-node connector-art override (PoE2 field). Currently observed
    /// values: "" (most nodes — use Character_orbit_*), "CharacterPlanned"
    /// (197 nodes — sketched/planned-edge variant). When set, the
    /// `connectionArt` prefix replaces "Character" for edges originating
    /// from this node.
    #[allow(dead_code)]
    pub(crate) connection_art: String,
    /// Unlock constraint (PoE2). Format: "<AscendancyName>:<id>,<id>,..."
    /// or empty. ~197 main-tree nodes are gated behind Oracle's "The
    /// Unseen Path" (node 5571) — they're invisible & unallocatable for
    /// any character that isn't an Oracle ascendant.
    pub(crate) unlock_constraint: String,
    /// Mastery node ids this node lights when allocated — the exact
    /// structural mapping from the `tree/masteries.tsv` sidecar
    /// (`buildwright masteries`). Empty for the ~62% of nodes that
    /// trigger no mastery. Usually one; a few boundary nodes trigger two.
    pub(crate) lights_mastery: Vec<u32>,
    /// Skills this node grants, resolved to (name, description). Parsed
    /// from the node's "Grants Skill: X" stat clauses and joined against
    /// the first-party `../skills/active_skills.tsv` catalogue. Empty for
    /// nodes that grant no skill (or whose grant isn't in the catalogue).
    /// Shown inline in the node tooltip so the reader sees what the skill
    /// does without leaving the planner.
    pub(crate) granted: Vec<(String, String)>,
}

pub(crate) struct Canvas {
    pub(crate) min_x: f64,
    pub(crate) max_x: f64,
    pub(crate) min_y: f64,
    pub(crate) max_y: f64,
    pub(crate) orbit_radii: Vec<f64>,
    pub(crate) groups: HashMap<u32, (f64, f64)>,
    /// Portraits straight from GGG's tree.json (class + ascendancy backgrounds).
    pub(crate) portraits: Vec<Portrait>,
    /// Ascendancy display name → (internalId, parent class name).
    /// internalId (e.g. "Druid1") is what the new in-game Build Planner
    /// `.build` format wants in its top-level `ascendancy` field.
    pub(crate) asc_internal: HashMap<String, (String, String)>,
    /// PoE2 native graph id → official Build Planner `PassiveSkills.Id`.
    /// Empty for PoE1 and older local datasets; strict export then reports
    /// the missing translation instead of emitting the wrong identifier.
    pub(crate) passive_build_ids: HashMap<u32, String>,
    /// "Pick one" notables: parent node id → option node ids, from the
    /// shapers' `multichoice` meta rows (derived from GGG's
    /// isMultipleChoice/-Option flags — never hardcoded per
    /// ascendancy). Options render nowhere; the planner offers them
    /// via the parent's popout at zero extra point cost.
    pub(crate) multi_choice: Vec<(String, Vec<String>)>,
}

/// Portrait sourced from tree.json `classes[i].background` or
/// `classes[i].ascendancies[j].background`. Positions and sizes are in
/// tree coordinates; the renderer places them at (x - w/2, y - h/2).
#[derive(Clone)]
pub(crate) struct Portrait {
    /// "class" or "asc"
    pub(crate) kind: String,
    /// Class or ascendancy name (e.g. "Huntress", "Amazon").
    pub(crate) name: String,
    /// Sprite-manifest key (e.g. "ClassesHuntress").
    pub(crate) image: String,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) w: f64,
    pub(crate) h: f64,
}

/// Sprite manifest entry. Width/height come from the source atlas filename
/// and (with scaleImage=1) are also the tree-coordinate render size.
#[derive(Clone)]
pub(crate) struct Sprite {
    pub(crate) png: String,
    pub(crate) w: u32,
    pub(crate) h: u32,
}

#[derive(Clone)]
pub(crate) struct ClassInfo {
    pub(crate) name: String,
    pub(crate) ascendancies: Vec<String>,
}

/// Target on-canvas pixel side of a node's frame and icon sprites.
/// Computed from the node's kind + node_overlay; passed around as a
/// pair so render code stays clear about which dimension is which.
pub(crate) struct NodeSize {
    pub(crate) icon: f64,
    pub(crate) frame: f64,
}

/// Resolved geometry for an arc edge.
pub(crate) struct ArcGeom {
    /// Orbit center (tree coords). Needed for canvas's textured-PNG
    /// rendering (PoB places the orbit PNG with its bottom-right corner
    /// at this point, then rotates around it).
    pub(crate) cx: f64,
    pub(crate) cy: f64,
    /// Arc radius (tree units), straight from `orbit_radii`.
    pub(crate) r: f64,
    /// Signed shorter-arc sweep from na to nb, in radians.
    /// Positive = CCW in math (= CW in screen y-down) → SVG sweep-flag 1.
    /// Always |sweep| ≤ π — `arc_geom_for` returns None for longer sweeps
    /// (PoB does the same per PassiveTree.lua:601).
    pub(crate) sweep: f64,
    /// Mid-arc angle (radians, math convention atan2(y-cy, x-cx)).
    /// Used by the canvas renderer to rotate the orbit PNG so its NW
    /// midpoint (baked at -3π/4) lands on the arc's middle.
    pub(crate) mid_angle: f64,
    /// Which orbit (1..9) this arc lies on. Drives the PNG choice
    /// (Character_orbit_normal{N}.png via ORBIT_TO_FILE).
    pub(crate) orbit_num: u32,
}
