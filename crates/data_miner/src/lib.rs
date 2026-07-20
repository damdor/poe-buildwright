//! First-party PoE2 data miner. Reads `Bundles2/` from a local PoE2
//! install and writes the same TSV/JSON shape under
//! `data/parsed/<patch>/` that the rest of the pipeline consumes.
//!
//! Design + table inventory + extraction strategy:
//! see `docs/native-data-miner.md` at the repo root.
//!
//! Status:
//! * `bundle` — header parsing works on all 60,051 bundles in the
//!   0.5 install (zero errors).
//! * `oodle` — decompression via RAD/Epic's official decoder,
//!   dlopen'd at mine time (`crates/oodle_official`); covers all four
//!   compressor families. A pure-Rust port is in flight behind the
//!   `oodle-port` feature (see `docs/native-data-miner.md`).
//! * `bundle_decode` — block-level orchestration on top of the above.

pub mod arc;
pub mod bundle;
pub mod bundle_decode;
pub mod csd;
pub mod dat;
pub mod dat_schema;
pub mod dds;
pub mod fetch;
pub mod index;
pub mod mine;
pub mod oodle;
pub mod png;
pub mod psg;
pub mod shape;
pub mod tree_json;
pub mod tree_tsv;
pub mod uniques;
