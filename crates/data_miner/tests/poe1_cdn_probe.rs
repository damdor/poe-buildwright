//! Offline-able probe for the PoE1 patch CDN — the groundwork check
//! for the poe1 gems/skills data step (docs/poe1-allflame-prep.md).
//!
//! PoE1's patch server speaks the exact protocol fetch.rs already
//! implements for PoE2, just on its own host. This probe handshakes,
//! pulls the bundle index, and lists the tables the skills catalogue
//! will need. Network + ~50MB cache; run explicitly:
//!
//!   cargo test -p data_miner --test poe1_cdn_probe -- --ignored --nocapture

use data_miner::bundle_decode;
use data_miner::fetch::{patch_info_from, CdnClient, Game, POE1_PATCH_SERVER};
use data_miner::index::Index;

#[test]
#[ignore = "network probe — run explicitly with --ignored --nocapture"]
fn poe1_cdn_serves_the_gem_tables() {
    let info = patch_info_from(POE1_PATCH_SERVER).expect("poe1 patch handshake");
    assert_eq!(POE1_PATCH_SERVER, Game::Poe1.patch_server());
    eprintln!("poe1 cdn base : {}", info.cdn_base);
    eprintln!("poe1 version  : {}", info.version);

    let cache = std::env::temp_dir().join("poe1-cdn-probe");
    let client = CdnClient::new(info, &cache);
    let local = client.fetch("Bundles2/_.index.bin").expect("fetch index");
    let payload = bundle_decode::decompress_full(&local).expect("decompress index");
    eprintln!("index         : {} bytes decompressed", payload.len());
    let index = Index::parse(&payload).expect("parse index");
    let paths = index.resolve_paths().expect("resolve paths");
    eprintln!("paths         : {}", paths.len());

    // The tables the poe1 skills catalogue needs, plus the stat
    // description files that render their stats.
    let wanted = [
        "data/skillgems.datc64",
        "data/gemtags.datc64",
        "data/grantedeffects.datc64",
        "data/grantedeffectsperlevel.datc64",
        "data/grantedeffectstatsets.datc64",
        "data/grantedeffectstatsetsperlevel.datc64",
        "data/activeskills.datc64",
        "data/activeskilltype.datc64",
        "data/gemeffects.datc64",
        "metadata/statdescriptions/skill_stat_descriptions.txt",
        "metadata/statdescriptions/gem_stat_descriptions.txt",
    ];
    let mut missing = Vec::new();
    for w in wanted {
        match index.lookup(w) {
            Some(f) => eprintln!("  ok  {w}  ({} bytes)", f.size),
            None => {
                eprintln!("  MISS {w}");
                missing.push(w);
            }
        }
    }
    // Gem icon art sample:
    for sample in ["art/2dart/skillicons/fireball.dds", "art/2dart/skillicons/gems/fireballgem.dds"] {
        eprintln!(
            "  art {} → {}",
            sample,
            if index.lookup(sample).is_some() { "present" } else { "absent (name differs — enumerate by prefix later)" }
        );
    }
    assert!(
        missing.len() <= 3,
        "too many expected tables missing from the poe1 index: {missing:?}"
    );
}
