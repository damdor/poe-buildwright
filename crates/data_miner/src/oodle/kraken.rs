//! Kraken decoder.
//!
//! Status: stub — returns [`OodleError::NotYetImplemented`]. The port
//! lives at <https://github.com/powzix/ooz> `kraken.cpp`
//! (`Kraken_DecodeQuantum`, `Kraken_DecodeStep`, and the entropy
//! decoders they call). 137 KB of dense reverse-engineered C++; the
//! port is its own focused work item.
//!
//! Known reachable test vectors in our 0.5 install:
//!
//! ```text
//! _.index.high.bin   74 B on disk, 1 block, 10 B compressed -> 8 B
//! _.index.low.bin    74 B on disk, 1 block, 10 B compressed -> 8 B
//! ```
//!
//! Both look like "small literal" mode encodings (the 10-byte payload
//! ends in 8 zero bytes; the chunk header is likely 2 bytes). Easiest
//! sanity check for a fresh decoder.

use super::OodleError;

pub(super) fn decode(_src: &[u8], _dst: &mut [u8]) -> Result<(), OodleError> {
    Err(OodleError::NotYetImplemented {
        compressor: crate::bundle::Compressor::Kraken,
    })
}
