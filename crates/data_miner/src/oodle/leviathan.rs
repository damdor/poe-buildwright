//! Leviathan decoder.
//!
//! Status: stub. Leviathan is Kraken's successor with richer context
//! modeling for literals (multi-stream literal encoding, longer
//! offset codes). Ported from ooz `kraken.cpp` (`Leviathan_*` —
//! the file is named for Kraken but holds all four decoders).
//!
//! 34.7% of bundles in the 0.5 install use Leviathan, second only to
//! Hydra. The master `_.index.bin` is Hydra (which falls through to
//! Kraken/Mermaid per block), so Leviathan isn't on the critical
//! path for index parsing — but it's required for the rest of the
//! actual game data.

use super::OodleError;

pub(super) fn decode(_src: &[u8], _dst: &mut [u8]) -> Result<(), OodleError> {
    Err(OodleError::NotYetImplemented {
        compressor: crate::bundle::Compressor::Leviathan,
    })
}
