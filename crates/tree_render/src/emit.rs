//! Tree-data JSON serialization + the canvas HTML emitter. The output
//! is a single self-contained .html file: a window.TREE blob followed
//! by the bundled planner JS (sourced from assets/planner.js).

use std::collections::HashMap;
use std::fmt::Write as _;

use crate::frames::{pick_frame_names, portrait_frame_alias, target_size};
use crate::geom::{arc_geom_for, edge_path_piece};
use crate::io::sprite_lookup;
use crate::model::{Canvas, ClassInfo, Node, Sprite};
use crate::text::{escape_html, json_str, parse_node_options};

/// Resolve a frame sprite NAME to its `/assets/sprites/...` URL. Tries
/// the verbatim overlay name first; if the atlas lacks it, falls back to
/// the per-ascendancy portrait-frame alias (e.g. `OracleFrameUnallocated`
/// → `OracleFrameLargeNormal`). Returns None if neither resolves, so
/// bespoke frames GGG hasn't shipped sprites for (Blighted, JewelSocketAlt)
/// simply draw no frame rather than a broken one.
fn resolve_frame_url(
    sprites: &HashMap<String, Sprite>,
    name: &str,
    kind: &str,
) -> Option<String> {
    if let Some(s) = sprite_lookup(sprites, name) {
        return Some(format!("/assets/sprites/{}", s.png));
    }
    if let Some(alias) = portrait_frame_alias(name, kind) {
        if let Some(s) = sprite_lookup(sprites, &alias) {
            return Some(format!("/assets/sprites/{}", s.png));
        }
    }
    None
}

pub(crate) fn build_meta_json(
    classes: &[ClassInfo],
    canvas: &Canvas,
    patch: &str,
    source: &str,
    sprites: &HashMap<String, Sprite>,
) -> String {
    let mut out = String::with_capacity(2048);
    out.push('{');
    out.push_str(r#""schema_version":1"#);
    // Patch label sourced from data/parsed/<patch>/manifest.json. Empty
    // string when the data dir didn't carry a manifest — wizard treats
    // that as "unknown patch" and doesn't render the version badge.
    let _ = write!(out, r#","patch":{}"#, json_str(patch));
    // Source family: "pob2-stable" for authoritative PoB2-extracted
    // data, "pob2-preview"/"poedb2-preview" for preview-period overlays.
    // The wizard surfaces a "preview" label on the badge if this is
    // anything other than the stable source.
    let _ = write!(out, r#","source":{}"#, json_str(source));
    out.push_str(r#","classes":["#);
    let mut first_c = true;
    for c in classes {
        if !first_c {
            out.push(',');
        }
        first_c = false;
        let _ = write!(out, r#"{{"name":{},"ascendancies":["#, json_str(&c.name));
        let mut first_a = true;
        for a in &c.ascendancies {
            if !first_a {
                out.push(',');
            }
            first_a = false;
            // Each ascendancy as { name, internal } — pulled from the
            // asc_internal map in meta.tsv (buildwright shape tree).
            let internal = canvas
                .asc_internal
                .get(a)
                .map(|(i, _)| i.as_str())
                .unwrap_or("");
            let _ = write!(
                out,
                r#"{{"name":{},"internal":{}}}"#,
                json_str(a),
                json_str(internal),
            );
        }
        out.push_str("]}");
    }
    out.push(']');
    // Portrait art for the index page's saved-build cards: the round
    // FACE portraits the game uses socially (Face<Name>, extracted by
    // the sprites command from uiimages/common) for both classes and
    // ascendancies, falling back to the big illustration art.
    out.push_str(r#","portraits":{"#);
    let mut first_p = true;
    for p in &canvas.portraits {
        let face_key = format!(
            "Face{}",
            p.name
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .collect::<String>()
        );
        let sp = sprite_lookup(sprites, &face_key)
            .or_else(|| sprite_lookup(sprites, &p.image));
        let Some(sp) = sp else {
            continue;
        };
        if !first_p {
            out.push(',');
        }
        first_p = false;
        let _ = write!(
            out,
            "{}:{}",
            json_str(&p.name),
            json_str(&format!("/assets/sprites/{}", sp.png)),
        );
    }
    out.push('}');
    out.push('}');
    out
}

pub(crate) fn build_tree_data(
    nodes: &[Node],
    edges: &[(u32, u32, i32)],
    canvas: &Canvas,
    classes: &[ClassInfo],
    sprites: &HashMap<String, Sprite>,
    asc_overrides: &[Vec<String>],
) -> String {
    let mut node_idx: HashMap<u32, &Node> = HashMap::new();
    for n in nodes {
        node_idx.insert(n.id, n);
    }

    let mut out = String::with_capacity(2 * 1024 * 1024);
    out.push('{');

    // bounds
    let _ = write!(
        out,
        r#""bounds":{{"x":{},"y":{},"w":{},"h":{}}}"#,
        canvas.min_x as i64,
        canvas.min_y as i64,
        (canvas.max_x - canvas.min_x) as i64,
        (canvas.max_y - canvas.min_y) as i64,
    );

    // Static layer asset URLs.
    if let Some(sp) = sprite_lookup(sprites, "Background2") {
        let _ = write!(
            out,
            r#","bg_tile":{}"#,
            json_str(&format!("/assets/sprites/{}", sp.png))
        );
    }
    if let Some(sp) = sprite_lookup(sprites, "BGTree") {
        let _ = write!(
            out,
            r#","bgtree":{}"#,
            json_str(&format!("/assets/sprites/{}", sp.png))
        );
    }
    if let Some(sp) = sprite_lookup(sprites, "BGTreeActive") {
        let _ = write!(
            out,
            r#","bgtree_active":{}"#,
            json_str(&format!("/assets/sprites/{}", sp.png))
        );
    }

    // Main-tree edge path (single concatenated SVG-path-data string,
    // used as a fallback flat-stroke renderer + for the gold selection
    // overlay) PLUS per-edge metadata for the textured-PNG renderer.
    //
    // edges_meta entries are compact tuples:
    //   ["a", a_id, b_id, cx, cy, mid_angle_rad, orbit_num, asc?]  (arc)
    //   ["l", a_id, b_id, mid_x, mid_y, dist, angle_rad, asc?]      (line)
    // asc is the ascendancy name when both endpoints are in an asc
    // panel (so JS can apply the panel's translate), empty otherwise.
    let mut main_d = String::new();
    let mut edges_for_sel = String::with_capacity(edges.len() * 60);
    let mut edges_meta = String::with_capacity(edges.len() * 80);
    edges_for_sel.push('[');
    edges_meta.push('[');
    let mut first_e = true;
    let mut first_m = true;
    let mut asc_edges: HashMap<String, String> = HashMap::new();
    for (a, b, orbit) in edges {
        let (Some(na), Some(nb)) = (node_idx.get(a), node_idx.get(b)) else {
            continue;
        };
        // Class-start hubs (Templar|Druid, Witch|Sorceress, etc.) are
        // visual anchors covered by the BGTreeActive sprite; their
        // edges to the first ring of small nodes are dropped from
        // every RENDERING path so the central wedge stays clean. We
        // still emit them into edges_for_sel so the JS adjacency
        // graph can pathfind from the class hub — without that, no
        // node in the tree is reachable from the player's start.
        let is_class_start_edge = na.kind == "class_start" || nb.kind == "class_start";
        if is_class_start_edge {
            if !first_e {
                edges_for_sel.push(',');
            }
            first_e = false;
            // The third element (path piece) is unused by the WebGL
            // renderer; we emit an empty string for class-start edges
            // so JS still sees the [a, b, _] tuple and adds adjacency.
            let _ = write!(edges_for_sel, r#"[{a},{b},""]"#);
            continue;
        }
        // Masteries connect structurally — those edges are what
        // `buildwright masteries` reads to derive the trigger→mastery
        // lighting map (tree/masteries.tsv) — but they draw NO visible
        // connector and aren't pathfinding nodes, so skip them from every
        // render/adjacency path here. (The data layer keeps them.)
        if na.kind == "mastery" || nb.kind == "mastery" {
            continue;
        }
        // Don't skip orbit==i32::MAX — PoB draws those as straight lines
        // (BuildConnector falls through both arc branches to line 660).
        // Previously skipping them left 124 nodes visually disconnected
        // (Deep Freeze, Nurturing Guardian, and many more).
        let piece = edge_path_piece(na, nb, *orbit, canvas);
        if piece.is_empty() {
            continue;
        }
        if !first_e {
            edges_for_sel.push(',');
        }
        first_e = false;
        let _ = write!(
            edges_for_sel,
            r#"[{a},{b},{piece}]"#,
            piece = json_str(&piece)
        );
        if na.ascendancy.is_empty() && nb.ascendancy.is_empty() {
            main_d.push_str(&piece);
        } else if !na.ascendancy.is_empty() && na.ascendancy == nb.ascendancy {
            asc_edges
                .entry(na.ascendancy.clone())
                .or_default()
                .push_str(&piece);
        }
        // Per-edge geometry record for the textured renderer.
        if !first_m {
            edges_meta.push(',');
        }
        first_m = false;
        let asc_s = if !na.ascendancy.is_empty() && na.ascendancy == nb.ascendancy {
            json_str(&na.ascendancy)
        } else {
            "\"\"".to_string()
        };
        if let Some(g) = arc_geom_for(na, nb, *orbit, canvas) {
            let _ = write!(
                edges_meta,
                r#"["a",{a},{b},{cx:.1},{cy:.1},{ma:.4},{on},{asc}]"#,
                cx = g.cx,
                cy = g.cy,
                ma = g.mid_angle,
                on = g.orbit_num,
                asc = asc_s,
            );
        } else {
            // Straight line.
            let dx = nb.x - na.x;
            let dy = nb.y - na.y;
            let dist = (dx * dx + dy * dy).sqrt();
            let mx = (na.x + nb.x) / 2.0;
            let my = (na.y + nb.y) / 2.0;
            let angle = dy.atan2(dx);
            let _ = write!(
                edges_meta,
                r#"["l",{a},{b},{mx:.1},{my:.1},{d:.1},{ang:.4},{asc}]"#,
                mx = mx,
                my = my,
                d = dist,
                ang = angle,
                asc = asc_s,
            );
        }
    }
    edges_for_sel.push(']');
    edges_meta.push(']');
    let _ = write!(out, r#","edges_main":{}"#, json_str(&main_d));
    out.push_str(r#","edges_asc":{"#);
    let mut first_a = true;
    for (asc, d) in &asc_edges {
        if !first_a {
            out.push(',');
        }
        first_a = false;
        let _ = write!(out, "{}:{}", json_str(asc), json_str(d));
    }
    out.push('}');
    let _ = write!(out, r#","edges_for_sel":{}"#, edges_for_sel);
    let _ = write!(out, r#","edges_meta":{}"#, edges_meta);
    // Orbit radii so JS can size the arc PNG correctly per orbit.
    out.push_str(r#","orbit_radii":["#);
    for (i, r) in canvas.orbit_radii.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        let _ = write!(out, "{}", *r as i32);
    }
    out.push(']');

    // Nodes — one entry per id with everything the renderer needs.
    out.push_str(r#","nodes":{"#);
    let mut first_n = true;
    for n in nodes {
        if !first_n {
            out.push(',');
        }
        first_n = false;
        let ts = target_size(n);
        let icon_url =
            sprite_lookup(sprites, &n.icon).map(|s| format!("/assets/sprites/{}", s.png));
        let (off_name, on_name) = pick_frame_names(n);
        let frame_off_url = off_name
            .as_ref()
            .and_then(|nm| resolve_frame_url(sprites, nm, &n.kind));
        let frame_on_url = on_name
            .as_ref()
            .and_then(|nm| resolve_frame_url(sprites, nm, &n.kind));
        let mastery_sp = if !n.active_effect.is_empty() {
            sprite_lookup(sprites, &n.active_effect)
        } else {
            None
        };
        let _ = write!(
            out,
            r#""{}":{{"x":{},"y":{},"k":{},"iw":{},"fw":{},"g":{}"#,
            n.id,
            n.x as i32,
            n.y as i32,
            json_str(&n.kind),
            ts.icon as u32,
            ts.frame as u32,
            n.group,
        );
        // Masteries this node lights when allocated (exact structural
        // map; masteries.tsv sidecar). The planner lights these on
        // allocation instead of guessing by proximity.
        if !n.lights_mastery.is_empty() {
            out.push_str(r#","lm":["#);
            for (i, m) in n.lights_mastery.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                let _ = write!(out, "{m}");
            }
            out.push(']');
        }
        if !n.name.is_empty() {
            let _ = write!(out, r#","n":{}"#, json_str(&n.name));
        }
        if !n.ascendancy.is_empty() {
            let _ = write!(out, r#","a":{}"#, json_str(&n.ascendancy));
        }
        // Per-node connection_art override (e.g. "CharacterPlanned").
        // Only emitted when non-empty AND non-default; the renderer
        // falls back to "Character" / "CharacterAscendancy" otherwise.
        if !n.connection_art.is_empty() && n.connection_art != "Character" {
            let _ = write!(out, r#","ca":{}"#, json_str(&n.connection_art));
        }
        // Unlock constraint: "Oracle:5571" → {"a":"Oracle","n":["5571"]}.
        // Renderer skips constrained nodes in hover / search / paths
        // unless state.asc matches uc.a — see isLocked() in the embedded
        // JS. Empty for the ~99% of nodes with no constraint.
        if !n.unlock_constraint.is_empty() {
            if let Some((asc, ids_csv)) = n.unlock_constraint.split_once(':') {
                let _ = write!(out, r#","uc":{{"a":{},"n":["#, json_str(asc));
                let mut first_uc = true;
                for id_part in ids_csv.split(',').filter(|s| !s.is_empty()) {
                    if !first_uc {
                        out.push(',');
                    }
                    first_uc = false;
                    let _ = write!(out, "{}", json_str(id_part));
                }
                out.push_str("]}");
            }
        }
        if !n.stats.is_empty() {
            let _ = write!(out, r#","s":{}"#, json_str(&n.stats));
        }
        // Granted skills resolved to (name, description) — shown inline in
        // the tooltip so the reader sees what an ascendancy-granted skill
        // does. `[{"n":..,"d":..}]`.
        if !n.granted.is_empty() {
            out.push_str(r#","gs":["#);
            for (i, (nm, desc)) in n.granted.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                let _ = write!(out, r#"{{"n":{},"d":{}}}"#, json_str(nm), json_str(desc));
            }
            out.push(']');
        }
        if !n.klass.is_empty() {
            let _ = write!(out, r#","kl":{}"#, json_str(&n.klass));
        }
        if let Some(u) = icon_url {
            let _ = write!(out, r#","i":{}"#, json_str(&u));
        }
        if let Some(u) = frame_off_url {
            let _ = write!(out, r#","f0":{}"#, json_str(&u));
        }
        if let Some(u) = frame_on_url {
            let _ = write!(out, r#","f1":{}"#, json_str(&u));
        }
        if let Some(eff) = mastery_sp {
            // Mastery effect is drawn at 380×380 per PoB (PassiveTree.lua:780).
            // We pre-scale aspect from native atlas dims.
            let target = 760.0_f64; // PoB 380 * DrawAsset doubling
            let aw = eff.w.max(1) as f64;
            let ah = eff.h.max(1) as f64;
            let scale = target / aw.max(ah);
            let dw = (aw * scale) as i32;
            let dh = (ah * scale) as i32;
            let _ = write!(
                out,
                r#","me":{},"mw":{},"mh":{}"#,
                json_str(&format!("/assets/sprites/{}", eff.png)),
                dw,
                dh,
            );
        }
        if n.kind == "attribute" {
            let opts = parse_node_options(&n.node_options);
            if !opts.is_empty() {
                // CRITICAL: the comma-separator flag must only flip on
                // actually-emitted entries. If we flipped it before the
                // sprite_lookup guard and the lookup failed, we'd emit a
                // leading/trailing comma (e.g. `[,{...}]`) which JS
                // parses as `[undefined, {...}]`. Downstream code then
                // does `o.i` on the undefined slot and the page dies
                // before the boot promise resolves — manifesting as a
                // permanent "Loading sprites…" overlay. Bit us in the
                // 0.5 rollout when some attribute icons weren't in the
                // 0.4-era sprite atlas.
                out.push_str(r#","o":["#);
                let mut first_o = true;
                for (name, ipath, variant_id) in opts.iter().take(3) {
                    let Some(sp) = sprite_lookup(sprites, ipath) else {
                        continue;
                    };
                    if !first_o {
                        out.push(',');
                    }
                    first_o = false;
                    // Per-option entry: {n, i, id?}. `id` is the variant's
                    // own passive id (Str / Dex / Int distinct ids), which
                    // is what the in-game .build format references when
                    // the attribute node is allocated with a specific
                    // variant picked. Parent node id is just UI grouping.
                    let _ = write!(
                        out,
                        r#"{{"n":{},"i":{}"#,
                        json_str(name),
                        json_str(&format!("/assets/sprites/{}", sp.png)),
                    );
                    if !variant_id.is_empty() {
                        let _ = write!(out, r#","id":{}"#, json_str(variant_id));
                    }
                    out.push('}');
                }
                out.push(']');
            }
        }
        out.push('}');
    }
    out.push('}');

    // Class portraits.
    out.push_str(r#","class_portraits":{"#);
    let mut first_p = true;
    for p in &canvas.portraits {
        if p.kind != "class" {
            continue;
        }
        let Some(sp) = sprite_lookup(sprites, &p.image) else {
            continue;
        };
        if !first_p {
            out.push(',');
        }
        first_p = false;
        let _ = write!(
            out,
            "{}:{}",
            json_str(&p.name),
            json_str(&format!("/assets/sprites/{}", sp.png)),
        );
    }
    out.push('}');

    // Ascendancy panels (portrait + position).
    // Variant ascendancies (Abyssal Lich): parent panel + per-node
    // content overrides, from tree/asc_overrides.tsv. The planner keys
    // engine state on the PARENT; the variant name is display/persist.
    {
        let mut by_variant: std::collections::BTreeMap<(String, String), Vec<&Vec<String>>> =
            Default::default();
        for row in asc_overrides {
            if row.len() >= 9 {
                by_variant
                    .entry((row[0].clone(), row[2].clone()))
                    .or_default()
                    .push(row);
            }
        }
        out.push_str(r#","asc_variants":{"#);
        let mut first_v = true;
        for ((variant, parent), rows) in &by_variant {
            if !first_v {
                out.push(',');
            }
            first_v = false;
            let _ = write!(out, r#"{}:{{"parent":{},"nodes":{{"#,
                json_str(variant), json_str(parent));
            for (i, row) in rows.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                let icon_url = sprite_lookup(sprites, &row[7])
                    .map(|sp| format!("/assets/sprites/{}", sp.png));
                let _ = write!(out, r#""{}":{{"n":{},"s":{},"k":{}"#,
                    row[3], json_str(&row[5]), json_str(&row[6]), json_str(&row[8]));
                if let Some(u) = icon_url {
                    let _ = write!(out, r#","i":{}"#, json_str(&u));
                }
                out.push('}');
            }
            out.push_str("}}");
        }
        out.push('}');
    }
    out.push_str(r#","asc_panels":{"#);
    let mut first_ap = true;
    for p in &canvas.portraits {
        if p.kind != "asc" {
            continue;
        }
        let Some(sp) = sprite_lookup(sprites, &p.image) else {
            continue;
        };
        if !first_ap {
            out.push(',');
        }
        first_ap = false;
        // PoB DrawAsset doubles bg.width/height (PassiveTreeView.lua:1239) —
        // we emit the doubled size so the JS draws it at 3000×3000 etc.
        let dw = p.w * 2.0;
        let dh = p.h * 2.0;
        let _ = write!(
            out,
            r#"{}:{{"p":{},"x":{},"y":{},"w":{},"h":{}}}"#,
            json_str(&p.name),
            json_str(&format!("/assets/sprites/{}", sp.png)),
            p.x as i32,
            p.y as i32,
            dw as i32,
            dh as i32,
        );
    }
    out.push('}');

    // Classes (for sidebar).
    out.push_str(r#","classes":["#);
    let mut first_c = true;
    for c in classes {
        if !first_c {
            out.push(',');
        }
        first_c = false;
        let _ = write!(out, r#"{{"name":{},"asc":["#, json_str(&c.name));
        let mut first_aa = true;
        for a in &c.ascendancies {
            if !first_aa {
                out.push(',');
            }
            first_aa = false;
            out.push_str(&json_str(a));
        }
        out.push_str("]}");
    }
    out.push(']');

    // asc_internal map: display-name → { internal: "Druid1", class: "Druid" }.
    // Used by the .build exporter to emit GGG's canonical `ascendancy` value.
    out.push_str(r#","asc_internal":{"#);
    let mut first_ai = true;
    for (name, (internal, parent)) in &canvas.asc_internal {
        if !first_ai {
            out.push(',');
        }
        first_ai = false;
        let _ = write!(
            out,
            "{}:{{\"internal\":{},\"class\":{}}}",
            json_str(name),
            json_str(internal),
            json_str(parent),
        );
    }
    out.push('}');

    // Schema version for the static TREE blob. Bumped when the shape
    // of TREE.* fields changes; lets the JS gracefully reject mismatched
    // builds rather than rendering garbled output.
    out.push_str(r#","tree_schema":1"#);

    out.push('}');
    out
}

pub(crate) fn render_canvas_html(
    nodes: &[Node],
    edges: &[(u32, u32, i32)],
    canvas: &Canvas,
    classes: &[ClassInfo],
    sprites: &HashMap<String, Sprite>,
    asc_overrides: &[Vec<String>],
    title: &str,
) -> String {
    let tree_data = build_tree_data(nodes, edges, canvas, classes, sprites, asc_overrides);
    let title_e = escape_html(title);

    // Sidebar class options — sorted alphabetically (PoE2 has no
    // canonical class order, and authors expect a stable default).
    // No placeholder option: the planner auto-selects the first
    // alphabetical class on boot if no class is persisted, so the
    // user always lands on a populated tree.
    let mut sorted_classes: Vec<&ClassInfo> = classes.iter().collect();
    sorted_classes.sort_by(|a, b| a.name.cmp(&b.name));
    let mut class_opts = String::new();
    for c in &sorted_classes {
        let _ = write!(
            class_opts,
            r#"<option value="{0}">{0}</option>"#,
            escape_html(&c.name),
        );
    }

    let mut out = String::with_capacity(tree_data.len() + 32 * 1024);
    let _ = write!(
        out,
        r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title_e}</title>
<link rel="stylesheet" href="/assets/wizard_chrome.css">
<link rel="stylesheet" href="/assets/planner.css">
<script src="/assets/share_codec.js" defer></script>
</head>
<body>
<header id="wizard-chrome" data-step="passives" data-capture-section="passives"></header>
<div class="planner-row">
<button id="panel-toggle" class="panel-toggle" type="button" title="Collapse / expand sidebar" aria-label="Toggle sidebar">
  <span class="panel-toggle-icon" aria-hidden="true">‹</span>
</button>
<aside id="panel">
  <!-- Counters (main / set / asc) moved into the bottom-left HUD;
       the wizard chrome above + the HUD below the canvas carry the
       header info now. Sidebar starts with editable identity then
       the captures bar. -->
  <section id="sec-identity" class="row sec-identity">
    <label>Build name
      <input id="build-name" type="text" maxlength="80" placeholder="e.g. Mama Bear — Smash and Grab" autocomplete="off">
    </label>
    <label>Description
      <textarea id="build-description" maxlength="500" rows="2" placeholder="Short blurb shown under the name in-game"></textarea>
    </label>
    <div class="row-pair">
      <label>Class
        <select id="class">{class_opts}</select>
      </label>
      <label>Ascendancy
        <select id="asc"><option value="">— pick a class first —</option></select>
      </label>
    </div>
  </section>
  <!-- Captures bar removed: Lv, snapshot count, chip rail, and the
       snapshot button all moved to the slider (cap markers + range
       labels) and a floating overlay (Snapshot S button on the
       canvas, defined inside #viewport below). The hidden shim
       below keeps the IDs the JS write-paths still expect — without
       them, renderCaptureBar would early-return and the snapshot
       button's disabled state wouldn't track. -->
  <div hidden>
    <span id="cap-level"></span><span id="cap-count"></span><span id="cap-count-plural"></span>
    <ol id="cap-list"></ol>
  </div>
  <!-- Identity (name / description / class / ascendancy) lives on the
       Start page in the wizard nav — duplicate inputs in the sidebar
       were noise. The visible inputs are now in #sec-identity at the
       top — this comment block is kept as a historical marker only. -->
  <section id="selected">
    <!-- Section header (Passives count + inline mode picker) removed.
         Mode selection now lives on the bottom-left HUD's clickable
         pill; the selected-passive count is implicit in the HUD's
         "MAIN ●N/cap" segment. The hidden #sel-count + the hidden
         #alloc-mode shim keep the JS write-paths alive. -->
    <div hidden>
      <span id="sel-count">0</span>
      <select id="alloc-mode">
        <option value="main">Main</option>
        <option value="set1">Set 1</option>
        <option value="set2">Set 2</option>
      </select>
    </div>
    <ul id="sel-list"></ul>
  </section>
  <footer>
    <div class="footer-row footer-primary">
      <button id="export" class="btn-primary" title="Export .build for the in-game Build Planner">Export .build</button>
    </div>
    <div class="footer-row footer-secondary">
      <button id="reset" title="Clear all snapshots and reset the tree">Clear</button>
      <button id="share" title="Copy a shareable link to the clipboard">Share</button>
    </div>
    <!-- GGG developer-program required disclaimer — always visible on
         the tree page itself, not just the help popover. -->
    <div class="planner-attribution">This product isn't affiliated with or endorsed by Grinding Gear Games in any way.</div>
  </footer>
</aside>
<main id="viewport">
  <div id="level-slider" class="level-slider hidden">
    <div class="ls-track-wrap">
      <div id="ls-segments" class="ls-segments" aria-hidden="true"></div>
      <div id="ls-thumb-label" class="ls-thumb-label hidden" aria-hidden="true">1</div>
      <input id="ls-input" type="range" min="1" max="100" value="1" step="1" />
      <div id="ls-ticks" class="ls-ticks" aria-hidden="true"></div>
    </div>
    <div id="ls-tooltip" class="ls-tooltip hidden" role="tooltip"></div>
  </div>
  <canvas id="tree" tabindex="0"></canvas>
  <!-- First-run guidance — visible only while the build has zero
       allocations (07_sidebar syncs it on every selection change).
       Kills the "silently defaulted to Druid, allocated half a tree"
       trap by naming the two first steps explicitly. -->
  <div id="firstrun-hint" class="firstrun-hint hidden" role="status">
    <span class="firstrun-hint-text">New build — <b>pick your class</b> in the sidebar, then click a highlighted start node to begin.</span>
    <button id="firstrun-hint-x" type="button" title="Dismiss" aria-label="Dismiss hint">✕</button>
  </div>
  <div id="hud-row" class="hud-row">
  <div id="mode-badge" class="mode-badge mode-main">
    <span class="hud-pool hud-pool-lv" title="Character level — derived from main passives spent (Lv 2 grants point 1, Lv 100 grants point 99)">
      <span class="hud-pool-label">Lv</span>
      <b id="mode-level-val">1</b>
    </span>
    <span class="mode-sep" aria-hidden="true"></span>
    <span class="hud-pool" title="Main passive points — spent / cap (+ ascendancy grants)">
      <span class="hud-pool-label">Main</span>
      <span class="dot dot-main"></span>
      <b id="count-main">0</b><span class="hud-pool-slash">/</span><span id="count-main-cap">99</span>
      <span id="count-main-bonus" class="hud-bonus"></span>
    </span>
    <span class="mode-sep" aria-hidden="true"></span>
    <span class="hud-pool" title="Weapon-set passive points — each set has its own cap. Witchhunter's Weapon Master adds +100 to both.">
      <span class="hud-pool-label">Set</span>
      <span class="dot dot-set1"></span><b id="count-set1">0</b><span class="hud-pool-slash">/</span><span class="hud-set-cap">24</span>
      <span class="dot dot-set2"></span><b id="count-set2">0</b><span class="hud-pool-slash">/</span><span class="hud-set-cap">24</span>
      <span class="hud-hidden">/<b id="count-sets">0</b>/<span id="count-sets-cap">24</span><span id="count-sets-bonus"></span></span>
    </span>
    <span class="mode-sep" aria-hidden="true"></span>
    <span class="hud-pool" title="Ascendancy points — spent / 8 (separate from main passive budget)">
      <span class="hud-pool-label">Asc</span>
      <span class="dot dot-asc"></span>
      <b id="count-asc">0</b><span class="hud-pool-slash">/</span>8
    </span>
    <span class="mode-sep" aria-hidden="true"></span>
    <span class="mode-dot"></span>
    <span class="mode-label">Main</span>
  </div>
  <button id="cap-snapshot" class="snapshot-action" type="button" title="Freeze the current tree as a snapshot at this level (hotkey: S)">
    <span class="snapshot-action-plus" aria-hidden="true">+</span>
    <span class="snapshot-action-label">Snapshot</span>
  </button>
  <ol id="cap-chip-list" class="cap-chip-list" aria-label="Capture snapshots"></ol>
  </div><!-- /.hud-row -->
  <div id="note-overlay" class="note-overlay" aria-hidden="true"></div>
  <div id="note-popover" class="note-popover hidden" role="dialog" aria-label="Edit note">
    <div class="note-popover-head">
      <span class="note-popover-name" id="note-popover-name">Node name</span>
      <button id="note-popover-trash" class="note-popover-trash" type="button" title="Delete this note">🗑</button>
    </div>
    <textarea id="note-popover-text" class="note-popover-text" placeholder="Note for this passive — autosaves as you type. Esc or click outside to close."></textarea>
    <div class="note-popover-hint">Autosaves · <kbd>Esc</kbd> to close</div>
  </div>
  <!-- Skills strip: upper-right overlay listing the ACTIVE capture's
       skill gems + supports. Edits via #skill-popover below. Text-only
       in v1 (no gem icons) per the explicit "selector and fields"
       scope. -->
  <div class="strips-col">
  <aside id="skills-strip" class="skills-strip" hidden>
    <header class="ss-header">
      <span class="ss-title">SKILLS</span>
      <span class="ss-cap-label" id="ss-cap-label"></span>
    </header>
    <ol class="ss-list" id="ss-list"></ol>
    <button class="ss-add" id="ss-add" type="button">+ Add skill…</button>
  </aside>
  <!-- Gear strip — placeholder v1. Per-capture equipment: slot + item
       name (unique from item_catalogue.json or freetext) + note.
       Persists as Capture.items (schema already plumbed); first UI. -->
  <aside id="gear-strip" class="skills-strip gear-strip" hidden>
    <header class="ss-header">
      <span class="ss-title">GEAR</span>
      <span class="ss-cap-label" id="gs-cap-label"></span>
    </header>
    <ol class="ss-list" id="gs-list"></ol>
    <button class="ss-add" id="gs-add" type="button">+ Set gear…</button>
    <button class="gv-open" id="guide-open" type="button" title="Read this build as a typeset leveling guide">&#128214; Build guide</button>
  </aside>
  </div>

  <!-- Edit-socket popover. Modal-style, opens on click of a row in
       #skills-strip or on +Add. Mobalytics-shaped: active gem +
       level + weapon-set + up to 5 supports + notes textarea (the
       additional_text the .build export carries). -->
  <div id="skill-popover" class="skill-popover hidden" role="dialog" aria-modal="true" aria-label="Edit skill gem socket">
    <header class="sp-header">
      <span class="sp-title">Edit Skill Gem Socket</span>
      <button class="sp-close" id="sp-close" type="button" aria-label="Close">×</button>
    </header>
    <div class="sp-body">
      <section class="sp-section">
        <label class="sp-label">Active Skill Gem</label>
        <div class="sp-combobox" data-target="active">
          <input id="sp-active-input" class="sp-combo-input" type="search" autocomplete="off" placeholder="Type to search…">
          <ol class="sp-combo-list" id="sp-active-list"></ol>
        </div>
      </section>
      <section class="sp-section">
        <label class="sp-label">Gem Level</label>
        <div class="sp-level-wrap">
          <select class="sp-level" id="sp-level" aria-label="Gem level"></select>
          <span class="sp-hint">Stored for the leveling timeline. GGG's .build doesn't carry a per-gem level field — different gem levels across snapshots are surfaced via additional_text on export.</span>
        </div>
      </section>
      <section class="sp-section">
        <label class="sp-label">Weapon Set</label>
        <div class="sp-set-tabs" id="sp-set-tabs" role="tablist" aria-label="Weapon set">
          <button type="button" data-set="main" class="sp-set-tab is-active">All Sets</button>
          <button type="button" data-set="set1" class="sp-set-tab">Weapon Set 1</button>
          <button type="button" data-set="set2" class="sp-set-tab">Weapon Set 2</button>
        </div>
      </section>
      <section class="sp-section">
        <label class="sp-label">Support Skill Gems <span class="sp-muted">(optional, up to 5)</span></label>
        <ol id="sp-supports" class="sp-supports"></ol>
      </section>
      <section class="sp-section">
        <label class="sp-label" for="sp-note">Notes <span class="sp-muted">(saved to additional_text on .build export)</span></label>
        <textarea id="sp-note" class="sp-note" rows="2" placeholder="e.g., 'Level Lightning Arrow to gem-level 12 at this snapshot'"></textarea>
      </section>
    </div>
    <footer class="sp-footer">
      <button class="sp-remove" id="sp-remove" type="button">Remove</button>
      <span class="sp-spacer"></span>
      <button class="sp-cancel" id="sp-cancel" type="button">Cancel</button>
      <button class="sp-apply"  id="sp-apply"  type="button">Apply</button>
    </footer>
  </div>

  <div id="gear-popover" class="skill-popover hidden" role="dialog" aria-modal="true" aria-label="Edit gear slot">
    <header class="sp-header">
      <span class="sp-title">Edit Gear Slot</span>
      <button class="sp-close" id="gp-close" type="button" aria-label="Close">×</button>
    </header>
    <div class="sp-body">
      <section class="sp-section">
        <label class="sp-label">Slot</label>
        <select class="sp-level gp-slot" id="gp-slot" aria-label="Gear slot"></select>
      </section>
      <section class="sp-section">
        <label class="sp-label">Item <span class="sp-muted">(pick a unique or a base, or type any name)</span></label>
        <div class="sp-combobox" data-target="gear">
          <input id="gp-item-input" class="sp-combo-input" type="search" autocomplete="off" placeholder="Type to search uniques and bases…">
          <ol class="sp-combo-list" id="gp-item-list"></ol>
        </div>
      </section>
      <section class="sp-section gp-base-opts hidden" id="gp-base-opts">
        <label class="sp-label">Rarity</label>
        <div class="sp-set-tabs" id="gp-rarity" role="tablist" aria-label="Rarity">
          <button type="button" data-rarity="normal" class="sp-set-tab">Normal</button>
          <button type="button" data-rarity="magic" class="sp-set-tab">Magic</button>
          <button type="button" data-rarity="rare" class="sp-set-tab is-active">Rare</button>
        </div>
        <label class="sp-label gp-stats-label" for="gp-stats">Priority stats <span class="sp-muted">(click to select the 1&ndash;3 that matter most; click again to remove)</span></label>
        <input id="gp-stats" class="sp-combo-input" type="search" autocomplete="off" placeholder="Search this base&rsquo;s rollable mods&hellip;">
        <div class="gp-stat-chips" id="gp-stat-chips"></div>
      </section>
      <section class="sp-section">
        <label class="sp-label" for="gp-note">Notes <span class="sp-muted">(mods to look for, crafting steps, swap level)</span></label>
        <textarea id="gp-note" class="sp-note" rows="2" placeholder="e.g., 'any rare with +life and lightning res until you can afford this'"></textarea>
      </section>
    </div>
    <footer class="sp-footer">
      <button class="sp-remove" id="gp-remove" type="button">Remove</button>
      <span class="sp-spacer"></span>
      <button class="sp-cancel" id="gp-cancel" type="button">Cancel</button>
      <button class="sp-apply"  id="gp-apply"  type="button">Apply</button>
    </footer>
  </div>

  <button id="help-badge" class="help-badge" type="button" aria-label="Keyboard shortcuts and tips" title="Keyboard shortcuts (?)">?</button>
  <div id="help-popover" class="help-popover hidden" role="dialog" aria-label="Keyboard shortcuts">
    <div class="help-popover-head">
      <span class="help-popover-title">Cheat sheet</span>
      <button id="help-popover-close" class="help-popover-close" type="button" aria-label="Close">×</button>
    </div>
    <div class="help-popover-body">
      <section>
        <h4>Tree</h4>
        <div class="help-row"><span class="help-keys"><kbd>Click</kbd></span><span>Allocate</span></div>
        <div class="help-row"><span class="help-keys"><kbd>R-click</kbd></span><span>Deallocate / cycle alt paths</span></div>
        <div class="help-row"><span class="help-keys"><kbd>Ctrl</kbd>+<kbd>Click</kbd></span><span>Weapon set 1</span></div>
        <div class="help-row"><span class="help-keys"><kbd>Shift</kbd>+<kbd>Click</kbd></span><span>Weapon set 2</span></div>
        <div class="help-row"><span class="help-keys"><kbd>N</kbd></span><span>Add / edit a note on the hovered node or skill row</span></div>
        <div class="help-row"><span class="help-keys"><kbd>S</kbd></span><span>Take a snapshot at the current level</span></div>
      </section>
      <section>
        <h4>Gear &amp; Skills</h4>
        <div class="help-row"><span class="help-keys"><kbd>G</kbd></span><span>Open the gem socket editor (add a skill to this snapshot)</span></div>
        <div class="help-row"><span class="help-keys"><kbd>I</kbd></span><span>Inventory / items <span class="help-soon">(coming soon)</span></span></div>
      </section>
      <section>
        <h4>Commands</h4>
        <div class="help-row"><span class="help-keys"><kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>K</kbd></span><span>Search · open command palette</span></div>
        <div class="help-row"><span class="help-keys"><kbd>Esc</kbd></span><span>Close any open panel</span></div>
      </section>
      <div class="help-attribution">This product isn't affiliated with or endorsed by Grinding Gear Games in any way. Game content, images, and materials are trademarks and copyrights of Grinding Gear Games. Site &copy; Damdor, non-commercial.</div>
    </div>
  </div>
  <div id="tooltip" role="tooltip"></div>
  <div id="loading" class="overlay">Loading sprites…</div>
</main>

  <!-- Build-guide reading view: a FLOATING window over the live tree —
       drag it by the title bar, hover tagged nodes/gems/items to
       preview (nodes pulse on the tree behind), edit the prose inline,
       copy the whole story as agent JSON. -->
  <div id="guide-view" class="guide-view hidden" role="dialog" aria-label="Build guide">
    <div class="gv-frame" id="gv-frame">
      <header class="gv-bar" id="gv-bar" title="Drag to move">
        <span class="gv-bar-grip" aria-hidden="true">&#8942;&#8942;</span>
        <span class="gv-bar-title">&#128214; Build Guide</span>
        <span class="gv-bar-spacer"></span>
        <button class="gv-btn" id="gv-edit" type="button" title="Edit the intro and chapter text inline">&#9998; Edit</button>
        <button class="gv-btn" id="gv-agent" type="button" title="Copy the whole build story as JSON for an AI agent to write a full guide from">Copy for agent</button>
        <button class="gv-close" id="guide-close" type="button" aria-label="Close guide">&times;</button>
      </header>
      <article class="gv-article" id="guide-body"></article>
      <footer class="gv-foot">This product isn't affiliated with or endorsed by Grinding Gear Games in any way &middot; game content &copy; Grinding Gear Games &middot; site &copy; Damdor, non-commercial</footer>
      <div class="gv-resize" id="gv-resize" title="Drag to resize" aria-hidden="true"></div>
    </div>
  </div>

<div id="cmdk" class="cmdk-overlay hidden" role="dialog" aria-label="Command palette">
  <div class="cmdk-modal">
    <div class="cmdk-input-row">
      <span class="cmdk-prefix">⌘K</span>
      <input id="cmdk-input" type="text" autocomplete="off" spellcheck="false" placeholder="Switch mode, jump to a node, search stats…">
      <kbd class="cmdk-esc">esc</kbd>
    </div>
    <div id="cmdk-results" class="cmdk-results"></div>
    <div class="cmdk-foot">
      <span id="cmdk-count"></span>
      <span class="cmdk-keys"><kbd>↑↓</kbd> navigate<span class="cmdk-keys-sep">·</span><kbd>⏎</kbd> select<span class="cmdk-keys-sep">·</span><kbd>esc</kbd> close</span>
    </div>
  </div>
</div>
</div>
<script src="/assets/wizard_chrome.js" defer></script>
<script>const TREE = {tree_data};</script>
<script src="/assets/planner.js" defer></script>
</body>
</html>
"##,
        title_e = title_e,
        class_opts = class_opts,
        tree_data = tree_data,
    );
    out
}

pub(crate) const CANVAS_CSS: &str = include_str!("../assets/planner.css");

// Note: the planner JS bundle (CANVAS_JS) used to live here as a
// compile-time concat of every planner/*.js file via include_str!.
// As of the TS migration it's built by esbuild — see
// scripts/build_js.sh + tools/setup.sh. Rust no longer touches the
// .js sources; the only artefact it still owns is planner.css above.
