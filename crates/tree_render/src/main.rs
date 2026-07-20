//! tree_render — emit a self-contained PoE2 passive tree viewer.
//!
//! Reads the TSV files produced by `buildwright shape tree` (+ masteries
//! / sprites) and bakes a one-file `planner.html`: a `<canvas>` driven by
//! a bundled JS planner
//! (assets/planner.js), with all tree data inlined as a `TREE` JSON blob.
//! No backend, no JS dependencies — drops into any static host.
//!
//! Module layout:
//!   model::*   structs (Node, Canvas, Sprite, ClassInfo, …)
//!   io::*      TSV / sprite-manifest readers
//!   frames::*  per-node frame-sprite + target-size lookup
//!   geom::*    arc-edge geometry + SVG path-piece emission
//!   text::*    HTML / JSON string escapes + node_options parser
//!   emit::*    JSON / HTML emission (the bulky data + render path)
//!   main.rs    CLI parsing + orchestration only

use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

mod emit;
mod frames;
mod geom;
mod io;
mod model;
mod text;

use emit::{CANVAS_CSS, build_meta_json, render_canvas_html};
use io::{
    read_active_skills, read_buffs, read_edges, read_masteries, read_meta, read_nodes, read_sprites,
};
use model::Args;

const USAGE: &str = "\
tree_render — PoE2 passive tree viewer

USAGE:
    tree_render [--tree-dir <dir>] --output <planner.html> [--title <str>]

ARGS:
    --tree-dir <dir>     directory with nodes.tsv, edges.tsv, meta.tsv, sprites.tsv
                         (default: data/parsed/CURRENT/tree — see docs/plan.md
                         for the patch-versioned data layout)
    --output <path>      where to write the rendered HTML
    --title <str>        page title (default: \"Build planner\")
";

/// Strip GGG inline markup from skill descriptions for display. Mirrors
/// `tree_json::strip_markup` (which already cleaned the node stat text):
/// `<tag>…` drops the tag, `{…}` braces drop, `[a|b]`→`b`, `[a]`→`a`,
/// and whitespace collapses to a single space. active_skills.tsv carries
/// the raw markup, so we clean it here at resolve time.
fn clean_markup(s: &str) -> String {
    let s = s.replace("\\n", " ").replace("\\t", " ");
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
            '\n' | '\r' | '\t' => out.push(' '),
            _ => out.push(c),
        }
    }
    // Collapse runs of whitespace introduced by the substitutions.
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Extract buff-grant phrases from a node's stat text. GGG phrases buff
/// grants two ways: "Grants <Name>" (Sands of Time, Unravelling,
/// Thaumaturgical Dynamism) and "… grant <Name> Auras" (Tactician's
/// Embankments). Splits on stat-clause boundaries (';'), takes the text
/// after grant/grants, drops "Grants Skill:" (a skill grant, resolved
/// separately), and keeps only proper-noun-initial phrases. The caller
/// matches each against the buff catalogue, which self-filters ordinary
/// "X grants Y%…" stat text (those match no buff name). ASCII-only
/// lowercasing keeps the keyword byte offset valid in the original clause.
fn parse_granted_buffs(stats: &str) -> Vec<String> {
    let mut out = Vec::new();
    for clause in stats.split(';') {
        let cl = clause.trim();
        let low = cl.to_ascii_lowercase();
        for kw in ["grants ", "grant "] {
            let Some(i) = low.find(kw) else { continue };
            let phrase = cl[i + kw.len()..].trim();
            if phrase.is_empty() || phrase.starts_with("Skill:") {
                continue;
            }
            if !phrase.chars().next().is_some_and(|c| c.is_uppercase()) {
                continue;
            }
            out.push(phrase.to_string());
            break;
        }
    }
    out
}

/// Normalize a granted-buff phrase for matching: lowercase + drop a
/// trailing "aura(s)"/"buff(s)" qualifier ("Embankment Auras" →
/// "embankment") so the family match lands on the buff-name stems.
fn normalize_buff_phrase(phrase: &str) -> String {
    let mut p = phrase.trim().to_ascii_lowercase();
    for suf in [" auras", " aura", " buffs", " buff"] {
        if let Some(stripped) = p.strip_suffix(suf) {
            p = stripped.to_string();
            break;
        }
    }
    p.trim().to_string()
}

/// Extract the skill names from a node's "Grants Skill: X" stat clauses.
/// tree_json joins stat lines with ';', so a clause runs from the marker
/// to the next ';' (or end of string). A node may grant more than one
/// skill, so this returns every match. Names are matched against the
/// skills catalogue case-insensitively by the caller.
fn parse_granted_skills(stats: &str) -> Vec<String> {
    const MARKER: &str = "Grants Skill:";
    let mut out = Vec::new();
    let mut rest = stats;
    while let Some(i) = rest.find(MARKER) {
        let after = &rest[i + MARKER.len()..];
        let end = after.find(';').unwrap_or(after.len());
        let name = after[..end].trim();
        if !name.is_empty() {
            out.push(name.to_string());
        }
        rest = &after[end..];
    }
    out
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let args = parse_args()?;
    let mut nodes = read_nodes(&args.tree_dir.join("nodes.tsv"))?;
    // Exact node→mastery lighting map (structural; see buildwright masteries).
    let mastery_map = read_masteries(&args.tree_dir.join("masteries.tsv"));
    for n in &mut nodes {
        if let Some(ms) = mastery_map.get(&n.id) {
            n.lights_mastery = ms.clone();
        }
    }
    // Granted-skill tooltips: resolve each node's "Grants Skill: X" stat
    // clauses against the first-party skills catalogue (sibling of the
    // tree dir). Absent catalogue → no grants resolved, tooltip degrades
    // to the bare stat text.
    let skills = read_active_skills(&args.tree_dir.join("../skills/active_skills.tsv"));
    if !skills.is_empty() {
        for n in &mut nodes {
            for name in parse_granted_skills(&n.stats) {
                if let Some(desc) = skills.get(&name.to_lowercase()) {
                    n.granted.push((name, clean_markup(desc)));
                }
            }
        }
    }
    // Granted buffs/auras: same "Grants X" / "grant X Auras" phrasing,
    // resolved against the buff catalogue (../skills/buffs.tsv, from
    // `buildwright shape buffs`). Exact name match first, then a family
    // match on the stem ("Embankment" → every "* Embankment" totem aura,
    // "Unravelling" → the elemental Unravelling variants). Non-buff stat
    // clauses ("X also grants Y%…") match no name and are dropped. Shares
    // the `granted` field with skills — one tooltip card per resolved buff.
    let buffs = read_buffs(&args.tree_dir.join("../skills/buffs.tsv"));
    if !buffs.is_empty() {
        for n in &mut nodes {
            for phrase in parse_granted_buffs(&n.stats) {
                let key = normalize_buff_phrase(&phrase);
                if key.is_empty() {
                    continue;
                }
                let pre = format!("{key} ");
                let suf = format!(" {key}");
                for (nm_low, disp, desc) in &buffs {
                    if *nm_low == key || nm_low.starts_with(&pre) || nm_low.ends_with(&suf) {
                        let entry = (disp.clone(), clean_markup(desc));
                        if !n.granted.contains(&entry) {
                            n.granted.push(entry);
                        }
                    }
                }
            }
        }
    }
    let edges = read_edges(&args.tree_dir.join("edges.tsv"))?;
    let (canvas, classes) = read_meta(&args.tree_dir.join("meta.tsv"))?;
    let sprites = read_sprites(&args.tree_dir.join("sprites.tsv")).unwrap_or_default();
    let asc_overrides = io::read_asc_overrides(&args.tree_dir.join("asc_overrides.tsv"));

    // Per-game client descriptor. poe2 = the defaults every module
    // assumes; poe1 step 1 is TREE-ONLY: gear/skills/jewels/spirit/
    // weapon-set features off, own storage namespace + agent dir,
    // budgets from the official export (123 + 8).
    let game_json = match args.game.as_str() {
        "poe1" => concat!(
            "{\"id\":\"poe1\",\"agentBase\":\"/assets/poe1-agent\",",
            "\"budgets\":{\"main\":123,\"asc\":8},",
            "\"features\":{\"gear\":false,\"skills\":false,\"jewels\":false,",
            "\"spirit\":false,\"weaponSets\":false,\"share\":false,",
            "\"ascInPlace\":true}}",
        )
        .to_string(),
        _ => "{\"id\":\"poe2\"}".to_string(),
    };
    let chrome = emit::PageChrome { title: &args.title, game_json: &game_json, game: &args.game };
    let html = render_canvas_html(&nodes, &edges, &canvas, &classes, &sprites, &asc_overrides, &chrome);
    fs::write(&args.output, html).map_err(|e| format!("writing {}: {e}", args.output.display()))?;
    eprintln!(
        "Canvas viewer: {} nodes, {} edges, {} classes, {} portraits → {}",
        nodes.len(),
        edges.len(),
        classes.len(),
        canvas.portraits.len(),
        args.output.display(),
    );

    // Sibling-of-output asset dir.
    let assets_dir = args
        .output
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join("assets");
    let _ = fs::create_dir_all(&assets_dir);

    // CSS is still bundled here via include_str! — small, simple, no
    // build pipeline needed. The planner JS bundle (viewer/assets/planner.js)
    // is now produced by scripts/build_js.sh using vendored esbuild —
    // run that script before / alongside this binary. Rust no longer
    // owns the JS concat (we lose the include_str! compile-time guarantee
    // that the 20 planner files exist, but gain a real bundler with type
    // checking and source maps).
    let css_path = assets_dir.join("planner.css");
    fs::write(&css_path, CANVAS_CSS).map_err(|e| format!("writing {}: {e}", css_path.display()))?;
    eprintln!("Planner CSS → {}", css_path.display());

    // Agent grounding data: every node an agent may reference in an
    // agent-plan's targets[] (see docs/agent-builds.md + /llms.txt).
    // Fresh-agent feedback shaped this format: a `classes` block maps
    // class → ascendancies + start hub (the single biggest gap — agents
    // otherwise need outside game knowledge), and per-node `cost` =
    // BFS hops from each class start so agents can budget passive
    // points before emitting a URL. Compact — LLMs fetch this.
    {
        let agent_dir = assets_dir.join(&args.agent_subdir);
        let _ = fs::create_dir_all(&agent_dir);

        // Hop distance from every class hub (adjacency over the same
        // pathable set the planner uses: no masteries).
        use std::collections::{HashMap, VecDeque};
        let mut adj: HashMap<u32, Vec<u32>> = HashMap::new();
        let kind_of: HashMap<u32, &str> =
            nodes.iter().map(|n| (n.id, n.kind.as_str())).collect();
        for (a, b, _) in &edges {
            if kind_of.get(a) == Some(&"mastery") || kind_of.get(b) == Some(&"mastery") {
                continue;
            }
            adj.entry(*a).or_default().push(*b);
            adj.entry(*b).or_default().push(*a);
        }
        // class name → (hub id, dist map)
        let mut class_dist: Vec<(String, u32, HashMap<u32, u32>)> = Vec::new();
        for n in &nodes {
            if n.kind != "class_start" {
                continue;
            }
            for cls in n.klass.split('|').filter(|s| !s.is_empty()) {
                // Hubs carry PoE1|PoE2 name pairs (Marauder|Warrior).
                // Only the PoE2 names in the canonical class list are
                // valid plan.class values — emitting the legacy halves
                // would bait agents into an invalid class.
                if !classes.iter().any(|c| c.name == cls) {
                    continue;
                }
                let mut dist: HashMap<u32, u32> = HashMap::new();
                let mut q = VecDeque::from([n.id]);
                dist.insert(n.id, 0);
                while let Some(cur) = q.pop_front() {
                    let d = dist[&cur];
                    for &nb in adj.get(&cur).into_iter().flatten() {
                        if let std::collections::hash_map::Entry::Vacant(e) = dist.entry(nb) {
                            e.insert(d + 1);
                            q.push_back(nb);
                        }
                    }
                }
                class_dist.push((cls.to_string(), n.id, dist));
            }
        }

        // Nearest-notables hints: every audit struggled to estimate the
        // COMBINED cost of a target set from per-node from-start costs
        // alone. For each main-tree notable/keystone, BFS out to its 4
        // nearest peers so agents can see clustering ("these three are
        // 3-4 hops apart — one path serves all").
        let notable_ids: std::collections::HashSet<u32> = nodes
            .iter()
            .filter(|n| {
                matches!(n.kind.as_str(), "notable" | "keystone") && n.ascendancy.is_empty()
            })
            .map(|n| n.id)
            .collect();
        let mut near: HashMap<u32, Vec<(u32, u32)>> = HashMap::new();
        for &start in &notable_ids {
            let mut dist: HashMap<u32, u32> = HashMap::new();
            let mut q = VecDeque::from([start]);
            dist.insert(start, 0);
            let mut found: Vec<(u32, u32)> = Vec::new();
            while let Some(cur) = q.pop_front() {
                let d = dist[&cur];
                if d > 12 || found.len() >= 4 {
                    break; // clustering signal only — far peers are noise
                }
                for &nb in adj.get(&cur).into_iter().flatten() {
                    if let std::collections::hash_map::Entry::Vacant(e) = dist.entry(nb) {
                        e.insert(d + 1);
                        q.push_back(nb);
                        if notable_ids.contains(&nb) && found.len() < 4 {
                            found.push((nb, d + 1));
                        }
                    }
                }
            }
            near.insert(start, found);
        }

        let mut out = String::from("{\"format\":\"poe2-agent-nodes\",\"version\":2,");
        // classes block: name → ascendancies + start hub id.
        out.push_str("\"classes\":[");
        let mut first_c = true;
        for (cls, hub, _) in &class_dist {
            if !first_c {
                out.push(',');
            }
            first_c = false;
            // Sorted: asc_internal is a HashMap and this JSON is a
            // tracked artifact — hash order churned it every bake.
            let mut ascs: Vec<String> = canvas
                .asc_internal
                .iter()
                .filter(|(_, (_, c))| c == cls)
                .map(|(name, _)| text::json_str(name))
                .collect();
            ascs.sort();
            out.push_str(&format!(
                "{{\"name\":{},\"start_id\":{hub},\"ascendancies\":[{}]}}",
                text::json_str(cls),
                ascs.join(","),
            ));
        }
        out.push_str("],\"nodes\":[");
        let mut first = true;
        for n in &nodes {
            let targetable = matches!(n.kind.as_str(), "notable" | "keystone" | "asc_notable");
            if !targetable || n.name.is_empty() {
                continue;
            }
            if !first {
                out.push(',');
            }
            first = false;
            out.push_str(&format!(
                "{{\"id\":{},\"name\":{},\"kind\":{}",
                n.id,
                text::json_str(&n.name),
                text::json_str(&n.kind),
            ));
            if !n.ascendancy.is_empty() {
                out.push_str(&format!(",\"asc\":{}", text::json_str(&n.ascendancy)));
            }
            // cost: BFS hops from each class start (≈ passive points to
            // reach it in isolation). Ascendancy nodes cost asc points
            // instead and skip this.
            if n.ascendancy.is_empty() {
                let costs: Vec<String> = class_dist
                    .iter()
                    .filter_map(|(cls, _, dist)| {
                        dist.get(&n.id)
                            .map(|d| format!("{}:{d}", text::json_str(cls)))
                    })
                    .collect();
                if !costs.is_empty() {
                    out.push_str(&format!(",\"cost\":{{{}}}", costs.join(",")));
                }
            }
            if let Some(nears) = near.get(&n.id)
                && !nears.is_empty()
            {
                let items: Vec<String> =
                    nears.iter().map(|(id2, d)| format!("[{id2},{d}]")).collect();
                out.push_str(&format!(",\"near\":[{}]", items.join(",")));
            }
            if !n.stats.is_empty() {
                out.push_str(&format!(",\"stats\":{}", text::json_str(&n.stats)));
            }
            out.push('}');
        }
        // Variant-ascendancy overrides (Abyssal Lich): targetable entries
        // whose id is the BASE node id on the parent panel — the importer
        // paths them on the parent and records the variant ascendancy.
        for row in &asc_overrides {
            if row.len() < 9 || row[5].is_empty() {
                continue;
            }
            out.push_str(&format!(
                ",{{\"id\":{},\"name\":{},\"kind\":{},\"asc\":{}}}",
                row[3],
                text::json_str(&row[5]),
                text::json_str(&row[8]),
                text::json_str(&row[0]),
            ));
        }
        out.push_str("]}\n");
        let agent_path = agent_dir.join("nodes.json");
        fs::write(&agent_path, out)
            .map_err(|e| format!("writing {}: {e}", agent_path.display()))?;
        eprintln!("Agent grounding data → {}", agent_path.display());

        // graph.json — the connectivity data the /agent/validate Pages
        // Function needs to run the SAME greedy BFS the importer runs,
        // headlessly. Node entries: name, kind, asc, unlock gate;
        // edges: pathable pairs (masteries + multichoice options out).
        let mut g = String::from("{\"format\":\"poe2-agent-graph\",\"version\":1,");
        g.push_str("\"classes\":{");
        let mut first = true;
        for (cls, hub, _) in &class_dist {
            if !first {
                g.push(',');
            }
            first = false;
            g.push_str(&format!("{}:{hub}", text::json_str(cls)));
        }
        g.push_str("},\"asc_starts\":{");
        first = true;
        for n in &nodes {
            if n.kind != "asc_start" || n.ascendancy.is_empty() {
                continue;
            }
            if !first {
                g.push(',');
            }
            first = false;
            g.push_str(&format!("{}:{}", text::json_str(&n.ascendancy), n.id));
        }
        g.push_str("},\"nodes\":{");
        first = true;
        let mut pathable: std::collections::HashSet<u32> = std::collections::HashSet::new();
        for n in &nodes {
            if n.kind == "mastery" || n.kind == "multichoice_opt" {
                continue;
            }
            pathable.insert(n.id);
            if !first {
                g.push(',');
            }
            first = false;
            g.push_str(&format!("\"{}\":{{\"k\":{}", n.id, text::json_str(&n.kind)));
            if !n.name.is_empty() {
                g.push_str(&format!(",\"n\":{}", text::json_str(&n.name)));
            }
            if !n.ascendancy.is_empty() {
                g.push_str(&format!(",\"a\":{}", text::json_str(&n.ascendancy)));
            }
            if !n.unlock_constraint.is_empty() {
                // "<Asc>:<ids>" — validate only needs the gating asc.
                let gate = n.unlock_constraint.split(':').next().unwrap_or("");
                g.push_str(&format!(",\"uc\":{}", text::json_str(gate)));
            }
            g.push('}');
        }
        g.push_str("},\"edges\":[");
        first = true;
        for (a, b, _) in &edges {
            if !pathable.contains(a) || !pathable.contains(b) {
                continue;
            }
            if !first {
                g.push(',');
            }
            first = false;
            g.push_str(&format!("[{a},{b}]"));
        }
        g.push_str("]}\n");
        let graph_path = agent_dir.join("graph.json");
        fs::write(&graph_path, g)
            .map_err(|e| format!("writing {}: {e}", graph_path.display()))?;
        eprintln!("Agent graph → {}", graph_path.display());

        // jewels.json — jewel sockets (position + what's reachable in
        // each ring size), the ring geometry itself, and jewel item
        // radii. Positions/radii are raw GGG tree units — the same
        // space the TREE blob renders in, so the planner can draw
        // rings without a transform. Optional: skipped when the patch
        // predates the jewels dataset (`shape jewels`).
        let jewels_tsv = args.tree_dir.join("jewels.tsv");
        if let Ok(raw) = fs::read_to_string(&jewels_tsv) {
            let mut rings: Vec<(String, i64, i64, i64)> = Vec::new(); // name, outer, inner, radius
            let mut bases: Vec<(String, i64)> = Vec::new();
            let mut adds: Vec<(String, i64)> = Vec::new();
            // (keystone name, faction, conqueror index, stat text)
            let mut timeless: Vec<(String, String, i64, String)> = Vec::new();
            for line in raw.lines().skip(1) {
                let c: Vec<&str> = line.split('\t').collect();
                if c.len() < 3 {
                    continue;
                }
                let num = |i: usize| c.get(i).and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
                match c[0] {
                    "ring" => rings.push((c[1].to_string(), num(2), num(3), num(4))),
                    "base" => bases.push((c[1].to_string(), num(2))),
                    "radius_add" => adds.push((c[1].to_string(), num(2))),
                    "timeless" => timeless.push((
                        c[1].to_string(),
                        c[2].to_string(),
                        num(3),
                        c.get(4).unwrap_or(&"").to_string(),
                    )),
                    _ => {}
                }
            }
            // Every distinct radius a jewel can have: base radii and
            // their rollable "+N" combinations, plus each ring's
            // nominal radius (unique jewels reference rings by name).
            let mut radii_set: std::collections::BTreeSet<i64> = std::collections::BTreeSet::new();
            for (_, r) in bases.iter().filter(|(_, r)| *r > 0) {
                radii_set.insert(*r);
                for (_, a) in &adds {
                    radii_set.insert(*r + *a);
                }
            }
            for (_, outer, _, r) in &rings {
                radii_set.insert(*r);
                // The disc bounded by the DRAWN circle — ring uniques'
                // allocation zone matches what the player sees.
                radii_set.insert(*outer);
            }
            // Annulus bands ("Only affects Passives in <X> Ring"):
            // nodes BETWEEN inner and outer, keyed "inner-outer".
            let bands: Vec<(i64, i64)> = rings.iter().map(|(_, o, i, _)| (*i, *o)).collect();
            // Sockets: kind=jewel nodes. For each, precompute which
            // passives fall inside every candidate radius (euclidean,
            // tree units, mastery/asc/start nodes excluded — jewels
            // affect the main tree only).
            let affectable = |n: &model::Node| {
                matches!(n.kind.as_str(), "small" | "notable" | "keystone" | "attribute" | "jewel")
            };
            let mut out = String::from("{\"format\":\"poe2-agent-jewels\",\"version\":1,");
            out.push_str("\"units\":\"tree coordinates (same space as node positions)\",");
            out.push_str("\"rings\":{");
            let mut first = true;
            for (name, outer, inner, radius) in &rings {
                if !first {
                    out.push(',');
                }
                first = false;
                out.push_str(&format!(
                    "{}:{{\"outer\":{outer},\"inner\":{inner},\"radius\":{radius}}}",
                    text::json_str(name),
                ));
            }
            out.push_str("},\"bases\":{");
            first = true;
            for (name, r) in &bases {
                if !first {
                    out.push(',');
                }
                first = false;
                out.push_str(&format!("{}:{{\"radius\":{r}}}", text::json_str(name)));
            }
            out.push_str("},\"radius_rolls\":{");
            first = true;
            for (name, a) in &adds {
                if !first {
                    out.push(',');
                }
                first = false;
                out.push_str(&format!("{}:{a}", text::json_str(name)));
            }
            out.push_str("},\"sockets\":[");
            first = true;
            for n in &nodes {
                if n.kind != "jewel" {
                    continue;
                }
                if !first {
                    out.push(',');
                }
                first = false;
                out.push_str(&format!(
                    "{{\"id\":{},\"x\":{:.1},\"y\":{:.1}",
                    n.id, n.x, n.y
                ));
                if !n.name.is_empty() && n.name != "[Jewel] Socket" {
                    out.push_str(&format!(",\"name\":{}", text::json_str(&n.name)));
                }
                // Not every socket is an ordinary jewel home: Sinister
                // sockets only activate via the Voices unique, and the
                // named specials (Zarokh's Gift, Crystalline
                // Phylactery) have their own mechanics.
                if n.name.contains("Sinister") {
                    out.push_str(",\"sinister\":true");
                } else if !n.name.is_empty() && !n.name.contains("[Jewel]") {
                    out.push_str(",\"special\":true");
                }
                out.push_str(",\"in_radius\":{");
                let mut rfirst = true;
                let emit_list = |key: String, lo2: f64, hi2: f64, out: &mut String, rfirst: &mut bool| {
                    let mut ids: Vec<u32> = Vec::new();
                    for m in &nodes {
                        if m.id == n.id || !affectable(m) {
                            continue;
                        }
                        let (dx, dy) = (m.x - n.x, m.y - n.y);
                        let d2 = dx * dx + dy * dy;
                        if d2 > lo2 && d2 <= hi2 {
                            ids.push(m.id);
                        }
                    }
                    if !*rfirst {
                        out.push(',');
                    }
                    *rfirst = false;
                    let list: Vec<String> = ids.iter().map(u32::to_string).collect();
                    out.push_str(&format!("\"{key}\":[{}]", list.join(",")));
                };
                for r in &radii_set {
                    emit_list(r.to_string(), -1.0, (*r * *r) as f64, &mut out, &mut rfirst);
                }
                for (inner, outer) in &bands {
                    emit_list(
                        format!("{inner}-{outer}"),
                        (*inner * *inner) as f64,
                        (*outer * *outer) as f64,
                        &mut out,
                        &mut rfirst,
                    );
                }
                out.push_str("}}");
            }
            out.push_str("],");
            // Keystone-proximity lists (From Nothing: "Passives in
            // Radius of <Keystone> can be Allocated without being
            // connected"). Radius = the mined
            // JewelUniqueAllocateDisconnectedPassivesAroundKeystone
            // stat (1000); the keystone ITSELF is not allocatable
            // (verified in-game behavior), so keystones are excluded
            // from the lists.
            // Timeless keystone conversions: deterministic per rolled
            // conqueror (ConquerorIndex); art ships as TK_<Name>.png.
            out.push_str("\"timeless_keystones\":[");
            let san = |n: &str| -> String {
                n.chars().map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' }).collect()
            };
            let mut tfirst = true;
            for (name, faction, idx, stats) in &timeless {
                if !tfirst {
                    out.push(',');
                }
                tfirst = false;
                out.push_str(&format!(
                    "{{\"name\":{},\"faction\":{},\"conqueror_index\":{idx},\"stats\":{},\"icon\":\"/assets/sprites/TK_{}.png\"}}",
                    text::json_str(name), text::json_str(faction), text::json_str(stats), san(name),
                ));
            }
            out.push_str("],");
            out.push_str("\"keystones\":{");
            let kr = 1000i64;
            let mut kfirst = true;
            for n in &nodes {
                if n.kind != "keystone" || n.name.is_empty() || !n.ascendancy.is_empty() {
                    continue;
                }
                let mut ids: Vec<u32> = Vec::new();
                let rr = (kr * kr) as f64;
                for m in &nodes {
                    if m.id == n.id || m.kind == "keystone" || !affectable(m) {
                        continue;
                    }
                    let (dx, dy) = (m.x - n.x, m.y - n.y);
                    if dx * dx + dy * dy <= rr {
                        ids.push(m.id);
                    }
                }
                if !kfirst {
                    out.push(',');
                }
                kfirst = false;
                let list: Vec<String> = ids.iter().map(u32::to_string).collect();
                out.push_str(&format!(
                    "{}:{{\"id\":{},\"x\":{:.1},\"y\":{:.1},\"in_radius\":[{}]}}",
                    text::json_str(&n.name), n.id, n.x, n.y, list.join(","),
                ));
            }
            out.push_str("}}\n");
            let jewels_path = agent_dir.join("jewels.json");
            // Two writers share this file: we own sockets/rings/bases/
            // keystones; scripts/gen_agent_meta.mjs enriches it with the
            // unique-jewel radii (`uniques`, needs node + items data).
            // Preserve any top-level keys we don't emit so a plain
            // tree_render run can never destroy the enrichment.
            let out = match fs::read_to_string(&jewels_path) {
                Ok(prev) => text::preserve_unknown_top_level(&prev, out),
                Err(_) => out,
            };
            fs::write(&jewels_path, out)
                .map_err(|e| format!("writing {}: {e}", jewels_path.display()))?;
            eprintln!("Agent jewels → {}", jewels_path.display());
        }
    }

    // Friendly warning if the JS bundle is missing entirely — common
    // failure mode for a fresh checkout that hasn't run setup.sh +
    // build_js.sh yet. Don't error: someone running tree_render just
    // to regenerate the TREE blob shouldn't be forced to install Node.
    let js_path = assets_dir.join("planner.js");
    if !js_path.exists() {
        eprintln!("WARNING: {} is missing.", js_path.display());
        eprintln!("         Run `tools/setup.sh && scripts/build_js.sh` to build it.");
    }

    // Small build_meta.json the wizard pages consume (class + ascendancy
    // names + GGG internalIds + game patch). They don't need the full
    // 2 MB TREE blob, so this stays tiny.
    //
    // Patch + source labels: read from data/parsed/<patch>/manifest.json
    // which sits ONE LEVEL UP from tree-dir. The extractor pipeline
    // writes it (see scripts/build_manifests.py). If the file is
    // missing/malformed both fields fall back to "" — the wizard
    // treats empty as unknown and hides the badge instead of erroring.
    let manifest_text = args
        .tree_dir
        .parent()
        .and_then(|p| fs::read_to_string(p.join("manifest.json")).ok())
        .unwrap_or_default();
    fn field(s: &str, name: &str) -> String {
        let key = format!("\"{name}\"");
        s.find(&key)
            .and_then(|i| s[i..].find(':').map(|j| i + j + 1))
            .and_then(|start| s[start..].find('"').map(|q| start + q + 1))
            .and_then(|qs| s[qs..].find('"').map(|qe| s[qs..qs + qe].to_string()))
            .unwrap_or_default()
    }
    let patch = field(&manifest_text, "patch");
    let source = field(&manifest_text, "source");
    let meta_path = if args.agent_subdir == "agent" {
        assets_dir.join("build_meta.json")
    } else {
        assets_dir.join(&args.agent_subdir).join("build_meta.json")
    };
    let meta = build_meta_json(&classes, &canvas, &patch, &source, &sprites);
    fs::write(&meta_path, meta).map_err(|e| format!("writing {}: {e}", meta_path.display()))?;
    eprintln!(
        "Build wizard metadata → {} (patch={}, source={})",
        meta_path.display(),
        if patch.is_empty() {
            "(unknown)"
        } else {
            &patch
        },
        if source.is_empty() {
            "(unknown)"
        } else {
            &source
        }
    );

    Ok(())
}

fn parse_args() -> Result<Args, String> {
    let mut argv = env::args().skip(1);
    let mut tree_dir: Option<PathBuf> = None;
    let mut output: Option<PathBuf> = None;
    let mut agent_subdir: Option<String> = None;
    let mut game: Option<String> = None;
    let mut title = String::from("Build planner");
    while let Some(a) = argv.next() {
        match a.as_str() {
            "--help" | "-h" => {
                print!("{USAGE}");
                std::process::exit(0);
            }
            "--tree-dir" => tree_dir = argv.next().map(PathBuf::from),
            "--output" => output = argv.next().map(PathBuf::from),
            // Second-game renders (PoE1) write their agent grounding +
            // build meta into their own subdir instead of clobbering
            // the primary game's /assets/agent/.
            "--agent-subdir" => agent_subdir = argv.next(),
            // Game descriptor: which game this page is (drives storage
            // namespacing, feature gates, point budgets client-side).
            "--game" => game = argv.next(),
            "--title" => {
                if let Some(t) = argv.next() {
                    title = t;
                }
            }
            other => return Err(format!("unknown arg: {other}\n\n{USAGE}")),
        }
    }
    // Default to the symlinked-current patch under data/parsed/. The
    // CURRENT symlink is part of the versioned-data layout described in
    // docs/plan.md; pointing at it means re-running tree_render after a
    // patch update Just Works without flag changes.
    let tree_dir = tree_dir.unwrap_or_else(|| PathBuf::from("data/parsed/CURRENT/tree"));
    let agent_subdir = agent_subdir.unwrap_or_else(|| "agent".into());
    let output = output.ok_or_else(|| format!("--output required\n\n{USAGE}"))?;
    Ok(Args {
        tree_dir,
        output,
        title,
        agent_subdir,
        game: game.unwrap_or_else(|| "poe2".into()),
    })
}
