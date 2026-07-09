//! Minimal PNG encoder for RGBA8 images — zero dependencies.
//!
//! We don't need compression ratio (icons are tiny), so the DEFLATE
//! stream uses only *stored* (uncompressed, type-0) blocks. That keeps
//! the encoder to a CRC32 + Adler32 + chunk framing — no compressor —
//! while producing files any PNG reader accepts.

/// Encode `rgba` (`width*height*4` bytes, row-major) as a PNG.
pub fn encode_rgba(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    assert_eq!(rgba.len(), (width as usize) * (height as usize) * 4);
    let mut out = Vec::new();
    out.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);

    // IHDR: width, height, bit depth 8, colour type 6 (RGBA), no
    // interlace.
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &ihdr);

    // Raw image = each scanline prefixed with a filter byte (0 = none).
    let mut raw = Vec::with_capacity((width as usize * 4 + 1) * height as usize);
    for y in 0..height as usize {
        raw.push(0);
        let row = &rgba[y * width as usize * 4..(y + 1) * width as usize * 4];
        raw.extend_from_slice(row);
    }
    chunk(&mut out, b"IDAT", &zlib_stored(&raw));
    chunk(&mut out, b"IEND", &[]);
    out
}

/// Wrap bytes in a zlib stream using stored DEFLATE blocks.
fn zlib_stored(data: &[u8]) -> Vec<u8> {
    let mut z = Vec::with_capacity(data.len() + data.len() / 65535 * 5 + 16);
    z.extend_from_slice(&[0x78, 0x01]); // zlib header: deflate, no dict
    let mut i = 0;
    while i < data.len() || (data.is_empty() && i == 0) {
        let n = (data.len() - i).min(0xFFFF);
        let last = i + n >= data.len();
        z.push(if last { 1 } else { 0 }); // BFINAL, BTYPE=00 (stored)
        z.extend_from_slice(&(n as u16).to_le_bytes());
        z.extend_from_slice(&(!(n as u16)).to_le_bytes()); // one's complement
        z.extend_from_slice(&data[i..i + n]);
        i += n;
        if data.is_empty() {
            break;
        }
    }
    z.extend_from_slice(&adler32(data).to_be_bytes());
    z
}

/// Write one PNG chunk: length, type, payload, CRC32(type+payload).
fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], payload: &[u8]) {
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(payload);
    let mut crc = Crc::new();
    crc.update(kind);
    crc.update(payload);
    out.extend_from_slice(&crc.finish().to_be_bytes());
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &byte in data {
        a = (a + byte as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

/// Streaming CRC32 (IEEE, the PNG polynomial), table computed on the fly
/// so there's no static data to maintain.
struct Crc {
    value: u32,
}

impl Crc {
    fn new() -> Self {
        Crc { value: 0xFFFF_FFFF }
    }
    fn update(&mut self, data: &[u8]) {
        for &byte in data {
            let mut c = (self.value ^ byte as u32) & 0xFF;
            for _ in 0..8 {
                c = if c & 1 != 0 {
                    0xEDB8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
            }
            self.value = c ^ (self.value >> 8);
        }
    }
    fn finish(self) -> u32 {
        self.value ^ 0xFFFF_FFFF
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_a_valid_png_header() {
        // 2×1 red/green image.
        let rgba = [255, 0, 0, 255, 0, 255, 0, 255];
        let png = encode_rgba(2, 1, &rgba);
        assert_eq!(
            &png[0..8],
            &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]
        );
        // IHDR chunk length is 13, right after the signature.
        assert_eq!(&png[8..12], &13u32.to_be_bytes());
        assert_eq!(&png[12..16], b"IHDR");
        assert_eq!(&png[16..20], &2u32.to_be_bytes()); // width
        assert_eq!(&png[20..24], &1u32.to_be_bytes()); // height
        // Must contain IDAT and end with IEND.
        assert!(png.windows(4).any(|w| w == b"IDAT"));
        assert_eq!(&png[png.len() - 8..png.len() - 4], b"IEND");
    }

    #[test]
    fn crc_and_adler_known_values() {
        // CRC32 of "IEND" (empty payload) is a PNG constant.
        let mut c = Crc::new();
        c.update(b"IEND");
        assert_eq!(c.finish(), 0xAE42_6082);
        // Adler32 of empty input is 1.
        assert_eq!(adler32(&[]), 1);
    }
}
