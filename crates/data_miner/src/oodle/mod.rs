//! Oodle decompression for the four compressor families used by PoE2
//! bundles: Kraken, Mermaid, Hydra (a per-block dispatcher between the
//! others), and Leviathan.
//!
//! ## Why Oodle at all
//!
//! Every byte we need from a PoE2 bundle goes through Oodle. There is
//! no LZ4 escape hatch in this format; the entire compressed payload
//! is one of these four variants (see `crates/data_miner/src/bundle.rs`
//! for the per-block compressor id). GGG does not ship an `oo2core.dll`
//! we could load — Oodle is statically linked into the game binary.
//!
//! ## Backend: vendored ooz (`ooz_sys`)
//!
//! Decoding is delegated to the `ooz_sys` crate, which vendors the
//! community-standard C++ decoder (zao/ooz). Its entry point
//! self-dispatches between all Oodle LZ variants by reading the
//! per-quantum header bytes, so one call covers Kraken, Mermaid,
//! Hydra, and Leviathan alike. Note ooz is GPL-3.0 — see
//! `crates/ooz_sys/VENDOR.md` for what that implies (in short: never
//! distribute miner binaries).
//!
//! An in-progress pure-Rust port lives in the sibling modules behind
//! the `oodle-port` cargo feature (off by default). It is
//! development-only: even with the feature on, dispatch still goes
//! through ooz — the port graduates by first passing differential
//! tests against ooz output on real bundles.
//!
//! ## Block payload entry point
//!
//! From the bundle header we know `compressor`, `block_count`,
//! `uncompressed_block_granularity`, and `block_sizes[i]`. For each
//! block we slice `block_sizes[i]` compressed bytes from the payload
//! and call [`decompress_block`] with the bundle-level compressor.
//! It dispatches to the decoder and returns exactly
//! `expected_uncompressed_size` bytes.

#[cfg(feature = "oodle-port")]
mod bitreader;
// dead_code: the port's decode() entry points are unreachable from
// dispatch by design until they pass differential tests against ooz.
#[cfg(feature = "oodle-port")]
#[allow(dead_code)]
mod hydra;
#[cfg(feature = "oodle-port")]
#[allow(dead_code)]
mod kraken;
#[cfg(feature = "oodle-port")]
#[allow(dead_code)]
mod leviathan;
#[cfg(feature = "oodle-port")]
#[allow(dead_code)]
mod mermaid;

#[cfg(feature = "oodle-port")]
pub use bitreader::BitReader;

use std::cell::RefCell;

use crate::bundle::Compressor;

/// Errors emitted by the Oodle decoders.
///
/// Every variant is fatal — there is no graceful recovery inside an
/// Oodle block. Callers should bail on the entire bundle if any block
/// fails (a partial decode would shift every subsequent block's offset
/// and silently corrupt downstream data).
#[derive(Debug, Clone)]
pub enum OodleError {
    /// The block header byte / mode bits don't match any decoder we
    /// recognise. Most likely a truncated block, a different compressor,
    /// or a future Oodle variant.
    UnsupportedMode { compressor: Compressor, mode: u8 },
    /// The block header asked us to write more bytes than the caller
    /// reserved (or fewer than the bundle's granularity demands).
    SizeMismatch { expected: usize, declared: usize },
    /// A bitstream / table read consumed more compressed bytes than
    /// the block actually contains.
    Truncated { at: &'static str },
    /// A compressor variant we plan to support but haven't ported yet.
    /// Distinguished from `UnsupportedMode` so the survey CLI can
    /// estimate coverage as we ship per-compressor decoders.
    NotYetImplemented { compressor: Compressor },
    /// The ooz backend rejected the block.
    Backend {
        compressor: Compressor,
        err: ooz_sys::OozError,
    },
}

impl std::fmt::Display for OodleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedMode { compressor, mode } => write!(
                f,
                "oodle: unsupported block mode 0x{mode:02x} for {}",
                compressor.name(),
            ),
            Self::SizeMismatch { expected, declared } => write!(
                f,
                "oodle: block declared {declared} bytes but caller expected {expected}",
            ),
            Self::Truncated { at } => write!(f, "oodle: bitstream truncated reading {at}"),
            Self::NotYetImplemented { compressor } => write!(
                f,
                "oodle: {} decoder not yet implemented — see docs/native-data-miner.md",
                compressor.name(),
            ),
            Self::Backend { compressor, err } => {
                write!(f, "oodle: {} block: {err}", compressor.name())
            }
        }
    }
}

impl std::error::Error for OodleError {}

/// Decompress one bundle block. `src` is exactly `block_sizes[i]`
/// bytes; `expected_uncompressed_size` is the size the bundle header
/// says this block must produce (every block but the last is exactly
/// the bundle's `uncompressed_block_granularity`, e.g. 256 KiB).
pub fn decompress_block(
    compressor: Compressor,
    src: &[u8],
    expected_uncompressed_size: usize,
) -> Result<Vec<u8>, OodleError> {
    let mut out = vec![0u8; expected_uncompressed_size];
    decompress_block_into(compressor, src, &mut out)?;
    Ok(out)
}

/// As [`decompress_block`] but writes into a caller-owned buffer. The
/// buffer length is taken as the expected uncompressed size; the
/// caller is responsible for sizing it correctly from
/// [`crate::bundle::BundleHeader::block_uncompressed_size`].
pub fn decompress_block_into(
    compressor: Compressor,
    src: &[u8],
    dst: &mut [u8],
) -> Result<(), OodleError> {
    match compressor {
        Compressor::Kraken | Compressor::Mermaid | Compressor::Hydra | Compressor::Leviathan => {
            // ooz needs SAFE_SPACE slack bytes past the declared output,
            // so we can't hand it `dst` directly. Decode into a
            // thread-local scratch buffer (reused across the thousands
            // of blocks in a bundle) and copy the valid prefix out.
            SCRATCH.with_borrow_mut(|scratch| {
                let out = ooz_sys::decompress_with_scratch(src, dst.len(), scratch)
                    .map_err(|err| OodleError::Backend { compressor, err })?;
                dst.copy_from_slice(out);
                Ok(())
            })
        }
        // Selkie and the legacy LZ* compressors don't appear in any
        // PoE2 0.5 bundle in our survey (60,051 bundles, zero hits).
        // We intentionally don't implement them — if a future patch
        // adds one we'll learn through the survey CLI surfacing it.
        other => Err(OodleError::UnsupportedMode {
            compressor: other,
            mode: 0,
        }),
    }
}

thread_local! {
    static SCRATCH: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}
