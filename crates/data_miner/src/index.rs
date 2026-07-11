//! Parser for `Bundles2/_.index.bin` — the master index mapping every
//! virtual game-file path to (bundle, offset, size).
//!
//! ## Format (reverse-engineered; reference: zao/ooz `bun.cpp`)
//!
//! The file on disk is itself a standard bundle (decompress with
//! [`crate::bundle_decode`] first). The decompressed payload:
//!
//! ```text
//! u32 bundle_count
//! bundle_count × { u32 name_len, name (UTF-8, no ".bundle.bin"),
//!                  u32 uncompressed_size }
//! u32 file_count
//! file_count × { u64 path_hash, u32 bundle_index,
//!                u32 file_offset, u32 file_size }
//! u32 path_rep_count
//! path_rep_count × { u64 dir_hash, u32 offset, u32 size,
//!                    u32 recursive_size }
//! <remaining bytes: a nested bundle — decompress to the "path
//!  spec" blob that path_rep offsets index into>
//! ```
//!
//! File records carry only a 64-bit hash of the lowercased path; the
//! actual strings are reconstructed from the path-spec blob (see
//! [`generate_paths`]) and matched back to file records by hashing.
//!
//! ## Path hash algorithms
//!
//! GGG switched algorithms over PoE1's lifetime; the index doesn't
//! declare which one it uses, so we detect it the way ooz does, from
//! `path_rep[0].hash` (the root directory, empty path):
//!
//! * `0x07e47507b4a92e53` → FNV-1a variant (PoE1 ≤ 3.21.1): files are
//!   lowercased, directories get `++` appended before hashing.
//! * anything else → seeded MurmurHash64A (PoE1 3.21.2+, all PoE2):
//!   the root hash is `murmur64a("", seed)`, which is just the
//!   finalizer applied to `seed` — so the seed is recovered by
//!   inverting the finalizer, then validated against a real directory
//!   entry.

use std::collections::HashMap;
use std::io::Cursor;

use crate::bundle_decode::{self, DecodeError};

/// One bundle known to the index. `name` is the path under `Bundles2/`
/// without the `.bundle.bin` suffix (e.g. `"Data/Passiveskills"`).
#[derive(Debug, Clone)]
pub struct BundleRecord {
    pub name: String,
    pub uncompressed_size: u32,
}

/// One virtual file: `size` bytes at `offset` into the *decompressed*
/// payload of `bundles[bundle_index]`.
#[derive(Debug, Clone, Copy)]
pub struct FileRecord {
    pub path_hash: u64,
    pub bundle_index: u32,
    pub offset: u32,
    pub size: u32,
}

/// One directory's worth of path-spec data: `size` bytes at `offset`
/// into the decompressed inner path blob.
#[derive(Debug, Clone, Copy)]
pub struct PathRepRecord {
    pub dir_hash: u64,
    pub offset: u32,
    pub size: u32,
    pub recursive_size: u32,
}

/// Which path-hash function this index was built with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathHash {
    /// FNV-1a 64 variant (old PoE1). Kept for completeness — PoE2
    /// indexes should always be Murmur.
    Fnv1a,
    /// Seeded MurmurHash64A; seed recovered from the root-dir hash.
    Murmur { seed: u64 },
}

#[derive(Debug)]
pub enum IndexError {
    /// Ran out of bytes mid-record.
    Truncated { at: &'static str },
    /// A bundle/file record field failed sanity checks (e.g. a file's
    /// `bundle_index` past `bundle_count`).
    Corrupt { what: &'static str },
    /// Bundle name or path fragment isn't valid UTF-8.
    BadString { at: &'static str },
    /// The nested path-spec bundle failed to decompress.
    InnerBundle(DecodeError),
    /// Root hash wasn't FNV and Murmur seed recovery failed validation
    /// against the first directory entry — unknown/changed algorithm.
    UnknownHashAlgorithm { root_hash: u64 },
}

impl std::fmt::Display for IndexError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Truncated { at } => write!(f, "index truncated reading {at}"),
            Self::Corrupt { what } => write!(f, "index corrupt: {what}"),
            Self::BadString { at } => write!(f, "index: invalid UTF-8 in {at}"),
            Self::InnerBundle(e) => write!(f, "index inner path bundle: {e}"),
            Self::UnknownHashAlgorithm { root_hash } => write!(
                f,
                "index root hash {root_hash:#018x} matches no known path-hash algorithm",
            ),
        }
    }
}

impl std::error::Error for IndexError {}

impl From<DecodeError> for IndexError {
    fn from(e: DecodeError) -> Self {
        Self::InnerBundle(e)
    }
}

/// Fully parsed `_.index.bin` payload.
pub struct Index {
    pub bundles: Vec<BundleRecord>,
    pub files: Vec<FileRecord>,
    pub path_reps: Vec<PathRepRecord>,
    /// Decompressed path-spec blob that `path_reps` offsets index into.
    pub path_blob: Vec<u8>,
    /// Byte ranges of `path_blob` that could not be decompressed
    /// (zero-filled). Path reps overlapping these are skipped.
    pub dead_ranges: Vec<std::ops::Range<usize>>,
    pub hash: PathHash,
    by_hash: HashMap<u64, u32>,
}

impl Index {
    /// Parse the *decompressed* payload of `_.index.bin`.
    pub fn parse(payload: &[u8]) -> Result<Self, IndexError> {
        let mut r = Reader(payload);

        let bundle_count = r.u32("bundle_count")?;
        let mut bundles = Vec::with_capacity(bundle_count as usize);
        for _ in 0..bundle_count {
            let name_len = r.u32("bundle name_len")?;
            let name = r.bytes(name_len as usize, "bundle name")?;
            // Lossy, not strict: patch 4.5.4.3 ships a bundle whose
            // NAME contains a raw 0xCC byte (an art bundle,
            // ".../bloodbathers/bloodbathe\xCC.f..." — a typo'd
            // filename on GGG's side). One bad art-bundle name must
            // not brick the whole index; the replacement char only
            // breaks fetching THAT bundle, which the data pipeline
            // never requests.
            let name = String::from_utf8_lossy(name).into_owned();
            let uncompressed_size = r.u32("bundle uncompressed_size")?;
            bundles.push(BundleRecord {
                name,
                uncompressed_size,
            });
        }

        let file_count = r.u32("file_count")?;
        let mut files = Vec::with_capacity(file_count as usize);
        let mut by_hash = HashMap::with_capacity(file_count as usize);
        for i in 0..file_count {
            let rec = FileRecord {
                path_hash: r.u64("file path_hash")?,
                bundle_index: r.u32("file bundle_index")?,
                offset: r.u32("file offset")?,
                size: r.u32("file size")?,
            };
            if rec.bundle_index >= bundle_count {
                return Err(IndexError::Corrupt {
                    what: "file bundle_index out of range",
                });
            }
            by_hash.insert(rec.path_hash, i);
            files.push(rec);
        }

        let rep_count = r.u32("path_rep_count")?;
        let mut path_reps = Vec::with_capacity(rep_count as usize);
        for _ in 0..rep_count {
            path_reps.push(PathRepRecord {
                dir_hash: r.u64("path_rep hash")?,
                offset: r.u32("path_rep offset")?,
                size: r.u32("path_rep size")?,
                recursive_size: r.u32("path_rep recursive_size")?,
            });
        }

        // Everything left is a nested bundle holding the path specs.
        // Decoded TOLERANTLY as a safety net: under the old ooz
        // backend, patch 4.5.4.3 had blocks that failed outright
        // (the official decoder handles them, but a future format
        // bump could regress). Path reps that overlap a dead
        // (zero-filled) range are dropped in resolve_paths with a
        // stderr note — losing some art paths must not brick the
        // data pipeline.
        let mut cursor = Cursor::new(r.0);
        let (path_blob, dead_ranges) = bundle_decode::decompress_full_tolerant(&mut cursor)?;
        if !dead_ranges.is_empty() {
            eprintln!(
                "index: {} path-blob block(s) undecodable; affected path entries will be skipped",
                dead_ranges.len()
            );
        }

        let hash = detect_hash(&path_reps, &path_blob)?;

        Ok(Self {
            bundles,
            files,
            path_reps,
            path_blob,
            dead_ranges,
            hash,
            by_hash,
        })
    }

    /// Hash a virtual path (e.g. `"Data/PassiveSkills.dat64"`) the way
    /// this index does and look it up. Case-insensitive by
    /// construction — paths are lowercased before hashing.
    pub fn lookup(&self, path: &str) -> Option<&FileRecord> {
        let idx = *self.by_hash.get(&self.hash_file_path(path))?;
        self.files.get(idx as usize)
    }

    fn hash_file_path(&self, path: &str) -> u64 {
        let trimmed = path.trim_end_matches('/');
        let lower = trimmed.to_ascii_lowercase();
        match self.hash {
            PathHash::Murmur { seed } => murmur64a(lower.as_bytes(), seed),
            PathHash::Fnv1a => fnv1a64(lower.as_bytes()),
        }
    }

    /// Reconstruct every (path, file record index) pair by expanding
    /// each directory's path spec and hashing the results back onto
    /// the file table. Paths whose hash matches no file record are
    /// skipped (directories hash into `path_reps`, not `files`).
    pub fn resolve_paths(&self) -> Result<Vec<(String, u32)>, IndexError> {
        let mut out = Vec::with_capacity(self.files.len());
        let mut skipped = 0usize;
        for rep in &self.path_reps {
            let start = rep.offset as usize;
            let end = start + rep.size as usize;
            // Path specs whose bytes fell in an undecodable block are
            // zero-filled garbage — skip them rather than parse junk.
            if self.dead_ranges.iter().any(|r| start < r.end && end > r.start) {
                skipped += 1;
                continue;
            }
            let spec = self.path_blob.get(start..end).ok_or(IndexError::Corrupt {
                what: "path_rep range outside path blob",
            })?;
            // A malformed spec (e.g. adjacent to zero-filled damage)
            // skips that directory, not the whole index.
            let Ok(paths) = generate_paths(spec) else {
                skipped += 1;
                continue;
            };
            for path in paths {
                if let Some(&file_idx) = self.by_hash.get(&self.hash_file_path(&path)) {
                    out.push((path, file_idx));
                }
            }
        }
        if skipped > 0 {
            eprintln!("index: skipped {skipped} path spec(s) in/near undecodable blocks");
        }
        Ok(out)
    }
}

/// Expand one directory's path-spec blob into full path strings.
///
/// Alternating-phase machine (doc comment in zao/ooz `path_rep.cpp`):
/// u32 command words followed by NUL-terminated UTF-8 fragments. A
/// zero word toggles between the *base* phase (build up a table of
/// prefix strings) and the *generation* phase (emit prefix+fragment
/// concatenations). Commands are 1-based references into the base
/// table; a reference past the table means "use the fragment as-is".
pub fn generate_paths(spec: &[u8]) -> Result<Vec<String>, IndexError> {
    let mut r = Reader(spec);
    let mut base_phase = false;
    let mut bases: Vec<String> = Vec::new();
    let mut results = Vec::new();

    while !r.0.is_empty() {
        let cmd = r.u32("path spec command")?;
        if cmd == 0 {
            base_phase = !base_phase;
            if base_phase {
                bases.clear();
            }
            continue;
        }
        let fragment = r.cstr("path spec fragment")?;
        let index = (cmd - 1) as usize;
        let full = match bases.get(index) {
            Some(base) => {
                let mut s = String::with_capacity(base.len() + fragment.len());
                s.push_str(base);
                s.push_str(fragment);
                s
            }
            None => fragment.to_string(),
        };
        if base_phase {
            bases.push(full);
        } else {
            results.push(full);
        }
    }
    Ok(results)
}

/// Identify the hash algorithm from the root-directory hash, following
/// ooz: a fixed constant means FNV; otherwise invert the Murmur
/// finalizer to recover the seed and validate it against the first
/// directory entry that yields a path.
fn detect_hash(path_reps: &[PathRepRecord], blob: &[u8]) -> Result<PathHash, IndexError> {
    const FNV_ROOT: u64 = 0x07e4_7507_b4a9_2e53;
    let Some(root) = path_reps.first() else {
        // Empty index — algorithm is irrelevant; pick the modern one.
        return Ok(PathHash::Murmur { seed: 0 });
    };
    if root.dir_hash == FNV_ROOT {
        return Ok(PathHash::Fnv1a);
    }
    let seed = invert_murmur_finalizer(root.dir_hash);
    // Validate: find a directory entry, hash its parent dir with the
    // recovered seed, compare to the recorded dir_hash.
    for rep in &path_reps[1..] {
        let start = rep.offset as usize;
        let end = start + rep.size as usize;
        let Some(spec) = blob.get(start..end) else {
            continue;
        };
        let Ok(paths) = generate_paths(spec) else {
            continue;
        };
        let Some(first) = paths.first() else {
            continue;
        };
        let Some(slash) = first.rfind('/') else {
            continue;
        };
        let dir = first[..slash].to_ascii_lowercase();
        return if murmur64a(dir.as_bytes(), seed) == rep.dir_hash {
            Ok(PathHash::Murmur { seed })
        } else {
            Err(IndexError::UnknownHashAlgorithm {
                root_hash: root.dir_hash,
            })
        };
    }
    // No directory entry to validate against; trust the recovery.
    Ok(PathHash::Murmur { seed })
}

/// MurmurHash64A (the classic 64-bit Murmur2, as used by GGG).
/// Straight port of `murmur_hash_64a` in zao/ooz `murmur.cpp`.
pub fn murmur64a(key: &[u8], seed: u64) -> u64 {
    const M: u64 = 0xc6a4_a793_5bd1_e995;
    const R: u32 = 47;

    let mut h = seed ^ (key.len() as u64).wrapping_mul(M);

    let mut chunks = key.chunks_exact(8);
    for chunk in &mut chunks {
        let mut k = u64::from_le_bytes(chunk.try_into().expect("8-byte chunk"));
        k = k.wrapping_mul(M);
        k ^= k >> R;
        k = k.wrapping_mul(M);
        h ^= k;
        h = h.wrapping_mul(M);
    }

    let tail = chunks.remainder();
    if !tail.is_empty() {
        let mut t = 0u64;
        for (i, &b) in tail.iter().enumerate() {
            t |= u64::from(b) << (8 * i);
        }
        h ^= t;
        h = h.wrapping_mul(M);
    }

    h ^= h >> R;
    h = h.wrapping_mul(M);
    h ^= h >> R;
    h
}

/// Invert the Murmur finalizer. `murmur64a("", seed)` is just the
/// finalizer applied to `seed` (`len = 0` contributes nothing), so
/// applying the inverse to the root-dir hash yields the seed.
/// `x ^= x >> 47` is self-inverse (47 ≥ 32); the constant is the
/// modular inverse of the Murmur multiplier mod 2⁶⁴.
fn invert_murmur_finalizer(hash: u64) -> u64 {
    const M_INV: u64 = 0x5f7a_0ea7_e59b_19bd;
    let mut h = hash;
    h ^= h >> 47;
    h = h.wrapping_mul(M_INV);
    h ^= h >> 47;
    h
}

/// FNV-1a 64 over raw bytes (old PoE1 path hash; see module docs for
/// the file/dir normalization quirks, applied by callers).
pub fn fnv1a64(data: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in data {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Bounds-checked little-endian reader over a byte slice.
struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn bytes(&mut self, n: usize, at: &'static str) -> Result<&'a [u8], IndexError> {
        if self.0.len() < n {
            return Err(IndexError::Truncated { at });
        }
        let (head, rest) = self.0.split_at(n);
        self.0 = rest;
        Ok(head)
    }

    fn u32(&mut self, at: &'static str) -> Result<u32, IndexError> {
        Ok(u32::from_le_bytes(
            self.bytes(4, at)?.try_into().expect("4 bytes"),
        ))
    }

    fn u64(&mut self, at: &'static str) -> Result<u64, IndexError> {
        Ok(u64::from_le_bytes(
            self.bytes(8, at)?.try_into().expect("8 bytes"),
        ))
    }

    fn cstr(&mut self, at: &'static str) -> Result<&'a str, IndexError> {
        let nul = self
            .0
            .iter()
            .position(|&b| b == 0)
            .ok_or(IndexError::Truncated { at })?;
        let (s, rest) = self.0.split_at(nul);
        self.0 = &rest[1..]; // skip the NUL
        std::str::from_utf8(s).map_err(|_| IndexError::BadString { at })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Vectors generated from the C reference implementation
    /// (murmur_hash_64a in zao/ooz murmur.cpp) compiled and run
    /// locally — see docs/native-data-miner.md validation notes.
    #[test]
    fn murmur64a_known_answers() {
        assert_eq!(
            murmur64a(b"art/2dart/atlas/atlas.dds", 0x1234_5678),
            0x1905_ba50_787a_6d50,
        );
        assert_eq!(
            murmur64a(b"metadata/statdescriptions", 0),
            0x6055_be1e_42a3_b56c,
        );
        assert_eq!(murmur64a(b"", 0xDEAD_BEEF_CAFE_F00D), 0x07fa_5ea1_3931_46fa);
    }

    #[test]
    fn fnv1a64_known_answers() {
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64(b"a"), 0xaf63_dc4c_8601_ec8c);
    }

    #[test]
    fn murmur_seed_recovery_roundtrips() {
        for seed in [0u64, 1, 0x1234_5678, u64::MAX, 0x07fa_5ea1_3931_46fa] {
            let root_hash = murmur64a(b"", seed);
            assert_eq!(invert_murmur_finalizer(root_hash), seed);
        }
    }

    /// Hand-assembled path spec: base phase installs "Art/", the
    /// generation phase emits two files under it plus one standalone.
    #[test]
    fn generate_paths_expands_bases() {
        let mut spec = Vec::new();
        let word = |v: u32| v.to_le_bytes();
        spec.extend_from_slice(&word(0)); // -> base phase
        spec.extend_from_slice(&word(1)); // new base (no back-ref)
        spec.extend_from_slice(b"Art/\0");
        spec.extend_from_slice(&word(0)); // -> generation phase
        spec.extend_from_slice(&word(1)); // bases[0] + fragment
        spec.extend_from_slice(b"a.dds\0");
        spec.extend_from_slice(&word(1)); // bases[0] + fragment
        spec.extend_from_slice(b"b.dds\0");
        spec.extend_from_slice(&word(9)); // past table -> standalone
        spec.extend_from_slice(b"root.txt\0");

        let paths = generate_paths(&spec).expect("parse");
        assert_eq!(paths, vec!["Art/a.dds", "Art/b.dds", "root.txt"]);
    }

    #[test]
    fn generate_paths_base_reset_on_reentry() {
        let mut spec = Vec::new();
        let word = |v: u32| v.to_le_bytes();
        // First template block.
        spec.extend_from_slice(&word(0));
        spec.extend_from_slice(&word(1));
        spec.extend_from_slice(b"Old/\0");
        spec.extend_from_slice(&word(0));
        spec.extend_from_slice(&word(1));
        spec.extend_from_slice(b"x\0");
        // Re-entering base phase clears the table.
        spec.extend_from_slice(&word(0));
        spec.extend_from_slice(&word(1));
        spec.extend_from_slice(b"New/\0");
        spec.extend_from_slice(&word(0));
        spec.extend_from_slice(&word(1));
        spec.extend_from_slice(b"y\0");

        let paths = generate_paths(&spec).expect("parse");
        assert_eq!(paths, vec!["Old/x", "New/y"]);
    }
}
