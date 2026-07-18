//! Parser for GGG's **official** passive-skill-tree export — `data.json`
//! from <https://github.com/grindinggear/poe2-skilltree-export> (GGG's own
//! `grindinggear` org). This is the same source Path of Building consumes,
//! and it carries **precomputed node positions**, so it needs no orbit math
//! and no `.psg` walk — every field is in the JSON.
//!
//! It is the primary, exact tree source. The bundle-derived [`crate::psg`]
//! reader is the fallback: it's game-accurate and current the instant a
//! patch drops (before GGG updates this repo), and a `tree-diff` between the
//! two surfaces GGG's per-patch curation.
//!
//! Emits the same `tree/{nodes,edges,meta}.tsv` shape as
//! [`crate::shape::shape_tree`] so both sources feed one renderer.

use std::collections::{BTreeMap, HashSet};

use crate::shape::{ORBIT_RADII, SKILLS_PER_ORBIT, TreeTsv};

/// Art paths the JSON doesn't carry, resolved from the CDN tables and
/// passed in so this stays a pure `data.json` transform:
/// `ascendancy internal id → PassiveTreeImage .dds`.
pub type AscArt = BTreeMap<String, String>;

fn s(v: &json::Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}
fn b(v: &json::Value, k: &str) -> bool {
    v.get(k).and_then(|x| x.as_bool()).unwrap_or(false)
}
fn f(v: &json::Value, k: &str) -> Option<f64> {
    v.get(k).and_then(|x| x.as_f64())
}
fn i(v: &json::Value, k: &str) -> i64 {
    v.get(k).and_then(|x| x.as_i64()).unwrap_or(0)
}

/// GGG inline markup → plain text: `<tag>{body}` → `body`, `[a|b]` → `b`,
/// `[a]` → `a`. Newlines/tabs (literal or escaped) collapse to spaces so a
/// stat stays one TSV cell. Matches how the site shows stat lines.
fn strip_markup(s: &str) -> String {
    let s = s.replace("\\n", "; ").replace("\\t", " ");
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '<' => {
                for d in chars.by_ref() {
                    if d == '>' {
                        break;
                    }
                }
            }
            '{' | '}' => {}
            '[' => {
                let mut inner = String::new();
                for d in chars.by_ref() {
                    if d == ']' {
                        break;
                    }
                    inner.push(d);
                }
                match inner.split_once('|') {
                    Some((_, right)) => out.push_str(right),
                    None => out.push_str(&inner),
                }
            }
            // Real line breaks inside one stat (keystones especially)
            // are semantic boundaries — "…maximum Energy Shield\nEnergy
            // Shield does not Recharge" read as run-together text with a
            // plain space (fresh-agent audit). Emit "; " like the
            // between-stat separator.
            '\n' => {
                if !out.ends_with("; ") && !out.is_empty() {
                    out.push_str("; ");
                }
            }
            '\r' | '\t' => out.push(' '),
            _ => out.push(c),
        }
    }
    out
}

/// The renderer's visual kind for a node (matches `shape_tree`'s strings).
fn kind_of(n: &json::Value, has_class_start: bool) -> &'static str {
    if b(n, "isAscendancyStart") {
        "asc_start"
    } else if has_class_start {
        "class_start"
    } else if b(n, "isJewelSocket") {
        "jewel"
    } else if b(n, "isMastery") {
        "mastery"
    } else if n.get("ascendancyId").and_then(|x| x.as_str()).is_some() {
        if b(n, "isNotable") {
            "asc_notable"
        } else {
            "asc_small"
        }
    } else if b(n, "isKeystone") {
        "keystone"
    } else if b(n, "isNotable") {
        "notable"
    } else if b(n, "isGenericAttribute") {
        "attribute"
    } else if b(n, "isMultipleChoice") {
        // PoE2 multi-choice parent (Gemling Legionnaire's node, Path Seeker…)
        "multichoice"
    } else if b(n, "isMultipleChoiceOption") {
        "multichoice_opt"
    } else {
        "small"
    }
}

/// Build a node's `node_overlay` frame-set ("alloc|path|unalloc"),
/// matching `passivetree_ggg.lua`: ascendancy nodes get the ascendancy
/// frame (or the alt jewel-socket frame), blighted mains the blighted
/// frame, and an unlock-gated node the Oracle frame (which overrides).
fn node_overlay(n: &json::Value, is_ascendancy: bool, has_unlock: bool) -> String {
    if has_unlock && !b(n, "isMastery") {
        return "OracleFrameAllocated|OracleFrameCanAllocate|OracleFrameUnallocated".into();
    }
    if is_ascendancy {
        return if b(n, "isJewelSocket") {
            "JewelSocketAltActive|JewelSocketAltCanAllocate|JewelSocketAltNormal".into()
        } else {
            let t = if b(n, "isNotable") { "Notable" } else { "Normal" };
            format!(
                "AscendancyFrame{t}Allocated|AscendancyFrame{t}CanAllocate|AscendancyFrame{t}Unallocated"
            )
        };
    }
    if b(n, "isBlighted") {
        return "BlightedNotableFrameAllocated|BlightedNotableFrameCanAllocate|BlightedNotableFrameUnallocated".into();
    }
    String::new()
}

fn push(out: &mut String, fields: &[&str]) {
    out.push_str(&fields.join("\t"));
    out.push('\n');
}

/// Parse a decoded `data.json` into the tree TSVs. `asc_art` supplies the
/// per-ascendancy backdrop `.dds` (resolved from the `Ascendancy` table),
/// since the JSON references only sprite-sheet keys.
pub fn shape_tree_json(data: &json::Value, asc_art: &AscArt) -> Result<TreeTsv, String> {
    let classes = data
        .get("classes")
        .and_then(|c| c.as_array())
        .ok_or("data.json: no classes array")?;
    let groups = data
        .get("groups")
        .and_then(|g| g.as_object())
        .ok_or("data.json: no groups object")?;
    let nodes = data
        .get("nodes")
        .and_then(|n| n.as_object())
        .ok_or("data.json: no nodes object")?;

    // Valid PoE2 ascendancies: those defined on a class that has any (the
    // legacy PoE1 classes carry an empty `ascendancies` list, so their nodes
    // filter out). id → (display name, class name).
    // id → (display name, class name, panel offsetX, offsetY). The offset
    // positions the backdrop relative to the ascendancy's node cluster.
    let mut valid_asc: BTreeMap<String, (String, String, f64, f64)> = BTreeMap::new();
    for c in classes {
        let cname = s(c, "name");
        let ascs = c.get("ascendancies").and_then(|a| a.as_array());
        for a in ascs.into_iter().flatten() {
            // `None`/nameless ascendancy slots (deprecated) are skipped.
            let (Some(id), Some(name)) = (
                a.get("id").and_then(|x| x.as_str()),
                a.get("name").and_then(|x| x.as_str()),
            ) else {
                continue;
            };
            let ox = f(a, "offsetX").unwrap_or(0.0);
            let oy = f(a, "offsetY").unwrap_or(0.0);
            valid_asc.insert(id.to_string(), (name.to_string(), cname.clone(), ox, oy));
        }
    }

    // First pass: decide which nodes survive (drop legacy-ascendancy nodes),
    // mapping data.json key → numeric skill id.
    let mut keep: HashSet<i64> = HashSet::new();
    let mut node_by_id: BTreeMap<i64, &json::Value> = BTreeMap::new();
    for (key, n) in nodes {
        if key == "root" {
            continue;
        }
        let Ok(id) = key.parse::<i64>() else { continue };
        let asc = n.get("ascendancyId").and_then(|x| x.as_str());
        if let Some(a) = asc
            && !valid_asc.contains_key(a)
        {
            continue; // legacy / unshipped ascendancy
        }
        keep.insert(id);
        node_by_id.insert(id, n);
    }

    // ---- nodes.tsv ----
    let mut out_nodes = String::from(
        "id\tx\ty\tkind\tklass\tascendancy\tname\tstats\tgroup\torbit\t\
         orbit_index\ticon\tnode_overlay\tactive_effect\tnode_options\t\
         connection_art\tunlock_constraint\n",
    );
    // id → (kind, ascendancy) for the edge filters below.
    let mut meta_by_id: BTreeMap<i64, (&'static str, String)> = BTreeMap::new();
    // Main-tree extents (ascendancy nodes excluded). data.json's own
    // min/max envelope includes the PARKED ascendancy cluster (x ≈
    // -22597) that we never draw in place — trusting it made fit-to-view
    // shrink the tree to ~57% of the viewport. Track the drawable
    // extents ourselves.
    let (mut mn_x, mut mx_x) = (f64::MAX, f64::MIN);
    let (mut mn_y, mut mx_y) = (f64::MAX, f64::MIN);
    for (&id, n) in &node_by_id {
        let x = f(n, "x").unwrap_or(0.0);
        let y = f(n, "y").unwrap_or(0.0);
        // `classStartIndex` is an array (a hub serves a PoE1+PoE2 class
        // pair, e.g. [0,6]); each index selects a class from `classes`.
        let class_start: Vec<usize> = n
            .get("classStartIndex")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_i64()).map(|i| i as usize).collect())
            .unwrap_or_default();
        let kind = kind_of(n, !class_start.is_empty());
        // Emit the ascendancy DISPLAY NAME (Infernalist), not the id
        // (Witch1): the renderer keys asc panels + node membership by name
        // (TREE.asc_panels[n.a], state.asc === n.a). With the id they never
        // match their panel and the ascendancy nodes stay invisible.
        let ascendancy = n
            .get("ascendancyId")
            .and_then(|x| x.as_str())
            .and_then(|aid| valid_asc.get(aid).map(|(nm, ..)| nm.clone()))
            .unwrap_or_default();
        meta_by_id.insert(id, (kind, ascendancy.clone()));
        if ascendancy.is_empty() {
            mn_x = mn_x.min(x);
            mx_x = mx_x.max(x);
            mn_y = mn_y.min(y);
            mx_y = mx_y.max(y);
        }
        let klass = class_start
            .iter()
            .filter_map(|&ci| classes.get(ci).map(|c| s(c, "name")))
            .collect::<Vec<_>>()
            .join("|");
        let name = s(n, "name");
        // data.json stats are already display strings — strip GGG markup.
        let stats = n
            .get("stats")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|st| st.as_str())
                    .map(strip_markup)
                    .collect::<Vec<_>>()
                    .join("; ")
            })
            .unwrap_or_default();
        let icon = s(n, "icon");
        let active = s(n, "activeEffectImage");

        // --- rich per-node fields (replicating passivetree_ggg.lua) ---
        let uc = n.get("unlockConstraint").filter(|u| u.is_object());
        let overlay = node_overlay(n, !ascendancy.is_empty(), uc.is_some());
        // node_options: the Str/Dex/Int choice manifest for attribute nodes,
        // built from the top-level skillOverrides (Name:Icon:VariantId).
        let options = if b(n, "isGenericAttribute") {
            ["26297", "14927", "57022"]
                .iter()
                .filter_map(|oid| {
                    let o = data.get("skillOverrides").and_then(|so| so.get(oid))?;
                    let (nm, ic) = (s(o, "name"), s(o, "icon"));
                    (!nm.is_empty() && !ic.is_empty()).then(|| format!("{nm}:{ic}:{oid}"))
                })
                .collect::<Vec<_>>()
                .join("|")
        } else {
            String::new()
        };
        // Oracle-style asc-gated mains: connectionArt + "AscName:id1,id2".
        let (conn_art, unlock) = match uc {
            Some(u) => {
                let asc_id = u.get("ascendancy").and_then(|a| a.as_str()).unwrap_or("");
                let asc_name = valid_asc.get(asc_id).map(|(nm, ..)| nm.as_str()).unwrap_or(asc_id);
                let ids = u
                    .get("nodes")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_i64())
                            .map(|i| i.to_string())
                            .collect::<Vec<_>>()
                            .join(",")
                    })
                    .unwrap_or_default();
                ("CharacterPlanned".to_string(), format!("{asc_name}:{ids}"))
            }
            None => (String::new(), String::new()),
        };

        let ids = id.to_string();
        let xs = format!("{x:.2}");
        let ys = format!("{y:.2}");
        let gr = i(n, "group").to_string();
        let orb = i(n, "orbit").to_string();
        let oi = i(n, "orbitIndex").to_string();
        push(
            &mut out_nodes,
            &[
                &ids, &xs, &ys, kind, &klass, &ascendancy, &name, &stats, &gr, &orb, &oi, &icon,
                &overlay, &active, &options, &conn_art, &unlock,
            ],
        );
    }

    // ---- edges.tsv ---- from data.json `edges`. `orbit` present ⇒ arc:
    // signed by the from→to sweep direction about (orbitX,orbitY); absent ⇒
    // straight (0). Skip edges incident to dropped/`root` nodes.
    let mut out_edges = String::from("from\tto\torbit\n");
    let mut seen: HashSet<(i64, i64)> = HashSet::new();
    if let Some(edges) = data.get("edges").and_then(|e| e.as_array()) {
        for e in edges {
            let (Some(from), Some(to)) = (edge_id(e, "from"), edge_id(e, "to")) else {
                continue;
            };
            if from == 0 || to == 0 || !keep.contains(&from) || !keep.contains(&to) {
                continue;
            }
            // Drop cross-ascendancy boundary edges: an ascendancy node is
            // parked far out in the raw export, so a boundary edge to the
            // main tree would draw a line spanning the whole view (the asc
            // panel renders within-ascendancy edges). Mastery edges are
            // KEPT here — `buildwright masteries` derives the lighting map
            // from them; the renderer (emit.rs) skips them from the visual.
            let aa = meta_by_id.get(&from).map(|(_, a)| a.as_str()).unwrap_or("");
            let ab = meta_by_id.get(&to).map(|(_, a)| a.as_str()).unwrap_or("");
            if aa != ab {
                continue;
            }
            let key = (from.min(to), from.max(to));
            if !seen.insert(key) {
                continue;
            }
            let orbit = arc_orbit(e, node_by_id.get(&from), node_by_id.get(&to));
            push(
                &mut out_edges,
                &[&from.to_string(), &to.to_string(), &orbit.to_string()],
            );
        }
    }

    // ---- meta.tsv ----
    // Canvas bounds = computed main-tree extents plus a small margin so
    // node frames at the rim aren't clipped at fit zoom. Falls back to
    // data.json's envelope only if we somehow saw no main-tree nodes.
    let mut out_meta = String::new();
    if mn_x <= mx_x && mn_y <= mx_y {
        const MARGIN: f64 = 250.0; // ~one notable frame beyond the last node centre
        for (v, key) in [
            (mn_x - MARGIN, "min_x"),
            (mx_x + MARGIN, "max_x"),
            (mn_y - MARGIN, "min_y"),
            (mx_y + MARGIN, "max_y"),
        ] {
            out_meta.push_str(&format!("{key}\t{v:.4}\n"));
        }
    } else {
        for (k, key) in [
            (data.get("min_x"), "min_x"),
            (data.get("max_x"), "max_x"),
            (data.get("min_y"), "min_y"),
            (data.get("max_y"), "max_y"),
        ] {
            if let Some(v) = k.and_then(|x| x.as_f64()) {
                out_meta.push_str(&format!("{key}\t{v:.4}\n"));
            }
        }
    }
    out_meta.push_str(&format!(
        "orbit_radii\t{}\n",
        ORBIT_RADII
            .iter()
            .map(|r| (*r as i64).to_string())
            .collect::<Vec<_>>()
            .join("|")
    ));
    out_meta.push_str(&format!(
        "skills_per_orbit\t{}\n",
        SKILLS_PER_ORBIT
            .iter()
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join("|")
    ));
    // group centres.
    let mut gids: Vec<i64> = groups.keys().filter_map(|k| k.parse().ok()).collect();
    gids.sort_unstable();
    for gid in gids {
        if let Some(g) = groups.get(&gid.to_string()) {
            let gx = f(g, "x").unwrap_or(0.0);
            let gy = f(g, "y").unwrap_or(0.0);
            out_meta.push_str(&format!("group\t{gid}\t{gx:.4}\t{gy:.4}\n"));
        }
    }
    // classes + ascendancies (valid only), with backdrop art.
    for c in classes {
        let cname = s(c, "name");
        let ascs: Vec<String> = c
            .get("ascendancies")
            .and_then(|a| a.as_array())
            .into_iter()
            .flatten()
            .filter_map(|a| a.get("name").and_then(|x| x.as_str()).map(String::from))
            .collect();
        if ascs.is_empty() {
            continue; // legacy class with no ascendancies
        }
        out_meta.push_str(&format!("class\t{cname}\t{}\n", ascs.join("|")));
    }
    // asc_internal <name> <id> <class> <image> <offsetX> <offsetY> — the
    // offset positions the backdrop relative to the node cluster (sprites
    // anchors the panel at centroid + offset). io.rs ignores extra fields.
    for (id, (name, class, ox, oy)) in &valid_asc {
        let img = asc_art.get(id).cloned().unwrap_or_default();
        out_meta.push_str(&format!(
            "asc_internal\t{name}\t{id}\t{class}\t{img}\t{ox:.2}\t{oy:.2}\n"
        ));
    }

    Ok(TreeTsv {
        nodes: out_nodes,
        edges: out_edges,
        meta: out_meta,
    })
}

/// Resolve an edge endpoint: `"root"` → 0, else numeric.
fn edge_id(e: &json::Value, k: &str) -> Option<i64> {
    match e.get(k) {
        Some(json::Value::Str(s)) if s == "root" => Some(0),
        Some(json::Value::Str(s)) => s.parse().ok(),
        Some(v) => v.as_i64(),
        None => None,
    }
}

/// Renderer connection orbit, matching PoB's `passivetree_ggg.lua` exactly:
/// * no `orbit` field ⇒ 0 (straight line)
/// * `orbit == 0` and no `orbitX/orbitY` ⇒ i32::MAX (hidden/proxy)
/// * otherwise ⇒ `(orbit + 1) * arcDirection`
///
/// where the radius index is `orbit + 1` (GGG stores it one less) and
/// `arcDirection` is `cross > 0 ? -1 : 1` for the from→target sweep about
/// the arc centre. The (a,b) order MUST be source→target (data.json lists
/// each edge once, from the owner) so this sign lands the arc on the right
/// side of the chord.
fn arc_orbit(e: &json::Value, from: Option<&&json::Value>, to: Option<&&json::Value>) -> i32 {
    let Some(orbit) = e.get("orbit").and_then(|x| x.as_i64()) else {
        return 0; // straight line
    };
    let has_center = e.get("orbitX").is_some() || e.get("orbitY").is_some();
    if orbit == 0 && !has_center {
        return i32::MAX; // hidden / proxy connection
    }
    let (ocx, ocy) = (f(e, "orbitX").unwrap_or(0.0), f(e, "orbitY").unwrap_or(0.0));
    let dir = match (from, to) {
        (Some(fr), Some(t)) => {
            let (fx, fy) = (f(fr, "x").unwrap_or(0.0), f(fr, "y").unwrap_or(0.0));
            let (tx, ty) = (f(t, "x").unwrap_or(0.0), f(t, "y").unwrap_or(0.0));
            let cross = (fx - ocx) * (ty - ocy) - (fy - ocy) * (tx - ocx);
            if cross > 0.0 { -1 } else { 1 }
        }
        _ => 1,
    };
    dir * (orbit as i32 + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_ggg_markup() {
        assert_eq!(
            strip_markup("Grants Skill: <underline>{Fire Spell on Hit}"),
            "Grants Skill: Fire Spell on Hit"
        );
        assert_eq!(strip_markup("[Physical|Physical] Damage"), "Physical Damage");
    }

    #[test]
    fn parses_minimal_tree() {
        let src = r#"{
          "classes":[{"name":"Witch","ascendancies":[{"id":"Witch1","name":"Infernalist"}]},
                     {"name":"Marauder","ascendancies":[]}],
          "groups":{"1":{"x":10.0,"y":20.0}},
          "nodes":{
            "root":{"id":"root"},
            "100":{"skill":100,"name":"Life","stats":["+10 to <size:20>{maximum Life}"],"group":1,"orbit":2,"orbitIndex":3,"x":42.0,"y":-5.0,"isNotable":true,"icon":"a.png"},
            "200":{"skill":200,"name":"Legacy","ascendancyId":"Marauder1","group":1,"orbit":0,"orbitIndex":0,"x":0.0,"y":0.0},
            "300":{"skill":300,"name":"Flame","ascendancyId":"Witch1","group":1,"orbit":1,"orbitIndex":0,"x":1.0,"y":2.0,"isNotable":true},
            "400":{"skill":400,"name":"Life Mastery","isMastery":true,"group":1,"orbit":0,"orbitIndex":0,"x":40.0,"y":-4.0},
            "500":{"skill":500,"name":"More Life","group":1,"orbit":2,"orbitIndex":6,"x":50.0,"y":-6.0}
          },
          "edges":[{"from":"100","to":"500"},{"from":"100","to":"300"},{"from":"100","to":"400"}],
          "min_x":-100,"max_x":100,"min_y":-100,"max_y":100
        }"#;
        let data = json::parse(src).unwrap();
        let art = AscArt::new();
        let t = shape_tree_json(&data, &art).unwrap();
        // node 200 (legacy Marauder ascendancy) is dropped; the rest kept.
        let ids: Vec<&str> = t.nodes.lines().skip(1).map(|l| l.split('\t').next().unwrap()).collect();
        assert_eq!(ids, vec!["100", "300", "400", "500"]);
        assert!(t.nodes.contains("+10 to maximum Life")); // markup stripped
        assert!(t.nodes.contains("\tnotable\t"));
        assert!(t.nodes.contains("\tasc_notable\t"));
        // Main→main + mastery edges kept (masteries.tsv derives from them);
        // cross-ascendancy dropped. The renderer skips mastery edges visually.
        assert!(t.edges.contains("100\t500\t0"));
        assert!(t.edges.contains("100\t400")); // →mastery kept for derivation
        assert!(!t.edges.contains("100\t300")); // main→ascendancy dropped
        // meta: valid class + ascendancy, legacy Marauder class dropped.
        assert!(t.meta.contains("class\tWitch\tInfernalist"));
        assert!(!t.meta.contains("Marauder"));
        assert!(t.meta.contains("asc_internal\tInfernalist\tWitch1\tWitch"));
    }
}
