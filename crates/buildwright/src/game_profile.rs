//! One typed ownership profile for every game-sensitive build path.
//!
//! Pipeline handlers resolve this once and derive CDN, catalogue, grounding,
//! renderer and metadata destinations from it. No handler is allowed to pair
//! a free-form `--game` with an unrelated output directory.

use std::path::{Path, PathBuf};

use data_miner::fetch::Game;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct GameProfile {
    pub(crate) game: Game,
    pub(crate) id: &'static str,
    pub(crate) patch_prefix: &'static str,
    pub(crate) agent_subdir: &'static str,
    catalogue_rel: &'static str,
    grounding_rel: &'static str,
    skill_stats_rel: &'static str,
}

pub(crate) const POE1: GameProfile = GameProfile {
    game: Game::Poe1,
    id: "poe1",
    patch_prefix: "poe1_",
    agent_subdir: "poe1-agent",
    catalogue_rel: "viewer/assets/poe1-agent",
    grounding_rel: "viewer/assets/poe1-agent",
    skill_stats_rel: "viewer/assets/poe1-agent/skill_stats.json",
};

pub(crate) const POE2: GameProfile = GameProfile {
    game: Game::Poe2,
    id: "poe2",
    patch_prefix: "",
    agent_subdir: "agent",
    catalogue_rel: "viewer/assets",
    grounding_rel: "viewer/assets/agent",
    skill_stats_rel: "viewer/assets/skill_stats.json",
};

impl GameProfile {
    pub(crate) fn from_patch(patch: &str) -> Self {
        if patch.starts_with(POE1.patch_prefix) {
            POE1
        } else {
            POE2
        }
    }

    pub(crate) fn from_id(id: &str) -> Result<Self, String> {
        match id {
            "poe1" => Ok(POE1),
            "poe2" => Ok(POE2),
            other => Err(format!("unsupported game {other:?}; expected poe1 or poe2")),
        }
    }

    pub(crate) fn catalogue_dir(self, root: &Path) -> PathBuf {
        root.join(self.catalogue_rel)
    }

    pub(crate) fn grounding_dir(self, root: &Path) -> PathBuf {
        root.join(self.grounding_rel)
    }

    pub(crate) fn skill_stats_path(self, root: &Path) -> PathBuf {
        root.join(self.skill_stats_rel)
    }

    pub(crate) fn patch_label(self, patch: &str) -> String {
        match self.game {
            Game::Poe1 => patch.replacen("poe1_", "poe1.", 1),
            Game::Poe2 => patch.trim_end_matches("_native").replace('_', "."),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles_keep_all_web_outputs_game_owned() {
        let root = Path::new("/repo");
        assert_eq!(GameProfile::from_patch("poe1_3.28.0k"), POE1);
        assert_eq!(GameProfile::from_patch("4.5.4.4_native"), POE2);
        assert!(
            POE1.catalogue_dir(root)
                .starts_with("/repo/viewer/assets/poe1-agent")
        );
        assert!(
            POE1.grounding_dir(root)
                .starts_with("/repo/viewer/assets/poe1-agent")
        );
        assert_ne!(POE1.skill_stats_path(root), POE2.skill_stats_path(root));
    }
}
