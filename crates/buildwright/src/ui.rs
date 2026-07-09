//! Terminal styling + subprocess orchestration helpers.
//!
//! Std-only, matching the workspace house style (see `crates/serve`).
//! Colour is applied only when stdout is a real terminal and `NO_COLOR`
//! is unset, so piped/CI output stays clean.

use std::io::IsTerminal;
use std::path::Path;
use std::process::Command;

/// Whether ANSI styling should be emitted. Resolved once at startup.
#[derive(Clone, Copy)]
pub struct Style {
    pub color: bool,
}

impl Style {
    pub fn detect() -> Self {
        let no_color = std::env::var_os("NO_COLOR").is_some();
        Self {
            color: !no_color && std::io::stdout().is_terminal(),
        }
    }

    fn wrap(self, code: &str, s: &str) -> String {
        if self.color {
            format!("\x1b[{code}m{s}\x1b[0m")
        } else {
            s.to_string()
        }
    }

    pub fn bold(self, s: &str) -> String {
        self.wrap("1", s)
    }
    pub fn dim(self, s: &str) -> String {
        self.wrap("2", s)
    }
    pub fn cyan(self, s: &str) -> String {
        self.wrap("36", s)
    }
    pub fn green(self, s: &str) -> String {
        self.wrap("32", s)
    }
    pub fn yellow(self, s: &str) -> String {
        self.wrap("33", s)
    }
    pub fn red(self, s: &str) -> String {
        self.wrap("31", s)
    }
    /// Heading colour used for group titles.
    pub fn heading(self, s: &str) -> String {
        self.wrap("1;38;5;214", s) // bold amber, echoes the planner's gold
    }
}

/// A `▶ step` header printed before a subprocess runs, so a long
/// pipeline reads as a sequence of labelled stages.
pub fn step_banner(style: Style, label: &str) {
    eprintln!("\n{} {}", style.cyan("▶"), style.bold(label));
}

pub fn note(style: Style, msg: &str) {
    eprintln!("{} {msg}", style.dim("·"));
}

pub fn ok(style: Style, msg: &str) {
    eprintln!("{} {msg}", style.green("✓"));
}

pub fn warn(style: Style, msg: &str) {
    eprintln!("{} {msg}", style.yellow("!"));
}

/// Spawn a subprocess in `cwd`, inheriting stdio so its output streams
/// live, and map a non-zero exit into a descriptive `Err`. `label` is
/// shown in the banner and in any error.
pub fn run(
    style: Style,
    cwd: &Path,
    label: &str,
    program: &str,
    args: &[&str],
) -> Result<(), String> {
    step_banner(style, label);
    note(style, &format!("{} {}", program, args.join(" ")));
    let status = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .status()
        .map_err(|e| format!("failed to launch `{program}`: {e} (is it installed / on PATH?)"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "{label} failed ({program} exited with {})",
            status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".into()),
        ))
    }
}

/// Like [`run`] but returns Ok/Err purely from the exit code without a
/// banner — used by `doctor` to probe tool availability quietly.
pub fn probe(program: &str, args: &[&str]) -> bool {
    Command::new(program)
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}
