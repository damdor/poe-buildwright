//! `buildwright` — the operational front door for the PoE2 planner.
//!
//! One CLI for the whole data lifecycle: detect the live patch, mine
//! GGG's CDN, run the extraction/render/build steps, and ship. Native
//! commands run in-process (via the `data_miner` library); the rest
//! orchestrate the existing scripts and sibling binaries until they're
//! ported. See `docs/ops-cli-plan.md` for the conversion roadmap.
//!
//! Design mirrors the workspace house style: std-only, hand-rolled
//! dispatch, `Result<(), String>` error flow. The command registry in
//! [`help`] is the single source of truth for dispatch + help.
//!
//! NB: this binary links `data_miner` → `ooz_sys` (GPL-3.0). Like the
//! miner it is an internal tool and must not be distributed; the
//! shipped artefact (viewer/) links none of it.

mod handlers;
mod help;
mod ui;

use std::path::PathBuf;
use std::process::ExitCode;

use ui::Style;

/// Shared context handed to every command handler.
pub struct Ctx {
    /// Repo root — all orchestrated steps run from here so the scripts'
    /// relative paths resolve.
    pub root: PathBuf,
    pub style: Style,
}

fn main() -> ExitCode {
    let style = Style::detect();
    let args: Vec<String> = std::env::args().skip(1).collect();

    // No command → the menu.
    let Some(name) = args.first() else {
        help::print_menu(style);
        return ExitCode::SUCCESS;
    };

    // Global help flags.
    if name == "--help" || name == "-h" {
        help::print_menu(style);
        return ExitCode::SUCCESS;
    }
    if name == "--version" || name == "-V" {
        println!("buildwright {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }

    let Some(cmd) = help::lookup(name) else {
        eprintln!("{}: unknown command `{name}`", style.red("error"));
        if let Some(sug) = suggest(name) {
            eprintln!("did you mean `{}`?", style.cyan(sug));
        }
        eprintln!("run `buildwright help` for the command list.");
        return ExitCode::from(2);
    };

    let rest = &args[1..];
    // Per-command help: `buildwright <cmd> --help` / `-h`.
    if rest.iter().any(|a| a == "--help" || a == "-h") {
        help::print_command_help(style, cmd);
        return ExitCode::SUCCESS;
    }

    let root = match repo_root() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{}: {e}", style.red("error"));
            return ExitCode::FAILURE;
        }
    };
    let ctx = Ctx { root, style };

    match (cmd.run)(&ctx, rest) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{}: {e}", style.red("error"));
            ExitCode::FAILURE
        }
    }
}

/// Walk up from the current directory to the repo root, identified by
/// the co-presence of `crates/`, `viewer/`, and `scripts/`. Falls back
/// to the current directory so read-only native commands still work
/// from anywhere.
fn repo_root() -> Result<PathBuf, String> {
    let start = std::env::current_dir().map_err(|e| format!("cwd: {e}"))?;
    let mut dir = start.as_path();
    loop {
        if dir.join("crates").is_dir()
            && dir.join("viewer").is_dir()
            && dir.join("scripts").is_dir()
        {
            return Ok(dir.to_path_buf());
        }
        match dir.parent() {
            Some(p) => dir = p,
            None => {
                // Not inside the repo. Native CDN commands don't need it;
                // orchestrated ones will fail clearly when a script is
                // missing. Use cwd rather than erroring here.
                return Ok(start);
            }
        }
    }
}

/// Cheap nearest-command suggestion by edit distance ≤ 2.
fn suggest(name: &str) -> Option<&'static str> {
    help::COMMANDS
        .iter()
        .map(|c| (c.name, edit_distance(name, c.name)))
        .filter(|&(_, d)| d <= 2)
        .min_by_key(|&(_, d)| d)
        .map(|(n, _)| n)
}

fn edit_distance(a: &str, b: &str) -> usize {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0; b.len() + 1];
    for (i, &ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, &cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            cur[j + 1] = (prev[j + 1] + 1).min(cur[j] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}
