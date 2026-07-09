//! Decompress a single `.bundle.bin` file and either write the result
//! to a path or print summary diagnostics. Useful for end-to-end
//! testing of new Oodle decoders against known-tiny bundles.
//!
//! Usage:
//!   cargo run --release -p data_miner --bin decode -- <bundle> [out_file]

use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

use data_miner::bundle_decode;

fn main() -> ExitCode {
    let mut args = env::args_os().skip(1);
    let Some(bundle) = args.next() else {
        eprintln!("usage: decode <bundle> [out_file]");
        return ExitCode::from(2);
    };
    let bundle = PathBuf::from(bundle);
    let out = args.next().map(PathBuf::from);

    let header = match bundle_decode::header(&bundle) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("header parse failed: {e}");
            return ExitCode::from(1);
        }
    };
    eprintln!(
        "{}: {} blocks, compressor={}, uncompressed={} bytes",
        bundle.display(),
        header.block_count,
        header.compressor.name(),
        header.uncompressed_size,
    );
    eprintln!("  block sizes (compressed): {:?}", header.block_sizes);

    match bundle_decode::decompress_full(&bundle) {
        Ok(payload) => {
            eprintln!("  -> decompressed: {} bytes", payload.len());
            // Hex-dump the first 32 bytes for sanity.
            let head: Vec<String> = payload
                .iter()
                .take(32)
                .map(|b| format!("{b:02x}"))
                .collect();
            eprintln!("  first 32 bytes : {}", head.join(" "));
            if let Some(out_path) = out
                && let Err(e) = std::fs::write(&out_path, &payload)
            {
                eprintln!("write {} failed: {e}", out_path.display());
                return ExitCode::from(1);
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("decompress failed: {e}");
            ExitCode::from(1)
        }
    }
}
