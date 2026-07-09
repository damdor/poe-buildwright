//! The command registry: one table that drives dispatch, the top-level
//! menu, and per-command help. Adding a command = adding a row.
//!
//! Each row carries a [`Badge`] marking how the command is currently
//! implemented (`native` Rust vs an orchestrated `esbuild`/`deno`/
//! `wrangler` step). The badge doubles as our migration tracker; the
//! data pipeline is now fully native (the last Python extractors were
//! retired once the first-party miner reached parity).

use crate::Ctx;
use crate::ui::Style;

/// Implementation status of a command, shown as a trailing badge.
#[derive(Clone, Copy, PartialEq)]
pub enum Badge {
    Native,
    /// esbuild — a native Go binary, no node.
    Esbuild,
    /// deno — a native binary embedding tsc, no node.
    Deno,
    /// wrangler — the one remaining node dependency (deploy).
    Wrangler,
    /// pob — first-party *resolution* of a list pinned to a Path of
    /// Building commit (the one dataset GGG ships no source for: which
    /// mods each unique grants). Stat text/ranges are still ours.
    Pob,
    Meta,
}

impl Badge {
    fn label(self) -> &'static str {
        match self {
            Badge::Native => "native",
            Badge::Esbuild => "esbuild",
            Badge::Deno => "deno",
            Badge::Wrangler => "wrangler",
            Badge::Pob => "pob-pinned",
            Badge::Meta => "",
        }
    }
    fn render(self, style: Style) -> String {
        let l = self.label();
        if l.is_empty() {
            return String::new();
        }
        let dot = format!("·{l}");
        match self {
            Badge::Native => style.green(&dot),
            Badge::Pob => style.yellow(&dot),
            _ => style.dim(&dot),
        }
    }
}

/// Command groups, in menu display order.
#[derive(Clone, Copy, PartialEq)]
pub enum Group {
    Sources,
    Mine,
    Data,
    Build,
    Ship,
    Pipeline,
    Meta,
}

impl Group {
    fn title(self) -> &'static str {
        match self {
            Group::Sources => "DATA SOURCES",
            Group::Mine => "MINE  (first-party · post-release)",
            Group::Data => "PATCH DATA  (integrity & changes)",
            Group::Build => "BUILD & RENDER",
            Group::Ship => "RUN & SHIP",
            Group::Pipeline => "PIPELINES  (repeatable one-shots)",
            Group::Meta => "META",
        }
    }
    const ORDER: [Group; 7] = [
        Group::Sources,
        Group::Mine,
        Group::Data,
        Group::Build,
        Group::Ship,
        Group::Pipeline,
        Group::Meta,
    ];
}

pub struct Command {
    pub name: &'static str,
    pub group: Group,
    pub badge: Badge,
    /// One-line summary for the menu.
    pub summary: &'static str,
    /// Multi-line detail for `<cmd> --help` (usage + notes + examples).
    pub help: &'static str,
    pub run: fn(&Ctx, &[String]) -> Result<(), String>,
}

/// The registry. Order within a group is display order.
pub const COMMANDS: &[Command] = &[
    // ---- DATA SOURCES ------------------------------------------------
    Command {
        name: "patch",
        group: Group::Sources,
        badge: Badge::Native,
        summary: "Detect the current live PoE2 patch (CDN handshake)",
        help: "\
buildwright patch — detect the current live PoE2 patch

Performs the GGG patch-server handshake (TCP patch.pathofexile2.com)
and prints the CDN version + base URL. This is the authoritative
'what is live right now' signal for the update pipelines.

USAGE
    buildwright patch

NOTES
    · No install or auth required.
    · The CDN only serves the current version; old versions 404.",
        run: crate::handlers::patch,
    },
    Command {
        name: "status",
        group: Group::Sources,
        badge: Badge::Native,
        summary: "Show local patches, CURRENT, and provenance",
        help: "\
buildwright status — local data inventory

Lists every patch under data/parsed/, which one CURRENT points at,
each one's .source marker (first-party | pob2-stable | pob2-dev |
preview) and manifest patch/version, and compares against the live
CDN patch so you can see at a glance whether the checkout is stale.

USAGE
    buildwright status",
        run: crate::handlers::status,
    },
    Command {
        name: "sources",
        group: Group::Sources,
        badge: Badge::Meta,
        summary: "Explain the data-source types + provenance model",
        help: "\
buildwright sources — the data-source model

Explains the .source markers and how the two operator scenarios
(pre-release preview vs post-release first-party) map onto them.

USAGE
    buildwright sources",
        run: crate::handlers::sources,
    },
    // ---- MINE --------------------------------------------------------
    Command {
        name: "fetch",
        group: Group::Mine,
        badge: Badge::Native,
        summary: "Download a file/bundle from the GGG CDN",
        help: "\
buildwright fetch — download a game-relative file from the CDN

Resolves the live patch, then downloads <path> (relative to the CDN
version root) into the version-keyed cache and prints the local path.
Already-cached files are returned without re-downloading.

USAGE
    buildwright fetch <path>

EXAMPLES
    buildwright fetch Bundles2/_.index.bin
    buildwright fetch Bundles2/Data/Passiveskills.bundle.bin",
        run: crate::handlers::fetch,
    },
    Command {
        name: "index",
        group: Group::Mine,
        badge: Badge::Native,
        summary: "Parse + summarise Bundles2/_.index.bin",
        help: "\
buildwright index — parse the master bundle index

Fetches (if needed) and decompresses Bundles2/_.index.bin, parses the
bundle/file/path tables, recovers the path-hash seed, resolves every
virtual path, and prints coverage stats + a sample.

USAGE
    buildwright index",
        run: crate::handlers::index,
    },
    Command {
        name: "find",
        group: Group::Mine,
        badge: Badge::Native,
        summary: "Search the index for game-file paths",
        help: "\
buildwright find — search the game file index

Case-insensitive substring search over every resolved virtual path,
printing the owning bundle + offset + size for each hit (capped).

USAGE
    buildwright find <substring>

EXAMPLES
    buildwright find passiveskills
    buildwright find statdescriptions/passive",
        run: crate::handlers::find,
    },
    Command {
        name: "get",
        group: Group::Mine,
        badge: Badge::Native,
        summary: "Extract one file by virtual path",
        help: "\
buildwright get — extract a single game file

Looks <vpath> up in the index, fetches only its owning bundle,
decompresses it, and writes the file's bytes to <out> (or hex-previews
the first bytes when no output path is given).

USAGE
    buildwright get <vpath> [out_file]

EXAMPLES
    buildwright get data/balance/passiveskills.datc64 skills.datc64",
        run: crate::handlers::get,
    },
    Command {
        name: "dat",
        group: Group::Mine,
        badge: Badge::Native,
        summary: "Decode a game table by name (dat-schema + reader)",
        help: "\
buildwright dat — decode a typed game table

Loads the community dat-schema (cached), locates the table's base
(non-localized) .datc64 in the index, fetches only its bundle, and
prints typed rows. This is the extraction foundation — the same path
`mine` uses.

USAGE
    buildwright dat <TableName> [--rows N] [--col NAME]

OPTIONS
    --rows N     rows to print (default 10)
    --col NAME   print only this column (else the first 6 named)

EXAMPLES
    buildwright dat PassiveSkills --col MasteryGroup
    buildwright dat PassiveSkillTreeMasteryArt --rows 3",
        run: crate::handlers::dat,
    },
    Command {
        name: "csd",
        group: Group::Mine,
        badge: Badge::Native,
        summary: "Render stat ids through a stat-description file",
        help: "\
buildwright csd — render stats through a .csd stat-description file

Development probe for GGG's stat-description pipeline: takes
`stat_id:lo:hi` triples (or `stat_id:v` singles) and prints the display
lines the given .csd resolves them to. Used to validate per-skill and
per-part stat rendering before wiring it into the catalogues.

USAGE
    buildwright csd <file.csd-virtual-path> <stat:lo[:hi]> [more…]

EXAMPLES
    buildwright csd data/statdescriptions/skill_stat_descriptions.csd \\
        spell_minimum_base_cold_damage:787 spell_maximum_base_cold_damage:1181
    buildwright csd data/statdescriptions/specific_skill_stat_descriptions/comet.csd \\
        active_skill_base_area_of_effect_radius:28",
        run: crate::handlers::csd_render,
    },
    Command {
        name: "skill-stats",
        group: Group::Mine,
        badge: Badge::Native,
        summary: "Bake per-gem per-level per-part rendered stat numbers",
        help: "\
buildwright skill-stats — bake viewer/assets/skill_stats.json

Per-gem, per-level, per-PART display numbers: resolved stat values from
GrantedEffectStatSetsPerLevel rendered through the
skill_stat_descriptions.csd include-chain, plus each effect's mana-cost
/ reservation / cooldown ladder from GrantedEffectsPerLevel. Powers the
gem preview popup's numbers-at-drafted-level and the guide.

USAGE
    buildwright skill-stats [--patch <p>]",
        run: crate::handlers::skill_stats,
    },
    Command {
        name: "mine",
        group: Group::Mine,
        badge: Badge::Native,
        summary: "Export a set of GGG tables to first-party TSVs",
        help: "\
buildwright mine — systematic first-party table export

The repeatable 'load a new patch through the miner' step. Fetches a set
of GGG tables from the CDN, decodes each via the dat reader, and writes
clean first-party TSVs to data/parsed/<patch>_native/dat/. Then
`manifest`/`verify` hash + index it exactly like the PoB-derived data,
and `diff <patch> <patch>_native` cross-validates. Tables missing from
the schema/index, or that don't fit their schema, are skipped (warned),
not fatal.

USAGE
    buildwright mine [--patch <p>] [--tables A,B,C] [--out <dir>]

OPTIONS
    --tables   comma list (default: a curated passive/skill/item set)
    --out      output dir (default data/parsed/<patch>_native/dat)

EXAMPLES
    buildwright mine --patch 0_5
    buildwright mine --tables BaseItemTypes,ItemClasses",
        run: crate::handlers::mine,
    },
    Command {
        name: "shape",
        group: Group::Mine,
        badge: Badge::Native,
        summary: "Shape raw GGG tables into a site dataset (first-party)",
        help: "\
buildwright shape — join raw tables into a site dataset

Where `mine` dumps one flat table per file, `shape` joins several into
one of the datasets the planner consumes. Loads the source tables into a
TableSet (O(1) reverse-index joins) and writes the shaped TSV to
data/parsed/<patch>_native/. Done one dataset at a time.

USAGE
    buildwright shape <dataset> [--patch <p>]

DATASETS
    bases           items/bases.tsv — BaseItemTypes ⋈ Armour/Weapon/
                    Attribute requirement/Flask/Shield tables
    gems            skills/gems.tsv — SkillGems ⋈ BaseItemTypes
                    (base/tags/reqs)
    active_skills   skills/active_skills.tsv — ActiveSkills ⋈
                    GrantedEffects (cast time)
    support_skills  skills/support_skills.tsv — GrantedEffects
                    (supports) ⋈ gem items (name) + SupportText
    buffs           skills/buffs.tsv — BuffDefinitions: visible buffs'
                    display name + tooltip text (granted-buff tooltips)
    mods            items/mods.tsv — Mods ⋈ Stats/Tags: stat ranges,
                    spawn-weight tags (what rolls it), derived tiers
    skill_levels    skills/skill_levels.tsv — GrantedEffectsPerLevel ⋈
                    stat sets: per-level cost/cooldown/crit
    soul_cores      items/soul_cores.tsv — SoulCoreStats ⋈ SoulCores:
                    runes/soul cores/idols + per-socket stats
    gem_quality     skills/gem_quality.tsv — GrantedEffectQualityStats:
                    a skill's quality bonus at 20%
    tree            tree/{nodes,edges,meta}.tsv — passiveskillgraph.psg
                    (geometry+topology) ⋈ PassiveSkills (name/icon/kind/
                    stats/klass) + class/ascendancy meta

    (uniques is intentionally deferred — run it to see why; tree stat
     text still needs statdescriptions, tracked as a follow-on)

EXAMPLES
    buildwright shape bases --patch 0_5
    buildwright shape tree --patch 0_5",
        run: crate::handlers::shape,
    },
    // ---- PATCH DATA -------------------------------------------------
    Command {
        name: "manifest",
        group: Group::Data,
        badge: Badge::Native,
        summary: "Write the patch integrity manifest (SHA-256)",
        help: "\
buildwright manifest — write the integrity manifest

Hashes every dataset file under data/parsed/<patch>/ (SHA-256) into a
single deterministic manifest.json: per-file sha256 + bytes + rows,
plus a rollup hash over the whole set and the .source provenance. No
timestamp, so it's byte-stable — clean git diffs. Native replacement
for scripts/build_manifests.py.

USAGE
    buildwright manifest [--patch <p>] [--source <s>]

DEFAULTS
    --patch    the CURRENT symlink target
    --source   the <patch>/.source marker, else pob2-stable",
        run: crate::handlers::manifest,
    },
    Command {
        name: "verify",
        group: Group::Data,
        badge: Badge::Native,
        summary: "Integrity gate: hashes + referential + completeness",
        help: "\
buildwright verify — the integrity gate

Checks a parsed patch before it may ship: recomputes every file's
SHA-256 against the manifest (corruption/drift), re-checks the rollup,
verifies referential integrity (every tree node icon resolves to a
sprite — the check that would have caught the 0.5 sprite regression),
and confirms core datasets are present and non-empty. Exits non-zero on
any failure so pipelines can gate on it.

USAGE
    buildwright verify [--patch <p>]",
        run: crate::handlers::verify,
    },
    Command {
        name: "diff",
        group: Group::Data,
        badge: Badge::Native,
        summary: "Show what changed between two patches' data",
        help: "\
buildwright diff — field-level patch changelog

Compares two parsed patches under data/parsed/ dataset-by-dataset and
reports added / removed / changed records. Rows are keyed by their id
(first column) when unique, so a changed record shows exactly which
columns moved (e.g. a stat tweak) — the subtle-change detector.

USAGE
    buildwright diff <old_patch> <new_patch>

EXAMPLES
    buildwright diff 0_4 0_5",
        run: crate::handlers::diff,
    },
    Command {
        name: "tree-diff",
        group: Group::Data,
        badge: Badge::Native,
        summary: "Compare two shaped trees (node set + positions) — the parity gate",
        help: "\
buildwright tree-diff — passive-tree parity gate

Compares data/parsed/<a>/tree/nodes.tsv against <b>/tree/nodes.tsv: node
set (only-in-a / only-in-b), position-identical %, and moved nodes. Two
uses:
  * gate a re-flip — the primary `data.json` tree should be identical to
    itself across a rebuild, and near-identical to the PSG fallback;
  * surface GGG's per-patch curation — diff the exact `data.json` source
    against the bundle-derived PSG (shape each to its own patch dir) to
    see exactly which nodes GGG added/dropped/nudged, first-party, every
    patch, without guessing.

USAGE
    buildwright tree-diff <patch_a> <patch_b>",
        run: crate::handlers::tree_diff,
    },
    // ---- BUILD & RENDER ---------------------------------------------
    Command {
        name: "masteries",
        group: Group::Build,
        badge: Badge::Native,
        summary: "Derive the exact node→mastery lighting map (structural)",
        help: "\
buildwright masteries — exact mastery cluster mapping

Writes tree/masteries.tsv (trigger_id → mastery_id): which nodes, when
allocated, light which mastery. Derived structurally from the tree —
a mastery's cluster is (nodes in its group) ∪ (its neighbours in the
tree's connections graph) — so it's exact and automatic on every import,
replacing the planner's proximity heuristic that over-lit masteries you
were merely near. Reads only local first-party data (nodes.tsv +
edges.tsv) — no PoB tree.json.

USAGE
    buildwright masteries [--patch <p>]",
        run: crate::handlers::masteries,
    },
    Command {
        name: "sprites",
        group: Group::Build,
        badge: Badge::Native,
        summary: "Decode node-icon DDS → PNG + write tree/sprites.tsv",
        help: "\
buildwright sprites — first-party passive-tree icons

For every icon referenced by tree/nodes.tsv, fetch its individual `.dds`
from the CDN (art/2dart/skillicons/…), decode it (BC1/BC3/BC4/BC5 — no
external libs), and re-encode as PNG into viewer/assets/sprites/. Writes
tree/sprites.tsv (icon → png + width/height) under the native patch, so
node icons resolve with zero Path-of-Building dependency.

USAGE
    buildwright sprites [--patch <p>]",
        run: crate::handlers::sprites,
    },
    Command {
        name: "uniques",
        group: Group::Build,
        badge: Badge::Pob,
        summary: "Resolve PoB's pinned unique list → items/uniques.tsv (first-party stats)",
        help: "\
buildwright uniques — the one PoB-pinned dataset, resolved first-party

A specific unique's fixed mod list is the *only* thing GGG ships no
source for (it's applied server-side at item generation), so every tool
sources that list from Path of Building's hand-maintained files. This
command takes the *minimal* seam: it reads only `src/Export/Uniques/*.lua`
— the `name → base → [mod ids + roll overrides]` recipe — from the pinned
data/pob2 checkout, then resolves every mod id against OUR first-party
items/mods.tsv + statdescriptions/*.csd. So the stat text, ranges and
ordering are all ours; PoB contributes nothing but the list.

Writes items/uniques.tsv (one row per unique, latest variant) +
items/uniques_variants.tsv (every historical variant) +
items/uniques.pob.json (provenance: the pinned PoB commit + file set +
resolved/skipped counts — hashed by the manifest, so the lock is
diffable across imports).

DECOUPLING — this never blocks the first-party pipeline:
  * update-native runs it best-effort; a failure warns, the native
    datasets still complete + hash.
  * If GGG is newer than PoB, new uniques are simply absent until PoB
    lists them; existing uniques keep resolving against the new mods.
  * A unique referencing a mod we don't have yet is skipped (logged),
    never emitted half-resolved.

USAGE
    buildwright uniques [--patch <p>]",
        run: crate::handlers::uniques,
    },
    Command {
        name: "catalogues",
        group: Group::Build,
        badge: Badge::Native,
        summary: "Emit wizard catalogues (skills/items JSON)",
        help: "\
buildwright catalogues — emit the wizard catalogues

Joins the first-party native TSVs (gems ⋈ granted skill via
granted_effect_id, uniques ⋈ base) into the compact JSON catalogues the
wizard pages fetch (viewer/assets/{skill,item}_catalogue.json). Gem
icons are left null — the wizard is text-only; first-party icon art is a
separate follow-up.

USAGE
    buildwright catalogues [--patch <p>]",
        run: crate::handlers::catalogues,
    },
    Command {
        name: "render",
        group: Group::Build,
        badge: Badge::Native,
        summary: "Regenerate planner.html from parsed data",
        help: "\
buildwright render — regenerate the planner

Runs the tree_render crate to emit viewer/planner.html (+ planner.css +
build_meta.json) from the parsed tree data for the current patch.

USAGE
    buildwright render [--tree-dir <dir>] [--output <file>]

DEFAULTS
    --tree-dir data/parsed/CURRENT/tree
    --output   viewer/planner.html",
        run: crate::handlers::render,
    },
    Command {
        name: "js",
        group: Group::Build,
        badge: Badge::Esbuild,
        summary: "Bundle the planner/wizard TypeScript",
        help: "\
buildwright js — build the JS bundles

Runs esbuild over the planner + wizard TypeScript, emitting the IIFE
bundles under viewer/assets/. Pass --watch to rebuild on save.

USAGE
    buildwright js [--watch]

NOTE
    Wraps scripts/build_js.sh (vendored esbuild).",
        run: crate::handlers::js,
    },
    Command {
        name: "typecheck",
        group: Group::Build,
        badge: Badge::Deno,
        summary: "Strict type-check the TypeScript (deno, no node)",
        help: "\
buildwright typecheck — strict type-check the TS

Runs `deno check` over the planner + wizard entry points. Deno embeds
the real TypeScript compiler, so this is full strict checking with no
node and no package manager (esbuild strips types without checking
them). Strict config in deno.json.

USAGE
    buildwright typecheck

NOTE
    Wraps scripts/check_types.sh (vendored tsc).",
        run: crate::handlers::typecheck,
    },
    // ---- RUN & SHIP --------------------------------------------------
    Command {
        name: "serve",
        group: Group::Ship,
        badge: Badge::Native,
        summary: "Serve viewer/ locally",
        help: "\
buildwright serve — local dev server

Serves the viewer/ directory over HTTP for local testing.

USAGE
    buildwright serve [--port <n>] [--host <addr>]

DEFAULTS
    --host 127.0.0.1   --port 8000",
        run: crate::handlers::serve,
    },
    Command {
        name: "deploy",
        group: Group::Ship,
        badge: Badge::Wrangler,
        summary: "Deploy viewer/ to Cloudflare Pages",
        help: "\
buildwright deploy — ship to Cloudflare Pages

Builds the JS fresh and deploys viewer/ via wrangler, using credentials
from .cloudflare.env.

USAGE
    buildwright deploy

NOTE
    Wraps scripts/deploy.sh. Requires a valid CLOUDFLARE_API_TOKEN in
    .cloudflare.env.",
        run: crate::handlers::deploy,
    },
    // ---- PIPELINES ---------------------------------------------------
    Command {
        name: "update-native",
        group: Group::Pipeline,
        badge: Badge::Meta,
        summary: "mine → shape → sprites → catalogues → manifest  (first-party)",
        help: "\
buildwright update-native — first-party mine + rebuild

Detect the live patch, fetch from GGG's CDN, and build every dataset
first-party into data/parsed/<patch>_native/ — authoritative
(source=first-party), zero PoB dependency.

USAGE
    buildwright update-native [--patch <p>]

STEPS
    mine (raw GGG tables) → shape (bases/mods/gems/skills/tree/…) →
    masteries → sprites → uniques (pob-pinned mod ids) → catalogues →
    manifest. Then run `verify` + flip CURRENT once you're happy.",
        run: crate::handlers::update_native,
    },
    Command {
        name: "doctor",
        group: Group::Pipeline,
        badge: Badge::Native,
        summary: "Check the toolchain + caches",
        help: "\
buildwright doctor — environment check

Probes every tool the pipelines depend on (curl, python3, lua, unzstd,
magick, node, esbuild, tsc, wrangler), the CDN reachability, and the
cache/credentials state — reporting what's ready and what's missing.

USAGE
    buildwright doctor",
        run: crate::handlers::doctor,
    },
    // ---- META --------------------------------------------------------
    Command {
        name: "help",
        group: Group::Meta,
        badge: Badge::Meta,
        summary: "Show this menu, or detail for one command",
        help: "\
buildwright help — help

USAGE
    buildwright help            # the full menu
    buildwright help <command>  # detail for one command
    buildwright <command> --help",
        run: crate::handlers::help_cmd,
    },
];

pub fn lookup(name: &str) -> Option<&'static Command> {
    COMMANDS.iter().find(|c| c.name == name)
}

/// The top-level grouped menu.
pub fn print_menu(style: Style) {
    println!(
        "{} {}",
        style.heading("buildwright"),
        style.dim("— PoE2 BuildWright operations"),
    );
    println!(
        "\n  The single front door for loading game data and shipping the planner.\n  {}",
        style.dim("native = runs in-process · others orchestrate an existing tool"),
    );
    println!(
        "\n{}\n    buildwright <command> [options]\n    buildwright help <command>",
        style.bold("USAGE"),
    );

    // Longest name for column alignment.
    let width = COMMANDS.iter().map(|c| c.name.len()).max().unwrap_or(0);

    for group in Group::ORDER {
        let mut first_in_group = true;
        for c in COMMANDS.iter().filter(|c| c.group == group) {
            if first_in_group {
                println!("\n{}", style.heading(group.title()));
                first_in_group = false;
            }
            let badge = c.badge.render(style);
            println!(
                "  {name:<width$}  {summary}  {badge}",
                name = style.cyan(c.name),
                // pad on the raw name length, not the styled length
                width = width + style_pad(style, c.name),
                summary = c.summary,
            );
        }
    }
    println!(
        "\n{}",
        style.dim("Tip: `buildwright doctor` checks your toolchain; `status` shows local data."),
    );
}

/// ANSI escapes inflate a string's byte length, breaking `{:<width}`
/// padding. When colour is on, add the escape overhead so the visible
/// columns still line up.
fn style_pad(style: Style, s: &str) -> usize {
    if style.color {
        style.cyan(s).len() - s.len()
    } else {
        0
    }
}

pub fn print_command_help(_style: Style, cmd: &Command) {
    println!("{}", cmd.help);
}
