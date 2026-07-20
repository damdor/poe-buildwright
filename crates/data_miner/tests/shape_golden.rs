//! Offline golden harness for the data.json tree shaper.
//!
//! Not a CI test (needs a real `tree.source.json` on disk) — a tool for
//! verifying that shaper refactors are behavior-preserving:
//!
//!   GOLDEN_SRC=data/parsed/<patch>_native/tree/tree.source.json \
//!   GOLDEN_OUT=/tmp/golden_pre \
//!   cargo test -p data_miner --test shape_golden -- --ignored
//!
//! Run once before the refactor and once after (different GOLDEN_OUT),
//! then `diff -r` the two directories. Runs with an empty AscArt so it
//! is fully offline; the asc-art columns therefore differ from the
//! shipped TSVs, which is fine — the comparison is pre vs post, not
//! harness vs disk.

use std::path::PathBuf;

#[test]
#[ignore = "offline golden harness — needs GOLDEN_SRC/GOLDEN_OUT env"]
fn shape_tree_json_golden() {
    let src = std::env::var("GOLDEN_SRC").expect("set GOLDEN_SRC to a tree.source.json path");
    let out = PathBuf::from(std::env::var("GOLDEN_OUT").expect("set GOLDEN_OUT to an output dir"));
    let body = std::fs::read_to_string(&src).expect("read GOLDEN_SRC");
    let data = json::parse(&body).expect("parse tree.source.json");
    let tree = data_miner::tree_json::shape_tree_json(&data, &data_miner::tree_json::AscArt::new())
        .expect("shape");
    std::fs::create_dir_all(&out).expect("mkdir GOLDEN_OUT");
    for (name, text) in [
        ("nodes.tsv", &tree.nodes),
        ("edges.tsv", &tree.edges),
        ("meta.tsv", &tree.meta),
    ] {
        std::fs::write(out.join(name), text).expect(name);
    }
}
