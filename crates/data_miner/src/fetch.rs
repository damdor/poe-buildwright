//! CDN fetching — get bundles straight from GGG's public patch CDN,
//! no game install required.
//!
//! ## Protocol (verified live 2026-07-02; see docs/native-data-miner.md)
//!
//! 1. Plain TCP to `patch.pathofexile2.com:13060`, send `[0x01, 0x06]`
//!    ("get patch info", protocol 6 — same bytes LibGGPK3 sends).
//! 2. Response: `0x02`, 33 unknown/zero bytes, then a u8
//!    UTF-16-code-unit length + UTF-16LE CDN base URL (twice; the
//!    second copy is a backup URL, currently identical).
//!    Live example: `https://patch-poe2.poecdn.com/4.5.4.1.3/`.
//!    The patch version is the last path segment of the URL — there
//!    is no separate version field.
//! 3. Files live at `<base><game-relative-path>`, e.g.
//!    `<base>Bundles2/_.index.bin`. HTTPS, no auth, no User-Agent
//!    requirement, `Accept-Ranges: bytes`.
//!
//! Only the **current** version is served — old version paths 404 as
//! soon as a patch ships. A 404 mid-run therefore means "re-do the
//! handshake and start over", not "retry".
//!
//! ## Why curl and not a TLS crate
//!
//! The handshake is plain TCP (std suffices), but the CDN is HTTPS.
//! Rather than pull a TLS stack into the workspace, downloads shell
//! out to the system `curl` (present on dev boxes and CI), which also
//! gives us `--retry`, resume, and sane proxy handling for free. The
//! miner is an internal pipeline tool; this is a deliberate tradeoff,
//! not a shortcut to revisit lightly.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// PoE2 patch server (LibGGPK3 `PatchClient.cs` endpoints).
pub const PATCH_SERVER: &str = "patch.pathofexile2.com:13060";
/// PoE1 patch server — same handshake protocol, its own host
/// (verified live 2026-07-20 → https://patch.poecdn.com/3.28.0.15/).
pub const POE1_PATCH_SERVER: &str = "patch.pathofexile.com:12995";

/// Which game's CDN/schema universe a pipeline call operates in. The
/// formats (bundles, .datc64, .csd, DDS) are identical; the patch
/// server, cache namespace, and schema `validFor` filter differ.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Game {
    Poe1,
    Poe2,
}

impl Game {
    pub fn patch_server(self) -> &'static str {
        match self {
            Game::Poe1 => POE1_PATCH_SERVER,
            Game::Poe2 => PATCH_SERVER,
        }
    }
    /// Cache subdirectory — the two games' CDN trees must never share
    /// a cache (same relative paths, different content + versions).
    pub fn cache_name(self) -> &'static str {
        match self {
            Game::Poe1 => "cdn-poe1",
            Game::Poe2 => "cdn",
        }
    }
}

/// The two-byte "get patch info" request, protocol version 6.
const PATCH_REQUEST: [u8; 2] = [0x01, 0x06];

#[derive(Debug, Clone)]
pub struct PatchInfo {
    /// CDN base URL including trailing slash and version segment,
    /// e.g. `https://patch-poe2.poecdn.com/4.5.4.1.3/`.
    pub cdn_base: String,
    /// Dotted patch version parsed from the URL, e.g. `4.5.4.1.3`.
    /// Five-part; do not assume four.
    pub version: String,
}

#[derive(Debug)]
pub enum FetchError {
    Io(std::io::Error),
    /// Patch server response didn't match the known layout.
    BadHandshake {
        what: &'static str,
    },
    /// curl exited non-zero. `status` is its exit code (22 with
    /// `--fail` means an HTTP error; on this CDN a 404 means the
    /// patch version rolled — re-run [`patch_info`]).
    Curl {
        status: i32,
        url: String,
    },
}

impl From<std::io::Error> for FetchError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "fetch i/o: {e}"),
            Self::BadHandshake { what } => write!(f, "patch server handshake: {what}"),
            Self::Curl { status, url } => write!(
                f,
                "curl exit {status} for {url} (404? the patch likely rolled — re-resolve the version)",
            ),
        }
    }
}

impl std::error::Error for FetchError {}

/// Ask the patch server for the current CDN base URL + version.
pub fn patch_info() -> Result<PatchInfo, FetchError> {
    patch_info_from(PATCH_SERVER)
}

/// As [`patch_info`] against an explicit `host:port` (tests, TW realm).
pub fn patch_info_from(server: &str) -> Result<PatchInfo, FetchError> {
    let mut addrs = std::net::ToSocketAddrs::to_socket_addrs(server)?;
    let addr = addrs.next().ok_or(FetchError::BadHandshake {
        what: "server name resolved to no addresses",
    })?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(10))?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
    stream.write_all(&PATCH_REQUEST)?;

    // One recv is enough in practice (~200 bytes), but read in a loop
    // until we can parse or the peer closes, to be safe on slow paths.
    let mut buf = Vec::with_capacity(512);
    let mut chunk = [0u8; 512];
    loop {
        match parse_patch_response(&buf) {
            Ok(info) => return Ok(info),
            Err(FetchError::BadHandshake { what: "truncated" }) => {}
            Err(e) => return Err(e),
        }
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            return parse_patch_response(&buf);
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

fn parse_patch_response(buf: &[u8]) -> Result<PatchInfo, FetchError> {
    const URL_LEN_OFFSET: usize = 34;
    if buf.len() < URL_LEN_OFFSET + 1 {
        return Err(FetchError::BadHandshake { what: "truncated" });
    }
    if buf[0] != 0x02 {
        return Err(FetchError::BadHandshake {
            what: "unexpected response opcode",
        });
    }
    let units = buf[URL_LEN_OFFSET] as usize;
    let start = URL_LEN_OFFSET + 1;
    let end = start + units * 2;
    if buf.len() < end {
        return Err(FetchError::BadHandshake { what: "truncated" });
    }
    let code_units: Vec<u16> = buf[start..end]
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    let cdn_base = String::from_utf16(&code_units).map_err(|_| FetchError::BadHandshake {
        what: "CDN URL is not valid UTF-16",
    })?;
    if !cdn_base.starts_with("http") || !cdn_base.ends_with('/') {
        return Err(FetchError::BadHandshake {
            what: "CDN URL has unexpected shape",
        });
    }
    let version = cdn_base
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_string();
    if version.is_empty() || !version.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return Err(FetchError::BadHandshake {
            what: "could not parse version from CDN URL",
        });
    }
    Ok(PatchInfo { cdn_base, version })
}

/// Version-keyed on-disk cache of CDN files. Files under one version
/// are immutable on the CDN (a new patch gets a new URL prefix), so
/// "exists locally" means "done" — no ETag dance needed.
pub struct CdnClient {
    pub info: PatchInfo,
    cache_dir: PathBuf,
}

impl CdnClient {
    /// `cache_root` gains a `<version>/` subdirectory per patch.
    pub fn new(info: PatchInfo, cache_root: &Path) -> Self {
        let cache_dir = cache_root.join(&info.version);
        Self { info, cache_dir }
    }

    /// Resolve the current patch and return a client caching under
    /// `~/.cache/poe-buildwright/cdn/` (or `$XDG_CACHE_HOME`).
    pub fn connect() -> Result<Self, FetchError> {
        Self::connect_for(Game::Poe2)
    }

    /// Game-parameterized connect: handshake that game's patch server
    /// and cache under its own namespace.
    pub fn connect_for(game: Game) -> Result<Self, FetchError> {
        let cache_root = std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
            .unwrap_or_else(|| PathBuf::from(".cache"))
            .join("poe-buildwright")
            .join(game.cache_name());
        Ok(Self::new(patch_info_from(game.patch_server())?, &cache_root))
    }

    /// Fetch a game-relative path (e.g. `Bundles2/_.index.bin`) into
    /// the cache and return the local file path. Skips the download if
    /// already cached.
    pub fn fetch(&self, rel: &str) -> Result<PathBuf, FetchError> {
        let local = self.cache_dir.join(rel);
        if local.is_file() {
            return Ok(local);
        }
        if let Some(parent) = local.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let url = format!("{}{rel}", self.info.cdn_base);
        // Download to a .part file and rename, so an interrupted run
        // never leaves a truncated file that "exists locally".
        // -C - resumes a previous .part; --fail turns HTTP errors into
        // exit 22 instead of saving the error body.
        let part = local.with_extension("part");
        let status = Command::new("curl")
            .args([
                "--fail",
                "--silent",
                "--show-error",
                "--retry",
                "3",
                "-C",
                "-",
            ])
            .arg("--user-agent")
            .arg("poe-buildwright-miner/0.1 (data pipeline)")
            .arg("-o")
            .arg(&part)
            .arg(&url)
            .status()?;
        if !status.success() {
            return Err(FetchError::Curl {
                status: status.code().unwrap_or(-1),
                url,
            });
        }
        std::fs::rename(&part, &local)?;
        Ok(local)
    }

    pub fn cache_dir(&self) -> &Path {
        &self.cache_dir
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Byte-for-byte reconstruction of the live 2026-07-02 capture
    /// shape (only the URL region matters to the parser).
    #[test]
    fn parses_live_response_shape() {
        let url = "https://patch-poe2.poecdn.com/4.5.4.1.3/";
        let mut buf = vec![0u8; 34];
        buf[0] = 0x02;
        buf.push(url.len() as u8); // ASCII url: chars == UTF-16 units
        for unit in url.encode_utf16() {
            buf.extend_from_slice(&unit.to_le_bytes());
        }
        // Backup-URL tail omitted — parser doesn't need it.
        let info = parse_patch_response(&buf).expect("parse");
        assert_eq!(info.cdn_base, url);
        assert_eq!(info.version, "4.5.4.1.3");
    }

    #[test]
    fn rejects_wrong_opcode_and_truncation() {
        assert!(matches!(
            parse_patch_response(&[0x01; 64]),
            Err(FetchError::BadHandshake {
                what: "unexpected response opcode"
            })
        ));
        assert!(matches!(
            parse_patch_response(&[0x02, 0x00]),
            Err(FetchError::BadHandshake { what: "truncated" })
        ));
    }
}
