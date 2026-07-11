//! Block-level orchestration on top of [`crate::bundle`].
//!
//! [`crate::bundle::read_header`] gives us the per-bundle metadata
//! (compressor, block sizes, granularity). This module reads the
//! compressed block payload, slices it into per-block byte ranges,
//! and dispatches each through [`crate::oodle::decompress_block`].
//!
//! End-state goal: `extract_file(bundle_path, &[(file_offset,
//! file_size)])` walks the minimum set of blocks needed to materialise
//! those byte ranges, decompresses them, and stitches the result.
//! Until the Oodle decoders land we expose [`decompress_full`]: read
//! every block and return the entire bundle's uncompressed payload.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

use crate::bundle::{self, BundleError, BundleHeader};
use crate::oodle::{self, OodleError};

#[derive(Debug)]
pub enum DecodeError {
    Bundle(BundleError),
    Io(io::Error),
    Oodle { block_index: usize, err: OodleError },
}

impl From<BundleError> for DecodeError {
    fn from(e: BundleError) -> Self {
        Self::Bundle(e)
    }
}

impl From<io::Error> for DecodeError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Bundle(e) => write!(f, "{e}"),
            Self::Io(e) => write!(f, "i/o: {e}"),
            Self::Oodle { block_index, err } => write!(f, "block {block_index}: {err}"),
        }
    }
}

impl std::error::Error for DecodeError {}

/// Decompress every block of a bundle in order. Returns the full
/// uncompressed payload (size = `header.uncompressed_size`).
///
/// Heavyweight — a single Tiny.V0 bundle is ~210 MiB uncompressed.
/// Useful as a smoke test for the decoders and for the index bundle
/// (147 MiB; manageable in RAM). Per-file random access lands later
/// behind a different entry point.
pub fn decompress_full<P: AsRef<Path>>(path: P) -> Result<Vec<u8>, DecodeError> {
    let mut f = File::open(path.as_ref())?;
    decompress_full_from(&mut f)
}

/// As [`decompress_full`] but over any seekable source — used for
/// nested bundles that live inside another decompressed payload
/// (e.g. the path-spec bundle at the tail of `_.index.bin`), via
/// `std::io::Cursor`.
pub fn decompress_full_from<R: Read + Seek>(f: &mut R) -> Result<Vec<u8>, DecodeError> {
    let header = bundle::read_header_from(f)?;
    f.seek(SeekFrom::Start(header.block_payload_offset))?;

    let mut out = Vec::with_capacity(header.uncompressed_size as usize);
    let mut block_src = Vec::new();
    for (i, &compressed_size) in header.block_sizes.iter().enumerate() {
        block_src.resize(compressed_size as usize, 0);
        f.read_exact(&mut block_src)?;
        let expected = header.block_uncompressed_size(i) as usize;
        let prev_len = out.len();
        out.resize(prev_len + expected, 0);
        let dst = &mut out[prev_len..];
        oodle::decompress_block_into(header.compressor, &block_src, dst).map_err(|err| {
            DecodeError::Oodle {
                block_index: i,
                err,
            }
        })?;
    }
    Ok(out)
}

/// As [`decompress_full_from`] but TOLERANT: a block the decoder
/// rejects is zero-filled instead of failing the whole bundle, and
/// its uncompressed byte range is reported to the caller.
///
/// Exists for the index's inner path bundle: patch 4.5.4.3 ships one
/// block (418 of 475 — streaming-art path territory) that ooz cannot
/// decode (status -1 in every mode: strict, fuzz-safe, and windowed;
/// upstream ooz HEAD as of 2025-10). Losing ~256 KiB of art paths
/// must not brick the data pipeline — the caller drops path entries
/// that overlap dead ranges and errors only if a path it actually
/// needs is affected.
pub fn decompress_full_tolerant<R: Read + Seek>(
    f: &mut R,
) -> Result<(Vec<u8>, Vec<std::ops::Range<usize>>), DecodeError> {
    let header = bundle::read_header_from(f)?;
    f.seek(SeekFrom::Start(header.block_payload_offset))?;

    let mut out = Vec::with_capacity(header.uncompressed_size as usize);
    let mut dead: Vec<std::ops::Range<usize>> = Vec::new();
    let mut block_src = Vec::new();
    for (i, &compressed_size) in header.block_sizes.iter().enumerate() {
        block_src.resize(compressed_size as usize, 0);
        f.read_exact(&mut block_src)?;
        let expected = header.block_uncompressed_size(i) as usize;
        let prev_len = out.len();
        out.resize(prev_len + expected, 0);
        let dst = &mut out[prev_len..];
        if oodle::decompress_block_into(header.compressor, &block_src, dst).is_err() {
            // Leave the range zeroed and remember it.
            dead.push(prev_len..prev_len + expected);
        }
    }
    Ok((out, dead))
}

/// Decompress one block of a bundle in-place. Same as
/// [`decompress_full`] but stops after `block_index`.
pub fn decompress_block_at<P: AsRef<Path>>(
    path: P,
    block_index: usize,
) -> Result<Vec<u8>, DecodeError> {
    let mut f = File::open(path.as_ref())?;
    let header = bundle::read_header_from(&mut f)?;
    if block_index >= header.block_count as usize {
        return Err(DecodeError::Oodle {
            block_index,
            err: OodleError::SizeMismatch {
                expected: header.block_count as usize,
                declared: block_index,
            },
        });
    }
    // Skip blocks 0..block_index by adding up their compressed sizes.
    let skip: u64 = header.block_sizes[..block_index]
        .iter()
        .map(|&s| u64::from(s))
        .sum();
    f.seek(SeekFrom::Start(header.block_payload_offset + skip))?;
    let compressed_size = header.block_sizes[block_index] as usize;
    let mut src = vec![0u8; compressed_size];
    f.read_exact(&mut src)?;
    let expected = header.block_uncompressed_size(block_index) as usize;
    let mut dst = vec![0u8; expected];
    oodle::decompress_block_into(header.compressor, &src, &mut dst)
        .map_err(|err| DecodeError::Oodle { block_index, err })?;
    Ok(dst)
}

/// Convenience: header alone, without reading any block payload.
pub fn header<P: AsRef<Path>>(path: P) -> Result<BundleHeader, DecodeError> {
    Ok(bundle::read_header(path)?)
}
