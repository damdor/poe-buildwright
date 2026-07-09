//! CDN-based access to PoE2 game data — no local install needed.
//!
//! Usage:
//!   cargo run --release -p data_miner --bin cdn -- info
//!   cargo run --release -p data_miner --bin cdn -- index
//!   cargo run --release -p data_miner --bin cdn -- get <virtual-path> [out_file]
//!
//! `info`  — patch server handshake; print version + CDN base URL.
//! `index` — fetch + decompress + parse `Bundles2/_.index.bin`;
//!           print stats and a path sample. First run downloads
//!           ~109 MiB into the version-keyed cache.
//! `get`   — resolve a virtual path (e.g. `Data/PassiveSkills.datc64`)
//!           via the index, fetch only its owning bundle, and write
//!           the file's bytes out.

use std::process::ExitCode;

use data_miner::bundle_decode;
use data_miner::fetch::CdnClient;
use data_miner::index::Index;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let cmd = args.next().unwrap_or_default();
    let result = match cmd.as_str() {
        "info" => info(),
        "index" => index_stats(),
        "get" => {
            let Some(path) = args.next() else {
                eprintln!("usage: cdn get <virtual-path> [out_file]");
                return ExitCode::from(2);
            };
            get(&path, args.next())
        }
        "find" => {
            let Some(needle) = args.next() else {
                eprintln!("usage: cdn find <substring>");
                return ExitCode::from(2);
            };
            find(&needle)
        }
        _ => {
            eprintln!("usage: cdn <info|index|get|find>");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::from(1)
        }
    }
}

type AnyError = Box<dyn std::error::Error>;

fn info() -> Result<(), AnyError> {
    let info = data_miner::fetch::patch_info()?;
    println!("patch version : {}", info.version);
    println!("cdn base url  : {}", info.cdn_base);
    Ok(())
}

fn load_index(client: &CdnClient) -> Result<Index, AnyError> {
    let local = client.fetch("Bundles2/_.index.bin")?;
    eprintln!("index bundle  : {}", local.display());
    let payload = bundle_decode::decompress_full(&local)?;
    eprintln!("decompressed  : {} bytes", payload.len());
    Ok(Index::parse(&payload)?)
}

fn index_stats() -> Result<(), AnyError> {
    let client = CdnClient::connect()?;
    eprintln!("patch version : {}", client.info.version);
    let index = load_index(&client)?;

    println!("bundles       : {}", index.bundles.len());
    println!("files         : {}", index.files.len());
    println!("directories   : {}", index.path_reps.len());
    println!("path hash     : {:?}", index.hash);

    let resolved = index.resolve_paths()?;
    println!(
        "paths resolved: {} / {} file records",
        resolved.len(),
        index.files.len(),
    );
    println!("sample paths  :");
    for (path, _) in resolved.iter().take(5) {
        println!("  {path}");
    }
    // Coverage sanity: mining is only viable if essentially every
    // file record got a reconstructed path.
    if resolved.len() < index.files.len() {
        eprintln!(
            "WARNING: {} file records have no resolved path",
            index.files.len() - resolved.len(),
        );
    }
    Ok(())
}

/// Case-insensitive substring search over every resolved path.
fn find(needle: &str) -> Result<(), AnyError> {
    let client = CdnClient::connect()?;
    let index = load_index(&client)?;
    let needle = needle.to_ascii_lowercase();
    let mut hits = 0usize;
    for (path, file_idx) in index.resolve_paths()? {
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

fn get(virtual_path: &str, out: Option<String>) -> Result<(), AnyError> {
    let client = CdnClient::connect()?;
    let index = load_index(&client)?;
    let Some(rec) = index.lookup(virtual_path) else {
        return Err(format!("no such file in index: {virtual_path}").into());
    };
    let bundle_name = &index.bundles[rec.bundle_index as usize].name;
    eprintln!(
        "found in bundle {bundle_name} @ {} ({} bytes)",
        rec.offset, rec.size,
    );
    let local = client.fetch(&format!("Bundles2/{bundle_name}.bundle.bin"))?;
    let payload = bundle_decode::decompress_full(&local)?;
    let start = rec.offset as usize;
    let end = start + rec.size as usize;
    let bytes = payload
        .get(start..end)
        .ok_or("file range exceeds decompressed bundle")?;
    match out {
        Some(path) => {
            std::fs::write(&path, bytes)?;
            eprintln!("wrote {} bytes to {path}", bytes.len());
        }
        None => {
            let head: Vec<String> = bytes.iter().take(32).map(|b| format!("{b:02x}")).collect();
            println!("{} bytes; first 32: {}", bytes.len(), head.join(" "));
        }
    }
    Ok(())
}
