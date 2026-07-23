//! The OFFICIAL Oodle decompressor, loaded at mine time via `dlopen`.
//!
//! ## Why the official library
//!
//! PoE2 bundles are compressed with RAD/Epic's proprietary Oodle. The
//! reverse-engineered ooz decoder served us until CDN patch 4.5.4.3,
//! where GGG's upgraded compressor produced streams ooz silently
//! MIS-decodes — dense byte corruption inside ~11% of quanta with a
//! success status (measured: 258,111 wrong bytes in one 2.2 MB
//! bundle). The official decoder is the only implementation
//! guaranteed to track the format; it decoded every previously-broken
//! bundle byte-perfectly.
//!
//! ## Provenance & licensing (read before touching)
//!
//! Epic distributes the Oodle SDK — including these exact library
//! binaries — free of charge with Unreal Engine. We download the
//! per-platform decoder from `WorkingRobot/OodleUE` (a verbatim,
//! widely-used mirror of Epic's public SDK artifacts; the same source
//! the MIT `oodle_loader`/repak ecosystem uses), pinned to a commit
//! and SHA-256 verified. The file lands in the user's cache dir, NOT
//! the repo: we never commit or redistribute it, and none of our
//! binaries link it — `dlopen` only, at runtime, on first use.
//!
//! Unlike the previous ooz backend (GPL-3.0/unlicensed sources), every
//! line in this crate is first-party, so the workspace license story
//! is uniform again.
//!
//! ## Boundary: extraction only
//!
//! The library is loaded lazily by the first [`decompress_into`] call
//! — which only ever happens under `data_miner`'s bundle decoding
//! (mine/get/index paths). Rendering, serving, the planner, and the
//! deployed site never reach this code, and a `bw` invocation that
//! doesn't extract never dlopens anything.
//!
//! ## Safety model
//!
//! The `unsafe` surface of the workspace lives here (the workspace
//! `forbid(unsafe_code)` lint is deliberately not inherited):
//! - `dlopen`/`dlsym` FFI declared by hand (no libc/libloading crate).
//! - One foreign call, `OodleLZ_Decompress`, invoked with
//!   `fuzzSafe=Yes` so the decoder never writes outside
//!   `[dst, dst+dst.len())` even on corrupt input (official contract;
//!   unlike ooz there is no out-of-bounds scribble area).
//! - The handle is never closed: the decoder lives for the process.

use std::ffi::{CString, c_char, c_int, c_void};
use std::path::PathBuf;
use std::sync::OnceLock;

/// Pinned mirror commit of Epic's SDK artifacts (WorkingRobot/OodleUE)
/// and the SDK version we load. Bump both together after re-verifying
/// hashes.
const MIRROR_COMMIT: &str = "5e38cb6c99c588b51cde0cae4a6420d6bc865605";
const SDK_VERSION: &str = "2.9.10";

/// (sdk-relative path, file name, SHA-256) per supported platform.
/// macOS ships one universal (x86_64 + arm64) dylib.
fn platform_lib() -> Option<(&'static str, &'static str, &'static str)> {
    if cfg!(target_os = "macos") {
        Some((
            "mac/lib",
            "liboo2coremac64.2.9.10.dylib",
            "b09af35f6b84a61e2b6488495c7927e1cef789b969128fa1c845e51a475ec501",
        ))
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some((
            "linux/lib",
            "liboo2corelinux64.so.9",
            "ed7e98f70be1254a80644efd3ae442ff61f854a2fe9debb0b978b95289884e9c",
        ))
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Some((
            "linuxarm/lib",
            "liboo2corelinuxarm64.so.9",
            "161a8ecca8cc2d4ea6469779c2cc529ed5bb2765d99466273c29fdbef4657374",
        ))
    } else {
        None
    }
}

#[derive(Debug, Clone)]
pub enum OodleError {
    /// No official library published for this OS/arch combination.
    UnsupportedPlatform,
    /// Download failed (curl missing/exit code, or filesystem error).
    Fetch(String),
    /// Downloaded bytes don't match the pinned SHA-256 — refused.
    HashMismatch { expected: String, got: String },
    /// `dlopen`/`dlsym` failed on the (verified) library file.
    Load(String),
    /// The decoder rejected the block (negative status), or produced
    /// a different byte count than the bundle header promised.
    Decode { status: isize, expected: usize },
    /// Compressed input longer than the FFI can express.
    SourceTooLarge { len: usize },
}

impl std::fmt::Display for OodleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedPlatform => write!(
                f,
                "oodle: no official Oodle library for this platform (supported: macOS, linux x86_64/aarch64)",
            ),
            Self::Fetch(e) => write!(f, "oodle: fetching the official library failed: {e}"),
            Self::HashMismatch { expected, got } => write!(
                f,
                "oodle: downloaded library hash {got} != pinned {expected} — refusing to load it",
            ),
            Self::Load(e) => write!(f, "oodle: loading the official library failed: {e}"),
            Self::Decode { status, expected } => write!(
                f,
                "oodle: decode returned {status}, expected {expected} bytes",
            ),
            Self::SourceTooLarge { len } => {
                write!(
                    f,
                    "oodle: compressed block of {len} bytes exceeds FFI limits"
                )
            }
        }
    }
}

impl std::error::Error for OodleError {}

// ---------------------------------------------------------------------
// Hand-rolled dynamic-loader FFI (macOS + Linux; RTLD_NOW == 2 on both)
// ---------------------------------------------------------------------

#[cfg(unix)]
unsafe extern "C" {
    fn dlopen(filename: *const c_char, flags: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    fn dlerror() -> *mut c_char;
}
#[cfg(unix)]
const RTLD_NOW: c_int = 2;

/// `OodleLZ_Decompress` from oo2core — the documented public decode
/// entry point. Parameter names follow RAD's headers.
type OodleLzDecompress = unsafe extern "C" fn(
    comp_buf: *const u8,
    comp_buf_size: isize,
    raw_buf: *mut u8,
    raw_len: isize,
    fuzz_safe: c_int,      // OodleLZ_FuzzSafe_Yes = 1
    check_crc: c_int,      // OodleLZ_CheckCRC_No = 0
    verbosity: c_int,      // OodleLZ_Verbosity_None = 0
    dec_buf_base: *mut u8, // window base; null = block is independent
    dec_buf_size: isize,
    fp_callback: *mut c_void,
    callback_user_data: *mut c_void,
    decoder_memory: *mut c_void,
    decoder_memory_size: isize,
    thread_phase: c_int, // OodleLZ_Decode_ThreadPhaseAll = 3
) -> isize;

struct Decoder(OodleLzDecompress);
// SAFETY: a bare `extern "C"` fn pointer into a library we never
// unload; calling it from any thread is the documented usage of
// oo2core (the decoder is stateless across calls we make — no shared
// decoder memory is passed).
unsafe impl Send for Decoder {}
unsafe impl Sync for Decoder {}

static DECODER: OnceLock<Result<Decoder, OodleError>> = OnceLock::new();

fn cache_dir() -> PathBuf {
    std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
        .unwrap_or_else(|| PathBuf::from(".cache"))
        .join("poe-buildwright")
        .join("oodle")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = hash::Sha256::new();
    h.update(bytes);
    hash::hex_encode(&h.finalize())
}

/// Locate the library file: `$POE2_OODLE_LIB` override (power users /
/// offline; hash NOT enforced, you're claiming you know the file),
/// else the cache, else download-and-verify into the cache.
fn locate_lib() -> Result<PathBuf, OodleError> {
    if let Some(p) = std::env::var_os("POE2_OODLE_LIB") {
        return Ok(PathBuf::from(p));
    }
    let (sdk_dir, file, want) = platform_lib().ok_or(OodleError::UnsupportedPlatform)?;
    let dir = cache_dir();
    let path = dir.join(file);
    if let Ok(bytes) = std::fs::read(&path) {
        let got = sha256_hex(&bytes);
        if got == want {
            return Ok(path);
        }
        // Stale/corrupt cache entry: fall through and re-download.
        eprintln!("oodle: cached {file} hash mismatch — re-fetching");
    }
    std::fs::create_dir_all(&dir).map_err(|e| OodleError::Fetch(e.to_string()))?;
    let url = format!(
        "https://raw.githubusercontent.com/WorkingRobot/OodleUE/{MIRROR_COMMIT}/Engine/Source/Programs/Shared/EpicGames.Oodle/Sdk/{SDK_VERSION}/{sdk_dir}/{file}",
    );
    eprintln!("oodle: fetching the official Oodle decoder (one-time, ~1 MB)\n       {url}");
    let tmp = dir.join(format!("{file}.part"));
    // Same tradeoff as data_miner::fetch: system curl instead of a
    // TLS crate. Mine-time tool; curl is present on dev boxes and CI.
    let status = std::process::Command::new("curl")
        .args(["-fsSL", "--retry", "3", "-o"])
        .arg(&tmp)
        .arg(&url)
        .status()
        .map_err(|e| OodleError::Fetch(format!("running curl: {e}")))?;
    if !status.success() {
        return Err(OodleError::Fetch(format!(
            "curl exit {} for {url}",
            status.code().unwrap_or(-1),
        )));
    }
    let bytes = std::fs::read(&tmp).map_err(|e| OodleError::Fetch(e.to_string()))?;
    let got = sha256_hex(&bytes);
    if got != want {
        let _ = std::fs::remove_file(&tmp);
        return Err(OodleError::HashMismatch {
            expected: want.to_string(),
            got,
        });
    }
    std::fs::rename(&tmp, &path).map_err(|e| OodleError::Fetch(e.to_string()))?;
    Ok(path)
}

#[cfg(unix)]
fn load() -> Result<Decoder, OodleError> {
    let path = locate_lib()?;
    let cpath = CString::new(path.as_os_str().as_encoded_bytes())
        .map_err(|_| OodleError::Load("NUL in library path".into()))?;
    // SAFETY: plain dlopen/dlsym on a hash-verified file; the returned
    // symbol is transmuted to the documented OodleLZ_Decompress
    // signature and the handle is intentionally leaked (process-lived).
    unsafe {
        let h = dlopen(cpath.as_ptr(), RTLD_NOW);
        if h.is_null() {
            let e = dlerror();
            let msg = if e.is_null() {
                "dlopen failed".to_string()
            } else {
                std::ffi::CStr::from_ptr(e).to_string_lossy().into_owned()
            };
            return Err(OodleError::Load(msg));
        }
        let sym_name = CString::new("OodleLZ_Decompress").unwrap();
        let sym = dlsym(h, sym_name.as_ptr());
        if sym.is_null() {
            return Err(OodleError::Load("OodleLZ_Decompress not exported".into()));
        }
        Ok(Decoder(
            std::mem::transmute::<*mut c_void, OodleLzDecompress>(sym),
        ))
    }
}

#[cfg(not(unix))]
fn load() -> Result<Decoder, OodleError> {
    Err(OodleError::UnsupportedPlatform)
}

/// Decompress one independent Oodle block into `dst` (whose length is
/// the exact uncompressed size the bundle header promises). The
/// decoder self-dispatches between Kraken/Mermaid/Hydra/Leviathan from
/// the quantum header, so callers don't pass a compressor id.
pub fn decompress_into(src: &[u8], dst: &mut [u8]) -> Result<(), OodleError> {
    let dec = match DECODER.get_or_init(load) {
        Ok(d) => d,
        Err(e) => return Err(e.clone()),
    };
    let src_len =
        isize::try_from(src.len()).map_err(|_| OodleError::SourceTooLarge { len: src.len() })?;
    let want = dst.len();
    // SAFETY: `src`/`dst` are live slices for the duration of the call;
    // fuzzSafe=1 contractually confines writes to `dst[..want]`. Null
    // window base is valid because GGG bundle blocks are independently
    // compressed (verified: byte-perfect decodes across full bundles).
    let status = unsafe {
        (dec.0)(
            src.as_ptr(),
            src_len,
            dst.as_mut_ptr(),
            want as isize,
            1, // fuzz-safe
            0, // no CRC check (bundles carry none)
            0, // silent
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
            3, // ThreadPhaseAll
        )
    };
    if status != want as isize {
        return Err(OodleError::Decode {
            status,
            expected: want,
        });
    }
    Ok(())
}
