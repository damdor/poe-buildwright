//! `cargo run --release -p data_miner --bin mine -- --install <path> --patch <id> --out <dir>`
//!
//! Skeleton only. The actual mining logic lives in `lib.rs` and gets
//! filled out on the Bazzite dev machine (we need a real PoE2 install
//! to develop against). Until that lands, running this binary prints
//! the planned CLI surface so callers don't get a confusing panic.

fn main() {
    eprintln!("data_miner: not yet implemented on this host.");
    eprintln!();
    eprintln!("This binary is the first-party native miner stub. The actual");
    eprintln!("extraction code is in development on the dev box where PoE2 is");
    eprintln!("installed (Bazzite). Design + scope: docs/native-data-miner.md");
    eprintln!();
    eprintln!("Planned CLI (locked here so call sites can be written):");
    eprintln!("  --install <PATH>   PoE2 install dir containing Content.ggpk");
    eprintln!("                     and Bundles2/");
    eprintln!("  --patch <ID>       Patch label, e.g. '0_5'. Becomes the");
    eprintln!("                     output subdir under data/parsed/");
    eprintln!("  --out <PATH>       Output root (default: data/parsed/<patch>)");
    eprintln!("  --skip-art         Tree/skills/items only; skip DDS → PNG");
    eprintln!("  --skip-bundles     Read only files inline in Content.ggpk");
    eprintln!("                     (faster smoke test; misses most data)");
    std::process::exit(2);
}
