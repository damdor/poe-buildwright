//! Walk a PoE2 install's `Bundles2/` tree and print each bundle's
//! header summary. Reads zero compressed payload — purely useful as
//! a sanity-check that the install is well-formed and tells us which
//! Oodle compressors are in play.
//!
//! Usage:
//!   cargo run --release -p data_miner --bin survey -- <install_dir>
//!
//! Output (TSV to stdout) with columns:
//!   relative_path  bytes_on_disk  uncompressed  blocks  compressor

use std::env;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use data_miner::bundle;

fn main() -> ExitCode {
    let mut args = env::args_os().skip(1);
    let Some(install) = args.next() else {
        eprintln!("usage: survey <install_dir>");
        eprintln!("  install_dir contains Bundles2/");
        return ExitCode::from(2);
    };
    let install = PathBuf::from(install);
    let bundles2 = install.join("Bundles2");
    if !bundles2.is_dir() {
        eprintln!("not a directory: {}", bundles2.display());
        return ExitCode::from(2);
    }

    let mut files = Vec::new();
    if let Err(e) = collect_bundles(&bundles2, &bundles2, &mut files) {
        eprintln!("walk failed: {e}");
        return ExitCode::from(1);
    }
    files.sort();

    println!("path\tsize_on_disk\tuncompressed\tblocks\tcompressor\tgranularity");
    let mut total_on_disk: u64 = 0;
    let mut total_uncompressed: u64 = 0;
    let mut errors = 0usize;
    let mut by_compressor: std::collections::BTreeMap<&'static str, usize> =
        std::collections::BTreeMap::new();
    for path in &files {
        let on_disk = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        total_on_disk += on_disk;
        match bundle::read_header(path) {
            Ok(h) => {
                total_uncompressed += h.uncompressed_size;
                *by_compressor.entry(h.compressor.name()).or_insert(0) += 1;
                let rel = path.strip_prefix(&bundles2).unwrap_or(path);
                println!(
                    "{}\t{}\t{}\t{}\t{}\t{}",
                    rel.display(),
                    on_disk,
                    h.uncompressed_size,
                    h.block_count,
                    h.compressor.name(),
                    h.uncompressed_block_granularity,
                );
            }
            Err(e) => {
                errors += 1;
                let rel = path.strip_prefix(&bundles2).unwrap_or(path);
                eprintln!("ERR {}: {e}", rel.display());
            }
        }
    }

    eprintln!();
    eprintln!("== summary ==");
    eprintln!("  bundles seen      : {}", files.len());
    eprintln!("  errored           : {errors}");
    eprintln!("  total on-disk     : {} MiB", total_on_disk / 1024 / 1024);
    eprintln!(
        "  total uncompressed: {} MiB",
        total_uncompressed / 1024 / 1024,
    );
    eprintln!("  compressors      :");
    for (name, count) in &by_compressor {
        eprintln!("    {:>10}  {}", name, count);
    }

    if errors > 0 {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}

fn collect_bundles(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let ft = entry.file_type()?;
        if ft.is_dir() {
            collect_bundles(root, &path, out)?;
        } else if ft.is_file() && is_bundle_file(&path) {
            out.push(path);
        }
    }
    Ok(())
}

fn is_bundle_file(path: &Path) -> bool {
    if path.extension() == Some(OsStr::new("bin")) {
        let name = path.file_name().and_then(OsStr::to_str).unwrap_or("");
        // The master indices and any `*.bundle.bin` count as bundles.
        return name == "_.index.bin"
            || name == "_.index.high.bin"
            || name == "_.index.low.bin"
            || name.ends_with(".bundle.bin");
    }
    false
}
