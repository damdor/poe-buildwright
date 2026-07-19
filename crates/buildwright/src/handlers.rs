//! Command handlers. Native commands call the `data_miner` library in
//! process; orchestrated commands shell out to the existing scripts /
//! sibling binaries from the repo root.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use data_miner::bundle_decode;
use data_miner::dat::Dat;
use data_miner::dat_schema::SchemaSet;
use data_miner::fetch::{self, CdnClient};
use data_miner::index::Index;
use data_miner::mine;

use crate::Ctx;
use crate::ui;

// ---------------------------------------------------------------------
// small arg helpers
// ---------------------------------------------------------------------

/// Pull `--patch <v>` out of `args`, returning (value, remaining).
fn take_patch(args: &[String]) -> (Option<String>, Vec<String>) {
    let mut rest = Vec::new();
    let mut patch = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--patch" {
            patch = it.next().cloned();
        } else if let Some(v) = a.strip_prefix("--patch=") {
            patch = Some(v.to_string());
        } else {
            rest.push(a.clone());
        }
    }
    (patch, rest)
}

fn has_flag(args: &[String], flag: &str) -> bool {
    args.iter().any(|a| a == flag)
}

/// Run a subprocess from the repo root, borrowing owned args as &str.
fn sh(ctx: &Ctx, label: &str, program: &str, args: &[String]) -> Result<(), String> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    ui::run(ctx.style, &ctx.root, label, program, &refs)
}

/// Resolve a sibling workspace binary (built next to buildwright), or
/// fall back to `cargo run` from source. Returns (program, arg-prefix).
fn sibling_or_cargo(bin: &str, crate_name: &str) -> (String, Vec<String>) {
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        let cand = dir.join(bin);
        if cand.is_file() {
            return (cand.to_string_lossy().into_owned(), Vec::new());
        }
    }
    (
        "cargo".into(),
        vec![
            "run".into(),
            "--release".into(),
            "-p".into(),
            crate_name.into(),
            "--bin".into(),
            bin.into(),
            "--".into(),
        ],
    )
}

// ---------------------------------------------------------------------
// native: sources
// ---------------------------------------------------------------------

pub fn patch(_ctx: &Ctx, _args: &[String]) -> Result<(), String> {
    let info = fetch::patch_info().map_err(|e| e.to_string())?;
    println!("patch version : {}", info.version);
    println!("cdn base url  : {}", info.cdn_base);
    Ok(())
}

pub fn status(ctx: &Ctx, _args: &[String]) -> Result<(), String> {
    let style = ctx.style;
    let parsed = ctx.root.join("data/parsed");
    let current = std::fs::read_link(parsed.join("CURRENT"))
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()));

    // Live CDN patch — best effort; don't fail status when offline.
    let live = fetch::patch_info().ok();
    match &live {
        Some(i) => ui::ok(
            style,
            &format!("live CDN patch: {} ({})", i.version, i.cdn_base),
        ),
        None => ui::warn(style, "live CDN patch: unreachable (offline?)"),
    }
    println!();

    let mut patches: Vec<String> = std::fs::read_dir(&parsed)
        .map_err(|e| format!("read data/parsed: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir() && e.file_name() != "CURRENT")
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    patches.sort();

    if patches.is_empty() {
        ui::warn(style, "no patches under data/parsed/");
        return Ok(());
    }

    println!("{}", style.bold("local patches (data/parsed/):"));
    for p in &patches {
        let dir = parsed.join(p);
        let source = std::fs::read_to_string(dir.join(".source"))
            .ok()
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| "?".into());
        let manifest = std::fs::read_to_string(dir.join("manifest.json")).unwrap_or_default();
        let mver = json_str(&manifest, "patch").unwrap_or_default();
        let is_current = current.as_deref() == Some(p.as_str());
        let marker = if is_current {
            style.green(" ← CURRENT")
        } else {
            String::new()
        };
        let src = if source == "first-party" {
            style.green(&source)
        } else {
            style.yellow(&source)
        };
        let ver = if mver.is_empty() {
            String::new()
        } else {
            style.dim(&format!("  patch={mver}"))
        };
        println!("  {}  source={src}{ver}{marker}", style.cyan(p));
    }
    Ok(())
}

pub fn sources(ctx: &Ctx, _args: &[String]) -> Result<(), String> {
    let s = ctx.style;
    println!("{}", s.heading("Data sources & the two operator scenarios"));
    println!(
        "\nEvery data/parsed/<patch>/ carries a {} marker recording where it",
        s.bold(".source"),
    );
    println!("came from. The wizard badges non-first-party data as non-authoritative.\n");
    println!("{}", s.bold("Source markers"));
    println!(
        "  {}   authoritative — our own CDN mining",
        s.green("first-party")
    );
    println!(
        "  {}   PoB2 fork, tagged stable release",
        s.yellow("pob2-stable")
    );
    println!(
        "  {}      PoB2 fork, dev branch snapshot",
        s.yellow("pob2-dev")
    );
    println!(
        "  {}       hand-entered / leaked overlay on a prior patch (legacy)",
        s.yellow("preview")
    );
    println!("\n{}", s.bold("Operator flow — first-party mining"));
    println!("  Mine GGG's CDN ourselves: detect → fetch → mine → shape →");
    println!("  render → verify → deploy, endlessly repeatable.");
    println!("  → {}", s.cyan("buildwright update-native"));
    println!(
        "\n  (The pre-release PoB2-fork preview path was retired once the\n   \
         first-party miner reached parity — everything is GGG-native now.)"
    );
    Ok(())
}

// ---------------------------------------------------------------------
// native: mine primitives
// ---------------------------------------------------------------------

pub fn fetch(_ctx: &Ctx, args: &[String]) -> Result<(), String> {
    let rel = args.first().ok_or("usage: buildwright fetch <path>")?;
    let client = CdnClient::connect().map_err(|e| e.to_string())?;
    let local = client.fetch(rel).map_err(|e| e.to_string())?;
    println!("{}", local.display());
    Ok(())
}

fn load_index(client: &CdnClient) -> Result<Index, String> {
    let local = client
        .fetch("Bundles2/_.index.bin")
        .map_err(|e| e.to_string())?;
    eprintln!("index bundle  : {}", local.display());
    let payload = bundle_decode::decompress_full(&local).map_err(|e| e.to_string())?;
    eprintln!("decompressed  : {} bytes", payload.len());
    Index::parse(&payload).map_err(|e| e.to_string())
}

pub fn index(ctx: &Ctx, _args: &[String]) -> Result<(), String> {
    let client = CdnClient::connect().map_err(|e| e.to_string())?;
    eprintln!("patch version : {}", client.info.version);
    let index = load_index(&client)?;
    println!("bundles       : {}", index.bundles.len());
    println!("files         : {}", index.files.len());
    println!("directories   : {}", index.path_reps.len());
    println!("path hash     : {:?}", index.hash);
    let resolved = index.resolve_paths().map_err(|e| e.to_string())?;
    println!(
        "paths resolved: {} / {} file records",
        resolved.len(),
        index.files.len(),
    );
    for (path, _) in resolved.iter().take(5) {
        println!("  {path}");
    }
    if resolved.len() < index.files.len() {
        ui::warn(
            ctx.style,
            &format!(
                "{} file records have no resolved path",
                index.files.len() - resolved.len()
            ),
        );
    }
    Ok(())
}

pub fn find(_ctx: &Ctx, args: &[String]) -> Result<(), String> {
    let needle = args
        .first()
        .ok_or("usage: buildwright find <substring>")?
        .to_ascii_lowercase();
    let client = CdnClient::connect().map_err(|e| e.to_string())?;
    let index = load_index(&client)?;
    let mut hits = 0usize;
    for (path, file_idx) in index.resolve_paths().map_err(|e| e.to_string())? {
        if path.to_ascii_lowercase().contains(&needle) {
            let rec = &index.files[file_idx as usize];
            let bundle = &index.bundles[rec.bundle_index as usize].name;
            println!("{path}  [{bundle} @{} {}B]", rec.offset, rec.size);
            hits += 1;
            if hits >= 200 {
                println!("... (truncated at 200 hits)");
                break;
            }
        }
    }
    eprintln!("{hits} hit(s)");
    Ok(())
}

pub fn get(_ctx: &Ctx, args: &[String]) -> Result<(), String> {
    let vpath = args
        .first()
        .ok_or("usage: buildwright get <vpath> [out_file]")?;
    let out = args.get(1);
    let client = CdnClient::connect().map_err(|e| e.to_string())?;
    let index = load_index(&client)?;
    let bytes = extract_by_path(&client, &index, vpath)?;
    match out {
        Some(path) => {
            std::fs::write(path, &bytes).map_err(|e| format!("write {path}: {e}"))?;
            eprintln!("wrote {} bytes to {path}", bytes.len());
        }
        None => {
            let head: Vec<String> = bytes.iter().take(32).map(|b| format!("{b:02x}")).collect();
            println!("{} bytes; first 32: {}", bytes.len(), head.join(" "));
        }
    }
    Ok(())
}

/// Fetch the bundle owning `vpath` and return that file's bytes.
fn extract_by_path(client: &CdnClient, index: &Index, vpath: &str) -> Result<Vec<u8>, String> {
    let rec = index
        .lookup(vpath)
        .ok_or_else(|| format!("no such file in index: {vpath}"))?;
    let bundle_name = index.bundles[rec.bundle_index as usize].name.clone();
    eprintln!(
        "found in bundle {bundle_name} @ {} ({} bytes)",
        rec.offset, rec.size,
    );
    let (offset, size) = (rec.offset as usize, rec.size as usize);
    let local = client
        .fetch(&format!("Bundles2/{bundle_name}.bundle.bin"))
        .map_err(|e| e.to_string())?;
    let payload = bundle_decode::decompress_full(&local).map_err(|e| e.to_string())?;
    payload
        .get(offset..offset + size)
        .map(<[u8]>::to_vec)
        .ok_or_else(|| "file range exceeds decompressed bundle".to_string())
}

/// Like [`extract_by_path`] but caches each decompressed bundle payload
/// by name — for pulling many files that share a handful of bundles
/// (e.g. hundreds of tree icons) without re-decompressing. Quiet (no
/// per-file logging).
fn extract_cached(
    client: &CdnClient,
    index: &Index,
    vpath: &str,
    cache: &mut BTreeMap<String, Vec<u8>>,
) -> Result<Vec<u8>, String> {
    let rec = index
        .lookup(vpath)
        .ok_or_else(|| format!("no such file in index: {vpath}"))?;
    let bundle_name = index.bundles[rec.bundle_index as usize].name.clone();
    if !cache.contains_key(&bundle_name) {
        // Some bundle names contain spaces (e.g. "vaal skill icons");
        // percent-encode for the fetch URL.
        let local = client
            .fetch(&format!(
                "Bundles2/{}.bundle.bin",
                bundle_name.replace(' ', "%20")
            ))
            .map_err(|e| e.to_string())?;
        let payload = bundle_decode::decompress_full(&local).map_err(|e| e.to_string())?;
        cache.insert(bundle_name.clone(), payload);
    }
    let payload = &cache[&bundle_name];
    let (offset, size) = (rec.offset as usize, rec.size as usize);
    payload
        .get(offset..offset + size)
        .map(<[u8]>::to_vec)
        .ok_or_else(|| "file range exceeds decompressed bundle".to_string())
}

// ---------------------------------------------------------------------
// native: typed table dump (dat-schema + .datc64 reader)
// ---------------------------------------------------------------------

pub fn dat(ctx: &Ctx, args: &[String]) -> Result<(), String> {
    let mut table_name: Option<String> = None;
    let mut only_col: Option<String> = None;
    let mut rows = 10usize;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--rows" => {
                rows = it
                    .next()
                    .and_then(|s| s.parse().ok())
                    .ok_or("--rows needs a number")?;
            }
            "--col" => only_col = Some(it.next().ok_or("--col needs a name")?.clone()),
            s if s.starts_with("--") => return Err(format!("unknown flag {s}")),
            s => table_name = Some(s.to_string()),
        }
    }
    let table_name = table_name.ok_or("usage: buildwright dat <Table> [--rows N] [--col NAME]")?;

    // dat-schema → the table's column layout.
    let schema_path = dat_schema_path(ctx)?;
    let src = std::fs::read_to_string(&schema_path).map_err(|e| e.to_string())?;
    let set = SchemaSet::from_json(&src).map_err(|e| e.to_string())?;
    let schema = set.table(&table_name).ok_or_else(|| {
        format!(
            "no PoE2 table '{table_name}' in dat-schema v{}",
            set.version
        )
    })?;

    // Locate + fetch the base (non-localized) .datc64 for this table.
    let client = CdnClient::connect().map_err(|e| e.to_string())?;
    let index = load_index(&client)?;
    let vpath = locate_table(&index, &table_name)?;
    eprintln!("table file : {vpath}");
    let bytes = extract_by_path(&client, &index, &vpath)?;

    let dat = Dat::parse(&bytes, schema).map_err(|e| e.to_string())?;
    println!(
        "{}  rows={}  cols={}  row_width={}  (dat-schema v{})",
        table_name,
        dat.row_count(),
        schema.columns.len(),
        schema.row_width(),
        set.version,
    );

    // Which columns to print: a single --col, else the first 6 named.
    let show: Vec<usize> = match &only_col {
        Some(name) => vec![
            schema
                .column(name)
                .ok_or_else(|| format!("table {table_name} has no column '{name}'"))?,
        ],
        None => (0..schema.columns.len())
            .filter(|&i| schema.columns[i].name.is_some())
            .take(6)
            .collect(),
    };
    let named_total = schema.columns.iter().filter(|c| c.name.is_some()).count();
    if only_col.is_none() && named_total > show.len() {
        ui::note(
            ctx.style,
            &format!(
                "showing {}/{named_total} named columns (--col NAME for others)",
                show.len()
            ),
        );
    }
    // `dat` is a quick diagnostic dump — no reference resolution (that
    // needs loading every referenced table); foreign ids show as #rowid.
    let refs = mine::RefMap::new();
    for r in 0..rows.min(dat.row_count()) {
        let cells: Vec<String> = show
            .iter()
            .map(|&c| {
                format!(
                    "{}={}",
                    schema.columns[c].name.as_deref().unwrap_or("?"),
                    mine::render_cell(&dat, schema, r, c, &refs),
                )
            })
            .collect();
        println!("  [{r}] {}", cells.join("  "));
    }
    Ok(())
}

/// Tables `buildwright mine` pulls by default — the ones relevant to
/// our domain that parse cleanly today. Override with `--tables`.
const DEFAULT_TABLES: &[&str] = &[
    "PassiveSkills",
    "PassiveSkillMasteryGroups",
    "PassiveSkillMasteryEffects",
    "PassiveSkillTreeMasteryArt",
    "BaseItemTypes",
    "ItemClasses",
    "Stats",
    "Mods",
    "ModType",
    "GrantedEffects",
    "GrantedEffectsPerLevel",
    "ActiveSkills",
    "SkillGems",
    // Item-granted skills + the spirit economy (docs/next-data-targets.md).
    "ItemSpirit",
    "ItemInherentSkills",
    "UniqueStashLayout",
    "ModGrantedSkills",
    "GrantedSkillSocketNumbers",
];

/// Systematically export a set of GGG tables to first-party TSVs — the
/// repeatable "load a new patch through the miner" step. Writes each
/// table to `data/parsed/<patch>_native/dat/<Table>.tsv` (a sibling of
/// the PoB-derived data, so `buildwright diff` can cross-validate), then
/// `manifest`/`verify` hash it like everything else. Tables that aren't
/// in the schema, aren't in the index, or don't fit their schema are
/// skipped with a warning rather than aborting the run.
pub fn mine(ctx: &Ctx, args: &[String]) -> Result<(), String> {
    let patch = resolve_patch(ctx, args)?;
    let (_, rest) = take_patch(args);

    let mut tables: Option<Vec<String>> = None;
    let mut out_override: Option<String> = None;
    let mut it = rest.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--tables" => {
                tables = Some(
                    it.next()
                        .ok_or("--tables needs a comma-separated list")?
                        .split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect(),
                );
            }
            "--out" => out_override = Some(it.next().ok_or("--out needs a path")?.clone()),
            other if other.starts_with("--") => return Err(format!("unknown flag {other}")),
            _ => {}
        }
    }
    let table_list =
        tables.unwrap_or_else(|| DEFAULT_TABLES.iter().map(|s| s.to_string()).collect());

    // Schema + live index.
    let schema_path = dat_schema_path(ctx)?;
    let set =
        SchemaSet::from_json(&std::fs::read_to_string(&schema_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let client = CdnClient::connect().map_err(|e| e.to_string())?;
    let index = load_index(&client)?;

    // Resolve every .datc64 path once → base filename → ranked
    // candidates. Avoids re-walking 4M paths per table.
    let paths = resolve_table_paths(&index)?;

    let out_dir = match out_override {
        Some(o) => ctx.root.join(o),
        None => ctx
            .root
            .join("data/parsed")
            .join(format!("{patch}_native"))
            .join("dat"),
    };
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

    // Every table referenced (foreignrow) by the export set — we resolve
    // those ids to the target's Id string, so collect + load them too.
    let mut referenced: BTreeSet<String> = BTreeSet::new();
    for name in &table_list {
        if let Some(schema) = set.table(name) {
            for c in &schema.columns {
                if let Some(t) = &c.references {
                    referenced.insert(t.clone());
                }
            }
        }
    }

    // Decompress each needed table once (export set ∪ referenced), keyed
    // by name, so a table that's both exported and referenced loads once.
    // Values carry the schema that autofit settled on for the copy that
    // parsed — later decode MUST reuse it, not the raw schema.
    let mut bytes_cache: BTreeMap<String, (Vec<u8>, data_miner::dat::TableSchema)> =
        BTreeMap::new();
    for name in table_list.iter().chain(referenced.iter()) {
        if bytes_cache.contains_key(name) {
            continue;
        }
        let Some(schema) = set.table(name) else {
            continue;
        };
        let base = format!("{}.datc64", name.to_ascii_lowercase());
        let cands = paths.get(&base).map(Vec::as_slice).unwrap_or(&[]);
        if let Ok(pair) = extract_parseable(&client, &index, name, cands, schema) {
            bytes_cache.insert(name.clone(), pair);
        }
    }

    // Build the RefMap: target table → Id per row index.
    let mut refs: mine::RefMap = mine::RefMap::new();
    for name in &referenced {
        if let Some((b, schema)) = bytes_cache.get(name)
            && let Ok(dat) = Dat::parse(b, schema)
        {
            refs.insert(name.clone(), mine::id_column(&dat, schema));
        }
    }

    let (mut done, mut skipped) = (0usize, 0usize);
    for name in &table_list {
        if set.table(name).is_none() {
            ui::warn(ctx.style, &format!("{name}: not in dat-schema — skipped"));
            skipped += 1;
            continue;
        }
        let Some((dat_bytes, schema)) = bytes_cache.get(name) else {
            ui::warn(
                ctx.style,
                &format!("{name}: no decodable copy in the index — skipped"),
            );
            skipped += 1;
            continue;
        };
        let dat = match Dat::parse(dat_bytes, schema) {
            Ok(d) => d,
            Err(e) => {
                ui::warn(ctx.style, &format!("{name}: {e} — skipped"));
                skipped += 1;
                continue;
            }
        };
        let named = schema.columns.iter().filter(|c| c.name.is_some()).count();
        let tsv = mine::export_tsv(&dat, schema, &refs);
        let out_path = out_dir.join(format!("{name}.tsv"));
        std::fs::write(&out_path, tsv).map_err(|e| format!("write {}: {e}", out_path.display()))?;
        ui::ok(
            ctx.style,
            &format!("{name}: {} rows × {named} cols", dat.row_count()),
        );
        done += 1;
    }

    // Provenance marker on the native patch dir.
    if let Some(root) = out_dir.parent() {
        let _ = std::fs::write(root.join(".source"), "first-party\n");
    }
    let shown = out_dir.strip_prefix(&ctx.root).unwrap_or(&out_dir);
    ui::ok(
        ctx.style,
        &format!(
            "mined {done} tables ({skipped} skipped, cdn {}) → {}",
            client.info.version,
            shown.display(),
        ),
    );
    ui::note(
        ctx.style,
        &format!("hash + index it: buildwright manifest --patch {patch}_native"),
    );
    Ok(())
}

/// Map lowercased `<name>.datc64` → ALL its resolved index paths,
/// best [`table_path_rank`] first, in one walk of the index. Callers
/// try candidates in order because a single "best" path is not always
/// usable: at transitional patches the newest copy (`data/balance/`)
/// can be a format ahead of the community dat-schema while the
/// lingering pre-move copy (`data/`) still parses.
fn resolve_table_paths(index: &Index) -> Result<BTreeMap<String, Vec<String>>, String> {
    let mut paths: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (path, _) in index.resolve_paths().map_err(|e| e.to_string())? {
        let lp = path.to_ascii_lowercase();
        if !lp.ends_with(".datc64") {
            continue;
        }
        if let Some(base) = lp.rsplit('/').next() {
            paths.entry(base.to_string()).or_default().push(path);
        }
    }
    for cands in paths.values_mut() {
        cands.sort_by_key(|p| table_path_rank(p));
    }
    Ok(paths)
}

/// Extract the newest copy of a table that actually PARSES: try each
/// candidate path in rank order, autofit the schema against its bytes,
/// and return the first `(bytes, fitted_schema)` that `Dat::parse`
/// accepts — logging when a newer-but-undecodable copy was skipped.
fn extract_parseable(
    client: &CdnClient,
    index: &Index,
    name: &str,
    candidates: &[String],
    schema: &data_miner::dat::TableSchema,
) -> Result<(Vec<u8>, data_miner::dat::TableSchema), String> {
    let mut last_err = format!("{name}: no candidate paths in index");
    for (i, vpath) in candidates.iter().enumerate() {
        let bytes = match extract_by_path(client, index, vpath) {
            Ok(b) => b,
            Err(e) => {
                last_err = format!("{name}: {vpath}: {e}");
                continue;
            }
        };
        let fitted = data_miner::dat::autofit(&bytes, schema).unwrap_or_else(|| schema.clone());
        match Dat::parse(&bytes, &fitted) {
            Ok(_) => {
                if i > 0 {
                    eprintln!(
                        "note: {name}: newest copy undecodable with current dat-schema — using older {vpath}"
                    );
                }
                return Ok((bytes, fitted));
            }
            Err(e) => last_err = format!("{name}: {vpath}: {e}"),
        }
    }
    Err(last_err)
}

/// Shape raw GGG tables into one of the site's datasets (first-party).
/// Loads the dataset's source tables into a `TableSet`, runs the shaper,
/// and writes to `data/parsed/<patch>_native/<dataset path>`.
/// The passive tree: read `metadata/passiveskillgraph.psg` (geometry +
/// topology), join `PassiveSkills`/`Ascendancy` metadata, and write
/// `tree/{nodes,edges,meta}.tsv` under `data/parsed/<patch>_native/`.
/// Self-contained fetch path — not a `.datc64` table join.
/// GGG's official skill-tree export, pinned for reproducibility. Bump when
/// adopting a new patch's tree; the manifest records the effective commit.
const TREE_EXPORT_REPO: &str = "grindinggear/poe2-skilltree-export";
const TREE_EXPORT_COMMIT: &str = "1e9eb2d8c1946398c3aaaacfbaead5c75c0d1fa6";

/// Tree dispatcher. `--source datajson` (default) parses GGG's official
/// export (exact, current); `--source psg` uses the bundle-derived `.psg`
/// reader (game-accurate fallback, current the instant a patch drops).
fn shape_tree_cmd(ctx: &Ctx, patch: &str, args: &[String]) -> Result<(), String> {
    let mut source = "datajson".to_string();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--source" {
            source = it.next().cloned().unwrap_or(source);
        }
    }
    match source.as_str() {
        "datajson" | "ggg" | "export" => shape_tree_datajson(ctx, patch),
        "psg" | "bundle" => shape_tree_psg(ctx, patch),
        other => Err(format!(
            "unknown tree source '{other}' (use: datajson | psg)"
        )),
    }
}

/// First-party tree from the CDN bundle's `.psg` graph (fallback source).
fn shape_tree_psg(ctx: &Ctx, patch: &str) -> Result<(), String> {
    let schema_path = dat_schema_path(ctx)?;
    let set =
        SchemaSet::from_json(&std::fs::read_to_string(&schema_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let client = CdnClient::connect().map_err(|e| e.to_string())?;
    let index = load_index(&client)?;
    let paths = resolve_table_paths(&index)?;

    // The graph file itself (not a table — fetched by its metadata path).
    let psg_bytes = extract_by_path(&client, &index, "metadata/passiveskillgraph.psg")?;
    let graph = data_miner::psg::Graph::parse(&psg_bytes, &data_miner::shape::SKILLS_PER_ORBIT)
        .map_err(|e| e.to_string())?;
    ui::note(
        ctx.style,
        &format!(
            "psg: version {} · {} groups · {} nodes · {} bytes unparsed",
            graph.version,
            graph.groups.len(),
            graph.nodes.len(),
            graph.unparsed_bytes,
        ),
    );

    // Metadata tables (PassiveSkills keyed by graph id; Ascendancy for
    // readable ascendancy ids).
    let mut ts = data_miner::shape::TableSet::new();
    for name in data_miner::shape::TREE_TABLES {
        let Some(schema) = set.table(name) else {
            ui::warn(ctx.style, &format!("{name}: not in dat-schema — skipped"));
            continue;
        };
        let base = format!("{}.datc64", name.to_ascii_lowercase());
        let cands = paths.get(&base).map(Vec::as_slice).unwrap_or(&[]);
        match extract_parseable(&client, &index, name, cands, schema) {
            Ok((bytes, fitted)) => ts.insert(name, bytes, fitted),
            Err(e) => ui::warn(ctx.style, &format!("{e} — skipped")),
        }
    }

    // Stat-description files (master + passive override) → rendered text.
    let mut sd = data_miner::csd::StatDescriptions::new();
    for path in data_miner::shape::TREE_STAT_CSD {
        match extract_by_path(&client, &index, path) {
            Ok(bytes) => sd.parse(&data_miner::csd::StatDescriptions::decode_utf16(&bytes)),
            Err(e) => ui::warn(ctx.style, &format!("{path}: {e} — stat text degraded")),
        }
    }

    let tree = data_miner::shape::shape_tree(&graph, &ts, &sd).map_err(|e| e.to_string())?;
    let dir = ctx
        .root
        .join("data/parsed")
        .join(format!("{patch}_native"))
        .join("tree");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for (name, body) in [
        ("nodes.tsv", &tree.nodes),
        ("edges.tsv", &tree.edges),
        ("meta.tsv", &tree.meta),
    ] {
        let p = dir.join(name);
        std::fs::write(&p, body).map_err(|e| format!("write {}: {e}", p.display()))?;
    }
    let nnodes = tree.nodes.lines().count().saturating_sub(1);
    let nedges = tree.edges.lines().count().saturating_sub(1);
    ui::ok(
        ctx.style,
        &format!(
            "shaped tree: {nnodes} nodes, {nedges} edges → {}",
            dir.display()
        ),
    );
    Ok(())
}

/// Fetch a URL to a String via `curl` (same dependency the CDN client uses).
fn fetch_url(url: &str) -> Result<String, String> {
    let out = std::process::Command::new("curl")
        .args(["-sSL", "--max-time", "90", url])
        .output()
        .map_err(|e| format!("curl: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "curl {url}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    String::from_utf8(out.stdout).map_err(|e| format!("{url}: non-utf8 body ({e})"))
}

/// `ascendancy internal id → PassiveTreeImage` (.dds) from the CDN
/// `Ascendancy` table — the backdrop art the JSON references only by
/// sprite key. Best-effort: an empty map just means no asc backdrops.
fn load_asc_art(ctx: &Ctx) -> Result<data_miner::tree_json::AscArt, String> {
    let schema_path = dat_schema_path(ctx)?;
    let set =
        SchemaSet::from_json(&std::fs::read_to_string(&schema_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let schema = set
        .table("Ascendancy")
        .ok_or("Ascendancy not in dat-schema")?;
    let client = CdnClient::connect().map_err(|e| e.to_string())?;
    let index = load_index(&client)?;
    let vpath = locate_table(&index, "Ascendancy")?;
    let bytes = extract_by_path(&client, &index, &vpath)?;
    let schema = data_miner::dat::autofit(&bytes, schema).unwrap_or_else(|| schema.clone());
    let dat = Dat::parse(&bytes, &schema).map_err(|e| e.to_string())?;
    let mut art = data_miner::tree_json::AscArt::new();
    if let (Some(cid), Some(cimg)) = (schema.column("Id"), schema.column("PassiveTreeImage")) {
        for r in 0..dat.row_count() {
            if let (Ok(id), Ok(img)) = (dat.string(r, cid), dat.string(r, cimg))
                && !id.is_empty()
                && !img.is_empty()
            {
                art.insert(id, img);
            }
        }
    }
    Ok(art)
}

/// Primary tree source: GGG's official `data.json` export (exact + current).
/// Resolve variant-ascendancy node overrides (AscendancyPassiveSkillOverrides
/// ⋈ PassiveSkills ⋈ Ascendancy, stats via CSD) and write
/// `tree/asc_overrides.tsv` next to the shaped tree.
fn emit_asc_overrides(ctx: &Ctx, dir: &Path) -> Result<(), String> {
    let schema_path = dat_schema_path(ctx)?;
    let set =
        SchemaSet::from_json(&std::fs::read_to_string(&schema_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let client = CdnClient::connect().map_err(|e| e.to_string())?;
    let index = load_index(&client)?;
    let paths = resolve_table_paths(&index)?;
    let mut ts = data_miner::shape::TableSet::new();
    for name in ["AscendancyPassiveSkillOverrides", "PassiveSkills", "Ascendancy", "Characters", "Stats"] {
        let schema = set.table(name).ok_or_else(|| format!("{name}: not in schema"))?;
        let base = format!("{}.datc64", name.to_ascii_lowercase());
        let cands = paths.get(&base).map(Vec::as_slice).unwrap_or(&[]);
        let (bytes, schema) = extract_parseable(&client, &index, name, cands, schema)?;
        ts.insert(name, bytes, schema);
    }
    let mut sd = data_miner::csd::StatDescriptions::new();
    for path in data_miner::shape::TREE_STAT_CSD {
        if let Ok(bytes) = extract_by_path(&client, &index, path) {
            sd.parse(&data_miner::csd::StatDescriptions::decode_utf16(&bytes));
        }
    }
    let tsv = data_miner::shape::shape_asc_overrides(&ts, &sd)?;
    let p = dir.join("asc_overrides.tsv");
    std::fs::write(&p, &tsv).map_err(|e| format!("write {}: {e}", p.display()))?;
    ui::note(
        ctx.style,
        &format!("{} variant-asc node overrides → tree/asc_overrides.tsv", tsv.lines().count().saturating_sub(1)),
    );
    Ok(())
}

fn shape_tree_datajson(ctx: &Ctx, patch: &str) -> Result<(), String> {
    let url =
        format!("https://raw.githubusercontent.com/{TREE_EXPORT_REPO}/{TREE_EXPORT_COMMIT}/data.json");
    ui::note(ctx.style, &format!("GGG export: {url}"));
    let body = fetch_url(&url)?;
    let data = json::parse(&body).map_err(|e| format!("data.json parse: {e}"))?;

    // Ascendancy backdrop art (best-effort — the tree still shapes without it).
    let asc_art = match load_asc_art(ctx) {
        Ok(a) => a,
        Err(e) => {
            ui::warn(ctx.style, &format!("asc backdrop art: {e} — skipped"));
            data_miner::tree_json::AscArt::new()
        }
    };

    let tree = data_miner::tree_json::shape_tree_json(&data, &asc_art)?;

    let dir = ctx
        .root
        .join("data/parsed")
        .join(format!("{patch}_native"))
        .join("tree");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for (name, out) in [
        ("nodes.tsv", &tree.nodes),
        ("edges.tsv", &tree.edges),
        ("meta.tsv", &tree.meta),
    ] {
        let p = dir.join(name);
        std::fs::write(&p, out).map_err(|e| format!("write {}: {e}", p.display()))?;
    }

    // Variant-ascendancy node overrides (Abyssal Lich, and any future
    // ones). GGG's export contains NO nodes for these: the game reuses
    // the parent panel and swaps node CONTENT in place, mapped by the
    // AscendancyPassiveSkillOverrides table. Emit tree/asc_overrides.tsv:
    //   variant_display  class  parent_display  base_node_id
    //   override_node_id  name  stats(CSD-rendered)  icon  kind
    // Best-effort: a fetch failure just skips the sidecar.
    if let Err(e) = emit_asc_overrides(ctx, &dir) {
        ui::warn(ctx.style, &format!("asc overrides: {e} — skipped"));
    }

    // Provenance (hashed by the manifest → the pinned export commit is diffable).
    let mut prov = json::Map::new();
    prov.insert("dataset".into(), json::Value::Str("tree".into()));
    prov.insert("source".into(), json::Value::Str(format!("ggg:{TREE_EXPORT_REPO}")));
    prov.insert("commit".into(), json::Value::Str(TREE_EXPORT_COMMIT.into()));
    prov.insert("file".into(), json::Value::Str("data.json".into()));
    std::fs::write(
        dir.join("tree.source.json"),
        json::emit_pretty(&json::Value::Object(prov)) + "\n",
    )
    .map_err(|e| e.to_string())?;

    let nnodes = tree.nodes.lines().count().saturating_sub(1);
    let nedges = tree.edges.lines().count().saturating_sub(1);
    ui::ok(
        ctx.style,
        &format!(
            "shaped tree (GGG export @{}): {nnodes} nodes, {nedges} edges → {}",
            &TREE_EXPORT_COMMIT[..9],
            dir.display()
        ),
    );
    Ok(())
}

pub fn shape(ctx: &Ctx, args: &[String]) -> Result<(), String> {
    let patch = resolve_patch(ctx, args)?;
    let (_, rest) = take_patch(args);
    let dataset = rest
        .iter()
        .find(|a| !a.starts_with("--"))
        .ok_or("usage: buildwright shape <dataset> [--patch <p>]")?;

    // Which source tables + shaper + output path, per dataset.
    let (tables, out_rel): (&[&str], &str) = match dataset.as_str() {
        "bases" => (data_miner::shape::BASES_TABLES, "items/bases.tsv"),
        "grants" => (data_miner::shape::GRANTS_TABLES, "items/grants.tsv"),
        "jewels" => (data_miner::shape::JEWELS_TABLES, "tree/jewels.tsv"),
        "gems" => (data_miner::shape::GEMS_TABLES, "skills/gems.tsv"),
        "active_skills" => (
            data_miner::shape::ACTIVE_SKILLS_TABLES,
            "skills/active_skills.tsv",
        ),
        "support_skills" => (
            data_miner::shape::SUPPORT_SKILLS_TABLES,
            "skills/support_skills.tsv",
        ),
        "buffs" => (data_miner::shape::BUFFS_TABLES, "skills/buffs.tsv"),
        "mods" => (data_miner::shape::MODS_TABLES, "items/mods.tsv"),
        "skill_levels" => (
            data_miner::shape::SKILL_LEVELS_TABLES,
            "skills/skill_levels.tsv",
        ),
        "soul_cores" => (data_miner::shape::SOUL_CORES_TABLES, "items/soul_cores.tsv"),
        "gem_quality" => (
            data_miner::shape::GEM_QUALITY_TABLES,
            "skills/gem_quality.tsv",
        ),
        // Unique art IS first-party (unlike unique mod lists): the
        // UniqueStashLayout table names every unique and keys its
        // inventory art. Complements `buildwright uniques`.
        "unique_art" => (
            data_miner::shape::UNIQUE_ART_TABLES,
            "items/unique_art.tsv",
        ),
        // Deliberately not table-shapeable — GGG ships no source for these
        // (verified against dat-schema). Fail loudly with the real reason
        // rather than emit a misleading partial file.
        "uniques" => {
            return Err(
                "uniques isn't a table shape — a unique's fixed mod list is the one thing \
                 GGG ships no source for (applied server-side at item generation). It has \
                 its own command: `buildwright uniques`, which reads only PoB's pinned \
                 `Export/Uniques/*.lua` mod-id recipe and resolves every id against our \
                 first-party items/mods.tsv + statdescriptions. See \
                 docs/native-data-miner.md § Uniques."
                    .to_string(),
            );
        }
        // The tree needs the .psg graph file plus tables, so it has its
        // own fetch/emit path (three output files) rather than the
        // generic single-table flow below.
        "tree" => return shape_tree_cmd(ctx, &patch, &rest),
        other => {
            return Err(format!(
                "unknown dataset '{other}' (known: bases, gems, active_skills, \
                 support_skills, buffs; uniques + tree are intentionally deferred — run them \
                 to see why)"
            ));
        }
    };

    let schema_path = dat_schema_path(ctx)?;
    let set =
        SchemaSet::from_json(&std::fs::read_to_string(&schema_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let client = CdnClient::connect().map_err(|e| e.to_string())?;
    let index = load_index(&client)?;
    let paths = resolve_table_paths(&index)?;

    // Load every source table once into the TableSet.
    let mut ts = data_miner::shape::TableSet::new();
    for name in tables {
        let Some(schema) = set.table(name) else {
            ui::warn(ctx.style, &format!("{name}: not in dat-schema — skipped"));
            continue;
        };
        let base = format!("{}.datc64", name.to_ascii_lowercase());
        let cands = paths.get(&base).map(Vec::as_slice).unwrap_or(&[]);
        match extract_parseable(&client, &index, name, cands, schema) {
            Ok((bytes, fitted)) => {
                if fitted.row_width() != schema.row_width() {
                    ui::note(
                        ctx.style,
                        &format!(
                            "{name}: schema drift {:+}B — auto-fit",
                            fitted.row_width() as i64 - schema.row_width() as i64
                        ),
                    );
                }
                ts.insert(name, bytes, fitted);
            }
            Err(e) => ui::warn(ctx.style, &format!("{e} — skipped")),
        }
    }

    let tsv = match dataset.as_str() {
        "bases" => data_miner::shape::shape_bases(&ts).map_err(|e| e.to_string())?,
        "grants" => data_miner::shape::shape_item_grants(&ts).map_err(|e| e.to_string())?,
        "jewels" => {
            // Keystone stat text renders through the same csd chain
            // the tree uses (best-effort — names/icons still ship if
            // the chain is unavailable).
            let mut sd = data_miner::csd::StatDescriptions::new();
            let mut seen = std::collections::HashSet::new();
            for path in data_miner::shape::TREE_STAT_CSD {
                let _ = load_csd_chain(&client, &index, path, &mut seen, &mut sd);
            }
            data_miner::shape::shape_jewels(&ts, Some(&sd)).map_err(|e| e.to_string())?
        }
        "gems" => data_miner::shape::shape_gems(&ts).map_err(|e| e.to_string())?,
        "active_skills" => {
            data_miner::shape::shape_active_skills(&ts).map_err(|e| e.to_string())?
        }
        "support_skills" => {
            data_miner::shape::shape_support_skills(&ts).map_err(|e| e.to_string())?
        }
        "buffs" => data_miner::shape::shape_buffs(&ts).map_err(|e| e.to_string())?,
        "mods" => data_miner::shape::shape_mods(&ts).map_err(|e| e.to_string())?,
        "skill_levels" => data_miner::shape::shape_skill_levels(&ts).map_err(|e| e.to_string())?,
        "soul_cores" => data_miner::shape::shape_soul_cores(&ts).map_err(|e| e.to_string())?,
        "gem_quality" => data_miner::shape::shape_gem_quality(&ts).map_err(|e| e.to_string())?,
        "unique_art" => data_miner::shape::shape_unique_art(&ts).map_err(|e| e.to_string())?,
        _ => unreachable!(),
    };

    let out_path = ctx
        .root
        .join("data/parsed")
        .join(format!("{patch}_native"))
        .join(out_rel);
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let rows = tsv.lines().count().saturating_sub(1);
    std::fs::write(&out_path, tsv).map_err(|e| format!("write {}: {e}", out_path.display()))?;
    ui::ok(
        ctx.style,
        &format!(
            "shaped {dataset}: {rows} rows → {}",
            out_path
                .strip_prefix(&ctx.root)
                .unwrap_or(&out_path)
                .display()
        ),
    );
    Ok(())
}

/// Rank candidate index paths for a table file — lower wins. GGG's
/// current home for tables is `data/balance/`, but STALE pre-move
/// copies linger at `data/` with outdated bytes (observed at 4.5.4.3:
/// `data/passiveskills.datc64` is an old, smaller table whose tail
/// rows are filler), and localized copies live a folder deeper
/// (`data/balance/thai/…`).
fn table_path_rank(path: &str) -> usize {
    let lp = path.to_ascii_lowercase();
    let segs = lp.matches('/').count();
    if lp.starts_with("data/balance/") && segs == 2 {
        0
    } else if lp.starts_with("data/") && segs == 1 {
        1
    } else {
        2 + segs
    }
}

/// Find the base (non-localized) `.datc64` for a table name: the
/// resolved path ending in `/<lower>.datc64` with the best
/// [`table_path_rank`].
fn locate_table(index: &Index, table: &str) -> Result<String, String> {
    let suffix = format!("/{}.datc64", table.to_ascii_lowercase());
    let mut best: Option<String> = None;
    for (path, _) in index.resolve_paths().map_err(|e| e.to_string())? {
        if path.to_ascii_lowercase().ends_with(&suffix) {
            let better = best
                .as_ref()
                .is_none_or(|b| table_path_rank(&path) < table_path_rank(b));
            if better {
                best = Some(path);
            }
        }
    }
    best.ok_or_else(|| {
        format!(
            "no '<…>/{}.datc64' in the index for table {table}",
            table.to_ascii_lowercase()
        )
    })
}

/// Fetch (and cache) the community dat-schema JSON; return its path.
fn dat_schema_path(ctx: &Ctx) -> Result<PathBuf, String> {
    const URL: &str =
        "https://github.com/poe-tool-dev/dat-schema/releases/latest/download/schema.min.json";
    let dir = cache_root().join("dat-schema");
    let path = dir.join("schema.min.json");
    if path.is_file() {
        return Ok(path);
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    ui::note(ctx.style, "fetching dat-schema (poe-tool-dev, latest)…");
    let part = path.with_extension("part");
    let ok = std::process::Command::new("curl")
        .args(["--fail", "--silent", "--show-error", "--location", "-o"])
        .arg(&part)
        .arg(URL)
        .status()
        .map_err(|e| format!("curl: {e}"))?
        .success();
    if !ok {
        let _ = std::fs::remove_file(&part);
        return Err("failed to download dat-schema".to_string());
    }
    std::fs::rename(&part, &path).map_err(|e| e.to_string())?;
    Ok(path)
}

fn cache_root() -> PathBuf {
    std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
        .unwrap_or_else(|| PathBuf::from(".cache"))
        .join("poe-buildwright")
}

// ---------------------------------------------------------------------
// native: mastery cluster mapping (exact, structural — no proximity)
// ---------------------------------------------------------------------

/// Derive the exact "which nodes light which mastery" mapping from the
/// tree structure and write `tree/masteries.tsv` (trigger_id →
/// mastery_id). A mastery's triggers are EXACTLY the nodes GGG connects
/// it to in the passive-tree `connections` graph (our edges.tsv, which
/// keeps mastery edges) — nothing more.
///
/// This is 100% data-derived: no proximity/group heuristic. An earlier
/// version also lit a mastery from every node sharing its geometric
/// position-group, which over-reached — a travel small merely passing
/// through the cluster's group would light the mastery even though GGG
/// never connects it. GGG's connections are near-entirely to the
/// cluster's notables (a handful of clusters connect a small that is a
/// genuine member); every mastery has at least one connection, so the
/// group fallback isn't needed. Reads only local `nodes.tsv` (kind) +
/// `edges.tsv` (connections) — no PoB dependency.
/// Pure core of the mastery derivation, kept separate so a unit test can
/// pin its one invariant: a mastery's triggers are EXACTLY its non-mastery
/// connection neighbours (GGG's edges) — never a node that merely shares
/// its geometric position-group. That perimeter heuristic has crept back
/// in three times; `tests::no_perimeter_lighting` + verify's ship-gate
/// check are the locks. Returns (sorted trigger→mastery links, count of
/// masteries with no trigger at all).
fn derive_mastery_links(
    kind: &BTreeMap<String, String>,
    adj: &BTreeMap<String, BTreeSet<String>>,
) -> (Vec<(String, String)>, usize) {
    let mut links: Vec<(String, String)> = Vec::new();
    let mut orphans = 0usize;
    for (id, k) in kind {
        if k != "mastery" {
            continue;
        }
        let mut cluster: BTreeSet<String> = BTreeSet::new();
        for nb in adj.get(id).into_iter().flatten() {
            if kind
                .get(nb)
                .map(String::as_str)
                .is_some_and(|k| k != "mastery")
            {
                cluster.insert(nb.clone());
            }
        }
        if cluster.is_empty() {
            orphans += 1;
        }
        for trig in cluster {
            links.push((trig, id.clone()));
        }
    }
    links.sort();
    (links, orphans)
}

pub fn masteries(ctx: &Ctx, args: &[String]) -> Result<(), String> {
    let patch = resolve_patch(ctx, args)?;
    let dir = ctx.root.join("data/parsed").join(&patch);
    let nodes_path = dir.join("tree/nodes.tsv");
    let nodes_text = std::fs::read_to_string(&nodes_path)
        .map_err(|e| format!("read {}: {e}", nodes_path.display()))?;

    // id → kind (from our extracted tree).
    let mut kind: BTreeMap<String, String> = BTreeMap::new();
    for line in nodes_text.lines().skip(1) {
        let c: Vec<&str> = line.split('\t').collect();
        if c.len() < 9 {
            continue;
        }
        kind.insert(c[0].to_string(), c[3].to_string());
    }

    // Undirected adjacency from our own tree/edges.tsv (first-party; no
    // PoB tree.json dependency). Edges are one-per-pair, so mirror both.
    let edges_path = dir.join("tree/edges.tsv");
    let edges_text = std::fs::read_to_string(&edges_path)
        .map_err(|e| format!("read {}: {e}", edges_path.display()))?;
    let mut adj: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for line in edges_text.lines().skip(1) {
        let c: Vec<&str> = line.split('\t').collect();
        if c.len() < 2 {
            continue;
        }
        let (a, b) = (c[0].to_string(), c[1].to_string());
        adj.entry(a.clone()).or_default().insert(b.clone());
        adj.entry(b).or_default().insert(a);
    }

    let masteries_seen = kind.values().filter(|k| k.as_str() == "mastery").count();
    let (links, orphans) = derive_mastery_links(&kind, &adj);

    // Self-check: refuse to write a trigger that isn't a real GGG
    // connection. Belt-and-suspenders against a future edit that
    // reintroduces a group/proximity source and bypasses
    // derive_mastery_links (verify enforces the same rule at ship time).
    if let Some((t, m)) = links
        .iter()
        .find(|(t, m)| !adj.get(m).is_some_and(|ns| ns.contains(t)))
    {
        return Err(format!(
            "mastery {m} lit by non-connected node {t} — perimeter regression; \
             mastery triggers must be GGG connections only"
        ));
    }

    let mut text = String::from("node_id\tmastery_id\n");
    for (trig, m) in &links {
        text.push_str(&format!("{trig}\t{m}\n"));
    }
    let out_path = dir.join("tree/masteries.tsv");
    std::fs::write(&out_path, text).map_err(|e| format!("write {}: {e}", out_path.display()))?;

    if orphans > 0 {
        ui::warn(
            ctx.style,
            &format!("{orphans} masteries have no trigger node (they can never light)"),
        );
    }
    ui::ok(
        ctx.style,
        &format!(
            "{} trigger→mastery links for {masteries_seen} masteries → tree/masteries.tsv",
            links.len(),
        ),
    );
    Ok(())
}

/// Flatten an icon path to a filesystem-safe sprite name: every
/// non-alphanumeric char → `_` (matches the viewer's sprite keys).
fn sprite_safe_name(icon: &str) -> String {
    icon.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

/// Map the renderer's frame/background sprite keys (from
/// `tree_render/frames.rs`) to their GGG `.dds` sources. GGG names frames
/// by state — `active` (allocated), `canallocate`, `normal`
/// (unallocated) — under the passive-skill-screen UI-image tree. Node
/// icons + mastery patterns are handled separately.
fn ui_sprite_map(asc_names: &[String]) -> Vec<(String, String)> {
    const UI: &str = "art/textures/interface/2d/2dart/uiimages/ingame/passiveskillscreen";
    let path = |stem: &str| format!("{UI}{stem}.dds");
    // (renderer state, GGG state).
    let states = [
        ("Allocated", "active"),
        ("Unallocated", "normal"),
        ("CanAllocate", "canallocate"),
    ];
    let mut m: Vec<(String, String)> = Vec::new();

    // Main node frames: keystone, notable, and the small "PSSkillFrame"
    // (also used by attribute/switchable/multichoice nodes).
    for (ptype, gtype) in [("Keystone", "keystone"), ("Notable", "notable")] {
        for (ps, gs) in states {
            m.push((
                format!("{ptype}Frame{ps}"),
                path(&format!("{gtype}frame{gs}")),
            ));
        }
    }
    m.push(("PSSkillFrame".into(), path("passiveframenormal")));
    m.push(("PSSkillFrameActive".into(), path("passiveframeactive")));

    // Jewel socket frame.
    for (ps, gs) in states {
        m.push((format!("JewelFrame{ps}"), path(&format!("jewelsocket{gs}"))));
    }

    // Ascendancy frames. GGG ships a bespoke frame only for a few
    // ascendancies; the rest reuse the tree notable/small frame, which is
    // the same ornate ring in-game. `frame_name` uses `Normal` (not
    // `Unallocated`) for the ascendancy off-state.
    let asc_states = [
        ("Allocated", "active"),
        ("Normal", "normal"),
        ("CanAllocate", "canallocate"),
    ];
    for asc in asc_names {
        for (ps, gs) in asc_states {
            m.push((
                format!("{asc}FrameLarge{ps}"),
                path(&format!("notableframe{gs}")),
            ));
            m.push((
                format!("{asc}FrameSmall{ps}"),
                path(&format!("passiveframe{gs}")),
            ));
        }
    }
    // Standalone anointable notables (+ a few special jewel sockets like
    // Sinister / Zarokh's Gift) carry GGG's "BlightedNotableFrame" overlay
    // in the tree data — legacy naming for what in PoE2 is the ornate
    // anoint large frame. It lives under a separate `anoint` prefix in the
    // same UI tree, and its off-state word is `normal` with the on-state
    // `allocated` (not the `active` the base notable frame uses).
    const UI_ANOINT: &str =
        "art/textures/interface/2d/2dart/uiimages/ingame/anointpassiveskillscreen";
    let apath = |stem: &str| format!("{UI_ANOINT}{stem}.dds");
    let anoint_states = [
        ("Allocated", "allocated"),
        ("Unallocated", "normal"),
        ("CanAllocate", "canallocate"),
    ];
    for (ps, gs) in anoint_states {
        m.push((
            format!("BlightedNotableFrame{ps}"),
            apath(&format!("framelarge{gs}")),
        ));
    }

    // (The tree backdrop `Background2` is per-class art — see the
    // class-portrait follow-on — not a single passiveskillscreen file.)
    m
}

/// Read a PNG's `(width, height)` from its IHDR chunk, or `None`.
fn png_dimensions(path: &Path) -> Option<(u32, u32)> {
    let data = std::fs::read(path).ok()?;
    if data.len() < 24 || &data[..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let w = u32::from_be_bytes(data.get(16..20)?.try_into().ok()?);
    let h = u32::from_be_bytes(data.get(20..24)?.try_into().ok()?);
    Some((w, h))
}

/// Decode every tree-node icon `.dds` from the CDN to a PNG under
/// `viewer/assets/sprites/`, and write `tree/sprites.tsv` (icon → png +
/// dims). First-party replacement for the PoB-derived sprite sheets.
pub fn sprites(ctx: &Ctx, args: &[String]) -> Result<(), String> {
    // Reads the patch dir directly (consistent with masteries/uniques/
    // manifest) — pass the `_native` patch, not the base.
    let patch = resolve_patch(ctx, args)?;
    let dir = ctx.root.join("data/parsed").join(&patch);
    let nodes_path = dir.join("tree/nodes.tsv");
    let nodes_text = std::fs::read_to_string(&nodes_path).map_err(|e| {
        format!(
            "read {} (run `shape tree` first): {e}",
            nodes_path.display()
        )
    })?;

    // Unique sprite refs: node icon (col 11) + mastery pattern
    // (active_effect, col 13), both 0-indexed.
    let mut icons: BTreeSet<String> = BTreeSet::new();
    for line in nodes_text.lines().skip(1) {
        let cols: Vec<&str> = line.split('\t').collect();
        for &i in &[11usize, 13] {
            if let Some(v) = cols.get(i)
                && !v.is_empty()
            {
                icons.insert(v.to_string());
            }
        }
    }
    // Gem inventory art (skills/gems.tsv icon_dds) — feeds the picker
    // and skills-strip icons via the catalogue's icon field.
    if let Ok(g) = std::fs::read_to_string(dir.join("skills/gems.tsv")) {
        let mut hdr = g.lines().next().unwrap_or("").split('\t');
        let icon_col = hdr.position(|h| h == "icon_dds");
        if let Some(ic) = icon_col {
            for line in g.lines().skip(1) {
                if let Some(v) = line.split('\t').nth(ic)
                    && !v.is_empty()
                {
                    icons.insert(v.to_string());
                }
            }
        }
    }
    // Unique inventory art (items/unique_art.tsv) — feeds the gear
    // strip/picker via item_catalogue's icon field.
    if let Ok(u) = std::fs::read_to_string(dir.join("items/unique_art.tsv")) {
        let mut hdr = u.lines().next().unwrap_or("").split('\t');
        if let Some(ic) = hdr.position(|h| h == "icon_dds") {
            for line in u.lines().skip(1) {
                if let Some(v) = line.split('\t').nth(ic)
                    && !v.is_empty()
                {
                    icons.insert(v.to_string());
                }
            }
        }
    }
    // Base-item inventory art (items/bases.tsv icon_dds) — EQUIPMENT
    // classes only; the full table is every item type in the game and
    // most of it never reaches a gear slot.
    if let Ok(b) = std::fs::read_to_string(dir.join("items/bases.tsv")) {
        const EQUIP_CLASSES: &[&str] = &[
            "Body Armour", "Helmet", "Gloves", "Boots", "Amulet", "Talisman",
            "Ring", "Belt", "One Hand Mace", "Two Hand Mace", "Sceptre",
            "Spear", "Bow", "Crossbow", "Wand", "Staff", "Warstaff",
            "Shield", "Buckler", "Focus", "Quiver", "LifeFlask", "ManaFlask",
            "UtilityFlask", "Jewel",
        ];
        let hdr: Vec<&str> = b.lines().next().unwrap_or("").split('\t').collect();
        let ic = hdr.iter().position(|h| *h == "icon_dds");
        let cc = hdr.iter().position(|h| *h == "item_class");
        if let (Some(ic), Some(cc)) = (ic, cc) {
            for line in b.lines().skip(1) {
                let cols: Vec<&str> = line.split('\t').collect();
                if let (Some(v), Some(class)) = (cols.get(ic), cols.get(cc))
                    && !v.is_empty()
                    && EQUIP_CLASSES.contains(class)
                {
                    icons.insert(v.to_string());
                }
            }
        }
    }
    // Variant-ascendancy override icons (asc_overrides.tsv col 8) — the
    // Abyssal node art isn't referenced by nodes.tsv.
    if let Ok(ov) = std::fs::read_to_string(dir.join("tree/asc_overrides.tsv")) {
        for line in ov.lines().skip(1) {
            if let Some(icon) = line.split('\t').nth(7)
                && !icon.is_empty()
            {
                icons.insert(icon.to_string());
            }
        }
    }
    ui::note(ctx.style, &format!("{} distinct sprites", icons.len()));

    let client = CdnClient::connect().map_err(|e| e.to_string())?;
    let index = load_index(&client)?;
    let assets = ctx.root.join("viewer/assets/sprites");
    std::fs::create_dir_all(&assets).map_err(|e| e.to_string())?;

    // Ascendancy display names (for per-ascendancy frame keys) from the
    // meta rows we shaped.
    let meta_text = std::fs::read_to_string(dir.join("tree/meta.tsv")).unwrap_or_default();
    let asc_names: Vec<String> = meta_text
        .lines()
        .filter_map(|l| l.strip_prefix("asc_internal\t"))
        .filter_map(|r| r.split('\t').next().map(str::to_string))
        .collect();

    // Jobs: (sprite key, candidate `.dds` paths). Node icons/patterns are
    // keyed by their own path and try both bundle roots; the UI frame/
    // background sprites are keyed by the renderer's name and map to one
    // GGG path each.
    let mut jobs: Vec<(String, Vec<String>)> = Vec::new();
    for icon in &icons {
        let low = icon.to_ascii_lowercase().replace(".png", ".dds");
        let ui = low
            .strip_prefix("art/")
            .map(|rest| format!("art/textures/interface/2d/{rest}"))
            .unwrap_or_else(|| low.clone());
        jobs.push((icon.clone(), vec![low, ui]));
    }
    for (key, path) in ui_sprite_map(&asc_names) {
        jobs.push((key, vec![path]));
    }

    let mut cache: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    let mut out = String::from("sprite_name\tpng\twidth\theight\n");
    let (mut ok, mut missing) = (0usize, 0usize);
    for (key, candidates) in &jobs {
        let bytes = match candidates
            .iter()
            .find_map(|p| extract_cached(&client, &index, p, &mut cache).ok())
        {
            Some(b) => b,
            None => {
                missing += 1;
                continue;
            }
        };
        let img = match data_miner::dds::decode(&bytes) {
            Ok(i) => i,
            Err(e) => {
                ui::warn(ctx.style, &format!("{key}: {e} — skipped"));
                missing += 1;
                continue;
            }
        };
        let png = data_miner::png::encode_rgba(img.width, img.height, &img.rgba);
        let png_name = format!("{}.png", sprite_safe_name(key));
        std::fs::write(assets.join(&png_name), &png)
            .map_err(|e| format!("write {png_name}: {e}"))?;
        out.push_str(&format!(
            "{key}\t{png_name}\t{}\t{}\n",
            img.width, img.height
        ));
        ok += 1;
    }

    // --- Connector arcs (synthesised) --------------------------------
    // GGG ships only the straight connector *line* texture; the renderer
    // samples per-orbit *arc* sprites whose curve is baked into the alpha
    // (see docs § Art pipeline). We bend the line cross-section into an
    // arc of the orbit's radius (arc.rs). Files are named exactly as the
    // renderer loads them: `<prefix>_orbit_<state><fileIdx>.png`.
    const UI: &str = "art/textures/interface/2d/2dart/uiimages/ingame/passiveskillscreen";
    // orbit → connector-file index (radius rank); index → sprite width;
    // orbit → arc radius in sprite pixels. Mirrors edge_tessellate.ts.
    let orbit_file_idx = [0usize, 9, 8, 6, 5, 4, 3, 7, 2, 1];
    let sprite_w = [1435u32, 1333, 1090, 853, 671, 501, 346, 263, 176, 91];
    let arc_r = [
        0.0f32, 82.0, 162.5, 333.5, 487.5, 657.0, 838.5, 250.5, 1077.0, 1318.0,
    ];
    let prefixes = ["Character", "CharacterPlanned", "CharacterAscendancy"];
    for (state, line_stem) in [
        ("normal", "linenormal"),
        ("intermediate", "lineintermediate"),
        ("intermediateactive", "lineactive"),
    ] {
        let line =
            match extract_cached(&client, &index, &format!("{UI}{line_stem}.dds"), &mut cache)
                .ok()
                .and_then(|b| data_miner::dds::decode(&b).ok())
            {
                Some(img) => img,
                None => {
                    ui::warn(
                        ctx.style,
                        &format!("{line_stem}: connector line missing — skipped"),
                    );
                    continue;
                }
            };
        let prof = data_miner::arc::line_profile(&line);
        for orbit in 0..10usize {
            let idx = orbit_file_idx[orbit];
            let w = sprite_w[idx];
            let img = if orbit == 0 {
                data_miner::arc::synth_line(&prof, w)
            } else {
                data_miner::arc::synth_arc(&prof, w, arc_r[orbit])
            };
            let png = data_miner::png::encode_rgba(img.width, img.height, &img.rgba);
            for prefix in prefixes {
                let name = format!("{prefix}_orbit_{state}{idx}.png");
                std::fs::write(assets.join(&name), &png)
                    .map_err(|e| format!("write {name}: {e}"))?;
                out.push_str(&format!("{name}\t{name}\t{}\t{}\n", img.width, img.height));
                ok += 1;
            }
        }
    }

    // --- Jewel art: socket-fill sprites + the radius circle ----------
    // GGG draws a socketed jewel INSIDE the socket node with a per-base
    // "JewelSocketActive…" texture, and radius jewels get the subtle
    // PassiveSkillScreenJewelCircle1 ring. Base → file stems verified
    // against the 4.5.4.3 index ("special" = the Time-Lost variants);
    // unique jewels' art comes from the PassiveJewelUniqueArt table.
    {
        let ui = "art/textures/interface/2d/2dart/uiimages/ingame/";
        let sanitize = |n: &str| -> String {
            n.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect()
        };
        let mut jobs: Vec<(String, String)> = vec![
            ("Jewel_ring.png".into(), format!("{ui}passiveskillscreenjewelcircle1.dds")),
            ("Jewel_glow.png".into(), format!("{ui}passiveskillscreenjeweleffectglow.dds")),
            // The plain "activated" socket frame — used to light
            // Voices-activated sinister sockets without a jewel.
            ("Jewel_socket_active.png".into(), format!("{ui}passiveskillscreenjewelsocketactive.dds")),
        ];
        for (base, stem) in [
            ("Ruby", "rubyjewel"),
            ("Emerald", "emeraldjewel"),
            ("Sapphire", "_sapphirejewel"),
            ("Diamond", "diamondbasejewel"),
            ("Time-Lost Ruby", "specialrubyjewel"),
            ("Time-Lost Emerald", "specialemeraldjewel"),
            ("Time-Lost Sapphire", "specialsapphirejewel"),
            ("Time-Lost Diamond", "diamondbasetimelost"),
            // timeless lives under the mtx/jewels/ subdir
            ("Timeless Jewel", "__MTX__timeless"),
        ] {
            jobs.push((
                format!("Jewel_{}.png", sanitize(base)),
                if let Some(m) = stem.strip_prefix("__MTX__") {
                    format!("{ui}mtx/jewels/passiveskillscreenjewelsocketactive{m}.dds")
                } else {
                    format!("{ui}passiveskillscreenjewelsocketactive{stem}.dds")
                },
            ));
        }
        // Timeless replacement-keystone icons (from the shaped
        // tree/jewels.tsv timeless rows) → TK_<Name>.png.
        if let Ok(raw) = std::fs::read_to_string(dir.join("tree/jewels.tsv")) {
            for line in raw.lines().skip(1) {
                let c: Vec<&str> = line.split('\t').collect();
                if c.first() != Some(&"timeless") || c.len() < 6 || c[5].is_empty() {
                    continue;
                }
                // SkillIcons live at their literal lowercased path
                // (no textures/interface prefix, unlike UIImages).
                let vpath = c[5].to_ascii_lowercase();
                jobs.push((format!("TK_{}.png", sanitize(c[1])), vpath));
            }
        }
        if let Ok((jh, jrows)) = read_tsv(&dir.join("dat/PassiveJewelUniqueArt.tsv")) {
            let col = |n: &str| jh.iter().position(|h| h == n);
            if let (Some(c_name), Some(c_art)) = (col("Name"), col("JewelArt")) {
                for r in &jrows {
                    let (Some(name), Some(art)) = (r.get(c_name), r.get(c_art)) else {
                        continue;
                    };
                    if name.is_empty() || art.is_empty() {
                        continue;
                    }
                    let vpath = art
                        .to_ascii_lowercase()
                        .replace("art/2dart/uiimages/", "art/textures/interface/2d/2dart/uiimages/")
                        + ".dds";
                    jobs.push((format!("Jewel_U_{}.png", sanitize(name)), vpath));
                }
            }
        }
        for (out_name, vpath) in jobs {
            match extract_cached(&client, &index, &vpath, &mut cache)
                .ok()
                .and_then(|b| data_miner::dds::decode(&b).ok())
            {
                Some(img) => {
                    let png = data_miner::png::encode_rgba(img.width, img.height, &img.rgba);
                    std::fs::write(assets.join(&out_name), &png)
                        .map_err(|e| format!("write {out_name}: {e}"))?;
                    out.push_str(&format!("{out_name}	{out_name}	{}	{}
", img.width, img.height));
                    ok += 1;
                }
                None => ui::warn(ctx.style, &format!("jewel art {vpath}: missing — skipped")),
            }
        }
    }

    // --- Class backdrops (portraits) ---------------------------------
    // Each PoE2 class's illustration is Characters.PassiveTreeImage =
    // Art/2DArt/BaseClassIllustrations/<Class>BaseIllustration.dds (the big
    // class portrait — the same field family as the ascendancy backdrops,
    // NOT the small start-node backdrop). The class name maps directly to
    // the file. Emits the sprite + a `portrait` meta row.
    let classes: &[&str] = &[
        "Warrior",
        "Witch",
        "Sorceress",
        "Ranger",
        "Huntress",
        "Mercenary",
        "Monk",
        "Druid",
    ];
    let mut portrait_rows = String::new();
    for class in classes {
        let path = format!(
            "art/2dart/baseclassillustrations/{}baseillustration.dds",
            class.to_ascii_lowercase()
        );
        let Some(img) = extract_cached(&client, &index, &path, &mut cache)
            .ok()
            .and_then(|b| data_miner::dds::decode(&b).ok())
        else {
            ui::warn(ctx.style, &format!("class backdrop {class} ({path}): missing"));
            continue;
        };
        let png = data_miner::png::encode_rgba(img.width, img.height, &img.rgba);
        let key = format!("Classes{class}");
        let png_name = format!("{key}.png");
        std::fs::write(assets.join(&png_name), &png)
            .map_err(|e| format!("write {png_name}: {e}"))?;
        out.push_str(&format!(
            "{key}\t{png_name}\t{}\t{}\n",
            img.width, img.height
        ));
        // Draw centred at the tree origin, ~2.4× the source (≈ PoB's
        // class-portrait footprint); the renderer centres it on (x,y).
        let (dw, dh) = (
            (img.width as f32 * 2.4) as u32,
            (img.height as f32 * 2.4) as u32,
        );
        portrait_rows.push_str(&format!(
            "portrait\tclass\t{class}\t{key}\t0\t0\t{dw}\t{dh}\n"
        ));
        ok += 1;
    }

    // --- Character FACE portraits ------------------------------------
    // The round face icons the game shows socially (party members,
    // character select, website avatars): uiimages/common/icon<attr
    // stem>[_<class><n>].dds. The unsuffixed file is the base class;
    // _<class>1/2/3 follow the Ascendancy table order (the same order
    // build_meta emits), and Witch's "3b" is the Abyssal Lich variant —
    // visually validated (3b decodes to the undead face). Keys are
    // Face<Name> with spaces/apostrophes stripped.
    const FACE_SETS: &[(&str, &str, &[&str])] = &[
        ("Warrior", "strfourb", &["Titan", "Warbringer", "Smith of Kitava"]),
        ("Witch", "intfour", &["Infernalist", "Blood Mage", "Lich"]),
        ("Sorceress", "intfourb", &["Stormweaver", "Chronomancer", "Disciple of Varashta"]),
        ("Ranger", "dexfour", &["Deadeye", "Pathfinder"]),
        ("Huntress", "dexfourb", &["Amazon", "Spirit Walker", "Ritualist"]),
        ("Mercenary", "strdexfourb", &["Tactician", "Witchhunter", "Gemling Legionnaire"]),
        ("Monk", "dexintfourb", &["Martial Artist", "Invoker", "Acolyte of Chayula"]),
        ("Druid", "strintfourb", &["Oracle", "Shaman"]),
    ];
    let mut face_jobs: Vec<(String, String)> = Vec::new(); // (display name, vpath)
    for (class, stem, ascs) in FACE_SETS {
        let base = "art/textures/interface/2d/2dart/uiimages/common";
        face_jobs.push((class.to_string(), format!("{base}/icon{stem}.dds")));
        for (i, asc) in ascs.iter().enumerate() {
            let class_l = class.to_ascii_lowercase();
            face_jobs.push((
                asc.to_string(),
                format!("{base}/icon{stem}_{class_l}{}.dds", i + 1),
            ));
        }
    }
    face_jobs.push((
        "Abyssal Lich".to_string(),
        "art/textures/interface/2d/2dart/uiimages/common/iconintfour_witch3b.dds".to_string(),
    ));
    for (name, path) in &face_jobs {
        let Some(img) = extract_cached(&client, &index, path, &mut cache)
            .ok()
            .and_then(|b| data_miner::dds::decode(&b).ok())
        else {
            ui::warn(ctx.style, &format!("face portrait {name} ({path}): missing"));
            continue;
        };
        let png = data_miner::png::encode_rgba(img.width, img.height, &img.rgba);
        let key = format!(
            "Face{}",
            name.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>()
        );
        let png_name = format!("{key}.png");
        std::fs::write(assets.join(&png_name), &png)
            .map_err(|e| format!("write {png_name}: {e}"))?;
        out.push_str(&format!("{key}\t{png_name}\t{}\t{}\n", img.width, img.height));
        ok += 1;
    }

    // --- Ascendancy backdrops (portraits) ----------------------------
    // Each ascendancy's illustration is `Ascendancy.PassiveTreeImage`
    // (Art/2DArt/BaseClassIllustrations/<Name>Ascendancy.dds), recorded on
    // the `asc_internal` meta rows by shape_tree. The renderer translates
    // an asc panel by -(p.x,p.y) and centres the portrait there, so the
    // anchor is that ascendancy's node-cluster centroid (our first-party
    // positions). Renderer doubles w/h, so emit the DDS native size.
    // Ascendancy START node position (group origin) per display name — the
    // real anchor: PoB places the backdrop at start + offset (verified:
    // portrait − start == the per-ascendancy offset exactly).
    let mut start_pos: BTreeMap<String, (f64, f64)> = BTreeMap::new();
    for line in nodes_text.lines().skip(1) {
        let c: Vec<&str> = line.split('\t').collect();
        if c.len() < 6 || c[5].is_empty() || c[3] != "asc_start" {
            continue;
        }
        if let (Ok(x), Ok(y)) = (c[1].parse::<f64>(), c[2].parse::<f64>()) {
            start_pos.insert(c[5].to_string(), (x, y));
        }
    }
    // internal id → display name (Witch3 → Lich) for the variant fallback;
    // node ascendancy columns carry the DISPLAY NAME, so the centroid map
    // (keyed off that column) is keyed by name too.
    let id2name: BTreeMap<&str, &str> = meta_text
        .lines()
        .filter_map(|l| l.strip_prefix("asc_internal\t"))
        .filter_map(|r| {
            let f: Vec<&str> = r.split('\t').collect();
            (f.len() >= 2).then_some((f[1], f[0]))
        })
        .collect();
    for line in meta_text.lines() {
        let Some(rest) = line.strip_prefix("asc_internal\t") else {
            continue;
        };
        // asc_internal <disp> <internal_id> <class> <image_path>
        let f: Vec<&str> = rest.split('\t').collect();
        if f.len() < 4 || f[3].is_empty() {
            continue;
        }
        let (disp, id, img) = (f[0], f[1], f[3]);
        // Variant ascendancies (Witch3b = Abyssal Lich) carry no nodes of
        // their own — they overlay the base ascendancy's cluster (Witch3 =
        // Lich), so fall back to the base ascendancy.
        let base_id = id.trim_end_matches(|c: char| c.is_ascii_lowercase());
        let base_name = id2name.get(base_id).copied().unwrap_or(base_id);
        // Panel anchor = ascendancy START node (group origin) + GGG's
        // per-ascendancy offset (asc_internal cols 5,6). The renderer draws
        // nodes at node-anchor and the backdrop at the anchor; PoB places it
        // at start + offset exactly (portrait − start == the offset).
        let ox: f64 = f.get(4).and_then(|s| s.parse().ok()).unwrap_or(0.0);
        let oy: f64 = f.get(5).and_then(|s| s.parse().ok()).unwrap_or(0.0);
        let Some(&(ax, ay)) = start_pos.get(disp).or_else(|| start_pos.get(base_name)) else {
            ui::warn(ctx.style, &format!("asc backdrop {disp}: no start node"));
            continue;
        };
        let (cx, cy) = (ax + ox, ay + oy);
        let path = img.to_ascii_lowercase();
        let Some(image) = extract_cached(&client, &index, &path, &mut cache)
            .ok()
            .and_then(|b| data_miner::dds::decode(&b).ok())
        else {
            ui::warn(ctx.style, &format!("asc backdrop {disp} ({path}): missing"));
            continue;
        };
        let png = data_miner::png::encode_rgba(image.width, image.height, &image.rgba);
        let key = format!("AscBg{id}");
        let png_name = format!("{key}.png");
        std::fs::write(assets.join(&png_name), &png).map_err(|e| format!("write {png_name}: {e}"))?;
        out.push_str(&format!("{key}\t{png_name}\t{}\t{}\n", image.width, image.height));
        portrait_rows.push_str(&format!(
            "portrait\tasc\t{disp}\t{key}\t{}\t{}\t{}\t{}\n",
            cx as i64, cy as i64, image.width, image.height
        ));
        ok += 1;
    }

    // Fold the portrait rows into meta.tsv (idempotent: drop any existing
    // first). meta is hashed after this by `manifest`.
    if !portrait_rows.is_empty() {
        let meta_path = dir.join("tree/meta.tsv");
        let existing = std::fs::read_to_string(&meta_path).unwrap_or_default();
        let mut meta: String = existing
            .lines()
            .filter(|l| !l.starts_with("portrait\t"))
            .map(|l| format!("{l}\n"))
            .collect();
        meta.push_str(&portrait_rows);
        std::fs::write(&meta_path, meta)
            .map_err(|e| format!("write {}: {e}", meta_path.display()))?;
    }

    // Shared UI backdrops/frames the renderer looks up by fixed key: the
    // central tree background (Background2 / BGTree / BGTreeActive), the
    // ascendancy-start glyph (AscendancyMiddle) and ascendancy node frames.
    // GGG ships these in its EXPORT sprite sheets (not the DDS bundles), so
    // they're decoded to viewer/assets/sprites/ by the sprite-asset
    // extractor; emit a row for each present PNG so the renderer resolves
    // them. (Bridged from the export sheets; a native webp-sheet decoder is
    // a follow-up — the PNGs are still GGG's own art.)
    const UI_BACKDROPS: &[&str] = &[
        "Background2",
        "BGTree",
        "BGTreeActive",
        "AscendancyMiddle",
        "AscendancyFrameNormalAllocated",
        "AscendancyFrameNormalCanAllocate",
        "AscendancyFrameNormalUnallocated",
        "AscendancyFrameNormalBacking",
        "AscendancyFrameNotableAllocated",
        "AscendancyFrameNotableCanAllocate",
        "AscendancyFrameNotableUnallocated",
        "AscendancyFrameNotableBacking",
    ];
    let mut bridged = 0;
    for key in UI_BACKDROPS {
        if out.lines().any(|l| l.starts_with(&format!("{key}\t"))) {
            continue;
        }
        let png = assets.join(format!("{key}.png"));
        if let Some((w, h)) = png_dimensions(&png) {
            out.push_str(&format!("{key}\t{key}.png\t{w}\t{h}\n"));
            bridged += 1;
        }
    }
    if bridged > 0 {
        ui::note(
            ctx.style,
            &format!("{bridged} UI backdrops/frames bridged from export sheets"),
        );
    }

    let out_path = dir.join("tree/sprites.tsv");
    std::fs::write(&out_path, &out).map_err(|e| format!("write {}: {e}", out_path.display()))?;
    ui::ok(
        ctx.style,
        &format!(
            "{ok} icons decoded → {} + tree/sprites.tsv ({missing} unresolved)",
            assets.display()
        ),
    );
    Ok(())
}

// ---------------------------------------------------------------------
// native: manifest (integrity) + verify (integrity gate)
// ---------------------------------------------------------------------

/// Resolve the patch dir name: `--patch <p>`, else the CURRENT symlink.
fn resolve_patch(ctx: &Ctx, args: &[String]) -> Result<String, String> {
    let (patch, _) = take_patch(args);
    if let Some(p) = patch {
        return Ok(p);
    }
    std::fs::read_link(ctx.root.join("data/parsed/CURRENT"))
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .ok_or_else(|| "no --patch given and data/parsed/CURRENT is not a symlink".to_string())
}

// ---------------------------------------------------------------------
// uniques — the one PoB-pinned dataset, resolved against first-party data
// ---------------------------------------------------------------------

/// Load `items/mods.tsv` into `mod_id → [(stat_id, lo, hi)]`. The `stats`
/// column is space-separated `stat_id:lo:hi` tokens (stat ids carry no
/// colon, so we split from the right).
fn load_mod_stats(mods_tsv: &str) -> BTreeMap<String, Vec<(String, i64, i64)>> {
    let mut out: BTreeMap<String, Vec<(String, i64, i64)>> = BTreeMap::new();
    let Some(header) = mods_tsv.lines().next() else {
        return out;
    };
    let cols: Vec<&str> = header.split('\t').collect();
    let id_i = cols.iter().position(|c| *c == "id").unwrap_or(0);
    let stats_i = cols.iter().position(|c| *c == "stats").unwrap_or(8);
    for line in mods_tsv.lines().skip(1) {
        let c: Vec<&str> = line.split('\t').collect();
        let (Some(id), Some(stats)) = (c.get(id_i), c.get(stats_i)) else {
            continue;
        };
        let mut parsed = Vec::new();
        // The `stats` column is `|`-separated `stat_id:lo:hi` entries
        // (stat ids carry no colon, so split id/lo/hi from the right).
        for tok in stats.split('|').filter(|t| !t.is_empty()) {
            let mut it = tok.rsplitn(3, ':');
            let hi = it.next().and_then(|s| s.parse::<i64>().ok());
            let lo = it.next().and_then(|s| s.parse::<i64>().ok());
            let sid = it.next();
            if let (Some(sid), Some(lo), Some(hi)) = (sid, lo, hi) {
                parsed.push((sid.to_string(), lo, hi));
            }
        }
        out.insert(id.to_string(), parsed);
    }
    out
}

/// Render one unique mod's stat lines. A `[lo,hi]` roll override pins the
/// mod's primary (first) stat range; the rest keep their pool ranges.
fn render_unique_mod(
    sd: &data_miner::csd::StatDescriptions,
    stats: &[(String, i64, i64)],
    roll: Option<(i64, i64)>,
) -> Vec<String> {
    let mut s = stats.to_vec();
    if let (Some((lo, hi)), Some(first)) = (roll, s.first_mut()) {
        first.1 = lo;
        first.2 = hi;
    }
    sd.render_ranges(&s)
}

/// Read the pinned `data/pob2` HEAD commit (full sha), or `"unknown"`.
fn pob_commit(pob_root: &Path) -> String {
    std::process::Command::new("git")
        .arg("-C")
        .arg(pob_root)
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Load a .csd and its `include "…"` ancestors (depth-first, so the
/// requested file's definitions override) into one StatDescriptions.
fn load_csd_chain(
    client: &CdnClient,
    index: &Index,
    vpath: &str,
    seen: &mut std::collections::HashSet<String>,
    sd: &mut data_miner::csd::StatDescriptions,
) -> Result<(), String> {
    let key = vpath.to_ascii_lowercase();
    if !seen.insert(key) {
        return Ok(());
    }
    let bytes = extract_by_path(client, index, vpath).map_err(|e| format!("{vpath}: {e}"))?;
    let text = data_miner::csd::StatDescriptions::decode_utf16(&bytes);
    for line in text.lines().take(64) {
        let l = line.trim_start_matches('\u{feff}').trim();
        if let Some(inc) = l.strip_prefix("include \"") {
            let inc = inc.trim_end_matches('"').replace('\\', "/").to_ascii_lowercase();
            load_csd_chain(client, index, &inc, seen, sd)?;
        }
    }
    sd.parse(&text);
    Ok(())
}

/// Dev probe: render `stat:lo[:hi]` triples through a .csd file. The
/// validation path for per-skill / per-part stat rendering.
pub fn csd_render(ctx: &Ctx, args: &[String]) -> Result<(), String> {
    let path = args
        .first()
        .ok_or("usage: buildwright csd <file.csd> <stat:lo[:hi]>…")?;
    let stats: Vec<(String, i64, i64)> = args[1..]
        .iter()
        .filter(|a| !a.starts_with("--"))
        .filter_map(|a| {
            let mut it = a.rsplitn(3, ':');
            let last = it.next()?;
            let mid = it.next();
            let head = it.next();
            match (head, mid) {
                (Some(id), Some(lo)) => {
                    Some((id.to_string(), lo.parse().ok()?, last.parse().ok()?))
                }
                (None, Some(id)) => {
                    let v: i64 = last.parse().ok()?;
                    Some((id.to_string(), v, v))
                }
                _ => None,
            }
        })
        .collect();
    if stats.is_empty() {
        return Err("no stat:value arguments given".into());
    }
    let client = CdnClient::connect().map_err(|e| e.to_string())?;
    let index = load_index(&client)?;
    let mut sd = data_miner::csd::StatDescriptions::new();
    let mut seen = std::collections::HashSet::new();
    load_csd_chain(&client, &index, path, &mut seen, &mut sd)?;
    for line in sd.render_ranges(&stats) {
        println!("{line}");
    }
    let _ = ctx;
    Ok(())
}

/// `viewer/assets/skill_stats.json` — per-gem, per-level, per-PART
/// rendered stat lines. The numbers the game shows in a gem popup:
/// GrantedEffectStatSetsPerLevel carries resolved values per stat set
/// per gem level (a stat set = one display part — Firebolt has
/// "Projectile" + "Explosion"), GrantedEffectsPerLevel the cost /
/// reservation / cooldown ladder, and the skill_stat_descriptions.csd
/// include-chain turns stat ids into display text.
pub fn skill_stats(ctx: &Ctx, args: &[String]) -> Result<(), String> {
    let patch = resolve_patch(ctx, args)?;
    let parsed = ctx.root.join("data/parsed").join(&patch);

    // Player-facing granted effects = those a gem in gems.tsv grants.
    let gems_text = std::fs::read_to_string(parsed.join("skills/gems.tsv"))
        .map_err(|e| format!("skills/gems.tsv: {e} — run `shape gems` first"))?;
    let mut hdr = gems_text.lines().next().unwrap_or("").split('\t');
    let ge_col = hdr
        .position(|h| h == "granted_effect_id")
        .ok_or("gems.tsv missing granted_effect_id")?;
    let player_effects: std::collections::HashSet<String> = gems_text
        .lines()
        .skip(1)
        .filter_map(|l| l.split('\t').nth(ge_col))
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .collect();

    // Tables + stat descriptions from the CDN.
    let schema_path = dat_schema_path(ctx)?;
    let set =
        SchemaSet::from_json(&std::fs::read_to_string(&schema_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let client = CdnClient::connect().map_err(|e| e.to_string())?;
    let index = load_index(&client)?;
    let paths = resolve_table_paths(&index)?;
    let mut ts = data_miner::shape::TableSet::new();
    for name in [
        "GrantedEffects",
        "GrantedEffectStatSets",
        "GrantedEffectStatSetsPerLevel",
        "GrantedEffectsPerLevel",
        "GrantedEffectLabels",
        "GrantedSkillSocketNumbers",
        "Stats",
    ] {
        let schema = set.table(name).ok_or_else(|| format!("{name}: not in dat-schema"))?;
        let base = format!("{}.datc64", name.to_ascii_lowercase());
        let cands = paths.get(&base).map(Vec::as_slice).unwrap_or(&[]);
        let (bytes, schema) = extract_parseable(&client, &index, name, cands, schema)?;
        ts.insert(name, bytes, schema);
    }
    let mut sd = data_miner::csd::StatDescriptions::new();
    let mut seen = std::collections::HashSet::new();
    load_csd_chain(
        &client,
        &index,
        "data/statdescriptions/skill_stat_descriptions.csd",
        &mut seen,
        &mut sd,
    )?;

    let granted_ids = ts.id_list("GrantedEffects");
    let stat_ids = ts.id_list("Stats");
    let sets = ts.dat("GrantedEffectStatSets").ok_or("no stat sets")?;
    let sets_s = ts.schema("GrantedEffectStatSets").ok_or("no stat sets")?;
    let sspl = ts.dat("GrantedEffectStatSetsPerLevel").ok_or("no per-level")?;
    let sspl_s = ts.schema("GrantedEffectStatSetsPerLevel").ok_or("no per-level")?;
    let gepl = ts.dat("GrantedEffectsPerLevel").ok_or("no gepl")?;
    let gepl_s = ts.schema("GrantedEffectsPerLevel").ok_or("no gepl")?;
    let labels = ts.dat("GrantedEffectLabels").ok_or("no labels")?;
    let lab_text = ts
        .schema("GrantedEffectLabels")
        .and_then(|s| s.column("Text"))
        .ok_or("labels: no Text")?;
    let col = |s: &data_miner::dat::TableSchema, n: &str| -> Result<usize, String> {
        s.column(n).ok_or_else(|| format!("missing column {n}"))
    };
    let ss_label = col(sets_s, "Label")?;
    let ss_const = col(sets_s, "ConstantStats")?;
    let ss_constv = col(sets_s, "ConstantStatsValues")?;
    let c_ss = col(sspl_s, "StatSet")?;
    let c_lvl = col(sspl_s, "GemLevel")?;
    let c_ge = col(sspl_s, "GrantedEffects")?;
    let c_spellcrit = col(sspl_s, "SpellCritChance")?;
    let c_attackcrit = col(sspl_s, "AttackCritChance")?;
    let c_floats = col(sspl_s, "FloatStats")?;
    let c_resolved = col(sspl_s, "BaseResolvedValues")?;
    let c_add = col(sspl_s, "AdditionalStats")?;
    let c_addv = col(sspl_s, "AdditionalStatsValues")?;
    let g_ge = col(gepl_s, "GrantedEffect")?;
    let g_lvl = col(gepl_s, "Level")?;
    let g_cost = col(gepl_s, "CostAmounts")?;
    let g_resv = col(gepl_s, "Reservation")?;
    let g_cd = col(gepl_s, "Cooldown")?;
    // Support gems: percent multiplier applied to the supported
    // skill's cost INCLUDING spirit reservation (100 = ×1.0).
    let g_costmult = col(gepl_s, "CostMultiplier")?;

    // Raw array readers (element layouts: foreignrow 16B, i32 4B).
    let rows_of = |dat: &data_miner::dat::Dat<'_>, row: usize, c: usize| -> Vec<usize> {
        let Ok((count, offset)) = dat.array_ref(row, c) else { return vec![] };
        (0..count)
            .filter_map(|i| {
                let b = dat.var().get(offset + i * 16..offset + i * 16 + 8)?;
                Some(u64::from_le_bytes(b.try_into().ok()?) as usize)
            })
            .collect()
    };
    let i32s_of = |dat: &data_miner::dat::Dat<'_>, row: usize, c: usize| -> Vec<i64> {
        let Ok((count, offset)) = dat.array_ref(row, c) else { return vec![] };
        (0..count)
            .filter_map(|i| {
                let b = dat.var().get(offset + i * 4..offset + i * 4 + 4)?;
                Some(i32::from_le_bytes(b.try_into().ok()?) as i64)
            })
            .collect()
    };

    const MAX_LEVEL: i32 = 20;
    // effect id → part (stat-set row) → {label, const lines, level → lines, crit}
    struct Part {
        label: String,
        const_lines: Vec<String>,
        levels: std::collections::BTreeMap<i64, Vec<String>>,
        crit: f64,
        order: usize,
    }
    let mut effects: std::collections::BTreeMap<String, std::collections::BTreeMap<usize, Part>> =
        std::collections::BTreeMap::new();
    for row in 0..sspl.row_count() {
        let lvl = sspl.i32(row, c_lvl).unwrap_or(0);
        if !(1..=MAX_LEVEL).contains(&lvl) {
            continue;
        }
        let eids: Vec<&String> = rows_of(&sspl, row, c_ge)
            .into_iter()
            .filter_map(|r| granted_ids.get(r))
            .filter(|id| player_effects.contains(*id))
            .collect();
        if eids.is_empty() {
            continue;
        }
        let Ok(Some(ssr)) = sspl.foreign(row, c_ss) else { continue };
        let ssr = ssr as usize;
        // Per-level stats: floats (with pre-resolved values) + additional.
        let mut stats: Vec<(String, i64, i64)> = Vec::new();
        let fstats = rows_of(&sspl, row, c_floats);
        let fvals = i32s_of(&sspl, row, c_resolved);
        for (i, sr) in fstats.iter().enumerate() {
            if let (Some(id), Some(v)) = (stat_ids.get(*sr), fvals.get(i)) {
                stats.push((id.clone(), *v, *v));
            }
        }
        let astats = rows_of(&sspl, row, c_add);
        let avals = i32s_of(&sspl, row, c_addv);
        for (i, sr) in astats.iter().enumerate() {
            if let (Some(id), Some(v)) = (stat_ids.get(*sr), avals.get(i)) {
                stats.push((id.clone(), *v, *v));
            }
        }
        let lines = sd.render_ranges(&stats);
        let crit = {
            let sc = sspl.i32(row, c_spellcrit).unwrap_or(0);
            let ac = sspl.i32(row, c_attackcrit).unwrap_or(0);
            (sc.max(ac) as f64) / 100.0
        };
        for eid in eids {
            let parts = effects.entry(eid.clone()).or_default();
            let order = parts.len();
            let part = parts.entry(ssr).or_insert_with(|| {
                let label = sets
                    .foreign(ssr, ss_label)
                    .ok()
                    .flatten()
                    .and_then(|lr| labels.string(lr as usize, lab_text).ok())
                    .unwrap_or_default();
                // Constants render once per part (radius, timers…).
                let cstats: Vec<(String, i64, i64)> = rows_of(&sets, ssr, ss_const)
                    .iter()
                    .zip(i32s_of(&sets, ssr, ss_constv))
                    .filter_map(|(sr, v)| stat_ids.get(*sr).map(|id| (id.clone(), v, v)))
                    .collect();
                Part {
                    label,
                    const_lines: sd.render_ranges(&cstats),
                    levels: Default::default(),
                    crit: 0.0,
                    order,
                }
            });
            if !lines.is_empty() {
                part.levels.insert(lvl as i64, lines.clone());
            }
            if crit > part.crit {
                part.crit = crit;
            }
        }
    }

    // Cost / reservation / cooldown ladders:
    // effect id → level → (cost, reservation, cooldown, cost multiplier).
    type CostLadder = std::collections::BTreeMap<i64, (i64, i64, i64, i64)>;
    let mut costs: std::collections::BTreeMap<String, CostLadder> = std::collections::BTreeMap::new();
    for row in 0..gepl.row_count() {
        let lvl = gepl.i32(row, g_lvl).unwrap_or(0);
        if !(1..=MAX_LEVEL).contains(&lvl) {
            continue;
        }
        let Ok(Some(ger)) = gepl.foreign(row, g_ge) else { continue };
        let Some(eid) = granted_ids.get(ger as usize) else { continue };
        if !player_effects.contains(eid) {
            continue;
        }
        let cost = i32s_of(&gepl, row, g_cost).first().copied().unwrap_or(0);
        let resv = gepl.i32(row, g_resv).unwrap_or(0) as i64;
        let cd = gepl.i32(row, g_cd).unwrap_or(0) as i64;
        let mult = gepl.i32(row, g_costmult).unwrap_or(100) as i64;
        costs.entry(eid.clone()).or_default().insert(lvl as i64, (cost, resv, cd, mult));
    }

    // Emit.
    let mut out = json::Map::new();
    out.insert("format".into(), json::Value::Str("poe2-skill-stats".into()));
    out.insert("version".into(), json::Value::Integer(1));
    let mut eff_map = json::Map::new();
    for (eid, parts) in &effects {
        let mut e = json::Map::new();
        let mut plist: Vec<(&usize, &Part)> = parts.iter().collect();
        plist.sort_by_key(|(_, p)| p.order);
        let parr: Vec<json::Value> = plist
            .iter()
            .map(|(_, p)| {
                let mut pm = json::Map::new();
                if !p.label.is_empty() {
                    pm.insert("label".into(), json::Value::Str(p.label.clone()));
                }
                if p.crit > 0.0 {
                    pm.insert("crit".into(), json::Value::Float(p.crit));
                }
                if !p.const_lines.is_empty() {
                    pm.insert(
                        "const".into(),
                        json::Value::Array(p.const_lines.iter().cloned().map(json::Value::Str).collect()),
                    );
                }
                let mut lm = json::Map::new();
                for (lvl, lines) in &p.levels {
                    lm.insert(
                        lvl.to_string(),
                        json::Value::Array(lines.iter().cloned().map(json::Value::Str).collect()),
                    );
                }
                if !lm.is_empty() {
                    pm.insert("levels".into(), json::Value::Object(lm));
                }
                json::Value::Object(pm)
            })
            .collect();
        e.insert("parts".into(), json::Value::Array(parr));
        if let Some(ladder) = costs.get(eid) {
            let mut cm = json::Map::new();
            let mut rm = json::Map::new();
            let mut dm = json::Map::new();
            let mut mm = json::Map::new();
            for (lvl, (cost, resv, cd, mult)) in ladder {
                if *cost > 0 {
                    cm.insert(lvl.to_string(), json::Value::Integer(*cost));
                }
                if *resv > 0 {
                    rm.insert(lvl.to_string(), json::Value::Integer(*resv));
                }
                if *cd > 0 {
                    dm.insert(lvl.to_string(), json::Value::Integer(*cd));
                }
                if *mult != 100 && *mult != 0 {
                    mm.insert(lvl.to_string(), json::Value::Integer(*mult));
                }
            }
            if !cm.is_empty() {
                e.insert("cost".into(), json::Value::Object(cm));
            }
            if !rm.is_empty() {
                e.insert("reservation".into(), json::Value::Object(rm));
            }
            if !dm.is_empty() {
                e.insert("cooldown_ms".into(), json::Value::Object(dm));
            }
            if !mm.is_empty() {
                // Support gems: % multiplier on the supported skill's
                // cost/reservation (product across supports, ÷100 each).
                e.insert("cost_multiplier".into(), json::Value::Object(mm));
            }
        }
        eff_map.insert(eid.clone(), json::Value::Object(e));
    }
    // Granted-skill support sockets: item-granted skills socket
    // supports for free; how many depends on the granted level.
    if let (Some(gssn), Some(gssn_s)) = (ts.dat("GrantedSkillSocketNumbers"), ts.schema("GrantedSkillSocketNumbers"))
        && let (Some(c_l), Some(c_n)) = (gssn_s.column("Level"), gssn_s.column("Sockets")) {
            let mut sm = json::Map::new();
            for row in 0..gssn.row_count() {
                let l = gssn.i32(row, c_l).unwrap_or(0);
                let n = gssn.i32(row, c_n).unwrap_or(0);
                if l > 0 { sm.insert(l.to_string(), json::Value::Integer(n as i64)); }
            }
            if !sm.is_empty() {
                out.insert("granted_skill_sockets".into(), json::Value::Object(sm));
            }
        }
    out.insert("count".into(), json::Value::Integer(eff_map.len() as i64));
    out.insert("effects".into(), json::Value::Object(eff_map));
    let path = ctx.root.join("viewer/assets/skill_stats.json");
    let text = json::emit_pretty(&json::Value::Object(out)) + "\n";
    let kb = text.len() / 1024;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    ui::ok(
        ctx.style,
        &format!("skill stats → viewer/assets/skill_stats.json ({} effects, {kb} KB, first-party)", effects.len()),
    );
    Ok(())
}

pub fn uniques(ctx: &Ctx, args: &[String]) -> Result<(), String> {
    let patch = resolve_patch(ctx, args)?;
    let dir = ctx.root.join("data/parsed").join(&patch);

    // 1. First-party mod → stats table (produced by `shape mods`).
    let mods_path = dir.join("items/mods.tsv");
    let mods_text = std::fs::read_to_string(&mods_path).map_err(|e| {
        format!(
            "read {}: {e} — run `buildwright shape mods --patch {patch}` first",
            mods_path.display()
        )
    })?;
    let mod_stats = load_mod_stats(&mods_text);

    // 2. First-party stat descriptions (item stats → display text).
    let client = CdnClient::connect().map_err(|e| e.to_string())?;
    let index = load_index(&client)?;
    let mut sd = data_miner::csd::StatDescriptions::new();
    let csd = "data/statdescriptions/stat_descriptions.csd";
    match extract_by_path(&client, &index, csd) {
        Ok(bytes) => sd.parse(&data_miner::csd::StatDescriptions::decode_utf16(&bytes)),
        Err(e) => return Err(format!("{csd}: {e}")),
    }

    // 3. The pinned PoB recipe: src/Export/Uniques/*.lua (mod-id lists).
    let pob_root = ctx.root.join("data/pob2");
    let src = pob_root.join("src/Export/Uniques");
    if !src.is_dir() {
        return Err(format!(
            "no {} — the PoB checkout is the one pinned external seam; \
             `git submodule update --init data/pob2` (or clone it there)",
            src.display()
        ));
    }
    let commit = pob_commit(&pob_root);

    let mut slots: Vec<PathBuf> = std::fs::read_dir(&src)
        .map_err(|e| format!("read {}: {e}", src.display()))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("lua"))
        .collect();
    slots.sort();

    let mut rows =
        String::from("name\tbase\tslot_file\tvariant_count\tlatest_variant\tlatest_stats\n");
    let mut vrows = String::from("name\tvariant_index\tvariant_label\tstat\n");
    let mut files_used: Vec<String> = Vec::new();
    let mut total = 0usize;
    let mut skipped: Vec<String> = Vec::new();

    for path in &slots {
        let slot = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let text = std::fs::read_to_string(path)
            .map_err(|e| format!("read {}: {e}", path.display()))?;
        let parsed = data_miner::uniques::parse(&text);
        if !parsed.is_empty() {
            files_used.push(format!("Export/Uniques/{slot}.lua"));
        }
        for u in parsed {
            // Skip a unique the moment a real mod id can't be resolved
            // against our first-party pool — never emit a half-item.
            // (Literal lines carry no mod id and always pass through.)
            if let Some(missing) = u
                .mods
                .iter()
                .find(|m| m.literal.is_none() && !mod_stats.contains_key(&m.mod_id))
            {
                skipped.push(format!("{} ({})", u.name, missing.mod_id));
                continue;
            }
            let nvar = u.variants.len().max(1);
            let mut latest_stats = String::new();
            for v in 1..=nvar {
                let label = u.variants.get(v - 1).map(String::as_str).unwrap_or("Current");
                let mut lines: Vec<String> = Vec::new();
                for m in &u.mods {
                    let active = m.variants.is_empty() || m.variants.contains(&(v as u32));
                    if !active {
                        continue;
                    }
                    match &m.literal {
                        Some(text) => lines.push(text.clone()),
                        None => lines.extend(render_unique_mod(&sd, &mod_stats[&m.mod_id], m.roll)),
                    }
                }
                for line in &lines {
                    vrows.push_str(&format!("{}\t{v}\t{label}\t{line}\n", u.name));
                }
                if v == nvar {
                    latest_stats = lines.join(" · ");
                }
            }
            let latest_label = u.variants.last().map(String::as_str).unwrap_or("Current");
            rows.push_str(&format!(
                "{}\t{}\t{slot}\t{nvar}\t{latest_label}\t{latest_stats}\n",
                u.name, u.base
            ));
            total += 1;
        }
    }

    // 3.5 Uniques the GAME knows but the pinned PoB doesn't (yet):
    //    UniqueStashLayout enumerates every unique by display name +
    //    stash type. Append name/slot-only rows for the gap so they're
    //    at least pickable and validate as real names — their stats
    //    fill in when the PoB pin catches up. First-party, no guesses.
    let mut game_only = 0usize;
    if let Ok((gh, grows)) = read_tsv(&dir.join("dat/UniqueStashLayout.tsv")) {
        let gcol = |n: &str| gh.iter().position(|h| h == n);
        if let (Some(c_w), Some(c_t)) = (gcol("WordsKey"), gcol("UniqueStashTypesKey")) {
            let have: std::collections::HashSet<String> = rows
                .lines()
                .skip(1)
                .filter_map(|l| l.split('\t').next())
                .map(str::to_string)
                .collect();
            let slot_of = |t: &str| -> &str {
                match t {
                    "Jewel" => "jewel",
                    "Amulet" => "amulet",
                    "Ring" => "ring",
                    "Belt" => "belt",
                    "Body Armour" => "body",
                    "Helmet" => "helmet",
                    "Gloves" => "gloves",
                    "Boots" => "boots",
                    "Shield" => "shield",
                    "Quiver" => "quiver",
                    "Flask" | "Life Flask" | "Mana Flask" => "flask",
                    "Focus" => "focus",
                    _ => "weapon",
                }
            };
            let mut seen: std::collections::HashSet<String> = Default::default();
            for r in &grows {
                let name = r.get(c_w).cloned().unwrap_or_default();
                if name.is_empty() || name.starts_with('#') || have.contains(&name) || !seen.insert(name.clone()) {
                    continue;
                }
                let ty = r.get(c_t).cloned().unwrap_or_default();
                rows.push_str(&format!("{name}\t\t{}\t0\t\t\n", slot_of(&ty)));
                game_only += 1;
            }
        }
    }
    if game_only > 0 {
        ui::note(
            ctx.style,
            &format!("{game_only} uniques known to the game but not the PoB pin — added name/slot only (stats pending)"),
        );
    }

    // 4. Write the two datasets + a hashed provenance sidecar. The sidecar
    //    records the pinned commit + exact files, so the PoB lock is
    //    itself diffable through the manifest.
    let out = dir.join("items");
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    std::fs::write(out.join("uniques.tsv"), &rows).map_err(|e| e.to_string())?;
    std::fs::write(out.join("uniques_variants.tsv"), &vrows).map_err(|e| e.to_string())?;

    let mut prov = json::Map::new();
    prov.insert("dataset".into(), json::Value::Str("uniques".into()));
    prov.insert(
        "source".into(),
        json::Value::Str("path-of-building-community/PathOfBuilding-PoE2".into()),
    );
    prov.insert("pob_commit".into(), json::Value::Str(commit.clone()));
    prov.insert(
        "source_files".into(),
        json::Value::Array(files_used.into_iter().map(json::Value::Str).collect()),
    );
    prov.insert(
        "resolved_against".into(),
        json::Value::Str("items/mods.tsv + statdescriptions/stat_descriptions.csd (first-party)".into()),
    );
    prov.insert("uniques_resolved".into(), json::Value::Integer(total as i64));
    prov.insert(
        "uniques_skipped".into(),
        json::Value::Integer(skipped.len() as i64),
    );
    prov.insert(
        "skipped".into(),
        json::Value::Array(skipped.iter().cloned().map(json::Value::Str).collect()),
    );
    let prov_text = json::emit_pretty(&json::Value::Object(prov)) + "\n";
    std::fs::write(out.join("uniques.pob.json"), prov_text).map_err(|e| e.to_string())?;

    let commit_short = commit.get(..9).unwrap_or(&commit);
    ui::ok(
        ctx.style,
        &format!(
            "uniques: {total} resolved first-party from pob@{commit_short}{}",
            if skipped.is_empty() {
                String::new()
            } else {
                format!(" · {} skipped (unresolved mods)", skipped.len())
            }
        ),
    );
    if !skipped.is_empty() {
        ui::note(
            ctx.style,
            &format!(
                "skipped (mod not in our pool yet — will resolve once GGG ships it): {}",
                skipped.join(", ")
            ),
        );
    }
    Ok(())
}

/// Recursively collect hashable files (`.tsv`/`.json`, excluding
/// `manifest.json`, dot-files, and `_`/dot dirs) as (rel-path, abs-path).
fn walk_hashable(root: &Path, prefix: &str, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let p = e.path();
        if p.is_dir() {
            if !name.starts_with('.') && !name.starts_with('_') {
                walk_hashable(&p, &rel, out);
            }
        } else if !name.starts_with('.')
            && name != "manifest.json"
            && (name.ends_with(".tsv") || name.ends_with(".json"))
        {
            out.push((rel, p));
        }
    }
}

/// (sha256-hex, byte-len, tsv-row-count-or-none) for one file.
fn hash_file(path: &Path) -> Result<(String, u64, Option<u64>), String> {
    let data = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let rows = if path.extension().is_some_and(|x| x == "tsv") {
        // Row count excludes the header line.
        Some(
            data.iter()
                .filter(|&&b| b == b'\n')
                .count()
                .saturating_sub(1) as u64,
        )
    } else {
        None
    };
    Ok((hash::sha256_hex(&data), data.len() as u64, rows))
}

pub fn manifest(ctx: &Ctx, args: &[String]) -> Result<(), String> {
    let patch = resolve_patch(ctx, args)?;
    let (source_override, _) = {
        // --source <s> overrides the .source marker.
        let mut src = None;
        let mut it = args.iter();
        while let Some(a) = it.next() {
            if a == "--source" {
                src = it.next().cloned();
            }
        }
        (src, ())
    };
    let dir = ctx.root.join("data/parsed").join(&patch);
    if !dir.is_dir() {
        return Err(format!("no data/parsed/{patch}"));
    }

    let mut files = Vec::new();
    walk_hashable(&dir, "", &mut files);
    files.sort();

    let mut datasets = json::Map::new();
    for (rel, path) in &files {
        let (sha, bytes, rows) = hash_file(path)?;
        let mut e = json::Map::new();
        e.insert("sha256".into(), json::Value::Str(sha));
        e.insert("bytes".into(), json::Value::Integer(bytes as i64));
        e.insert(
            "rows".into(),
            rows.map(|r| json::Value::Integer(r as i64))
                .unwrap_or(json::Value::Null),
        );
        datasets.insert(rel.clone(), json::Value::Object(e));
    }

    // Rollup: sha256 over the canonical (compact, key-sorted) datasets
    // JSON — one stable integrity value for the whole patch.
    let datasets_val = json::Value::Object(datasets);
    let rollup = hash::sha256_hex(json::emit(&datasets_val).as_bytes());

    let source = source_override
        .or_else(|| {
            std::fs::read_to_string(dir.join(".source"))
                .ok()
                .map(|s| s.trim().to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "pob2-stable".to_string());

    let mut root = json::Map::new();
    root.insert("schema_version".into(), json::Value::Integer(2));
    root.insert("patch".into(), json::Value::Str(patch.replace('_', ".")));
    root.insert("source".into(), json::Value::Str(source));
    root.insert(
        "generated_by".into(),
        json::Value::Str("buildwright".into()),
    );
    root.insert("datasets".into(), datasets_val);
    root.insert("rollup".into(), json::Value::Str(rollup.clone()));

    let text = json::emit_pretty(&json::Value::Object(root)) + "\n";
    let out_path = dir.join("manifest.json");
    std::fs::write(&out_path, text).map_err(|e| format!("write {}: {e}", out_path.display()))?;
    ui::ok(
        ctx.style,
        &format!(
            "{} — {} files, rollup {}…",
            patch,
            files.len(),
            &rollup[..12]
        ),
    );
    Ok(())
}

pub fn verify(ctx: &Ctx, args: &[String]) -> Result<(), String> {
    let s = ctx.style;
    let patch = resolve_patch(ctx, args)?;
    let dir = ctx.root.join("data/parsed").join(&patch);
    let man_path = dir.join("manifest.json");
    let man_src = std::fs::read_to_string(&man_path).map_err(|e| {
        format!(
            "read {}: {e} (run `buildwright manifest` first)",
            man_path.display()
        )
    })?;
    let man = json::parse(&man_src).map_err(|e| format!("parse manifest: {e}"))?;

    println!("{} {}", s.heading("verify"), s.cyan(&patch));
    let mut failures = 0usize;

    // 1. Integrity: recompute each file's sha256 vs the manifest.
    let datasets = man
        .get("datasets")
        .and_then(|v| v.as_object())
        .ok_or("manifest has no datasets object")?;
    let mut checked = 0;
    for (rel, entry) in datasets {
        let want = entry.get("sha256").and_then(|v| v.as_str()).unwrap_or("");
        let path = dir.join(rel);
        match hash_file(&path) {
            Ok((got, _, _)) if got == want => checked += 1,
            Ok((_, _, _)) => {
                println!(
                    "  {} {rel} {}",
                    s.red("✗"),
                    s.red("hash mismatch (content changed)")
                );
                failures += 1;
            }
            Err(_) => {
                println!("  {} {rel} {}", s.red("✗"), s.red("missing"));
                failures += 1;
            }
        }
    }
    if failures == 0 {
        ui::ok(s, &format!("integrity: {checked} files match the manifest"));
    }

    // 2. Rollup consistency.
    if let (Some(want), Some(datasets)) = (
        man.get("rollup").and_then(|v| v.as_str()),
        man.get("datasets"),
    ) {
        let got = hash::sha256_hex(json::emit(datasets).as_bytes());
        if got == want {
            ui::ok(s, "rollup matches datasets");
        } else {
            println!(
                "  {} {}",
                s.red("✗"),
                s.red("rollup does not match datasets")
            );
            failures += 1;
        }
    }

    // 3. Referential: every node icon resolves to a sprite (this is the
    //    exact check that would have caught the 0.5 sprite regression).
    let nodes = dir.join("tree/nodes.tsv");
    let sprites = dir.join("tree/sprites.tsv");
    if nodes.is_file() && sprites.is_file() {
        let icons = tsv_column(&nodes, 11)?; // icon column
        let sprite_keys = tsv_column(&sprites, 0)?; // sprite_name column
        let missing: Vec<&String> = icons.difference(&sprite_keys).collect();
        if missing.is_empty() {
            ui::ok(
                s,
                &format!(
                    "referential: all {} node icons resolve to sprites",
                    icons.len()
                ),
            );
        } else {
            println!(
                "  {} {} of {} node icons have no sprite (e.g. {})",
                s.red("✗"),
                missing.len(),
                icons.len(),
                missing
                    .iter()
                    .take(3)
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join(", "),
            );
            failures += 1;
        }
    }

    // 3b. Mastery lighting integrity — the LOCK on the "no perimeter" rule.
    // Every masteries.tsv trigger MUST be a real GGG connection in
    // edges.tsv. A group/proximity-derived trigger (a node merely near the
    // mastery, not connected) shows up here as a non-edge link and fails
    // the ship gate — the guard that keeps the derivation from regressing
    // to the old perimeter heuristic (it has, three times).
    let masteries = dir.join("tree/masteries.tsv");
    let edges = dir.join("tree/edges.tsv");
    if masteries.is_file() && edges.is_file() {
        let etext = std::fs::read_to_string(&edges).map_err(|e| e.to_string())?;
        let mut edge: BTreeSet<(String, String)> = BTreeSet::new();
        for line in etext.lines().skip(1) {
            let mut it = line.split('\t');
            if let (Some(a), Some(b)) = (it.next(), it.next()) {
                edge.insert((a.to_string(), b.to_string()));
                edge.insert((b.to_string(), a.to_string()));
            }
        }
        let mtext = std::fs::read_to_string(&masteries).map_err(|e| e.to_string())?;
        let (mut links, mut perimeter, mut example) = (0usize, 0usize, String::new());
        for line in mtext.lines().skip(1) {
            let mut it = line.split('\t');
            if let (Some(trig), Some(m)) = (it.next(), it.next()) {
                links += 1;
                if !edge.contains(&(trig.to_string(), m.to_string())) {
                    if perimeter == 0 {
                        example = format!("{trig}→{m}");
                    }
                    perimeter += 1;
                }
            }
        }
        if perimeter == 0 {
            ui::ok(
                s,
                &format!("referential: all {links} mastery triggers are GGG connections (no perimeter)"),
            );
        } else {
            println!(
                "  {} {perimeter} of {links} mastery triggers are NOT GGG connections (e.g. {example}) — perimeter regression",
                s.red("✗"),
            );
            failures += 1;
        }
    }

    // 4. Completeness: core datasets present and non-empty. poe1_*
    //    dirs are tree-only by design (step 1: no skills/items), so
    //    their required set is just the tree.
    let core_sets: &[&str] = if patch.starts_with("poe1_") {
        &["tree/nodes.tsv", "tree/edges.tsv", "tree/meta.tsv", "tree/sprites.tsv"]
    } else {
        &[
            "tree/nodes.tsv",
            "tree/edges.tsv",
            "skills/gems.tsv",
            "items/bases.tsv",
        ]
    };
    for &core in core_sets {
        match datasets
            .get(core)
            .and_then(|e| e.get("rows"))
            .and_then(|v| v.as_i64())
        {
            Some(n) if n > 0 => {}
            _ => {
                println!("  {} {core} {}", s.red("✗"), s.red("missing or empty"));
                failures += 1;
            }
        }
    }

    if failures == 0 {
        ui::ok(s, &format!("{patch} verified — all checks passed"));
        Ok(())
    } else {
        Err(format!(
            "{failures} verification failure(s) — do not ship this patch"
        ))
    }
}

/// Distinct non-empty values of column `col` (0-based) across a TSV,
/// skipping the header row.
fn tsv_column(path: &Path, col: usize) -> Result<BTreeSet<String>, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut out = BTreeSet::new();
    for line in text.lines().skip(1) {
        if let Some(v) = line.split('\t').nth(col)
            && !v.is_empty()
        {
            out.insert(v.to_string());
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------
// native: patch diff (field-level "what changed")
// ---------------------------------------------------------------------

/// One parsed TSV: header + rows keyed for diffing.
struct Tsv {
    header: Vec<String>,
    /// key → row. Key is the first column when it's unique across rows
    /// (id-keyed → detects add/remove/change); otherwise the whole row
    /// (content-keyed → add/remove only, e.g. edges with no stable id).
    rows: BTreeMap<String, Vec<String>>,
    id_keyed: bool,
}

fn load_tsv(path: &Path) -> Result<Option<Tsv>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut lines = text.lines();
    let header: Vec<String> = match lines.next() {
        Some(h) => h.split('\t').map(str::to_string).collect(),
        None => {
            return Ok(Some(Tsv {
                header: vec![],
                rows: BTreeMap::new(),
                id_keyed: false,
            }));
        }
    };
    let rows: Vec<Vec<String>> = lines
        .filter(|l| !l.is_empty())
        .map(|l| l.split('\t').map(str::to_string).collect())
        .collect();
    // First column unique? → id-key; else content-key.
    let firsts: BTreeSet<&str> = rows
        .iter()
        .filter_map(|r| r.first().map(String::as_str))
        .collect();
    let id_keyed = firsts.len() == rows.len();
    let mut map = BTreeMap::new();
    for r in rows {
        let key = if id_keyed {
            r.first().cloned().unwrap_or_default()
        } else {
            r.join("\t")
        };
        map.insert(key, r);
    }
    Ok(Some(Tsv {
        header,
        rows: map,
        id_keyed,
    }))
}

/// Recursively list `*.tsv` under `root`, as paths relative to it.
fn list_tsvs(root: &Path, prefix: &str, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if p.is_dir() {
            list_tsvs(&p, &rel, out);
        } else if rel.ends_with(".tsv") {
            out.push(rel);
        }
    }
}

/// Compare two shaped trees (node set + positions) — the parity gate for a
/// re-flip, and how we surface GGG's per-patch curation between the exact
/// `data.json` source and the bundle-derived PSG fallback. Reads
/// `data/parsed/<a>/tree/nodes.tsv` vs `<b>/tree/nodes.tsv`.
pub fn tree_diff(ctx: &Ctx, args: &[String]) -> Result<(), String> {
    let s = ctx.style;
    let pos: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    let [a, b] = pos.as_slice() else {
        return Err("usage: buildwright tree-diff <patch_a> <patch_b>".into());
    };
    // id → (x, y, kind) from a tree's nodes.tsv.
    let load = |patch: &str| -> Result<BTreeMap<String, (f64, f64, String)>, String> {
        let p = ctx
            .root
            .join("data/parsed")
            .join(patch)
            .join("tree/nodes.tsv");
        let text = std::fs::read_to_string(&p).map_err(|e| format!("read {}: {e}", p.display()))?;
        let mut m = BTreeMap::new();
        for line in text.lines().skip(1) {
            let c: Vec<&str> = line.split('\t').collect();
            if c.len() < 4 {
                continue;
            }
            let (Ok(x), Ok(y)) = (c[1].parse::<f64>(), c[2].parse::<f64>()) else {
                continue;
            };
            m.insert(c[0].to_string(), (x, y, c[3].to_string()));
        }
        Ok(m)
    };
    let (na, nb) = (load(a)?, load(b)?);
    let a_ids: BTreeSet<&String> = na.keys().collect();
    let b_ids: BTreeSet<&String> = nb.keys().collect();
    let shared: Vec<&String> = a_ids.intersection(&b_ids).copied().collect();
    let only_a: Vec<&String> = a_ids.difference(&b_ids).copied().collect();
    let only_b: Vec<&String> = b_ids.difference(&a_ids).copied().collect();
    let moved: Vec<&String> = shared
        .iter()
        .filter(|id| {
            let (ax, ay, _) = &na[**id];
            let (bx, by, _) = &nb[**id];
            (ax - bx).abs() > 0.5 || (ay - by).abs() > 0.5
        })
        .copied()
        .collect();
    let exact = shared.len() - moved.len();

    println!("{}", s.heading(&format!("tree-diff  {a}  vs  {b}")));
    println!("  {} nodes: {}   {} nodes: {}", a, na.len(), b, nb.len());
    println!(
        "  shared {}   position-identical {}/{} ({}%)",
        shared.len(),
        exact,
        shared.len().max(1),
        100 * exact / shared.len().max(1)
    );
    println!("  only in {a}: {}   only in {b}: {}   moved: {}", only_a.len(), only_b.len(), moved.len());
    let sample = |label: &str, v: &[&String], m: &BTreeMap<String, (f64, f64, String)>| {
        for id in v.iter().take(8) {
            let k = m.get(*id).map(|t| t.2.as_str()).unwrap_or("");
            println!("      {label} {id} [{k}]");
        }
        if v.len() > 8 {
            println!("      … +{} more", v.len() - 8);
        }
    };
    if !only_a.is_empty() {
        println!("  {}", s.dim(&format!("nodes only in {a}:")));
        sample("", &only_a, &na);
    }
    if !only_b.is_empty() {
        println!("  {}", s.dim(&format!("nodes only in {b}:")));
        sample("", &only_b, &nb);
    }
    let parity = only_a.is_empty() && only_b.is_empty() && moved.is_empty();
    if parity {
        ui::ok(s, "trees are identical (node set + positions)");
    } else {
        ui::warn(s, "trees differ — see above");
    }
    Ok(())
}

pub fn diff(ctx: &Ctx, args: &[String]) -> Result<(), String> {
    let s = ctx.style;
    let positional: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    let (old, new) = match positional.as_slice() {
        [o, n] => (o.as_str(), n.as_str()),
        _ => return Err("usage: buildwright diff <old_patch> <new_patch>".into()),
    };
    let parsed = ctx.root.join("data/parsed");
    let (old_dir, new_dir) = (parsed.join(old), parsed.join(new));
    if !old_dir.is_dir() {
        return Err(format!("no data/parsed/{old}"));
    }
    if !new_dir.is_dir() {
        return Err(format!("no data/parsed/{new}"));
    }

    println!(
        "{} {} {} {}",
        s.heading("patch diff"),
        s.cyan(old),
        s.dim("→"),
        s.cyan(new),
    );

    // Union of datasets across both patches.
    let mut datasets = Vec::new();
    list_tsvs(&old_dir, "", &mut datasets);
    let before = datasets.len();
    list_tsvs(&new_dir, "", &mut datasets);
    datasets.truncate(before);
    let mut all: BTreeSet<String> = datasets.into_iter().collect();
    let mut nd = Vec::new();
    list_tsvs(&new_dir, "", &mut nd);
    all.extend(nd);

    for rel in &all {
        let old_t = load_tsv(&old_dir.join(rel))?;
        let new_t = load_tsv(&new_dir.join(rel))?;
        match (old_t, new_t) {
            (None, Some(_)) => println!("  {}  {rel}  {}", s.green("＋"), s.dim("(new dataset)")),
            (Some(_), None) => println!("  {}  {rel}  {}", s.red("－"), s.dim("(removed dataset)")),
            (Some(o), Some(n)) => diff_dataset(s, rel, &o, &n),
            (None, None) => {}
        }
    }
    Ok(())
}

/// Display label for a row: its first field (the id/name), plus the
/// `name` column when that adds information. Never the raw content key.
fn row_disp(s: crate::ui::Style, name_col: Option<usize>, t: &Tsv, key: &str) -> String {
    let Some(row) = t.rows.get(key) else {
        return trunc_plain(key);
    };
    let first = row.first().map(String::as_str).unwrap_or("");
    match name_col
        .and_then(|c| row.get(c))
        .map(String::as_str)
        .filter(|v| !v.is_empty() && *v != first)
    {
        Some(name) => format!("{}  {}", trunc_plain(first), s.dim(name)),
        None => trunc_plain(first),
    }
}

fn diff_dataset(s: crate::ui::Style, rel: &str, old: &Tsv, new: &Tsv) {
    let old_keys: BTreeSet<&String> = old.rows.keys().collect();
    let new_keys: BTreeSet<&String> = new.rows.keys().collect();
    let added: Vec<&String> = new_keys.difference(&old_keys).copied().collect();
    let removed: Vec<&String> = old_keys.difference(&new_keys).copied().collect();

    // Changed (id-keyed only): same key, different row content.
    let mut changed: Vec<&String> = Vec::new();
    if old.id_keyed && new.id_keyed {
        for k in old_keys.intersection(&new_keys) {
            if old.rows.get(*k) != new.rows.get(*k) {
                changed.push(k);
            }
        }
    }

    if added.is_empty() && removed.is_empty() && changed.is_empty() {
        return;
    }
    println!(
        "\n  {}  {}  {}  {}",
        s.bold(rel),
        s.green(&format!("＋{}", added.len())),
        s.red(&format!("－{}", removed.len())),
        s.yellow(&format!("~{}", changed.len())),
    );

    let name_col = new
        .header
        .iter()
        .position(|h| h == "name")
        .or_else(|| old.header.iter().position(|h| h == "name"));

    // Sample up to 5 *distinct* labels (content-keyed rows repeat a
    // parent, e.g. many variants of one unique — collapse them).
    let sample = |mark: &str, keys: &[&String], t: &Tsv| {
        let mut seen = BTreeSet::new();
        for k in keys {
            let d = row_disp(s, name_col, t, k);
            if seen.insert(d.clone()) && seen.len() <= 5 {
                println!("    {mark} {d}");
            }
        }
        if seen.len() > 5 {
            println!("    {}", s.dim(&format!("… {} distinct total", seen.len())));
        }
    };
    sample(&s.green("＋"), &added, new);
    sample(&s.red("－"), &removed, old);
    for k in changed.iter().take(5) {
        let (o, n) = (&old.rows[*k], &new.rows[*k]);
        println!(
            "    {} {}  {}",
            s.yellow("~"),
            row_disp(s, name_col, new, k),
            field_deltas(&new.header, o, n),
        );
    }
    if changed.len() > 5 {
        println!(
            "    {}",
            s.dim(&format!("… +{} more changed", changed.len() - 5))
        );
    }
}

/// Describe the columns that differ between two rows, truncated.
fn field_deltas(header: &[String], old: &[String], new: &[String]) -> String {
    let mut parts = Vec::new();
    let width = header.len().max(old.len()).max(new.len());
    for i in 0..width {
        let (o, n) = (
            old.get(i).map(String::as_str).unwrap_or(""),
            new.get(i).map(String::as_str).unwrap_or(""),
        );
        if o != n {
            let col = header.get(i).map(String::as_str).unwrap_or("?");
            parts.push(format!("{col}: {}→{}", trunc(o), trunc(n)));
        }
    }
    if parts.len() > 3 {
        let extra = parts.len() - 3;
        parts.truncate(3);
        parts.push(format!("(+{extra} cols)"));
    }
    parts.join("  ")
}

fn trunc(s: &str) -> String {
    const MAX: usize = 28;
    if s.chars().count() > MAX {
        let head: String = s.chars().take(MAX).collect();
        format!("{head:?}…")
    } else {
        format!("{s:?}")
    }
}

/// Truncate an identifier for display (no surrounding quotes).
fn trunc_plain(s: &str) -> String {
    const MAX: usize = 44;
    if s.chars().count() > MAX {
        let head: String = s.chars().take(MAX).collect();
        format!("{head}…")
    } else {
        s.to_string()
    }
}

// ---------------------------------------------------------------------
// orchestrated: build & render
// ---------------------------------------------------------------------

/// Read a TSV into (header, rows). Columns are looked up by name via the
/// returned `col` closure pattern at the call site.
fn read_tsv(path: &Path) -> Result<(Vec<String>, Vec<Vec<String>>), String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut lines = text.lines();
    let header: Vec<String> = lines
        .next()
        .unwrap_or_default()
        .split('\t')
        .map(str::to_string)
        .collect();
    let rows: Vec<Vec<String>> = lines
        .filter(|l| !l.is_empty())
        .map(|l| l.split('\t').map(str::to_string).collect())
        .collect();
    Ok((header, rows))
}

/// Split a pipe-joined TSV cell into a JSON string array.
fn json_arr(cell: &str) -> json::Value {
    json::Value::Array(
        cell.split('|')
            .filter(|s| !s.is_empty())
            .map(|s| json::Value::Str(s.to_string()))
            .collect(),
    )
}

/// Build the wizard's `skill_catalogue.json` + `item_catalogue.json`
/// entirely from the first-party native TSVs (this replaced the old
/// PoB-derived Python emitter). Gems join to their granted skill via
/// `granted_effect_id` so the support-compatibility filter can read
/// `skill_types`. Icons are
/// left null (the wizard is text-only; first-party icon art is a
/// separate follow-up). Output lands in viewer/assets/ for the serve
/// crate's static handler.
pub fn catalogues(ctx: &Ctx, args: &[String]) -> Result<(), String> {
    let patch = resolve_patch(ctx, args)?;
    let parsed = ctx.root.join("data/parsed").join(&patch);
    let assets = ctx.root.join("viewer/assets");
    let patch_label = patch.trim_end_matches("_native").replace('_', ".");
    let idx = |h: &[String], name: &str| h.iter().position(|c| c == name);

    // ---- Skill catalogue (gems ⋈ granted skill) ----
    let (gh, grows) = read_tsv(&parsed.join("skills/gems.tsv"))?;
    let gc = |n: &str| idx(&gh, n).ok_or_else(|| format!("gems.tsv missing column {n}"));
    let (g_id, g_name, g_tags, g_col, g_coln, g_str, g_dex, g_int, g_ge, g_minlvl) = (
        gc("id")?, gc("name")?, gc("tags")?, gc("gem_colour")?, gc("colour_name")?,
        gc("req_str_pct")?, gc("req_dex_pct")?, gc("req_int_pct")?, gc("granted_effect_id")?,
        gc("min_level")?,
    );

    // Active + support skills keyed by granted_effect_id.
    let (ah, arows) = read_tsv(&parsed.join("skills/active_skills.tsv"))?;
    let (a_ge, a_types, a_desc, a_cast) = (
        idx(&ah, "granted_effect_id").ok_or("active_skills.tsv missing granted_effect_id")?,
        idx(&ah, "skill_types").unwrap_or(usize::MAX),
        idx(&ah, "description").unwrap_or(usize::MAX),
        idx(&ah, "cast_time").unwrap_or(usize::MAX),
    );
    let get = |r: &[String], i: usize| if i == usize::MAX { String::new() } else { r.get(i).cloned().unwrap_or_default() };
    let active: std::collections::HashMap<String, Vec<String>> = arows
        .iter()
        .filter(|r| !get(r, a_ge).is_empty())
        .map(|r| (get(r, a_ge), r.clone()))
        .collect();
    // Fallback join by display NAME: when several GrantedEffects point at
    // one ActiveSkill (Frostbolt has a monster GE too), the reverse index
    // may have kept the wrong one — the gem's granted_effect_id then
    // misses and the gem shipped with empty skill_types/description
    // (caught by the fresh-agent re-audit: only 22 supports evaluated
    // compatible with Frostbolt).
    let a_name = idx(&ah, "name").unwrap_or(usize::MAX);
    let active_by_name: std::collections::HashMap<String, Vec<String>> = arows
        .iter()
        .filter(|r| !get(r, a_name).is_empty())
        .map(|r| (get(r, a_name).to_lowercase(), r.clone()))
        .collect();

    let (sh_, srows) = read_tsv(&parsed.join("skills/support_skills.tsv"))?;
    let (s_id, s_types, s_excl, s_desc) = (
        idx(&sh_, "skill_id").ok_or("support_skills.tsv missing skill_id")?,
        idx(&sh_, "skill_types").unwrap_or(usize::MAX),
        idx(&sh_, "exclude_skill_types").unwrap_or(usize::MAX),
        idx(&sh_, "description").unwrap_or(usize::MAX),
    );
    let support: std::collections::HashMap<String, Vec<String>> =
        srows.iter().map(|r| (get(r, s_id), r.clone())).collect();

    // Max gem level per granted effect (skill_levels ⋈ granted_effect_id).
    let mut max_level: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    if let Ok((lh, lrows)) = read_tsv(&parsed.join("skills/skill_levels.tsv"))
        && let (Some(l_id), Some(l_lvl)) = (idx(&lh, "skill_id"), idx(&lh, "level"))
    {
        for r in &lrows {
            if let (Some(id), Some(Ok(lvl))) = (r.get(l_id), r.get(l_lvl).map(|s| s.parse::<i64>())) {
                let e = max_level.entry(id.clone()).or_insert(0);
                *e = (*e).max(lvl);
            }
        }
    }

    let mut gems: Vec<json::Value> = Vec::with_capacity(grows.len());
    for r in &grows {
        // GGG marks dev/unreleased gems with a literal "[DNT-UNUSED]"
        // name prefix (Do Not Translate). They're real table rows but
        // not obtainable; the picker must never offer them. (The old
        // PoB-derived catalogue filtered these upstream — keep parity.)
        // Template entries ("Companion: {0}", "Spectre: {0}") are
        // parameterized runtime names, equally un-referenceable — the
        // fresh-agent audit flagged them as hallucination bait.
        let name = get(r, g_name);
        if name.starts_with("[DNT")
            || name.trim().is_empty()
            || name.contains("{0}")
            || name == "Coming Soon"
            || name == "Removed Skill"
        {
            continue;
        }
        let ge = get(r, g_ge);
        let sup = support.get(&ge);
        let act = active
            .get(&ge)
            .or_else(|| active_by_name.get(&name.to_lowercase()));
        let gem_type = if sup.is_some() { "Support" } else { "Active" };
        let tags = get(r, g_tags);
        let mut m = json::Map::new();
        m.insert("id".into(), json::Value::Str(get(r, g_id)));
        m.insert("name".into(), json::Value::Str(get(r, g_name)));
        m.insert("gem_type".into(), json::Value::Str(gem_type.into()));
        m.insert("tags".into(), json_arr(&tags));
        // tag_string fallback: gem tags are empty for many weapons-class
        // gems (crossbow/grenade audit hit this) — derive a searchable
        // string from the first few skill_types instead. Internal
        // bookkeeping tags (up_to_level_N_gem) are display noise.
        let display_tags: Vec<&str> = tags
            .split('|')
            .filter(|t| !t.is_empty() && !t.starts_with("up_to_level_"))
            .collect();
        let tag_str = if display_tags.is_empty() {
            act.map(|a| get(a, a_types))
                .unwrap_or_default()
                .split('|')
                .take(4)
                .collect::<Vec<_>>()
                .join(", ")
        } else {
            display_tags.join(", ")
        };
        m.insert("tag_string".into(), json::Value::Str(tag_str));
        for (k, i) in [("req_str", g_str), ("req_dex", g_dex), ("req_int", g_int)] {
            m.insert(k.into(), json::Value::Integer(get(r, i).parse().unwrap_or(0)));
        }
        // GrantedEffectsPerLevel runs to ~40 to leave headroom for +levels
        // from supports/items; a gem's own natural cap is 20 (1 for
        // non-leveling gems, which have a single-level table).
        m.insert("natural_max_level".into(), json::Value::Integer(max_level.get(&ge).copied().unwrap_or(0).min(20)));
        m.insert("req_level".into(), json::Value::Integer(get(r, g_minlvl).parse().unwrap_or(0)));
        // (skill_levels' level_requirement column is unpopulated in 0.5
        // data — per-gem-level char requirements can't be emitted yet;
        // req_level + the primer's gem-level rule of thumb cover it.)
        m.insert("granted_effect_id".into(), json::Value::Str(ge.clone()));
        m.insert("color".into(), json::Value::Integer(get(r, g_col).parse().unwrap_or(0)));
        m.insert("color_name".into(), json::Value::Str(get(r, g_coln)));
        // Description: actives carry theirs on active_skills; supports on
        // support_skills — agents (and the picker) need to know what a
        // support DOES to pair it sensibly, not just its type gates.
        let desc = act
            .map(|a| get(a, a_desc))
            .filter(|d| !d.is_empty())
            .or_else(|| sup.map(|s| get(s, s_desc)))
            .unwrap_or_default();
        m.insert("description".into(), json::Value::Str(desc));
        m.insert("cast_time".into(), json::Value::Str(act.map(|a| get(a, a_cast)).unwrap_or_default()));
        // Gem inventory art, extracted by `sprites` from icon_dds.
        let icon_dds = idx(&gh, "icon_dds").map(|i| get(r, i)).unwrap_or_default();
        if icon_dds.is_empty() {
            m.insert("icon".into(), json::Value::Null);
        } else {
            m.insert(
                "icon".into(),
                json::Value::Str(format!("/assets/sprites/{}.png", sprite_safe_name(&icon_dds))),
            );
        }
        m.insert("gem_icon".into(), json::Value::Null);
        // Display parts (stat-set labels): what the skill consists of —
        // "Flask · Acidic Burst", "Core · Explosion". Multi-part gems
        // are real in 0.5 (112 of them); the hover lists every part.
        m.insert(
            "parts".into(),
            json_arr(&idx(&gh, "parts").map(|i| get(r, i)).unwrap_or_default()),
        );
        // Actives grant their skill_types; supports gate on require/exclude.
        m.insert("skill_types".into(), json_arr(&act.map(|a| get(a, a_types)).unwrap_or_default()));
        m.insert("require_skill_types".into(), json_arr(&sup.map(|s| get(s, s_types)).unwrap_or_default()));
        m.insert("exclude_skill_types".into(), json_arr(&sup.map(|s| get(s, s_excl)).unwrap_or_default()));
        gems.push(json::Value::Object(m));
    }
    // Dedupe exact name+type duplicates (Skeletal Sniper ships twice;
    // Herald of Thunder / Blink also exist as UniqueSkillGem/SandPlayer
    // variants with EMPTY skill_types that would fail every compat
    // check). Name-based agent imports need ONE deterministic winner:
    // prefer the real player gem — non-Unique-variant id, non-empty
    // skill_types — then lowest id.
    {
        let pref = |g: &json::Value| -> (bool, bool, String) {
            let id = g.get("id").and_then(|x| x.as_str()).unwrap_or_default();
            let types_empty = g
                .get("skill_types")
                .and_then(|x| x.as_array())
                .is_none_or(|a| a.is_empty());
            (id.contains("UniqueSkillGem"), types_empty, id.to_string())
        };
        gems.sort_by_key(|a| pref(a));
        let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
        gems.retain(|g| {
            let key = (
                g.get("name").and_then(|x| x.as_str()).unwrap_or_default().to_lowercase(),
                g.get("gem_type").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
            );
            seen.insert(key)
        });
    }
    let gem_count = gems.len();
    // Stable sort by name → id so the JSON diffs cleanly across patches.
    gems.sort_by(|a, b| {
        let k = |v: &json::Value| (
            v.get("name").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
            v.get("id").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
        );
        k(a).cmp(&k(b))
    });
    let mut skill = json::Map::new();
    skill.insert("schema_version".into(), json::Value::Integer(1));
    skill.insert("patch".into(), json::Value::Str(patch_label.clone()));
    skill.insert("source".into(), json::Value::Str("first-party".into()));
    skill.insert("count".into(), json::Value::Integer(gems.len() as i64));
    skill.insert("gems".into(), json::Value::Array(gems));
    std::fs::create_dir_all(&assets).map_err(|e| e.to_string())?;
    std::fs::write(assets.join("skill_catalogue.json"), json::emit_pretty(&json::Value::Object(skill)) + "\n")
        .map_err(|e| e.to_string())?;

    // ---- Item catalogue (uniques ⋈ base ⋈ unique_art) ----
    // Unique inventory art is first-party (UniqueStashLayout → Words →
    // ItemVisualIdentity, shaped by `shape unique_art`); the icon field
    // points at the sprite the `sprites` command extracted.
    let unique_art: std::collections::HashMap<String, String> =
        read_tsv(&parsed.join("items/unique_art.tsv"))
            .ok()
            .and_then(|(ah, arows)| {
                let n = idx(&ah, "name")?;
                let d = idx(&ah, "icon_dds")?;
                Some(
                    arows
                        .iter()
                        .filter_map(|r| Some((r.get(n)?.clone(), r.get(d)?.clone())))
                        .filter(|(_, d)| !d.is_empty())
                        .collect(),
                )
            })
            .unwrap_or_default();
    // PoB unique names drift slightly from GGG's Words rows (letter
    // transpositions like Byrnabas/Brynabas, "Sekhema's Resolve" vs its
    // per-element rows, "Waistgate Heavy Belt" vs "Waistgate"). Fallback
    // for exact-lookup misses: sorted-letter signature, then prefix /
    // containment — applied only when the exact name has no art.
    // Letter-SET signature (not multiset): survives both transpositions
    // (Byrnabas/Brynabas) and doubled-letter drift (Lorrata/Loratta).
    // Only consulted when the exact name misses, so collision risk is
    // confined to the handful of drifted names.
    let sig = |s: &str| -> String {
        let mut cs: Vec<char> = s
            .to_lowercase()
            .chars()
            .filter(|c| c.is_alphanumeric())
            .collect();
        cs.sort_unstable();
        cs.dedup();
        cs.into_iter().collect()
    };
    let art_by_sig: std::collections::HashMap<String, String> = unique_art
        .iter()
        .map(|(n, d)| (sig(n), d.clone()))
        .collect();
    let art_fuzzy = |name: &str| -> Option<String> {
        unique_art
            .get(name)
            .or_else(|| art_by_sig.get(&sig(name)))
            .cloned()
            .or_else(|| {
                let nl = name.to_lowercase();
                unique_art
                    .iter()
                    .find(|(k, _)| {
                        let kl = k.to_lowercase();
                        kl.starts_with(&nl) || nl.starts_with(&kl)
                    })
                    .map(|(_, d)| d.clone())
            })
    };
    let mut uniq_count = 0usize;
    // Per-variant stat lines (variant label → lines), current-era only.
    let mut variants_by_name: std::collections::HashMap<String, Vec<(String, String)>> =
        std::collections::HashMap::new();
    if let Ok((vh, vvrows)) = read_tsv(&parsed.join("items/uniques_variants.tsv"))
        && let (Some(v_n), Some(v_l), Some(v_s)) =
            (idx(&vh, "name"), idx(&vh, "variant_label"), idx(&vh, "stat"))
        {
            for r in &vvrows {
                let (Some(n), Some(l), Some(st)) = (r.get(v_n), r.get(v_l), r.get(v_s)) else {
                    continue;
                };
                if l.starts_with("Pre ") || l.is_empty() || n.is_empty() {
                    continue;
                }
                variants_by_name.entry(n.clone()).or_default().push((l.clone(), st.clone()));
            }
        }
    if let Ok((uh, urows)) = read_tsv(&parsed.join("items/uniques.tsv")) {
        let uc = |n: &str| idx(&uh, n);
        let bases = read_tsv(&parsed.join("items/bases.tsv")).ok();
        let base_map: std::collections::HashMap<String, Vec<String>> = bases
            .as_ref()
            .and_then(|(bh, brows)| idx(bh, "name").map(|bn| (bn, brows)))
            .map(|(bn, brows)| brows.iter().map(|r| (r.get(bn).cloned().unwrap_or_default(), r.clone())).collect())
            .unwrap_or_default();
        let (bh_tags, bh_req) = bases
            .as_ref()
            .map(|(bh, _)| (idx(bh, "tags"), idx(bh, "drop_level")))
            .unwrap_or((None, None));
        let mut items: Vec<json::Value> = Vec::with_capacity(urows.len());
        for r in &urows {
            let cell = |n: &str| uc(n).and_then(|i| r.get(i)).cloned().unwrap_or_default();
            let base = cell("base");
            let brow = base_map.get(&base);
            let mut m = json::Map::new();
            let name = cell("name");
            m.insert("name".into(), json::Value::Str(name.clone()));
            m.insert("base".into(), json::Value::Str(base));
            m.insert("slot".into(), json::Value::Str(cell("slot_file")));
            m.insert("variant_count".into(), json::Value::Integer(cell("variant_count").parse().unwrap_or(1)));
            m.insert("latest_variant".into(), json::Value::Str(cell("latest_variant")));
            m.insert("latest_stats".into(), json::Value::Str(cell("latest_stats")));
            // Rollable variants (current-era only — "Pre X" labels are
            // legacy history): label + stat lines, so the planner and
            // agents can pick WHICH roll ("Split Personality: Warrior"
            // = allocate from the Warrior start).
            if let Some(vlist) = variants_by_name.get(&name) {
                // FIRST-APPEARANCE order = variant_index order (the
                // TSV is index-sorted). Ordinal position is load-
                // bearing: timeless conqueror rolls map to
                // ConquerorIndex by position, so alphabetizing here
                // would scramble the keystone conversions.
                let mut labels: Vec<&str> = Vec::new();
                for (l, _) in vlist {
                    if !labels.contains(&l.as_str()) {
                        labels.push(l.as_str());
                    }
                }
                if labels.len() > 1 {
                    let arr: Vec<json::Value> = labels
                        .iter()
                        .map(|label| {
                            let stats: Vec<String> = vlist
                                .iter()
                                .filter(|(l, _)| l == label)
                                .map(|(_, st)| st.clone())
                                .collect();
                            let mut vm = json::Map::new();
                            vm.insert("label".into(), json::Value::Str((*label).to_string()));
                            vm.insert("stats".into(), json::Value::Str(stats.join(" · ")));
                            json::Value::Object(vm)
                        })
                        .collect();
                    m.insert("variants".into(), json::Value::Array(arr));
                }
            }
            m.insert(
                "icon".into(),
                match art_fuzzy(&name) {
                    Some(dds) => json::Value::Str(format!(
                        "/assets/sprites/{}.png",
                        sprite_safe_name(&dds)
                    )),
                    None => json::Value::Null,
                },
            );
            m.insert("req_level".into(), brow.zip(bh_req).map(|(b, i)| json::Value::Integer(b.get(i).and_then(|s| s.parse().ok()).unwrap_or(0))).unwrap_or(json::Value::Null));
            m.insert("tags".into(), json_arr(&brow.zip(bh_tags).map(|(b, i)| b.get(i).cloned().unwrap_or_default()).unwrap_or_default()));
            items.push(json::Value::Object(m));
        }
        items.sort_by(|a, b| {
            let k = |v: &json::Value| (
                v.get("slot").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
                v.get("name").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
            );
            k(a).cmp(&k(b))
        });
        uniq_count = items.len();
        let mut item = json::Map::new();
        item.insert("schema_version".into(), json::Value::Integer(1));
        item.insert("patch".into(), json::Value::Str(patch_label));
        item.insert("source".into(), json::Value::Str("first-party".into()));
        item.insert("count".into(), json::Value::Integer(items.len() as i64));
        item.insert("uniques".into(), json::Value::Array(items));
        std::fs::write(assets.join("item_catalogue.json"), json::emit_pretty(&json::Value::Object(item)) + "\n")
            .map_err(|e| e.to_string())?;
    }

    // ---- Agent base-item grounding (/assets/agent/bases.json) ----
    // Fresh-agent audits showed gear[] devolving to "any rare with ES":
    // agents had no base vocabulary. Give them every equipment base with
    // its slot, attribute requirements and defence numbers so a plan can
    // say {base:"Expert Hexer's Robe", rarity:"rare", mods:[...]}.
    let mut base_count = 0usize;
    // Grants sidecar (items/grants.tsv, `shape grants`): base name →
    // (spirit granted, item-granted skill names). Absent = fields
    // simply don't appear (older datasets).
    let mut grants_by_name: std::collections::HashMap<String, (i64, Vec<String>)> =
        std::collections::HashMap::new();
    if let Ok((gh, grows)) = read_tsv(&parsed.join("items/grants.tsv")) {
        let gcol = |n: &str| idx(&gh, n);
        if let (Some(g_id), Some(g_name), Some(g_sp), Some(g_gr)) =
            (gcol("base_id"), gcol("name"), gcol("spirit"), gcol("grants"))
        {
            for r in &grows {
                // Unique-only base variants (…SceptreUnique1) share the
                // display name of the normal base but grant a skill a
                // player can never roll on it — exclude from the union.
                if r.get(g_id).is_some_and(|id| id.contains("Unique")) {
                    continue;
                }
                let name = r.get(g_name).cloned().unwrap_or_default();
                let sp: i64 = r.get(g_sp).and_then(|s| s.parse().ok()).unwrap_or(0);
                let gr: Vec<String> = r
                    .get(g_gr)
                    .map(|s| s.split('|').filter(|x| !x.is_empty()).map(str::to_string).collect())
                    .unwrap_or_default();
                if !name.is_empty() {
                    // Same display name can cover several base variants
                    // with DIFFERENT grants (the three Shrine Sceptres
                    // grant Purity of Fire/Ice/Lightning) — union them.
                    let e = grants_by_name.entry(name).or_insert((0, Vec::new()));
                    e.0 = e.0.max(sp);
                    for g in gr {
                        if !e.1.contains(&g) {
                            e.1.push(g);
                        }
                    }
                }
            }
        }
    }
    if let Ok((bh, brows)) = read_tsv(&parsed.join("items/bases.tsv")) {
        let bcol = |n: &str| idx(&bh, n);
        if let (Some(b_name), Some(b_class), Some(b_lvl)) =
            (bcol("name"), bcol("item_class"), bcol("drop_level"))
        {
            // item_class → agent gear-slot vocabulary. Weapon classes map
            // to "weapon1", offhands to "offhand1" (the importer bumps
            // pairs); non-equipment classes are excluded entirely.
            let slot_of = |class: &str| -> Option<&'static str> {
                Some(match class {
                    "Body Armour" => "body",
                    "Helmet" => "helmet",
                    "Gloves" => "gloves",
                    "Boots" => "boots",
                    "Amulet" | "Talisman" => "amulet",
                    "Ring" => "ring1",
                    "Belt" => "belt",
                    "One Hand Mace" | "Two Hand Mace" | "Sceptre" | "Spear" | "Bow"
                    | "Crossbow" | "Wand" | "Staff" | "Warstaff" => "weapon1",
                    "Shield" | "Buckler" | "Focus" | "Quiver" => "offhand1",
                    "LifeFlask" | "ManaFlask" | "UtilityFlask" => "flask",
                    "Jewel" => "jewel",
                    _ => return None,
                })
            };
            let g2 = |r: &[String], i: Option<usize>| {
                i.and_then(|i| r.get(i)).cloned().unwrap_or_default()
            };
            let num = |r: &[String], i: Option<usize>| -> i64 {
                i.and_then(|i| r.get(i)).and_then(|s| s.parse().ok()).unwrap_or(0)
            };
            let (b_str, b_dex, b_int) = (bcol("req_str"), bcol("req_dex"), bcol("req_int"));
            let (b_ar, b_ev, b_es) = (bcol("armour"), bcol("evasion"), bcol("energy_shield"));
            let (b_ward, b_block) = (bcol("ward"), bcol("block"));
            let (b_dmin, b_dmax) = (bcol("damage_min"), bcol("damage_max"));
            let (b_crit, b_speed) = (bcol("crit_chance"), bcol("attack_speed"));
            let b_icon = bcol("icon_dds");
            let b_tags2 = bcol("tags");
            let mut arr: Vec<json::Value> = Vec::new();
            for r in &brows {
                let name = g2(r, Some(b_name));
                let Some(slot) = slot_of(&g2(r, Some(b_class))) else { continue };
                if name.trim().is_empty() || name.contains("{0}") || name.starts_with("[DNT") {
                    continue;
                }
                let mut m = json::Map::new();
                m.insert("name".into(), json::Value::Str(name));
                m.insert("slot".into(), json::Value::Str(slot.into()));
                m.insert("class".into(), json::Value::Str(g2(r, Some(b_class))));
                m.insert("lvl".into(), json::Value::Integer(num(r, Some(b_lvl))));
                // Sprite path for the gear strip/pickers (art extracted
                // by the `sprites` command from bases.tsv icon_dds).
                let dds = g2(r, b_icon);
                if !dds.is_empty() {
                    m.insert(
                        "icon".into(),
                        json::Value::Str(format!(
                            "/assets/sprites/{}.png",
                            sprite_safe_name(&dds)
                        )),
                    );
                }
                // Real GGG tags (int_armour, ezomyte_basetype, …) — the
                // base side of the mod spawn-weight gate. Class-level
                // tags (body_armour, ring, …) are derived by consumers
                // from `class`.
                let tags = g2(r, b_tags2);
                if !tags.is_empty() {
                    m.insert(
                        "tags".into(),
                        json::Value::Array(
                            tags.split('|')
                                .filter(|t| !t.is_empty())
                                .map(|t| json::Value::Str(t.to_string()))
                                .collect(),
                        ),
                    );
                }
                for (k, i2) in [("str", b_str), ("dex", b_dex), ("int", b_int),
                                ("ar", b_ar), ("ev", b_ev), ("es", b_es),
                                ("ward", b_ward), ("block", b_block)] {
                    let v = num(r, i2);
                    if v > 0 {
                        m.insert(k.into(), json::Value::Integer(v));
                    }
                }
                // Weapon numbers, display-ready: damage range, attacks
                // per second (GGG stores attack TIME in ms), crit % (GGG
                // stores basis points).
                let (dmin, dmax) = (num(r, b_dmin), num(r, b_dmax));
                if dmax > 0 {
                    m.insert("dmg".into(), json::Value::Array(vec![
                        json::Value::Integer(dmin), json::Value::Integer(dmax),
                    ]));
                    let speed = num(r, b_speed);
                    if speed > 0 {
                        m.insert("aps".into(), json::Value::Float((1000.0 / speed as f64 * 100.0).round() / 100.0));
                    }
                    let crit = num(r, b_crit);
                    if crit > 0 {
                        m.insert("crit".into(), json::Value::Float(crit as f64 / 100.0));
                    }
                }
                // Grants while equipped (items/grants.tsv): base spirit
                // (sceptres carry 100) and item-granted skills — the
                // "Shrine Sceptre grants Purity of Fire" chain, mined
                // from ItemSpirit + ModGrantedSkills.
                if let Some((sp, gr)) = grants_by_name.get(&g2(r, Some(b_name))) {
                    if *sp > 0 {
                        m.insert("spirit".into(), json::Value::Integer(*sp));
                    }
                    if !gr.is_empty() {
                        m.insert("grants".into(), json::Value::Array(
                            gr.iter().map(|s| json::Value::Str(s.clone())).collect(),
                        ));
                    }
                }
                arr.push(json::Value::Object(m));
            }
            arr.sort_by(|a, b| {
                let k = |v: &json::Value| (
                    v.get("slot").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
                    v.get("lvl").and_then(|x| x.as_i64()).unwrap_or(0),
                );
                k(a).cmp(&k(b))
            });
            base_count = arr.len();
            let agent_dir = assets.join("agent");
            let _ = std::fs::create_dir_all(&agent_dir);
            let mut root = json::Map::new();
            root.insert("format".into(), json::Value::Str("poe2-agent-bases".into()));
            root.insert("version".into(), json::Value::Integer(1));
            root.insert("count".into(), json::Value::Integer(base_count as i64));
            root.insert("bases".into(), json::Value::Array(arr));
            std::fs::write(
                agent_dir.join("bases.json"),
                json::emit_pretty(&json::Value::Object(root)) + "\n",
            )
            .map_err(|e| e.to_string())?;
        }
    }

    // ---- Agent mod vocabulary (/assets/agent/mods.json) ----
    // Complements bases.json: the finite affix vocabulary that can
    // actually roll on equipment, grouped by mod family, so gear[].mods
    // entries are real concepts instead of freeform wishes. Filtered to
    // item-domain prefixes/suffixes whose spawn weights hit a core
    // equipment tag with weight > 0 (drops league/monster/jewel noise).
    let mut mod_count = 0usize;
    if let Ok((mh, mrows)) = read_tsv(&parsed.join("items/mods.tsv")) {
        let mcol = |n: &str| idx(&mh, n);
        if let (Some(m_dom), Some(m_gen), Some(m_type), Some(m_stats), Some(m_sw)) = (
            mcol("domain"), mcol("generation_type"), mcol("mod_type"),
            mcol("stats"), mcol("spawn_weights"),
        ) {
            const CORE_TAGS: &[&str] = &[
                "amulet", "ring", "belt", "body_armour", "boots", "gloves", "helmet",
                "shield", "focus", "quiver", "bow", "crossbow", "mace", "sceptre",
                "spear", "staff", "wand", "armour", "weapon", "str_armour",
                "dex_armour", "int_armour", "str_dex_armour", "str_int_armour",
                "dex_int_armour", "str_dex_int_armour",
                // Jewel-domain gating tags (strjewel = Ruby, dexjewel =
                // Emerald, intjewel = Sapphire; *_radius_jewel = the
                // Time-Lost variants). "default" jewel mods roll on any.
                "strjewel", "dexjewel", "intjewel",
                "str_radius_jewel", "dex_radius_jewel", "int_radius_jewel",
                "radius_jewel",
            ];
            let g2 = |r: &[String], i: usize| r.get(i).cloned().unwrap_or_default();
            let m_lvl = mcol("required_level");
            // Display text needs the stat-description CSD — best-effort
            // (the vocabulary still ships without text if offline).
            let sd = (|| -> Option<data_miner::csd::StatDescriptions> {
                let client = CdnClient::connect().ok()?;
                let index = load_index(&client).ok()?;
                let bytes = extract_by_path(
                    &client,
                    &index,
                    "data/statdescriptions/stat_descriptions.csd",
                )
                .ok()?;
                let mut sd = data_miner::csd::StatDescriptions::new();
                sd.parse(&data_miner::csd::StatDescriptions::decode_utf16(&bytes));
                Some(sd)
            })();
            if sd.is_none() {
                ui::warn(ctx.style, "mods.json: stat_descriptions.csd unavailable — no display text");
            }
            // mod family → kind, stat ids, slot tags, plus a rendering
            // recipe: the highest-level row's stat ORDER with the range
            // UNION across the whole tier ladder ("+(5-99) to maximum
            // Life" describes the family, not one tier).
            struct Fam {
                kind: String,
                stats: std::collections::BTreeSet<String>,
                slots: std::collections::BTreeSet<String>,
                // Distinct raw spawn-weight strings — the game's gating
                // is ORDERED first-match (a leading `int_armour:0`
                // excludes ES bases even when a later generic tag is
                // positive), so sets of positive tags aren't enough.
                weights: std::collections::BTreeSet<String>,
                rep_level: i64,
                rep: Vec<(String, i64, i64)>,
                span: std::collections::BTreeMap<String, (i64, i64)>,
            }
            let mut fam: std::collections::BTreeMap<String, Fam> = std::collections::BTreeMap::new();
            for r in &mrows {
                let dom = g2(r, m_dom);
                if dom != "item" && dom != "jewel" {
                    continue;
                }
                let gentype = g2(r, m_gen);
                if gentype != "prefix" && gentype != "suffix" {
                    continue;
                }
                let mut slots: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
                for sw in g2(r, m_sw).split('|') {
                    let mut it = sw.split(':');
                    let (tag, w) = (it.next().unwrap_or(""), it.next().unwrap_or("0"));
                    if CORE_TAGS.contains(&tag) && w != "0" {
                        slots.insert(tag.to_string());
                    }
                    // Jewel mods gated only by `default` roll on every
                    // jewel — give them the generic tag.
                    if dom == "jewel" && tag == "default" && w != "0" {
                        slots.insert("jewel".to_string());
                    }
                }
                if slots.is_empty() {
                    continue;
                }
                // `stats` cell is |-separated `stat_id:lo:hi` (ids carry
                // no colon — split from the right, as in load_mod_stats).
                let mut parsed: Vec<(String, i64, i64)> = Vec::new();
                for tok in g2(r, m_stats).split('|').filter(|t| !t.is_empty()) {
                    let mut it = tok.rsplitn(3, ':');
                    let hi = it.next().and_then(|s| s.parse::<i64>().ok());
                    let lo = it.next().and_then(|s| s.parse::<i64>().ok());
                    if let (Some(sid), Some(lo), Some(hi)) = (it.next(), lo, hi) {
                        parsed.push((sid.to_string(), lo, hi));
                    }
                }
                let lvl: i64 = m_lvl.map(|i| g2(r, i).parse().unwrap_or(0)).unwrap_or(0);
                let e = fam.entry(g2(r, m_type)).or_insert_with(|| Fam {
                    kind: gentype.clone(),
                    stats: Default::default(),
                    slots: Default::default(),
                    weights: Default::default(),
                    rep_level: -1,
                    rep: Vec::new(),
                    span: Default::default(),
                });
                e.weights.insert(g2(r, m_sw));
                for (sid, lo, hi) in &parsed {
                    e.stats.insert(sid.clone());
                    let s = e.span.entry(sid.clone()).or_insert((*lo, *hi));
                    s.0 = s.0.min(*lo);
                    s.1 = s.1.max(*hi);
                }
                if lvl > e.rep_level && !parsed.is_empty() {
                    e.rep_level = lvl;
                    e.rep = parsed;
                }
                e.slots.extend(slots);
            }
            let mut arr: Vec<json::Value> = Vec::new();
            for (ty, f) in fam {
                let mut m = json::Map::new();
                m.insert("type".into(), json::Value::Str(ty));
                m.insert("kind".into(), json::Value::Str(f.kind));
                if let Some(sd) = &sd {
                    let spanned: Vec<(String, i64, i64)> = f
                        .rep
                        .iter()
                        .map(|(sid, lo, hi)| {
                            let (l, h) = f.span.get(sid).copied().unwrap_or((*lo, *hi));
                            (sid.clone(), l, h)
                        })
                        .collect();
                    let lines = sd.render_ranges(&spanned);
                    if !lines.is_empty() {
                        m.insert("text".into(), json::Value::Str(lines.join(" · ")));
                    }
                }
                m.insert("stats".into(), json::Value::Array(f.stats.into_iter().map(json::Value::Str).collect()));
                m.insert("slots".into(), json::Value::Array(f.slots.into_iter().map(json::Value::Str).collect()));
                // Ordered gate lists, one per distinct spawn-weight
                // string: [[tag, weight], ...]. A family can roll on a
                // base iff ANY gate list's FIRST tag matching the
                // base's tags (`default` matches everything) has
                // weight > 0 — the game's own evaluation order.
                let gates: Vec<json::Value> = f
                    .weights
                    .iter()
                    .map(|w| {
                        json::Value::Array(
                            w.split('|')
                                .filter(|t| !t.is_empty())
                                .filter_map(|tok| {
                                    let mut it = tok.split(':');
                                    let tag = it.next()?;
                                    let wt: i64 = it.next()?.parse().ok()?;
                                    Some(json::Value::Array(vec![
                                        json::Value::Str(tag.to_string()),
                                        json::Value::Integer(wt),
                                    ]))
                                })
                                .collect(),
                        )
                    })
                    .collect();
                m.insert("gates".into(), json::Value::Array(gates));
                arr.push(json::Value::Object(m));
            }
            mod_count = arr.len();
            let agent_dir = assets.join("agent");
            let _ = std::fs::create_dir_all(&agent_dir);
            let mut root = json::Map::new();
            root.insert("format".into(), json::Value::Str("poe2-agent-mods".into()));
            root.insert("version".into(), json::Value::Integer(1));
            root.insert("count".into(), json::Value::Integer(mod_count as i64));
            root.insert("mods".into(), json::Value::Array(arr));
            std::fs::write(
                agent_dir.join("mods.json"),
                json::emit_pretty(&json::Value::Object(root)) + "\n",
            )
            .map_err(|e| e.to_string())?;
        }
    }

    ui::ok(
        ctx.style,
        &format!("wizard catalogues → viewer/assets/ ({gem_count} gems, {uniq_count} uniques, {base_count} bases, {mod_count} mod families, first-party)"),
    );
    Ok(())
}

pub fn render(ctx: &Ctx, args: &[String]) -> Result<(), String> {
    let (program, mut argv) = sibling_or_cargo("tree_render", "tree_render");
    // Default output if the caller didn't pass one.
    if !args.iter().any(|a| a == "--output") {
        argv.push("--output".into());
        argv.push("viewer/planner.html".into());
    }
    argv.extend(args.iter().cloned());
    sh(ctx, "render planner.html", &program, &argv)
}

// ---------------------------------------------------------------------
// fixture: a runnable viewer with zero game data
// ---------------------------------------------------------------------

/// Paint a filled disc (icons) as RGBA: `rgb` at full alpha inside the
/// radius, soft edge, transparent outside.
fn fx_disc(size: u32, rgb: [u8; 3]) -> Vec<u8> {
    let mut px = vec![0u8; (size * size * 4) as usize];
    let c = (size as f64 - 1.0) / 2.0;
    let r = c - 1.0;
    for y in 0..size {
        for x in 0..size {
            let d = (((x as f64 - c).powi(2) + (y as f64 - c).powi(2)).sqrt() - r).max(0.0);
            let a = (255.0 * (1.0 - d / 1.5).clamp(0.0, 1.0)) as u8;
            let i = ((y * size + x) * 4) as usize;
            px[i] = rgb[0];
            px[i + 1] = rgb[1];
            px[i + 2] = rgb[2];
            px[i + 3] = a;
        }
    }
    px
}

/// Paint a ring (frames): transparent center, `rgb` band of the given
/// thickness at the rim.
fn fx_ring(size: u32, rgb: [u8; 3], thickness: f64) -> Vec<u8> {
    let mut px = vec![0u8; (size * size * 4) as usize];
    let c = (size as f64 - 1.0) / 2.0;
    let r_out = c - 1.0;
    let r_in = r_out - thickness;
    for y in 0..size {
        for x in 0..size {
            let d = ((x as f64 - c).powi(2) + (y as f64 - c).powi(2)).sqrt();
            let edge = (r_out - d).min(d - r_in);
            let a = (255.0 * (edge / 1.5).clamp(0.0, 1.0)) as u8;
            let i = ((y * size + x) * 4) as usize;
            px[i] = rgb[0];
            px[i + 1] = rgb[1];
            px[i + 2] = rgb[2];
            px[i + 3] = a;
        }
    }
    px
}

/// Radial falloff glow (mastery pattern, tree background).
fn fx_glow(size: u32, rgb: [u8; 3]) -> Vec<u8> {
    let mut px = vec![0u8; (size * size * 4) as usize];
    let c = (size as f64 - 1.0) / 2.0;
    for y in 0..size {
        for x in 0..size {
            let d = ((x as f64 - c).powi(2) + (y as f64 - c).powi(2)).sqrt() / c;
            let a = (160.0 * (1.0 - d).clamp(0.0, 1.0)) as u8;
            let i = ((y * size + x) * 4) as usize;
            px[i] = rgb[0];
            px[i + 1] = rgb[1];
            px[i + 2] = rgb[2];
            px[i + 3] = a;
        }
    }
    px
}

/// Solid square with a contrasting rim (portraits, panels, bg tile).
fn fx_square(size: u32, rgb: [u8; 3], rim: [u8; 3]) -> Vec<u8> {
    let mut px = vec![0u8; (size * size * 4) as usize];
    for y in 0..size {
        for x in 0..size {
            let on_rim = x < 2 || y < 2 || x >= size - 2 || y >= size - 2;
            let col = if on_rim { rim } else { rgb };
            let i = ((y * size + x) * 4) as usize;
            px[i] = col[0];
            px[i + 1] = col[1];
            px[i + 2] = col[2];
            px[i + 3] = 255;
        }
    }
    px
}

/// `./bw fixture` — make a clean clone runnable with ZERO game data.
/// Generates original placeholder sprites (procedural discs/rings —
/// no GGG content anywhere) into viewer/assets/sprites/, then renders
/// planner.html from the committed toy tree at data/fixture/tree/.
pub fn fixture(ctx: &Ctx, _args: &[String]) -> Result<(), String> {
    let dir = ctx.root.join("viewer/assets/sprites");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let write = |name: &str, size: u32, rgba: &[u8]| -> Result<(), String> {
        let png = data_miner::png::encode_rgba(size, size, rgba);
        std::fs::write(dir.join(name), png).map_err(|e| format!("writing {name}: {e}"))
    };

    // Icons (discs) + frames (rings) — dim "off", bright "on".
    write("fixture_icon_small.png", 48, &fx_disc(48, [90, 140, 220]))?;
    write("fixture_icon_notable.png", 56, &fx_disc(56, [220, 180, 80]))?;
    write("fixture_icon_keystone.png", 80, &fx_disc(80, [170, 110, 220]))?;
    write("fixture_icon_asc_a.png", 48, &fx_disc(48, [110, 210, 140]))?;
    write("fixture_icon_asc_b.png", 48, &fx_disc(48, [220, 110, 110]))?;
    write("fixture_frame_small_off.png", 64, &fx_ring(64, [110, 110, 120], 4.0))?;
    write("fixture_frame_small_on.png", 64, &fx_ring(64, [230, 230, 200], 4.0))?;
    write("fixture_frame_notable_off.png", 96, &fx_ring(96, [130, 115, 80], 6.0))?;
    write("fixture_frame_notable_on.png", 96, &fx_ring(96, [255, 215, 130], 6.0))?;
    write("fixture_frame_keystone_off.png", 128, &fx_ring(128, [120, 95, 140], 8.0))?;
    write("fixture_frame_keystone_on.png", 128, &fx_ring(128, [220, 170, 255], 8.0))?;
    write("fixture_frame_asc_off.png", 96, &fx_ring(96, [80, 130, 130], 6.0))?;
    write("fixture_frame_asc_on.png", 96, &fx_ring(96, [140, 240, 240], 6.0))?;
    write("fixture_frame_class_start.png", 48, &fx_ring(48, [200, 200, 210], 3.0))?;
    write("fixture_asc_middle.png", 100, &fx_ring(100, [180, 220, 220], 10.0))?;
    write("fixture_mastery_glow.png", 256, &fx_glow(256, [120, 160, 255]))?;
    write("fixture_face_alpha.png", 128, &fx_square(128, [40, 70, 110], [140, 180, 230]))?;
    write("fixture_face_beta.png", 128, &fx_square(128, [110, 50, 50], [230, 150, 150]))?;
    write("fixture_panel_alpha.png", 256, &fx_square(256, [24, 40, 60], [90, 130, 170]))?;
    write("fixture_panel_beta.png", 256, &fx_square(256, [60, 28, 28], [170, 100, 100]))?;
    write("fixture_bgtree.png", 256, &fx_glow(256, [40, 44, 56]))?;
    write("fixture_bg_tile.png", 64, &fx_square(64, [14, 15, 19], [20, 22, 28]))?;

    // Orbit connector sprites: the planner fetches these 90 fixed
    // names directly (image_preload) — same tiny strip per state.
    let strip = |rgb: [u8; 3]| -> Vec<u8> {
        let (w, h) = (24u32, 6u32);
        let mut px = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                px[i] = rgb[0];
                px[i + 1] = rgb[1];
                px[i + 2] = rgb[2];
                px[i + 3] = if y == 0 || y == h - 1 { 90 } else { 220 };
            }
        }
        px
    };
    let states = [
        ("normal", [95u8, 95, 105]),
        ("intermediate", [170, 170, 150]),
        ("intermediateactive", [235, 215, 150]),
    ];
    for prefix in ["Character", "CharacterPlanned", "CharacterAscendancy"] {
        for (state, rgb) in states {
            for idx in 0..=9u32 {
                let name = format!("{prefix}_orbit_{state}{idx}.png");
                let png = data_miner::png::encode_rgba(24, 6, &strip(rgb));
                std::fs::write(dir.join(&name), png)
                    .map_err(|e| format!("writing {name}: {e}"))?;
            }
        }
    }
    println!("fixture sprites → viewer/assets/sprites/ (all procedural, zero game content)");

    // Render the committed toy tree, then remind about the bundles.
    render(ctx, &[
        "--tree-dir".to_string(),
        "data/fixture/tree".to_string(),
        "--title".to_string(),
        "poe-buildwright fixture tree".to_string(),
    ])?;
    println!("\nFixture viewer ready:");
    println!("  ./bw js       # build the JS bundles (once per TS edit)");
    println!("  ./bw serve    # http://127.0.0.1:8000/planner.html");
    Ok(())
}

pub fn js(ctx: &Ctx, args: &[String]) -> Result<(), String> {
    let mut argv = vec!["scripts/build_js.sh".to_string()];
    if has_flag(args, "--watch") {
        argv.push("--watch".into());
    }
    sh(ctx, "build JS bundles", "bash", &argv)
}

/// The type-check entry points esbuild bundles (planner + 5 wizard
/// pages). Deno reads deno.json (strict) from the repo root.
const TS_ENTRIES: &[&str] = &[
    "crates/tree_render/assets/planner/_main.ts",
    "viewer/assets/wizard_chrome.ts",
    "viewer/assets/share_codec.ts",
    "viewer/assets/index_page.ts",
    "viewer/assets/share_page.ts",
    // Cloudflare Pages Functions — the agent surface. Checked with the
    // same strictness; _lib.ts is pulled in transitively.
    "viewer/functions/agent/validate.ts",
    "viewer/functions/agent/build.ts",
    "viewer/functions/live/[token].ts",
];

/// Prefer the pinned deno that tools/setup.sh installs; fall back to
/// a system deno for anyone who already has one on PATH.
fn deno_program(ctx: &Ctx) -> String {
    let pinned = ctx.root.join("tools/bin/deno");
    if pinned.is_file() {
        pinned.to_string_lossy().into_owned()
    } else {
        "deno".to_string()
    }
}

pub fn typecheck(ctx: &Ctx, _args: &[String]) -> Result<(), String> {
    // `deno check` embeds the real TS compiler — full strict checking,
    // no node, no package manager. deno.json holds the strict config.
    let program = deno_program(ctx);
    let mut argv = vec!["check".to_string()];
    argv.extend(TS_ENTRIES.iter().map(|s| s.to_string()));
    sh(ctx, "typecheck (deno, strict)", &program, &argv)
}

pub fn test_js(ctx: &Ctx, _args: &[String]) -> Result<(), String> {
    // `deno test` discovers *_test.ts next to the modules they test,
    // typechecks them strictly, and runs them — no node, no test
    // framework dependency. Pure-logic modules only (schema walker,
    // sprite tiering); anything needing DOM/WebGL stays out.
    let program = deno_program(ctx);
    let argv = vec![
        "test".to_string(),
        "crates/tree_render/assets/planner/".to_string(),
        "viewer/assets/".to_string(),
    ];
    sh(ctx, "test-js (deno)", &program, &argv)
}

// ---------------------------------------------------------------------
// orchestrated: run & ship
// ---------------------------------------------------------------------

pub fn serve(ctx: &Ctx, args: &[String]) -> Result<(), String> {
    let (program, mut argv) = sibling_or_cargo("serve", "serve");
    if !args.iter().any(|a| a == "--dir") {
        argv.push("--dir".into());
        argv.push("viewer".into());
    }
    argv.extend(args.iter().cloned());
    sh(ctx, "serve viewer/", &program, &argv)
}

pub fn deploy(ctx: &Ctx, _args: &[String]) -> Result<(), String> {
    sh(
        ctx,
        "deploy to Cloudflare Pages",
        "bash",
        &["scripts/deploy.sh".into()],
    )
}

// ---------------------------------------------------------------------
// pipelines
// ---------------------------------------------------------------------

pub fn update_native(ctx: &Ctx, args: &[String]) -> Result<(), String> {
    let style = ctx.style;
    ui::note(style, "SCENARIO 2 — first-party mine from the GGG CDN");
    patch(ctx, &[])?;

    // Mine the raw GGG tables to data/parsed/<patch>_native/, then hash
    // them on the same manifest path as everything else.
    ui::step_banner(style, "mine tables");
    mine(ctx, args)?;

    let base_patch = resolve_patch(ctx, args)?;
    let native = format!("{base_patch}_native");
    let man_args = ["--patch".to_string(), native.clone()];

    // Shape the raw tables into the site's schemas. Each shaper fetches
    // what it needs and writes under data/parsed/<patch>_native/; a
    // failure warns (that dataset is skipped) rather than aborting the
    // whole import. `tree` runs the masteries derivation after, since it
    // consumes the tree/edges.tsv we just wrote.
    ui::step_banner(style, "shape datasets");
    let shape_args = |dataset: &str| -> Vec<String> {
        vec![
            dataset.to_string(),
            "--patch".to_string(),
            base_patch.clone(),
        ]
    };
    for dataset in [
        "bases",
        "grants",
        "jewels",
        "mods",
        "gems",
        "active_skills",
        "support_skills",
        "skill_levels",
        "soul_cores",
        "gem_quality",
        "unique_art",
        "tree",
    ] {
        if let Err(e) = shape(ctx, &shape_args(dataset)) {
            ui::warn(style, &format!("shape {dataset}: {e} — skipped"));
        }
    }
    // Mastery lighting derives from the tree we just shaped.
    ui::step_banner(style, "mastery mapping");
    if let Err(e) = masteries(ctx, &man_args) {
        ui::warn(style, &format!("masteries: {e} — skipped"));
    }
    // Node icons: decode DDS → PNG + sprites.tsv (needs the shaped tree).
    ui::step_banner(style, "sprites");
    if let Err(e) = sprites(ctx, &man_args) {
        ui::warn(style, &format!("sprites: {e} — skipped"));
    }
    // Uniques: the one PoB-pinned dataset, resolved against the mods.tsv we
    // just shaped. Best-effort by design — if PoB is absent or lags GGG,
    // this warns and the first-party datasets above still stand + hash.
    ui::step_banner(style, "uniques (pob-pinned)");
    if let Err(e) = uniques(ctx, &man_args) {
        ui::warn(style, &format!("uniques: {e} — skipped (native data intact)"));
    }

    // Wizard skill/item catalogues — first-party JSON joined from the
    // shaped gem/skill/unique TSVs (into viewer/assets/). Best-effort:
    // a failure here doesn't invalidate the mined + hashed datasets.
    ui::step_banner(style, "skill stats (per-level numbers)");
    if let Err(e) = skill_stats(ctx, &man_args) {
        ui::warn(style, &format!("skill-stats: {e} — skipped"));
    }
    ui::step_banner(style, "wizard catalogues");
    if let Err(e) = catalogues(ctx, &man_args) {
        ui::warn(style, &format!("catalogues: {e} — skipped"));
    }

    ui::step_banner(style, "manifest");
    manifest(ctx, &man_args)?;

    ui::ok(
        style,
        &format!("first-party datasets built + hashed → data/parsed/{native}/"),
    );
    ui::note(
        style,
        "next: verify + flip CURRENT. Uniques are resolved first-party from \
         PoB's pinned mod-id list (its commit is recorded in \
         items/uniques.pob.json); everything else is 100% GGG.",
    );
    Ok(())
}

// ---------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------

pub fn doctor(ctx: &Ctx, _args: &[String]) -> Result<(), String> {
    let s = ctx.style;
    println!("{}", s.heading("buildwright doctor"));

    let probe_line = |label: &str, ok: bool, hint: &str| {
        let mark = if ok { s.green("✓") } else { s.red("✗") };
        let tail = if ok || hint.is_empty() {
            String::new()
        } else {
            format!("  {}", s.dim(hint))
        };
        println!("  {mark} {label}{tail}");
        ok
    };

    println!("\n{}", s.bold("toolchain"));
    probe_line(
        "curl",
        ui::probe("curl", &["--version"]),
        "needed for CDN downloads",
    );
    probe_line(
        "python3",
        ui::probe("python3", &["--version"]),
        "extraction pipeline",
    );
    let lua = ui::probe("lua", &["-v"]) || ui::probe("lua5.4", &["-v"]);
    probe_line("lua", lua, "skill/item extractors (lua or lua5.4)");
    probe_line(
        "unzstd",
        ui::probe("unzstd", &["--version"]),
        "sprite atlas decompression",
    );
    probe_line(
        "magick",
        ui::probe("magick", &["--version"]),
        "sprite/icon conversion (ImageMagick)",
    );
    println!("\n{}", s.bold("frontend build (node-free)"));
    let esbuild = ctx.root.join("tools/bin/esbuild").is_file();
    probe_line(
        "esbuild (bundler)",
        esbuild,
        "native Go binary — run tools/setup.sh",
    );
    probe_line(
        "deno (typecheck)",
        ctx.root.join("tools/bin/deno").is_file() || ui::probe("deno", &["--version"]),
        "native tsc, no node — run tools/setup.sh",
    );

    println!("\n{}", s.bold("first-party mining"));
    match fetch::patch_info() {
        Ok(i) => {
            probe_line(&format!("GGG CDN reachable (live {})", i.version), true, "");
        }
        Err(_) => {
            probe_line("GGG CDN reachable", false, "patch server handshake failed");
        }
    }
    let cache = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
        .unwrap_or_else(|| PathBuf::from(".cache"))
        .join("poe-buildwright/cdn");
    probe_line(
        &format!("cdn cache dir ({})", cache.display()),
        cache.is_dir(),
        "created on first fetch",
    );

    println!("\n{}", s.bold("deploy"));
    let envf = ctx.root.join(".cloudflare.env");
    probe_line(
        ".cloudflare.env present",
        envf.is_file(),
        "cp .cloudflare.env.example .cloudflare.env",
    );
    // node survives ONLY here (wrangler); slated for removal once the CF
    // Pages upload is reimplemented natively (docs/ops-cli-plan.md).
    probe_line(
        "node (wrangler only)",
        ui::probe("node", &["--version"]),
        "last node dep — for wrangler deploy",
    );

    Ok(())
}

pub fn help_cmd(ctx: &Ctx, args: &[String]) -> Result<(), String> {
    match args.first() {
        Some(name) => match crate::help::lookup(name) {
            Some(cmd) => crate::help::print_command_help(ctx.style, cmd),
            None => return Err(format!("unknown command: {name}")),
        },
        None => crate::help::print_menu(ctx.style),
    }
    Ok(())
}

// ---------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------

/// Naive `"key":"value"` string extractor — enough for the status
/// display without pulling in a JSON dependency.
fn json_str(haystack: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let i = haystack.find(&needle)? + needle.len();
    let rest = &haystack[i..];
    let colon = rest.find(':')?;
    let after = rest[colon + 1..].trim_start();
    let after = after.strip_prefix('"')?;
    let end = after.find('"')?;
    Some(after[..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Locks the mastery invariant against a fourth perimeter regression:
    /// a mastery lights ONLY from the non-mastery nodes GGG connects to it
    /// (edges), never from a node that merely shares its position-group.
    #[test]
    fn no_perimeter_lighting() {
        // M(1) is edge-connected to notable N(2). Small S(3) shares NO
        // edge with M — under the old heuristic it would still light M as
        // a group peer. M2(4) is edge-connected to M — masteries must not
        // trigger each other.
        let kind: BTreeMap<String, String> = [
            ("1", "mastery"),
            ("2", "notable"),
            ("3", "small"),
            ("4", "mastery"),
        ]
        .iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect();
        let mut adj: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        let mut link = |a: &str, b: &str| {
            adj.entry(a.to_string()).or_default().insert(b.to_string());
            adj.entry(b.to_string()).or_default().insert(a.to_string());
        };
        link("1", "2"); // M ↔ N — the one real GGG connection
        link("1", "4"); // M ↔ M2 — mastery-to-mastery, must be ignored
        // S(3) is deliberately NOT connected to M.

        let (links, orphans) = derive_mastery_links(&kind, &adj);

        // M(1) lights from N(2) only.
        assert_eq!(links, vec![("2".to_string(), "1".to_string())]);
        // The group-peer small must never be a trigger.
        assert!(
            !links.iter().any(|(t, _)| t == "3"),
            "perimeter regression: an unconnected node lit a mastery"
        );
        // A mastery must never light another mastery.
        assert!(!links.iter().any(|(t, _)| t == "4"));
        // M2(4) has no non-mastery connection → orphan.
        assert_eq!(orphans, 1);
    }
}

// ---------------------------------------------------------------------
// poe1-tree: ingest GGG's OFFICIAL PoE1 passive-tree JSON into the
// same tree TSV shape the PoE2 pipeline produces, so tree_render and
// the whole downstream (planner, agent emitters) work unchanged.
//
// Source of truth: the `var passiveSkillTreeData = {...}` embed on
// https://www.pathofexile.com/passive-skill-tree — GGG has published
// it per league for a decade; it is the official first-party export
// (nodes, groups, orbits, edges, stat text, sprite atlases). Re-run
// on every league to refresh. Atlases arrive as JPG/WEBP/PNG; the
// non-PNG ones are normalized with the system `sips` tool (macOS —
// same shell-out philosophy as curl; Linux users convert manually).
// ---------------------------------------------------------------------
/// Pull `--<name> <value>` (or `--<name>=<value>`) out of an arg list.
fn arg_value(args: &[String], name: &str) -> Option<String> {
    let eq = format!("{name}=");
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == name {
            return it.next().cloned();
        }
        if let Some(v) = a.strip_prefix(&eq) {
            return Some(v.to_string());
        }
    }
    None
}

pub fn poe1_tree(ctx: &Ctx, args: &[String]) -> Result<(), String> {
    let label = arg_value(args, "--label").unwrap_or_else(|| "current".into());
    let out_dir = ctx.root.join(format!("data/parsed/poe1_{label}"));
    let tree_dir = out_dir.join("tree");
    std::fs::create_dir_all(&tree_dir).map_err(|e| e.to_string())?;

    // 1. Obtain the JSON: --json <file> or fetch the live page.
    let raw = if let Some(p) = arg_value(args, "--json") {
        std::fs::read_to_string(&p).map_err(|e| format!("read {p}: {e}"))?
    } else {
        let page_path = out_dir.join("page.html");
        let status = std::process::Command::new("curl")
            .args(["-fsSL", "--retry", "3", "-A",
                   "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "-o"])
            .arg(&page_path)
            .arg("https://www.pathofexile.com/passive-skill-tree")
            .status()
            .map_err(|e| format!("running curl: {e}"))?;
        if !status.success() {
            return Err("fetching the passive-skill-tree page failed".into());
        }
        let html = std::fs::read_to_string(&page_path).map_err(|e| e.to_string())?;
        let marker = "var passiveSkillTreeData = ";
        let start = html
            .find(marker)
            .ok_or("page has no passiveSkillTreeData embed")?
            + marker.len();
        // Brace-match to the end of the object (string-aware).
        let bytes = &html.as_bytes()[start..];
        let (mut depth, mut i, mut in_str, mut esc) = (0i32, 0usize, false, false);
        let end = loop {
            let b = *bytes.get(i).ok_or("unterminated tree JSON embed")?;
            if in_str {
                if esc {
                    esc = false;
                } else if b == b'\\' {
                    esc = true;
                } else if b == b'"' {
                    in_str = false;
                }
            } else {
                match b {
                    b'"' => in_str = true,
                    b'{' => depth += 1,
                    b'}' => {
                        depth -= 1;
                        if depth == 0 {
                            break i + 1;
                        }
                    }
                    _ => {}
                }
            }
            i += 1;
        };
        let json_text = html[start..start + end].to_string();
        std::fs::write(out_dir.join("tree.json"), &json_text).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&page_path);
        json_text
    };
    let tree = json::parse(&raw).map_err(|e| format!("tree JSON: {e}"))?;

    let f = |v: Option<&json::Value>| v.and_then(json::Value::as_f64).unwrap_or(0.0);
    let s = |v: Option<&json::Value>| v.and_then(json::Value::as_str).unwrap_or("").to_string();
    let flag = |n: &json::Value, k: &str| n.get(k).and_then(json::Value::as_bool).unwrap_or(false);

    // 2. Geometry constants.
    let consts = tree.get("constants").ok_or("no constants")?;
    let radii: Vec<f64> = consts
        .get("orbitRadii")
        .and_then(json::Value::as_array)
        .ok_or("no orbitRadii")?
        .iter()
        .filter_map(json::Value::as_f64)
        .collect();
    let per_orbit: Vec<f64> = consts
        .get("skillsPerOrbit")
        .and_then(json::Value::as_array)
        .ok_or("no skillsPerOrbit")?
        .iter()
        .filter_map(json::Value::as_f64)
        .collect();
    let groups = tree.get("groups").and_then(json::Value::as_object).ok_or("no groups")?;
    let classes = tree.get("classes").and_then(json::Value::as_array).ok_or("no classes")?;
    let class_names: Vec<String> = classes.iter().map(|c| s(c.get("name"))).collect();

    // 3. Nodes → nodes.tsv (same 17 columns the PoE2 shaper emits).
    let nodes_obj = tree.get("nodes").and_then(json::Value::as_object).ok_or("no nodes")?;
    let mut nodes_out = String::from(
        "id\tx\ty\tkind\tklass\tascendancy\tname\tstats\tgroup\torbit\torbit_index\ticon\tnode_overlay\tactive_effect\tnode_options\tconnection_art\tunlock_constraint\n",
    );
    let mut edges: std::collections::BTreeSet<(u64, u64)> = std::collections::BTreeSet::new();
    let mut n_nodes = 0usize;
    for (nid, n) in nodes_obj.iter() {
        let Ok(id) = nid.parse::<u64>() else { continue };
        let Some(gid) = n.get("group").and_then(json::Value::as_i64) else { continue };
        let g = groups.get(&gid.to_string());
        let (gx, gy) = (f(g.and_then(|g| g.get("x"))), f(g.and_then(|g| g.get("y"))));
        let orbit = n.get("orbit").and_then(json::Value::as_i64).unwrap_or(0) as usize;
        let oidx = n.get("orbitIndex").and_then(json::Value::as_i64).unwrap_or(0) as f64;
        let r = radii.get(orbit).copied().unwrap_or(0.0);
        let slots = per_orbit.get(orbit).copied().unwrap_or(1.0).max(1.0);
        let angle = std::f64::consts::TAU * oidx / slots;
        let (x, y) = (gx + r * angle.sin(), gy - r * angle.cos());

        let asc = s(n.get("ascendancyName"));
        let node_is_asc = !asc.is_empty();
        let kind = if n.get("classStartIndex").is_some() {
            "class_start"
        } else if flag(n, "isAscendancyStart") {
            "asc_start"
        } else if flag(n, "isKeystone") {
            "keystone"
        } else if flag(n, "isMastery") {
            "mastery"
        } else if flag(n, "isJewelSocket") {
            "jewel"
        } else if flag(n, "isNotable") {
            if asc.is_empty() { "notable" } else { "asc_notable" }
        } else if asc.is_empty() {
            "small"
        } else {
            "asc_small"
        };
        let klass = n
            .get("classStartIndex")
            .and_then(json::Value::as_i64)
            .and_then(|i| class_names.get(i as usize).cloned())
            .unwrap_or_default();
        let stats: Vec<String> = n
            .get("stats")
            .and_then(json::Value::as_array)
            .map(|a| a.iter().filter_map(json::Value::as_str).map(|t| t.replace('\n', "; ")).collect())
            .unwrap_or_default();
        let row = [
            id.to_string(),
            format!("{x:.2}"),
            format!("{y:.2}"),
            kind.to_string(),
            klass,
            asc,
            s(n.get("name")),
            stats.join("; "),
            gid.to_string(),
            orbit.to_string(),
            (oidx as i64).to_string(),
            s(n.get("icon")),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
        ];
        nodes_out.push_str(&row.join("\t"));
        nodes_out.push('\n');
        n_nodes += 1;
        for e in n.get("out").and_then(json::Value::as_array).unwrap_or(&[]) {
            if let Some(b) = e.as_str().and_then(|v| v.parse::<u64>().ok()) {
                // Ascendancy↔main crossing edges are mechanics, not
                // visuals (Scion's Ascendant path nodes, asc starts →
                // Scion) — no PoE1 tool draws them, and rendered
                // literally they streak across the whole tree.
                let other_asc = nodes_obj
                    .get(&b.to_string())
                    .map(|m| s(m.get("ascendancyName")))
                    .unwrap_or_default();
                if node_is_asc == other_asc.is_empty() {
                    continue;
                }
                edges.insert((id.min(b), id.max(b)));
            }
        }
    }
    std::fs::write(tree_dir.join("nodes.tsv"), &nodes_out).map_err(|e| e.to_string())?;

    // 4. edges.tsv (a, b, conn_orbit 0 — arcs derive from shared
    //    group/orbit downstream, same as PoE2).
    let mut edges_out = String::from("a\tb\tconn_orbit\n");
    for (a, b) in &edges {
        edges_out.push_str(&format!("{a}\t{b}\t0\n"));
    }
    std::fs::write(tree_dir.join("edges.tsv"), &edges_out).map_err(|e| e.to_string())?;

    // 5. meta.tsv: bounds, orbit geometry, groups, classes + asc map.
    let mut meta = String::new();
    for k in ["min_x", "max_x", "min_y", "max_y"] {
        meta.push_str(&format!("{k}\t{}\n", f(tree.get(k))));
    }
    let join_f = |v: &[f64]| v.iter().map(|x| format!("{x}")).collect::<Vec<_>>().join("|");
    meta.push_str(&format!("orbit_radii\t{}\n", join_f(&radii)));
    meta.push_str(&format!("skills_per_orbit\t{}\n", join_f(&per_orbit)));
    for (gid, g) in groups.iter() {
        meta.push_str(&format!("group\t{gid}\t{}\t{}\n", f(g.get("x")), f(g.get("y"))));
    }
    for c in classes {
        let name = s(c.get("name"));
        let ascs: Vec<String> = c
            .get("ascendancies")
            .and_then(json::Value::as_array)
            .map(|a| a.iter().map(|x| s(x.get("name"))).collect())
            .unwrap_or_default();
        meta.push_str(&format!("class\t{name}\t{}\n", ascs.join("|")));
        for a in c.get("ascendancies").and_then(json::Value::as_array).unwrap_or(&[]) {
            meta.push_str(&format!(
                "asc_internal\t{}\t{}\t{name}\n",
                s(a.get("name")),
                s(a.get("id")),
            ));
        }
    }

    // Portrait rows drive the renderer's asc_panels — without them the
    // ascendancy subtrees never draw (they're excluded from the main
    // pass). One row per class-pickable ascendancy: panel origin = the
    // asc-start node's GROUP center (GGG lays each subtree out around
    // it, and centers the Classes<Name> backdrop art there too); w/h =
    // the backdrop's sheet dims, which the emitter doubles to full
    // resolution exactly like PoB's DrawAsset.
    let asc_sheet = tree
        .get("sprites")
        .and_then(|v| v.get("ascendancy"))
        .and_then(json::Value::as_object)
        .and_then(|levels| {
            levels
                .keys()
                .max_by(|a, b| {
                    a.parse::<f64>().unwrap_or(0.0).total_cmp(&b.parse::<f64>().unwrap_or(0.0))
                })
                .and_then(|z| levels.get(z))
        })
        .and_then(|z| z.get("coords"))
        .and_then(json::Value::as_object);
    let mut asc_start_group: std::collections::BTreeMap<String, String> =
        std::collections::BTreeMap::new();
    for n in nodes_obj.values() {
        if flag(n, "isAscendancyStart")
            && let Some(g) = n.get("group").and_then(json::Value::as_i64)
        {
            asc_start_group.insert(s(n.get("ascendancyName")), g.to_string());
        }
    }
    for c in classes {
        for a in c.get("ascendancies").and_then(json::Value::as_array).unwrap_or(&[]) {
            let aname = s(a.get("name"));
            let mut image = format!("Classes{aname}");
            let (Some(gid), Some(coords)) = (asc_start_group.get(&aname), asc_sheet) else {
                ui::warn(ctx.style, &format!("no panel data for ascendancy {aname}"));
                continue;
            };
            // GGG kept the old art key when 3.24 renamed Raider→Warden.
            if !coords.contains_key(&image) && aname == "Warden" {
                image = "ClassesRaider".into();
            }
            let (Some(g), Some(art)) = (groups.get(gid), coords.get(&image)) else {
                ui::warn(ctx.style, &format!("no group/art for ascendancy {aname}"));
                continue;
            };
            meta.push_str(&format!(
                "portrait\tasc\t{aname}\t{image}\t{}\t{}\t{}\t{}\n",
                f(g.get("x")),
                f(g.get("y")),
                f(art.get("w")),
                f(art.get("h")),
            ));
        }
    }
    std::fs::write(tree_dir.join("meta.tsv"), &meta).map_err(|e| e.to_string())?;

    // Provenance marker consumed by `manifest` — same contract as the
    // PoE2 patch dirs, so poe1_<label> gets the identical hash story.
    let source_marker = format!("pathofexile.com/passive-skill-tree ({label})\n");
    std::fs::write(
        tree_dir.parent().unwrap_or(&tree_dir).join(".source"),
        source_marker,
    )
    .map_err(|e| e.to_string())?;

    ui::ok(
        ctx.style,
        &format!(
            "poe1 tree ({label}): {n_nodes} nodes, {} edges, {} classes → {}",
            edges.len(),
            class_names.len(),
            tree_dir.strip_prefix(&ctx.root).unwrap_or(&tree_dir).display(),
        ),
    );
    ui::note(ctx.style, "next: buildwright poe1-sprites (atlas download + slice)");
    Ok(())
}

/// poe1-sprites: download the official sprite atlases referenced by
/// the ingested tree JSON, normalize JPG/WEBP → PNG with the system
/// `sips` tool, slice every icon/frame out with our PNG codec, and
/// write tree/sprites.tsv. Sprite files are prefixed `poe1_` so the
/// shared /assets/sprites/ dir can host both games without collisions.
pub fn poe1_sprites(ctx: &Ctx, args: &[String]) -> Result<(), String> {
    let label = arg_value(args, "--label").unwrap_or_else(|| "current".into());
    let out_dir = ctx.root.join(format!("data/parsed/poe1_{label}"));
    let raw = std::fs::read_to_string(out_dir.join("tree.json"))
        .map_err(|e| format!("tree.json (run poe1-tree first): {e}"))?;
    let tree = json::parse(&raw).map_err(|e| e.to_string())?;
    let sprites = tree.get("sprites").and_then(json::Value::as_object).ok_or("no sprites")?;
    let assets = ctx.root.join("viewer/assets/sprites");
    std::fs::create_dir_all(&assets).map_err(|e| e.to_string())?;
    let cache = cache_root().join("poe1_atlases");
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;

    // The sheets the renderer needs for the base tree. The ascendancy
    // sheet (webp) carries the Classes<Name> panel backdrops referenced
    // by portrait rows; league-bloodline sheets come later.
    const SHEETS: &[&str] = &[
        "normalActive", "notableActive", "keystoneActive", "mastery",
        "masteryConnected", "masteryInactive", "frame", "jewel", "line",
        "groupBackground", "ascendancy", "startNode",
    ];
    let sanitize = |n: &str| -> String {
        n.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect()
    };
    // Download + normalize each unique atlas once, decode once.
    // (width, height, rgba)
    let mut atlases: std::collections::BTreeMap<String, (u32, u32, Vec<u8>)> =
        std::collections::BTreeMap::new();
    let mut out = String::from("sprite_name\tpng\twidth\theight\n");
    let mut count = 0usize;
    for sheet in SHEETS {
        let Some(levels) = sprites.get(*sheet).and_then(json::Value::as_object) else {
            ui::warn(ctx.style, &format!("sprite sheet {sheet} missing — skipped"));
            continue;
        };
        // Highest zoom level = sharpest atlas.
        let Some(zkey) = levels.keys().max_by(|a, b| {
            a.parse::<f64>().unwrap_or(0.0).total_cmp(&b.parse::<f64>().unwrap_or(0.0))
        }) else { continue };
        let z = levels.get(zkey).unwrap_or(&json::Value::Null);
        let url = z.get("filename").and_then(json::Value::as_str).unwrap_or("");
        if url.is_empty() {
            continue;
        }
        let fname = url.split('/').next_back().unwrap_or("atlas").split('?').next().unwrap_or("atlas").to_string();
        if !atlases.contains_key(&fname) {
            let local = cache.join(&fname);
            if !local.exists() {
                let st = std::process::Command::new("curl")
                    .args(["-fsSL", "--retry", "3", "-o"])
                    .arg(&local)
                    .arg(url)
                    .status()
                    .map_err(|e| format!("curl: {e}"))?;
                if !st.success() {
                    return Err(format!("download failed: {url}"));
                }
            }
            // Normalize to PNG when needed (JPG/WEBP atlases).
            let png_path = if fname.ends_with(".png") {
                local.clone()
            } else {
                let p = cache.join(format!("{fname}.png"));
                if !p.exists() {
                    let st = std::process::Command::new("sips")
                        .args(["-s", "format", "png"])
                        .arg(&local)
                        .arg("--out")
                        .arg(&p)
                        .output()
                        .map_err(|e| format!("sips: {e}"))?;
                    if !st.status.success() {
                        return Err(format!(
                            "sips could not convert {fname} (non-macOS? convert to PNG manually into {})",
                            cache.display(),
                        ));
                    }
                }
                p
            };
            let bytes = std::fs::read(&png_path).map_err(|e| e.to_string())?;
            let img = data_miner::png::decode_rgba(&bytes).map_err(|e| format!("{fname}: {e}"))?;
            atlases.insert(fname.clone(), img);
        }
        let (aw, ah, apx) = atlases.get(&fname).cloned().ok_or("atlas missing")?;
        let (aw, ah) = (aw as usize, ah as usize);
        let Some(coords) = z.get("coords").and_then(json::Value::as_object) else { continue };
        for (key, c) in coords.iter() {
            let (x, y, w, h) = (
                c.get("x").and_then(json::Value::as_i64).unwrap_or(0) as usize,
                c.get("y").and_then(json::Value::as_i64).unwrap_or(0) as usize,
                c.get("w").and_then(json::Value::as_i64).unwrap_or(0) as usize,
                c.get("h").and_then(json::Value::as_i64).unwrap_or(0) as usize,
            );
            if w == 0 || h == 0 || x + w > aw || y + h > ah {
                continue;
            }
            let file = format!("poe1_{}.png", sanitize(key));
            let dest = assets.join(&file);
            if !dest.exists() {
                let mut px = Vec::with_capacity(w * h * 4);
                for row in 0..h {
                    let off = ((y + row) * aw + x) * 4;
                    px.extend_from_slice(&apx[off..off + w * 4]);
                }
                let png = data_miner::png::encode_rgba(w as u32, h as u32, &px);
                std::fs::write(&dest, &png).map_err(|e| format!("write {file}: {e}"))?;
            }
            out.push_str(&format!("{key}\t{file}\t{w}\t{h}\n"));
            count += 1;
        }
    }
    std::fs::write(out_dir.join("tree/sprites.tsv"), &out).map_err(|e| e.to_string())?;
    ui::ok(ctx.style, &format!("poe1 sprites: {count} sliced → viewer/assets/sprites (poe1_*)"));
    Ok(())
}
