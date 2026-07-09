//! Bit-stream reader shared by every Oodle entropy decoder.
//!
//! Oodle's bitstreams are LSB-first within each byte, and the byte
//! stream itself reads forward from the cursor (most decoders) or
//! backward from the tail (the literal-stream half of Kraken's
//! "ANS" entropy mode). This reader provides forward reads only;
//! backward-reading callers slice their buffer in reverse first.
//!
//! Refill model:
//! * `bits` holds up to 56 valid low bits.
//! * `bit_count` is how many of those are actually populated.
//! * On every read of N≤56 bits, we first refill `bits` from up to 7
//!   source bytes so `bit_count >= 56`. (Reading 56 bits when the
//!   buffer holds 56 is safe; reading 57 would overflow, hence the
//!   `<= 56` cap.)
//!
//! Cf. ooz `kraken.cpp` — `BitReader` and friends.

use super::OodleError;

pub struct BitReader<'a> {
    src: &'a [u8],
    cursor: usize,
    bits: u64,
    bit_count: u32,
}

impl<'a> BitReader<'a> {
    pub fn new(src: &'a [u8]) -> Self {
        Self {
            src,
            cursor: 0,
            bits: 0,
            bit_count: 0,
        }
    }

    /// Source bytes still ahead of the cursor (not counting bits
    /// already pulled into the refill window).
    pub fn bytes_remaining(&self) -> usize {
        self.src.len().saturating_sub(self.cursor)
    }

    /// Refill `bits` so we hold at least 56 of them, drawing from
    /// `src` one byte at a time. Stops short at end-of-source.
    fn refill(&mut self) {
        while self.bit_count <= 56 && self.cursor < self.src.len() {
            self.bits |= u64::from(self.src[self.cursor]) << self.bit_count;
            self.cursor += 1;
            self.bit_count += 8;
        }
    }

    /// Read `n` bits (LSB-first). Caller must ensure `n <= 56`.
    pub fn read(&mut self, n: u32) -> Result<u64, OodleError> {
        debug_assert!(n <= 56, "BitReader::read: n must be <= 56");
        if self.bit_count < n {
            self.refill();
            if self.bit_count < n {
                return Err(OodleError::Truncated {
                    at: "BitReader::read",
                });
            }
        }
        let mask = (1u64 << n) - 1;
        let val = self.bits & mask;
        self.bits >>= n;
        self.bit_count -= n;
        Ok(val)
    }

    /// Peek `n` bits without consuming them. Caller must ensure
    /// `n <= 56`. Returns 0 if fewer than `n` bits are available
    /// after a refill — callers that care should check via
    /// [`Self::bytes_remaining`] and the residual `bit_count`.
    pub fn peek(&mut self, n: u32) -> u64 {
        debug_assert!(n <= 56, "BitReader::peek: n must be <= 56");
        if self.bit_count < n {
            self.refill();
        }
        if self.bit_count < n {
            return 0;
        }
        let mask = (1u64 << n) - 1;
        self.bits & mask
    }

    /// Consume `n` bits previously [`peek`](Self::peek)ed.
    pub fn consume(&mut self, n: u32) -> Result<(), OodleError> {
        debug_assert!(n <= 56, "BitReader::consume: n must be <= 56");
        if self.bit_count < n {
            self.refill();
            if self.bit_count < n {
                return Err(OodleError::Truncated {
                    at: "BitReader::consume",
                });
            }
        }
        self.bits >>= n;
        self.bit_count -= n;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_within_one_byte() {
        // 0b1010_0101 -> read low 4 bits = 5, then next 4 = 10.
        let buf = [0xA5u8];
        let mut br = BitReader::new(&buf);
        assert_eq!(br.read(4).unwrap(), 0x5);
        assert_eq!(br.read(4).unwrap(), 0xA);
    }

    #[test]
    fn read_crossing_bytes() {
        // 0x12 0x34 little-endian-low = 0b0011_0100_0001_0010
        // first 12 LSBs => 0b0100_0001_0010 = 0x412.
        let buf = [0x12u8, 0x34];
        let mut br = BitReader::new(&buf);
        assert_eq!(br.read(12).unwrap(), 0x412);
        assert_eq!(br.read(4).unwrap(), 0x3);
    }

    #[test]
    fn peek_then_consume() {
        let buf = [0xFFu8, 0x00, 0xAA];
        let mut br = BitReader::new(&buf);
        assert_eq!(br.peek(8), 0xFF);
        br.consume(8).unwrap();
        assert_eq!(br.read(8).unwrap(), 0x00);
        assert_eq!(br.read(8).unwrap(), 0xAA);
    }

    #[test]
    fn truncation_is_an_error() {
        let buf = [0x01u8];
        let mut br = BitReader::new(&buf);
        assert_eq!(br.read(8).unwrap(), 0x01);
        assert!(br.read(8).is_err());
    }
}
