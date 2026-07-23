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
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
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
        "viewer/assets/poe1-agent/jewels.json",
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
    assert!(poe1.contains("/assets/poe1-agent/jewels.json"));
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
            "--game",
            "poe1",
            "--agent-subdir",
            "agent",
            "--output",
            output.to_str().unwrap(),
        ])
        .status()
        .expect("run tree_render");
    assert!(
        !status.success(),
        "cross-game output combination was accepted"
    );
    assert!(!output.exists(), "invalid render wrote an output file");
}

#[test]
fn poe1_jewel_assets_ship_native_radius_and_cluster_policy() {
    let jewels =
        std::fs::read_to_string(root().join("viewer/assets/poe1-agent/jewels.json")).unwrap();
    assert!(jewels.contains("\"VeryLarge\":{\"outer\":2000"));
    assert!(jewels.contains("\"Massive\":{\"outer\":2400"));
    assert_eq!(
        jewels.matches("\"cluster_outer\":true").count(),
        6,
        "PoE1 must expose exactly its six official outer-ring cluster sockets",
    );
    assert!(
        !jewels.contains("\"name\":\"Charm Socket\""),
        "Primalist charm sockets must not enter the jewel picker",
    );
    assert!(
        jewels.contains("\"Small\":{\"size_index\":0,\"min_nodes\":2,\"max_nodes\":3")
            && jewels.contains("\"Medium\":{\"size_index\":1,\"min_nodes\":4,\"max_nodes\":6")
            && jewels.contains("\"Large\":{\"size_index\":2,\"min_nodes\":8,\"max_nodes\":12"),
        "PoE1 must ship GGG's three cluster-jewel graph templates",
    );
    assert_eq!(
        jewels.matches("\"size\":\"Large\",\"node_id\":").count(),
        17,
        "GGG's current Large cluster skill set changed without a regenerated contract",
    );
    assert_eq!(
        jewels.matches("\"size\":\"Medium\",\"node_id\":").count(),
        21,
        "GGG's current Medium cluster skill set changed without a regenerated contract",
    );
    assert_eq!(
        jewels.matches("\"size\":\"Small\",\"node_id\":").count(),
        17,
        "GGG's current Small cluster skill set changed without a regenerated contract",
    );
    assert_eq!(
        jewels.matches("\"cluster_index\":").count(),
        42,
        "PoE1 must retain all outer and nested expansion-socket topology",
    );
    assert!(
        jewels.contains("\"local_affliction_notable_prodigious_defense\"")
            && jewels.contains("\"local_affliction_notable_blowback\"")
            && jewels.contains("\"local_affliction_notable_fettle\""),
        "cluster notable stat ids must remain joined to their generated passives",
    );
    assert!(
        !jewels.contains("PathOfBuilding") && !jewels.contains("githubusercontent"),
        "the shipped cluster graph must remain first-party GGG data",
    );

    let items =
        std::fs::read_to_string(root().join("viewer/assets/poe1-agent/item_catalogue.json"))
            .unwrap();
    assert!(items.contains("\"base\": \"Large Cluster Jewel\""));
    assert!(items.contains("\"slot\": \"jewel\""));
    assert!(items.contains("\"radius\": \"Large\""));

    let bases =
        std::fs::read_to_string(root().join("viewer/assets/poe1-agent/bases.json")).unwrap();
    assert!(bases.contains("\"name\": \"Crimson Jewel\""));
    assert!(bases.contains("\"name\": \"Large Cluster Jewel\""));
}
