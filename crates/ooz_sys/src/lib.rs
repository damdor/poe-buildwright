//! Safe wrapper around the vendored [ooz] Oodle decompressor.
//!
//! PoE2 bundles compress every block with one of four proprietary Oodle
//! variants (Kraken, Mermaid, Hydra, Leviathan). ooz's `Ooz_Decompress`
//! entry point self-dispatches between all of them by reading the
//! per-quantum header bytes, so callers don't need to tell us which
//! compressor a block used.
//!
//! ## Safety model
//!
//! The single `unsafe` block in this workspace lives in [`decompress`].
//! Its soundness contract with the C++ side:
//!
//! - ooz documents that the decoder **writes up to [`SAFE_SPACE`] bytes
//!   past the end of the destination** ("The decompressor will write
//!   outside of the target buffer" — vendor/kraken.cpp). We therefore
//!   allocate `uncompressed_size + SAFE_SPACE` and truncate after.
//! - ooz is **not fuzz-safe** (its own README). Only feed it data from
//!   trusted sources — for us, bundles fetched from GGG's CDN or read
//!   from a local game install.
//!
//! ## Licensing
//!
//! The vendored sources are GPL-3.0-or-later (details in VENDOR.md).
//! This crate is license-marked accordingly; do not distribute binaries
//! that link it. The long-term plan is to replace this backend with the
//! in-progress pure-Rust port in `data_miner::oodle` (feature
//! `oodle-port`), at which point this crate can be dropped.
//!
//! [ooz]: https://github.com/zao/ooz

use std::ffi::{c_int, c_void};
use std::ptr;

/// Bytes the decoder may scribble past the end of the destination
/// buffer. Mirrors `SAFE_SPACE` in vendor/kraken.cpp.
pub const SAFE_SPACE: usize = 64;

unsafe extern "C" {
    /// vendor/kraken.cpp — thin `extern "C"` shim over
    /// `Kraken_Decompress`, which handles all Oodle LZ variants.
    /// Returns bytes written, or < 0 on failure. Trailing parameters
    /// mirror the oo2core `OodLZ_Decompress` signature but are unused
    /// by the ooz implementation.
    fn Ooz_Decompress(
        src_buf: *const u8,
        src_len: c_int,
        dst: *mut u8,
        dst_size: usize,
        fuzz_safe: c_int,
        check_crc: c_int,
        verbosity: c_int,
        dst_base: *mut u8,
        e: usize,
        callback: *mut c_void,
        callback_ctx: *mut c_void,
        scratch: *mut c_void,
        scratch_size: usize,
        thread_phase: c_int,
    ) -> c_int;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OozError {
    /// The decoder rejected the stream (returned a negative status).
    DecodeFailed { code: i32 },
    /// The decoder succeeded but produced a different byte count than
    /// the caller expected. Treated as fatal: a short block would shift
    /// every later offset in the bundle.
    SizeMismatch { expected: usize, got: usize },
    /// Source longer than `c_int::MAX` — can't cross the FFI boundary.
    /// Never legitimate for bundle blocks (≤ 256 KiB granularity).
    SourceTooLarge { len: usize },
}

impl std::fmt::Display for OozError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DecodeFailed { code } => write!(f, "ooz: decode failed (status {code})"),
            Self::SizeMismatch { expected, got } => {
                write!(f, "ooz: expected {expected} uncompressed bytes, got {got}")
            }
            Self::SourceTooLarge { len } => {
                write!(f, "ooz: source of {len} bytes exceeds c_int range")
            }
        }
    }
}

impl std::error::Error for OozError {}

/// Decompress a complete Oodle stream (one bundle block, or a whole
/// multi-quantum stream) that is known to expand to exactly
/// `uncompressed_size` bytes.
pub fn decompress(src: &[u8], uncompressed_size: usize) -> Result<Vec<u8>, OozError> {
    let mut dst = vec![0u8; uncompressed_size + SAFE_SPACE];
    let written = decompress_into_padded(src, &mut dst, uncompressed_size)?;
    debug_assert_eq!(written, uncompressed_size);
    dst.truncate(uncompressed_size);
    Ok(dst)
}

/// As [`decompress`], but reuses a caller-owned scratch buffer across
/// calls (the block loop in `data_miner` decodes thousands of blocks).
/// Returns the valid prefix of `scratch`.
pub fn decompress_with_scratch<'a>(
    src: &[u8],
    uncompressed_size: usize,
    scratch: &'a mut Vec<u8>,
) -> Result<&'a [u8], OozError> {
    scratch.resize(uncompressed_size + SAFE_SPACE, 0);
    decompress_into_padded(src, scratch, uncompressed_size)?;
    Ok(&scratch[..uncompressed_size])
}

/// Shared FFI core. `dst` must be at least
/// `uncompressed_size + SAFE_SPACE` long (both public entry points
/// guarantee this by construction).
fn decompress_into_padded(
    src: &[u8],
    dst: &mut [u8],
    uncompressed_size: usize,
) -> Result<usize, OozError> {
    assert!(dst.len() >= uncompressed_size + SAFE_SPACE);
    let src_len =
        c_int::try_from(src.len()).map_err(|_| OozError::SourceTooLarge { len: src.len() })?;
    // SAFETY: `src` is a live slice for the duration of the call; ooz
    // only reads `src_len` bytes from it. `dst` has `uncompressed_size
    // + SAFE_SPACE` writable bytes (asserted above), covering both the
    // declared output and the documented out-of-bounds scribble area.
    // All pointer/context tail parameters are documented as unused by
    // the ooz implementation and passed as null/zero.
    let status = unsafe {
        Ooz_Decompress(
            src.as_ptr(),
            src_len,
            dst.as_mut_ptr(),
            uncompressed_size,
            0,
            0,
            0,
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            0,
            0,
        )
    };
    if status < 0 {
        return Err(OozError::DecodeFailed { code: status });
    }
    let got = status as usize;
    if got != uncompressed_size {
        return Err(OozError::SizeMismatch {
            expected: uncompressed_size,
            got,
        });
    }
    Ok(got)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ooz CLI container: u64 LE uncompressed size (older files: u32),
    /// then the raw Oodle stream. Mirrors the autodetect in
    /// vendor/kraken.cpp's main().
    fn split_testfile(data: &[u8]) -> (usize, &[u8]) {
        let first = u64::from_le_bytes(data[..8].try_into().unwrap());
        if first >= 0x100_0000_0000 {
            let size = u32::from_le_bytes(data[..4].try_into().unwrap());
            (size as usize, &data[4..])
        } else {
            (first as usize, &data[8..])
        }
    }

    /// Cross-codec known-answer test against the ooz corpus (the same
    /// input compressed as Kraken, Mermaid, and Leviathan must decode
    /// to identical bytes). The corpus is ~3 MiB per file so it is not
    /// vendored; point OOZ_SYS_TESTDATA at a checkout of
    /// https://github.com/powzix/ooz `testdata/` to enable.
    #[test]
    fn cross_codec_corpus() {
        let Ok(dir) = std::env::var("OOZ_SYS_TESTDATA") else {
            eprintln!("skipped: set OOZ_SYS_TESTDATA to the ooz testdata dir");
            return;
        };
        let mut outputs = Vec::new();
        for codec in ["kraken", "mermaid", "leviathan"] {
            let raw = std::fs::read(format!("{dir}/dickens.{codec}")).unwrap();
            let (size, stream) = split_testfile(&raw);
            let out = decompress(stream, size).unwrap_or_else(|e| panic!("dickens.{codec}: {e}"));
            assert_eq!(out.len(), size, "dickens.{codec}");
            outputs.push(out);
        }
        assert_eq!(outputs[0], outputs[1], "kraken vs mermaid disagree");
        assert_eq!(outputs[0], outputs[2], "kraken vs leviathan disagree");
        // dickens is English prose — sanity-check we produced text, not
        // plausible-length garbage.
        let sample = &outputs[0][..4096.min(outputs[0].len())];
        let ascii = sample
            .iter()
            .filter(|b| b.is_ascii_graphic() || b.is_ascii_whitespace())
            .count();
        assert!(
            ascii * 10 > sample.len() * 9,
            "output does not look like text"
        );
    }

    #[test]
    fn rejects_garbage() {
        let garbage = vec![0xA5u8; 1024];
        assert!(decompress(&garbage, 4096).is_err());
    }
}
