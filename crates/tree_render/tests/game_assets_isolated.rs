//! Cross-game ship-state contract. These are tracked generated artifacts, so
//! CI verifies that every browser-visible JSON file declares the same owner as
//! its namespace and that the two rendered pages advertise only their own
//! data URLs.

use std::path::{Path, PathBuf};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn assert_owner(rel: &str, game: &str) {
    let path = root().join(rel);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    assert!(
        text.contains(&format!("\"game\":\"{game}\""))
            || text.contains(&format!("\"game\": \"{game}\"")),
        "{} does not declare game={game}",
        path.display(),
    );
}

#[test]
fn every_game_asset_declares_its_namespace_owner() {
    for rel in [
        "viewer/assets/skill_catalogue.json",
        "viewer/assets/item_catalogue.json",
        "viewer/assets/skill_stats.json",
        "viewer/assets/build_meta.json",
        "viewer/assets/agent/nodes.json",
        "viewer/assets/agent/graph.json",
        "viewer/assets/agent/bases.json",
        "viewer/assets/agent/mods.json",
        "viewer/assets/agent/jewels.json",
        "viewer/assets/agent/spirit.json",
        "viewer/assets/agent/granted_skills.json",
        "viewer/assets/agent/support_compat.json",
        "viewer/assets/agent/capabilities.json",
    ] {
        assert_owner(rel, "poe2");
    }
    for rel in [
        "viewer/assets/poe1-agent/skill_catalogue.json",
        "viewer/assets/poe1-agent/item_catalogue.json",
        "viewer/assets/poe1-agent/skill_stats.json",
        "viewer/assets/poe1-agent/build_meta.json",
        "viewer/assets/poe1-agent/nodes.json",
        "viewer/assets/poe1-agent/graph.json",
        "viewer/assets/poe1-agent/bases.json",
        "viewer/assets/poe1-agent/mods.json",
        "viewer/assets/poe1-agent/support_compat.json",
        "viewer/assets/poe1-agent/capabilities.json",
    ] {
        assert_owner(rel, "poe1");
    }
}

#[test]
fn rendered_pages_embed_exact_isolated_asset_registries() {
    let poe1 = std::fs::read_to_string(root().join("viewer/planner-poe1.html")).unwrap();
    let poe2 = std::fs::read_to_string(root().join("viewer/planner.html")).unwrap();
    assert!(poe1.contains("/assets/poe1-agent/skill_catalogue.json"));
    assert!(poe1.contains("/assets/poe1-agent/item_catalogue.json"));
    assert!(!poe1.contains("\"skillCatalogue\":\"/assets/skill_catalogue.json\""));
    assert!(poe2.contains("\"skillCatalogue\":\"/assets/skill_catalogue.json\""));
    assert!(!poe2.contains("/assets/poe1-agent/skill_catalogue.json"));
}

#[test]
fn renderer_refuses_cross_game_agent_directory() {
    let output = std::env::temp_dir().join(format!(
        "buildwright-invalid-render-{}.html",
        std::process::id(),
    ));
    let status = std::process::Command::new(env!("CARGO_BIN_EXE_tree_render"))
        .args([
            "--game", "poe1",
            "--agent-subdir", "agent",
            "--output", output.to_str().unwrap(),
        ])
        .status()
        .expect("run tree_render");
    assert!(!status.success(), "cross-game output combination was accepted");
    assert!(!output.exists(), "invalid render wrote an output file");
}
