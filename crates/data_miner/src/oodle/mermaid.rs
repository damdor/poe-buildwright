//! Mermaid decoder.
//!
//! Status: stub. Ported from ooz `kraken.cpp` (`Mermaid_DecodeStep`,
//! `Mermaid_DecodeFarOffsets`, `Mermaid_DecodeQuantum`). Mermaid
//! shares the bundle-block envelope with Kraken; the LZ77 inner
//! loop differs in offset encoding and literal-stream handling.

use super::OodleError;

pub(super) fn decode(_src: &[u8], _dst: &mut [u8]) -> Result<(), OodleError> {
    Err(OodleError::NotYetImplemented {
        compressor: crate::bundle::Compressor::Mermaid,
    })
}
