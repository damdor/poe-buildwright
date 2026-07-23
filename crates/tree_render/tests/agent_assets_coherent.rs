//! Ship-state coherence gate for the shared agent sidecar files.
//!
//! `viewer/assets/agent/jewels.json` has two writers — tree_render
//! (base) and scripts/gen_agent_meta.mjs (the `uniques` enrichment).
//! tree_render preserves keys it doesn't own (see
//! text::preserve_unknown_top_level), so the tracked file must always
//! carry the enrichment. If this test fails, a bake destroyed it —
//! restore the file (`git checkout viewer/assets/agent/jewels.json`)
//! or re-run `node scripts/gen_agent_meta.mjs`, and fix whatever
//! rewrote the file without the preservation path.

use std::path::PathBuf;

fn repo_file(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(rel)
}

#[test]
fn poe2_agent_jewels_keep_their_enrichment() {
    let path = repo_file("viewer/assets/agent/jewels.json");
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    assert!(
        text.contains("\"uniques\":{\""),
        "{} lost its gen_agent_meta enrichment (`uniques` section) — \
         a bake overwrote it without the preserve path",
        path.display()
    );
    // And the base sections tree_render owns are present too.
    for key in ["\"sockets\":", "\"rings\":", "\"bases\":"] {
        assert!(
            text.contains(key),
            "{} missing base section {key}",
            path.display()
        );
    }
}
