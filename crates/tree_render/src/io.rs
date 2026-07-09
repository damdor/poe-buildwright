//! TSV / sprite-manifest readers. Tree data lives in plain-text TSVs
//! shipped at data/parsed/CURRENT/tree/ — this module decodes them
//! into the structs from model.rs.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use crate::model::{Canvas, ClassInfo, Node, Portrait, Sprite};

pub(crate) fn read_sprites(path: &Path) -> Result<HashMap<String, Sprite>, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    let mut out = HashMap::new();
    for (i, line) in text.lines().enumerate() {
        if i == 0 || line.is_empty() {
            continue;
        }
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() < 4 {
            continue;
        }
        let name = cols[0].to_string();
        let png = cols[1].to_string();
        let w: u32 = cols[2].parse().unwrap_or(0);
        let h: u32 = cols[3].parse().unwrap_or(0);
        out.insert(name, Sprite { png, w, h });
    }
    Ok(out)
}

/// Resolve a sprite name. The manifest stores the original sprite_name → Sprite mapping.
pub(crate) fn sprite_lookup<'a>(
    sprites: &'a HashMap<String, Sprite>,
    name: &str,
) -> Option<&'a Sprite> {
    sprites.get(name)
}

pub(crate) fn read_nodes(path: &Path) -> Result<Vec<Node>, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    let mut out = Vec::new();
    for (lineno, line) in text.lines().enumerate() {
        if lineno == 0 || line.is_empty() {
            continue;
        }
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() < 17 {
            return Err(format!(
                "{}:{}: expected 17 columns, got {}",
                path.display(),
                lineno + 1,
                cols.len()
            ));
        }
        let id: u32 = cols[0]
            .parse()
            .map_err(|_| format!("bad id {:?}", cols[0]))?;
        let x: f64 = cols[1]
            .parse()
            .map_err(|_| format!("bad x {:?}", cols[1]))?;
        let y: f64 = cols[2]
            .parse()
            .map_err(|_| format!("bad y {:?}", cols[2]))?;
        let group: u32 = cols[8].parse().unwrap_or(0);
        let orbit: u32 = cols[9].parse().unwrap_or(0);
        let orbit_index: u32 = cols[10].parse().unwrap_or(0);
        out.push(Node {
            id,
            x,
            y,
            kind: cols[3].to_string(),
            klass: cols[4].to_string(),
            ascendancy: cols[5].to_string(),
            name: cols[6].to_string(),
            stats: cols[7].to_string(),
            group,
            orbit,
            orbit_index,
            icon: cols[11].to_string(),
            node_overlay: cols[12].to_string(),
            active_effect: cols[13].to_string(),
            node_options: cols[14].to_string(),
            connection_art: cols[15].to_string(),
            unlock_constraint: cols[16].to_string(),
            lights_mastery: Vec::new(),
            granted: Vec::new(),
        });
    }
    Ok(out)
}

/// Read the optional `tree/masteries.tsv` sidecar (trigger_id →
/// mastery_id, one row per link) into trigger → [mastery ids]. Produced
/// by `buildwright masteries`. Empty map if absent, so rendering
/// degrades gracefully when the mapping hasn't been generated.
pub(crate) fn read_masteries(path: &Path) -> HashMap<u32, Vec<u32>> {
    let Ok(text) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    let mut out: HashMap<u32, Vec<u32>> = HashMap::new();
    for line in text.lines().skip(1) {
        let mut cols = line.split('\t');
        if let (Some(t), Some(m)) = (cols.next(), cols.next())
            && let (Ok(t), Ok(m)) = (t.parse::<u32>(), m.parse::<u32>())
        {
            out.entry(t).or_default().push(m);
        }
    }
    out
}

/// Read the optional first-party skills catalogue (default
/// `../skills/active_skills.tsv` beside the tree dir) into a
/// lowercase-name → description map. Produced by the data miner's skills
/// extraction. Empty map if absent, so granted-skill tooltips degrade
/// gracefully when skills haven't been mined for this patch.
pub(crate) fn read_active_skills(path: &Path) -> HashMap<String, String> {
    let Ok(text) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    let mut out: HashMap<String, String> = HashMap::new();
    for line in text.lines().skip(1) {
        let cols: Vec<&str> = line.split('\t').collect();
        // active_skills.tsv: skill_id, name, description, ...
        if cols.len() >= 3 && !cols[1].is_empty() && !cols[2].is_empty() {
            out.insert(cols[1].to_lowercase(), cols[2].to_string());
        }
    }
    out
}

/// Read the optional first-party buffs catalogue (`../skills/buffs.tsv`)
/// into `(name_lower, display_name, raw_description)` rows. Produced by
/// `buildwright shape buffs`. Empty if absent, so granted-buff tooltips
/// degrade gracefully. Kept as a flat list (not a map) so the resolver
/// can do family matching (e.g. grant "Embankment" → "Ripwire
/// Embankment", "Artillery Embankment", …) as well as exact-name lookup.
pub(crate) fn read_buffs(path: &Path) -> Vec<(String, String, String)> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in text.lines().skip(1) {
        let cols: Vec<&str> = line.split('\t').collect();
        // buffs.tsv: buff_id, name, description
        if cols.len() >= 3 && !cols[1].is_empty() && !cols[2].is_empty() {
            out.push((cols[1].to_lowercase(), cols[1].to_string(), cols[2].to_string()));
        }
    }
    out
}

/// Read the optional `tree/asc_overrides.tsv` sidecar (variant-ascendancy
/// node content overrides — Abyssal Lich). Rows: variant, class, parent,
/// base_node_id, override_node_id, name, stats, icon, kind.
pub(crate) fn read_asc_overrides(path: &Path) -> Vec<Vec<String>> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .skip(1)
        .filter(|l| !l.is_empty())
        .map(|l| l.split('\t').map(str::to_string).collect())
        .collect()
}

/// Edge tuple: (from_id, to_id, connection_orbit).
///   orbit ==  0  → straight line
///   orbit  >  0  → arc along orbit N (clockwise per GGG convention)
///   orbit  <  0  → arc along orbit |N| (counter-clockwise)
///   orbit i32::MAX (2147483647) → hidden/proxy connection (skip rendering)
pub(crate) fn read_edges(path: &Path) -> Result<Vec<(u32, u32, i32)>, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    let mut out = Vec::new();
    for (lineno, line) in text.lines().enumerate() {
        if lineno == 0 || line.is_empty() {
            continue;
        }
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() < 3 {
            return Err(format!(
                "{}:{}: expected 3 columns",
                path.display(),
                lineno + 1
            ));
        }
        let a: u32 = cols[0].parse().map_err(|_| "bad from")?;
        let b: u32 = cols[1].parse().map_err(|_| "bad to")?;
        let orbit: i32 = cols[2].parse().unwrap_or(0);
        out.push((a, b, orbit));
    }
    Ok(out)
}

pub(crate) fn read_meta(path: &Path) -> Result<(Canvas, Vec<ClassInfo>), String> {
    let text = fs::read_to_string(path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    let mut min_x = 0.0;
    let mut max_x = 0.0;
    let mut min_y = 0.0;
    let mut max_y = 0.0;
    let mut classes = Vec::new();
    let mut orbit_radii: Vec<f64> = Vec::new();
    let mut groups: HashMap<u32, (f64, f64)> = HashMap::new();
    let mut portraits: Vec<Portrait> = Vec::new();
    let mut asc_internal: HashMap<String, (String, String)> = HashMap::new();
    for line in text.lines() {
        let mut parts = line.split('\t');
        let key = parts.next().unwrap_or("");
        match key {
            "min_x" => min_x = parts.next().unwrap_or("0").parse().unwrap_or(0.0),
            "max_x" => max_x = parts.next().unwrap_or("0").parse().unwrap_or(0.0),
            "min_y" => min_y = parts.next().unwrap_or("0").parse().unwrap_or(0.0),
            "max_y" => max_y = parts.next().unwrap_or("0").parse().unwrap_or(0.0),
            "orbit_radii" => {
                orbit_radii = parts
                    .next()
                    .unwrap_or("")
                    .split('|')
                    .filter_map(|s| s.parse().ok())
                    .collect();
            }
            "group" => {
                let gid: u32 = parts.next().unwrap_or("0").parse().unwrap_or(0);
                let gx: f64 = parts.next().unwrap_or("0").parse().unwrap_or(0.0);
                let gy: f64 = parts.next().unwrap_or("0").parse().unwrap_or(0.0);
                groups.insert(gid, (gx, gy));
            }
            "class" => {
                let name = parts.next().unwrap_or("").to_string();
                let ascs: Vec<String> = parts
                    .next()
                    .unwrap_or("")
                    .split('|')
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect();
                classes.push(ClassInfo {
                    name,
                    ascendancies: ascs,
                });
            }
            "asc_internal" => {
                let name = parts.next().unwrap_or("").to_string();
                let internal = parts.next().unwrap_or("").to_string();
                let parent = parts.next().unwrap_or("").to_string();
                if !name.is_empty() && !internal.is_empty() {
                    asc_internal.insert(name, (internal, parent));
                }
            }
            "portrait" => {
                // portrait <kind=class|asc> <name> <image> <x> <y> <w> <h>
                let kind = parts.next().unwrap_or("").to_string();
                let name = parts.next().unwrap_or("").to_string();
                let image = parts.next().unwrap_or("").to_string();
                let x: f64 = parts.next().unwrap_or("0").parse().unwrap_or(0.0);
                let y: f64 = parts.next().unwrap_or("0").parse().unwrap_or(0.0);
                let w: f64 = parts.next().unwrap_or("0").parse().unwrap_or(0.0);
                let h: f64 = parts.next().unwrap_or("0").parse().unwrap_or(0.0);
                portraits.push(Portrait {
                    kind,
                    name,
                    image,
                    x,
                    y,
                    w,
                    h,
                });
            }
            _ => {}
        }
    }
    Ok((
        Canvas {
            min_x,
            max_x,
            min_y,
            max_y,
            orbit_radii,
            groups,
            portraits,
            asc_internal,
        },
        classes,
    ))
}
