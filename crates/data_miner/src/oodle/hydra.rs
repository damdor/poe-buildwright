//! Hydra dispatch.
//!
//! Hydra is not a separate compressor — it's a per-block dispatcher
//! between Kraken / Mermaid / Selkie at encode time. The decoder
//! reads the block's mode byte to determine which inner decoder to
//! invoke. In our install, Hydra blocks dispatch to Kraken and
//! Mermaid (we haven't seen a Selkie hit in the 60,051-bundle
//! survey). Implementation parks behind [`super::kraken`] and
//! [`super::mermaid`] landing first.

use super::OodleError;

pub(super) fn decode(_src: &[u8], _dst: &mut [u8]) -> Result<(), OodleError> {
    Err(OodleError::NotYetImplemented {
        compressor: crate::bundle::Compressor::Hydra,
    })
}
