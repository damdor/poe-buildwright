//! Bundle file header parsing — no decompression yet.
//!
//! A PoE2 `*.bundle.bin` file (the `_.index.bin` is itself one) starts
//! with a small fixed header, followed by a head-payload that lists
//! per-block compressed sizes, followed by the compressed block
//! payload itself. The format was reverse-engineered by the community
//! over the PoE1 bundle-migration era; LibGGPK2 is the canonical
//! reference.
//!
//! ```text
//! offset  size  field
//! 0x00    u32   uncompressed_size_low      // also duplicated at 0x14 as u64
//! 0x04    u32   total_payload_size_low     // also duplicated at 0x1c as u64
//! 0x08    u32   head_payload_size          // remaining header bytes after 0x0c
//! 0x0c    u32   first_file_encode          // Oodle compressor id (8=Kraken, 9=Mermaid, 13=Leviathan)
//! 0x10    u32   unk10
//! 0x14    u64   uncompressed_size          // total uncompressed payload
//! 0x1c    u64   total_payload_size         // total compressed payload (sum of block_sizes)
//! 0x24    u32   block_count
//! 0x28    u32   uncompressed_block_granularity   // typically 0x40000 (256 KiB)
//! 0x2c    u32[4] reserved_zeros
//! 0x3c    u32[block_count]  block_sizes
//! ...     bytes[total_payload_size]  blocks_payload
//! ```
//!
//! Every block except the last decompresses to exactly
//! `uncompressed_block_granularity` bytes. The last block decompresses
//! to `uncompressed_size - granularity*(block_count-1)`.

use std::fs::File;
use std::io::{self, Read, Seek};
use std::path::Path;

/// Oodle compressor ids as used in a bundle's `first_file_encode`.
///
/// Values are stable Oodle constants (also documented in powzix/ooz).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Compressor {
    Lzh,
    Lzhlw,
    Lznib,
    None,
    Lzb16,
    Lzblw,
    Lza,
    Lzna,
    Kraken,
    Mermaid,
    Bitknit,
    Selkie,
    Hydra,
    Leviathan,
    Unknown(u32),
}

impl Compressor {
    pub fn from_u32(value: u32) -> Self {
        match value {
            0 => Self::Lzh,
            1 => Self::Lzhlw,
            2 => Self::Lznib,
            3 => Self::None,
            4 => Self::Lzb16,
            5 => Self::Lzblw,
            6 => Self::Lza,
            7 => Self::Lzna,
            8 => Self::Kraken,
            9 => Self::Mermaid,
            10 => Self::Bitknit,
            11 => Self::Selkie,
            12 => Self::Hydra,
            13 => Self::Leviathan,
            other => Self::Unknown(other),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Lzh => "LZH",
            Self::Lzhlw => "LZHLW",
            Self::Lznib => "LZNIB",
            Self::None => "None",
            Self::Lzb16 => "LZB16",
            Self::Lzblw => "LZBLW",
            Self::Lza => "LZA",
            Self::Lzna => "LZNA",
            Self::Kraken => "Kraken",
            Self::Mermaid => "Mermaid",
            Self::Bitknit => "BitKnit",
            Self::Selkie => "Selkie",
            Self::Hydra => "Hydra",
            Self::Leviathan => "Leviathan",
            Self::Unknown(_) => "Unknown",
        }
    }
}

/// Parsed bundle header. Everything except the actual block payload.
#[derive(Debug, Clone)]
pub struct BundleHeader {
    pub uncompressed_size: u64,
    pub total_payload_size: u64,
    pub head_payload_size: u32,
    pub compressor: Compressor,
    pub unk10: u32,
    pub block_count: u32,
    pub uncompressed_block_granularity: u32,
    pub block_sizes: Vec<u32>,
    /// Absolute byte offset (from start of file) of the first compressed block.
    pub block_payload_offset: u64,
}

impl BundleHeader {
    /// Size of all bytes preceding the block payload.
    pub fn header_bytes(&self) -> u64 {
        // 12 fixed bytes (uncompressed_size_low, total_payload_size_low,
        // head_payload_size) + head_payload_size bytes.
        12 + u64::from(self.head_payload_size)
    }

    /// The decompressed size of block `i` (0-based). Every block decompresses
    /// to `granularity` bytes except the last, which gets whatever remainder
    /// is left to reach `uncompressed_size`.
    pub fn block_uncompressed_size(&self, i: usize) -> u64 {
        if i + 1 < self.block_count as usize {
            u64::from(self.uncompressed_block_granularity)
        } else if self.block_count == 0 {
            0
        } else {
            let g = u64::from(self.uncompressed_block_granularity);
            self.uncompressed_size - g * (u64::from(self.block_count) - 1)
        }
    }
}

#[derive(Debug)]
pub enum BundleError {
    Io(io::Error),
    Truncated {
        at: &'static str,
    },
    HeadPayloadMismatch {
        declared: u32,
        expected: u32,
    },
    SizeMismatch {
        low: u32,
        full: u64,
        field: &'static str,
    },
}

impl From<io::Error> for BundleError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

impl std::fmt::Display for BundleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "i/o: {e}"),
            Self::Truncated { at } => write!(f, "bundle truncated while reading {at}"),
            Self::HeadPayloadMismatch { declared, expected } => write!(
                f,
                "head_payload_size {declared} disagrees with derived size {expected} \
                 (48 + 4*block_count)",
            ),
            Self::SizeMismatch { low, full, field } => write!(
                f,
                "{field}: low u32 ({low}) disagrees with full u64 ({full})",
            ),
        }
    }
}

impl std::error::Error for BundleError {}

/// Parse just the header of a bundle file. Does NOT read the block payload.
pub fn read_header<P: AsRef<Path>>(path: P) -> Result<BundleHeader, BundleError> {
    let mut f = File::open(path.as_ref())?;
    read_header_from(&mut f)
}

fn read_u32_le<R: Read>(r: &mut R, at: &'static str) -> Result<u32, BundleError> {
    let mut buf = [0u8; 4];
    r.read_exact(&mut buf)
        .map_err(|_| BundleError::Truncated { at })?;
    Ok(u32::from_le_bytes(buf))
}

fn read_u64_le<R: Read>(r: &mut R, at: &'static str) -> Result<u64, BundleError> {
    let mut buf = [0u8; 8];
    r.read_exact(&mut buf)
        .map_err(|_| BundleError::Truncated { at })?;
    Ok(u64::from_le_bytes(buf))
}

pub fn read_header_from<R: Read + Seek>(r: &mut R) -> Result<BundleHeader, BundleError> {
    let uncompressed_size_low = read_u32_le(r, "uncompressed_size_low")?;
    let total_payload_size_low = read_u32_le(r, "total_payload_size_low")?;
    let head_payload_size = read_u32_le(r, "head_payload_size")?;
    let first_file_encode = read_u32_le(r, "first_file_encode")?;
    let unk10 = read_u32_le(r, "unk10")?;
    let uncompressed_size = read_u64_le(r, "uncompressed_size")?;
    let total_payload_size = read_u64_le(r, "total_payload_size")?;
    let block_count = read_u32_le(r, "block_count")?;
    let granularity = read_u32_le(r, "uncompressed_block_granularity")?;
    for i in 0..4 {
        // Reserved zeros — read but don't enforce: GGG could put telemetry
        // bits in here later without breaking older readers.
        let _ = read_u32_le(r, "reserved_zeros[i]")?;
        let _ = i;
    }

    // Cross-check: the low-half u32 fields should equal the low 32 bits of
    // the full u64 fields. If not, the file isn't a bundle (or we mis-parsed).
    let low_matches_full = u64::from(uncompressed_size_low) == uncompressed_size & 0xFFFF_FFFF;
    if !low_matches_full {
        return Err(BundleError::SizeMismatch {
            low: uncompressed_size_low,
            full: uncompressed_size,
            field: "uncompressed_size",
        });
    }
    let payload_low_matches = u64::from(total_payload_size_low) == total_payload_size & 0xFFFF_FFFF;
    if !payload_low_matches {
        return Err(BundleError::SizeMismatch {
            low: total_payload_size_low,
            full: total_payload_size,
            field: "total_payload_size",
        });
    }

    // head_payload_size includes everything from first_file_encode through
    // the end of block_sizes[]. That's 4+4+8+8+4+4 + 16 (reserved) + 4*block_count
    // = 48 + 4*block_count bytes.
    let expected_head = 48u32.saturating_add(block_count.saturating_mul(4));
    if head_payload_size != expected_head {
        return Err(BundleError::HeadPayloadMismatch {
            declared: head_payload_size,
            expected: expected_head,
        });
    }

    let mut block_sizes = Vec::with_capacity(block_count as usize);
    for _ in 0..block_count {
        block_sizes.push(read_u32_le(r, "block_sizes")?);
    }

    let block_payload_offset = r.stream_position()?;

    Ok(BundleHeader {
        uncompressed_size,
        total_payload_size,
        head_payload_size,
        compressor: Compressor::from_u32(first_file_encode),
        unk10,
        block_count,
        uncompressed_block_granularity: granularity,
        block_sizes,
        block_payload_offset,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// Minimal synthetic header: 0 blocks, "None" compressor. Lets us
    /// exercise the parser without needing a real bundle file.
    #[test]
    fn empty_bundle_roundtrips() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0u32.to_le_bytes()); // uncompressed_size_low
        bytes.extend_from_slice(&0u32.to_le_bytes()); // total_payload_size_low
        bytes.extend_from_slice(&48u32.to_le_bytes()); // head_payload_size = 48 + 4*0
        bytes.extend_from_slice(&3u32.to_le_bytes()); // first_file_encode = None
        bytes.extend_from_slice(&0u32.to_le_bytes()); // unk10
        bytes.extend_from_slice(&0u64.to_le_bytes()); // uncompressed_size
        bytes.extend_from_slice(&0u64.to_le_bytes()); // total_payload_size
        bytes.extend_from_slice(&0u32.to_le_bytes()); // block_count
        bytes.extend_from_slice(&0x40000u32.to_le_bytes()); // granularity
        for _ in 0..4 {
            bytes.extend_from_slice(&0u32.to_le_bytes());
        }
        let mut cur = Cursor::new(&bytes);
        let h = read_header_from(&mut cur).expect("parse");
        assert_eq!(h.compressor, Compressor::None);
        assert_eq!(h.block_count, 0);
        assert_eq!(h.block_sizes.len(), 0);
        assert_eq!(h.block_payload_offset, bytes.len() as u64);
    }
}
