//! Minimal DDS texture decoder — enough to turn GGG's passive-tree icon
//! `.dds` files into RGBA pixels for re-encoding as PNG. Zero external
//! dependencies (we decode the block formats ourselves).
//!
//! GGG stores each icon as a standalone DDS (magic `DDS `) whose pixel
//! data is a block-compressed texture. The 0.5 passive icons are all
//! **DX10 BC1_UNORM** (dxgiFormat 71/72); we also handle BC3 (77/78) and
//! BC4/BC5, the other formats GGG uses for UI art, so one decoder covers
//! the set. (The `.dds.header` sidecar file is GGG's mip descriptor and
//! isn't needed — the `.dds` itself is a valid DDS.)

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DdsError {
    NotDds,
    Truncated,
    /// A compression format we don't decode (with the dxgi/fourCC tag).
    Unsupported(String),
}

impl std::fmt::Display for DdsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotDds => write!(f, "dds: missing 'DDS ' magic"),
            Self::Truncated => write!(f, "dds: file truncated"),
            Self::Unsupported(t) => write!(f, "dds: unsupported format {t}"),
        }
    }
}

impl std::error::Error for DdsError {}

/// A decoded image: tightly packed `width*height*4` RGBA8 bytes.
pub struct Image {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// DXGI formats we recognise.
#[derive(Clone, Copy, PartialEq)]
enum Fmt {
    Bc1,
    Bc3,
    Bc4,
    Bc5,
    Bc7,
    Rgba8,
    Bgra8,
}

#[inline]
fn u32_at(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

/// Just the dimensions from a DDS header (no pixel decode) — for the
/// sprite manifest, which only needs width/height.
pub fn dimensions(bytes: &[u8]) -> Result<(u32, u32), DdsError> {
    if bytes.len() < 128 || &bytes[0..4] != b"DDS " {
        return Err(DdsError::NotDds);
    }
    Ok((u32_at(bytes, 16), u32_at(bytes, 12)))
}

/// Decode a DDS to RGBA8.
pub fn decode(bytes: &[u8]) -> Result<Image, DdsError> {
    if bytes.len() < 128 || &bytes[0..4] != b"DDS " {
        return Err(DdsError::NotDds);
    }
    let height = u32_at(bytes, 12);
    let width = u32_at(bytes, 16);
    let pf_flags = u32_at(bytes, 80);
    let fourcc = &bytes[84..88];

    // DDPF_FOURCC (0x4). DX10 adds a 20-byte extended header at 128.
    let (fmt, data_off) = if pf_flags & 0x4 != 0 && fourcc == b"DX10" {
        if bytes.len() < 148 {
            return Err(DdsError::Truncated);
        }
        let dxgi = u32_at(bytes, 128);
        let f = match dxgi {
            71 | 72 => Fmt::Bc1,
            77 | 78 => Fmt::Bc3,
            80 | 81 => Fmt::Bc4,
            83 | 84 => Fmt::Bc5,
            98 | 99 => Fmt::Bc7,
            28 | 29 => Fmt::Rgba8,
            87 | 88 => Fmt::Bgra8,
            other => return Err(DdsError::Unsupported(format!("dxgi {other}"))),
        };
        (f, 148)
    } else if pf_flags & 0x4 != 0 {
        let f = match fourcc {
            b"DXT1" => Fmt::Bc1,
            b"DXT5" => Fmt::Bc3,
            b"BC4U" | b"ATI1" => Fmt::Bc4,
            b"BC5U" | b"ATI2" => Fmt::Bc5,
            other => {
                return Err(DdsError::Unsupported(format!(
                    "fourCC {}",
                    String::from_utf8_lossy(other)
                )));
            }
        };
        (f, 128)
    } else {
        // Uncompressed. RGB masks tell BGRA vs RGBA; assume BGRA (D3D).
        (Fmt::Bgra8, 128)
    };

    let data = bytes.get(data_off..).ok_or(DdsError::Truncated)?;
    let mut rgba = vec![0u8; (width as usize) * (height as usize) * 4];
    match fmt {
        Fmt::Bc1 => decode_bc(data, width, height, 8, &mut rgba, bc1_block)?,
        Fmt::Bc3 => decode_bc(data, width, height, 16, &mut rgba, bc3_block)?,
        Fmt::Bc4 => decode_bc(data, width, height, 8, &mut rgba, bc4_block)?,
        Fmt::Bc5 => decode_bc(data, width, height, 16, &mut rgba, bc5_block)?,
        Fmt::Bc7 => decode_bc(data, width, height, 16, &mut rgba, bc7_block)?,
        Fmt::Rgba8 => copy_linear(data, width, height, false, &mut rgba)?,
        Fmt::Bgra8 => copy_linear(data, width, height, true, &mut rgba)?,
    }
    Ok(Image {
        width,
        height,
        rgba,
    })
}

fn copy_linear(data: &[u8], w: u32, h: u32, swap_rb: bool, out: &mut [u8]) -> Result<(), DdsError> {
    let n = (w as usize) * (h as usize) * 4;
    if data.len() < n {
        return Err(DdsError::Truncated);
    }
    for i in 0..(w as usize * h as usize) {
        let (b0, b1, b2, b3) = (
            data[i * 4],
            data[i * 4 + 1],
            data[i * 4 + 2],
            data[i * 4 + 3],
        );
        if swap_rb {
            out[i * 4] = b2;
            out[i * 4 + 1] = b1;
            out[i * 4 + 2] = b0;
            out[i * 4 + 3] = b3;
        } else {
            out[i * 4..i * 4 + 4].copy_from_slice(&[b0, b1, b2, b3]);
        }
    }
    Ok(())
}

/// Walk 4×4 blocks row-major, decoding each into `out` at its pixels.
fn decode_bc(
    data: &[u8],
    w: u32,
    h: u32,
    block_bytes: usize,
    out: &mut [u8],
    decode_block: fn(&[u8], &mut [[u8; 4]; 16]),
) -> Result<(), DdsError> {
    let bw = w.div_ceil(4) as usize;
    let bh = h.div_ceil(4) as usize;
    if data.len() < bw * bh * block_bytes {
        return Err(DdsError::Truncated);
    }
    let (w, h) = (w as usize, h as usize);
    let mut px = [[0u8; 4]; 16];
    for by in 0..bh {
        for bx in 0..bw {
            let off = (by * bw + bx) * block_bytes;
            decode_block(&data[off..off + block_bytes], &mut px);
            for row in 0..4 {
                for col in 0..4 {
                    let (x, y) = (bx * 4 + col, by * 4 + row);
                    if x < w && y < h {
                        let di = (y * w + x) * 4;
                        out[di..di + 4].copy_from_slice(&px[row * 4 + col]);
                    }
                }
            }
        }
    }
    Ok(())
}

#[inline]
fn rgb565(c: u16) -> [u8; 3] {
    let r = ((c >> 11) & 0x1F) as u32;
    let g = ((c >> 5) & 0x3F) as u32;
    let b = (c & 0x1F) as u32;
    [
        ((r * 255 + 15) / 31) as u8,
        ((g * 255 + 31) / 63) as u8,
        ((b * 255 + 15) / 31) as u8,
    ]
}

/// The 4-colour palette + index bits shared by BC1 and the colour half
/// of BC3. `alpha1bit` enables BC1's punch-through transparency.
fn bc_colours(block: &[u8], px: &mut [[u8; 4]; 16], alpha1bit: bool) {
    let c0 = u16::from_le_bytes([block[0], block[1]]);
    let c1 = u16::from_le_bytes([block[2], block[3]]);
    let a = rgb565(c0);
    let b = rgb565(c1);
    let mut pal = [[0u8; 4]; 4];
    pal[0] = [a[0], a[1], a[2], 255];
    pal[1] = [b[0], b[1], b[2], 255];
    if c0 > c1 || !alpha1bit {
        for k in 0..3 {
            pal[2][k] = ((2 * a[k] as u32 + b[k] as u32 + 1) / 3) as u8;
            pal[3][k] = ((a[k] as u32 + 2 * b[k] as u32 + 1) / 3) as u8;
        }
        pal[2][3] = 255;
        pal[3][3] = 255;
    } else {
        for k in 0..3 {
            pal[2][k] = ((a[k] as u32 + b[k] as u32) / 2) as u8;
        }
        pal[2][3] = 255;
        pal[3] = [0, 0, 0, 0]; // punch-through transparent
    }
    let bits = u32::from_le_bytes([block[4], block[5], block[6], block[7]]);
    for i in 0..16 {
        px[i] = pal[((bits >> (2 * i)) & 0x3) as usize];
    }
}

fn bc1_block(block: &[u8], px: &mut [[u8; 4]; 16]) {
    bc_colours(block, px, true);
}

fn bc3_block(block: &[u8], px: &mut [[u8; 4]; 16]) {
    // Bytes 0..8 = BC4-style alpha, 8..16 = BC1 colour (no 1-bit alpha).
    let alpha = bc_alpha(&block[0..8]);
    bc_colours(&block[8..16], px, false);
    for i in 0..16 {
        px[i][3] = alpha[i];
    }
}

/// Decode an 8-byte BC4/alpha block to 16 interpolated values.
fn bc_alpha(block: &[u8]) -> [u8; 16] {
    let a0 = block[0];
    let a1 = block[1];
    let mut lut = [0u8; 8];
    lut[0] = a0;
    lut[1] = a1;
    if a0 > a1 {
        for k in 1..7 {
            lut[k + 1] = (((7 - k) as u32 * a0 as u32 + k as u32 * a1 as u32) / 7) as u8;
        }
    } else {
        for k in 1..5 {
            lut[k + 1] = (((5 - k) as u32 * a0 as u32 + k as u32 * a1 as u32) / 5) as u8;
        }
        lut[6] = 0;
        lut[7] = 255;
    }
    // 16 × 3-bit indices packed into 6 bytes (48 bits).
    let mut bits: u64 = 0;
    for (i, &b) in block[2..8].iter().enumerate() {
        bits |= (b as u64) << (8 * i);
    }
    let mut out = [0u8; 16];
    for (i, o) in out.iter_mut().enumerate() {
        *o = lut[((bits >> (3 * i)) & 0x7) as usize];
    }
    out
}

fn bc4_block(block: &[u8], px: &mut [[u8; 4]; 16]) {
    let v = bc_alpha(&block[0..8]);
    for i in 0..16 {
        px[i] = [v[i], v[i], v[i], 255];
    }
}

fn bc5_block(block: &[u8], px: &mut [[u8; 4]; 16]) {
    let r = bc_alpha(&block[0..8]);
    let g = bc_alpha(&block[8..16]);
    for i in 0..16 {
        px[i] = [r[i], g[i], 0, 255];
    }
}

// --- BC7 -------------------------------------------------------------
//
// BC7 packs a 4×4 RGBA block into 16 bytes across 8 modes that trade off
// colour precision, alpha, and the number of "subsets" (independent
// endpoint pairs selected per-pixel by a partition pattern). This is a
// faithful decoder of the format; the constant tables (partitions,
// anchors) are the standard ones from the BC7 spec.

/// Per-mode parameters: (subsets, partition bits, rotation bits, index-
/// selection bit, colour bits, alpha bits, endpoint p-bits, shared
/// p-bits, index bits, index bits 2).
struct Bc7Mode {
    ns: u8,
    pb: u8,
    rb: u8,
    isb: u8,
    cb: u8,
    ab: u8,
    epb: u8,
    spb: u8,
    ib: u8,
    ib2: u8,
}

const BC7_MODES: [Bc7Mode; 8] = [
    Bc7Mode {
        ns: 3,
        pb: 4,
        rb: 0,
        isb: 0,
        cb: 4,
        ab: 0,
        epb: 1,
        spb: 0,
        ib: 3,
        ib2: 0,
    },
    Bc7Mode {
        ns: 2,
        pb: 6,
        rb: 0,
        isb: 0,
        cb: 6,
        ab: 0,
        epb: 0,
        spb: 1,
        ib: 3,
        ib2: 0,
    },
    Bc7Mode {
        ns: 3,
        pb: 6,
        rb: 0,
        isb: 0,
        cb: 5,
        ab: 0,
        epb: 0,
        spb: 0,
        ib: 2,
        ib2: 0,
    },
    Bc7Mode {
        ns: 2,
        pb: 6,
        rb: 0,
        isb: 0,
        cb: 7,
        ab: 0,
        epb: 1,
        spb: 0,
        ib: 2,
        ib2: 0,
    },
    Bc7Mode {
        ns: 1,
        pb: 0,
        rb: 2,
        isb: 1,
        cb: 5,
        ab: 6,
        epb: 0,
        spb: 0,
        ib: 2,
        ib2: 3,
    },
    Bc7Mode {
        ns: 1,
        pb: 0,
        rb: 2,
        isb: 0,
        cb: 7,
        ab: 8,
        epb: 0,
        spb: 0,
        ib: 2,
        ib2: 2,
    },
    Bc7Mode {
        ns: 1,
        pb: 0,
        rb: 0,
        isb: 0,
        cb: 7,
        ab: 7,
        epb: 1,
        spb: 0,
        ib: 4,
        ib2: 0,
    },
    Bc7Mode {
        ns: 2,
        pb: 6,
        rb: 0,
        isb: 0,
        cb: 5,
        ab: 5,
        epb: 1,
        spb: 0,
        ib: 2,
        ib2: 0,
    },
];

/// 2-subset partition patterns (which subset each of the 16 pixels
/// belongs to), 64 entries packed 2 bits per pixel.
const BC7_PART2: [u32; 64] = [
    0xCCCC, 0x8888, 0xEEEE, 0xECC8, 0xC880, 0xFEEC, 0xFEC8, 0xEC80, 0xC800, 0xFFEC, 0xFE80, 0xE800,
    0xFFE8, 0xFF00, 0xFFF0, 0xF000, 0xF710, 0x008E, 0x7100, 0x08CE, 0x008C, 0x7310, 0x3100, 0x8CCE,
    0x088C, 0x3110, 0x6666, 0x366C, 0x17E8, 0x0FF0, 0x718E, 0x399C, 0xAAAA, 0xF0F0, 0x5A5A, 0x33CC,
    0x3C3C, 0x55AA, 0x9696, 0xA55A, 0x73CE, 0x13C8, 0x324C, 0x3BDC, 0x6996, 0xC33C, 0x9966, 0x0660,
    0x0272, 0x04E4, 0x4E40, 0x2720, 0xC936, 0x936C, 0x39C6, 0x639C, 0x9336, 0x9CC6, 0x817E, 0xE718,
    0xCCF0, 0x0FCC, 0x7744, 0xEE22,
];

/// 3-subset partition patterns, 64 entries packed 2 bits per pixel.
const BC7_PART3: [u32; 64] = [
    0xAA685050, 0x6A5A5040, 0x5A5A4200, 0x5450A0A8, 0xA5A50000, 0xA0A05050, 0x5555A0A0, 0x5A5A5050,
    0xAA550000, 0xAA555500, 0xAAAA5500, 0x90909090, 0x94949494, 0xA4A4A4A4, 0xA9A59450, 0x2A0A4250,
    0xA5945040, 0x0A425054, 0xA5A5A500, 0x55A0A0A0, 0xA8A85454, 0x6A6A4040, 0xA4A45000, 0x1A1A0500,
    0x0050A4A4, 0xAAA59090, 0x14696914, 0x69691400, 0xA08585A0, 0xAA821414, 0x50A4A450, 0x6A5A0200,
    0xA9A58000, 0x5090A0A8, 0xA8A09050, 0x24242424, 0x00AA5500, 0x24924924, 0x24499224, 0x50A50A50,
    0x500AA550, 0xAAAA4444, 0x66660000, 0xA5A0A5A0, 0x50A050A0, 0x69286928, 0x44AAAA44, 0x66666600,
    0xAA444444, 0x54A854A8, 0x95809580, 0x96969600, 0xA85454A8, 0x80959580, 0xAA141414, 0x96960000,
    0xAAAA1414, 0xA05050A0, 0xA0A5A5A0, 0x96000000, 0x40804080, 0xA9A8A9A8, 0xAAAAAA44, 0x2A4A5254,
];

/// Second anchor index (per 2-subset partition).
const BC7_ANCHOR2: [u8; 64] = [
    15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 2, 8, 2, 2, 8, 8, 15, 2, 8,
    2, 2, 8, 8, 2, 2, 15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6, 6, 2, 6, 8, 15, 15, 2,
    2, 15, 15, 15, 15, 15, 2, 2, 15,
];
const BC7_ANCHOR3A: [u8; 64] = [
    3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3, 3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5,
    15, 15, 8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15, 15, 15, 3, 15, 5, 5, 5, 8, 5, 10, 5,
    10, 8, 13, 15, 12, 3, 3,
];
const BC7_ANCHOR3B: [u8; 64] = [
    15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8, 15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6,
    10, 15, 15, 10, 8, 15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8, 15, 3, 6, 6, 8, 15, 3, 15, 15, 15,
    15, 15, 15, 15, 15, 15, 15, 15, 15, 3, 15,
];

/// Little-endian bit reader over the 16-byte block.
struct BitReader<'a> {
    b: &'a [u8],
    pos: usize,
}
impl BitReader<'_> {
    fn bit(&mut self) -> u32 {
        // A well-formed block reads exactly 128 bits; guard the boundary
        // so a stray read degrades to 0 instead of panicking.
        let byte = self.pos >> 3;
        let v = if byte < self.b.len() {
            (self.b[byte] >> (self.pos & 7)) & 1
        } else {
            0
        };
        self.pos += 1;
        v as u32
    }
    fn bits(&mut self, n: u32) -> u32 {
        let mut v = 0;
        for i in 0..n {
            v |= self.bit() << i;
        }
        v
    }
}

#[inline]
fn bc7_expand(v: u32, bits: u8) -> u8 {
    if bits >= 8 {
        return v as u8; // already full precision
    }
    let v = (v << (8 - bits)) as u8;
    v | (v >> bits)
}

const BC7_WEIGHTS2: [u32; 4] = [0, 21, 43, 64];
const BC7_WEIGHTS3: [u32; 8] = [0, 9, 18, 27, 37, 46, 55, 64];
const BC7_WEIGHTS4: [u32; 16] = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];

#[inline]
fn bc7_interp(a: u32, b: u32, i: u32, ib: u8) -> u8 {
    let w = match ib {
        2 => BC7_WEIGHTS2[i as usize],
        3 => BC7_WEIGHTS3[i as usize],
        _ => BC7_WEIGHTS4[i as usize],
    };
    (((64 - w) * a + w * b + 32) >> 6) as u8
}

// Endpoints are a `[subset][end][component]` cube; explicit index loops
// read clearer than iterator chains here.
#[allow(clippy::needless_range_loop)]
fn bc7_block(block: &[u8], px: &mut [[u8; 4]; 16]) {
    // Mode = index of the first set bit from the LSB (mode 8 is invalid).
    let mut mode = 0usize;
    while mode < 8 && (block[0] >> mode) & 1 == 0 {
        mode += 1;
    }
    if mode >= 8 {
        *px = [[0, 0, 0, 0]; 16];
        return;
    }
    let m = &BC7_MODES[mode];
    let mut r = BitReader {
        b: block,
        pos: mode + 1,
    };

    let partition = r.bits(m.pb as u32) as usize;
    let rotation = r.bits(m.rb as u32);
    let idx_sel = r.bits(m.isb as u32);

    let ns = m.ns as usize;
    let ncomp = if m.ab > 0 { 4 } else { 3 };
    // endpoints[subset][0/1][rgba]
    let mut ep = [[[0u32; 4]; 2]; 3];
    for c in 0..3 {
        for s in 0..ns {
            for e in 0..2 {
                ep[s][e][c] = r.bits(m.cb as u32);
            }
        }
    }
    if m.ab > 0 {
        for s in 0..ns {
            for e in 0..2 {
                ep[s][e][3] = r.bits(m.ab as u32);
            }
        }
    }
    // P-bits refine the low bit of each endpoint component.
    if m.epb > 0 {
        for s in 0..ns {
            for e in 0..2 {
                let p = r.bit();
                for c in 0..ncomp {
                    ep[s][e][c] = (ep[s][e][c] << 1) | p;
                }
            }
        }
    }
    if m.spb > 0 {
        for s in 0..ns {
            let p0 = r.bit();
            let p1 = r.bit();
            for c in 0..ncomp {
                ep[s][0][c] = (ep[s][0][c] << 1) | p0;
                ep[s][1][c] = (ep[s][1][c] << 1) | p1;
            }
        }
    }
    // Expand each endpoint component to 8 bits.
    let cb = m.cb + m.epb + m.spb;
    let ab = if m.ab > 0 { m.ab + m.epb + m.spb } else { 0 };
    for s in 0..ns {
        for e in 0..2 {
            for c in 0..3 {
                ep[s][e][c] = bc7_expand(ep[s][e][c], cb) as u32;
            }
            ep[s][e][3] = if m.ab > 0 {
                bc7_expand(ep[s][e][3], ab) as u32
            } else {
                255
            };
        }
    }

    // Which subset each pixel belongs to. The 2-subset table packs one
    // bit per pixel; the 3-subset table packs two.
    let subset = |i: usize| -> usize {
        match ns {
            2 => ((BC7_PART2[partition] >> i) & 1) as usize,
            3 => ((BC7_PART3[partition] >> (2 * i)) & 3) as usize,
            _ => 0,
        }
    };
    // Anchor pixel per subset (index there has one fewer bit).
    let anchor = |s: usize| -> usize {
        match (ns, s) {
            (_, 0) => 0,
            (2, _) => BC7_ANCHOR2[partition] as usize,
            (3, 1) => BC7_ANCHOR3A[partition] as usize,
            (3, _) => BC7_ANCHOR3B[partition] as usize,
            _ => 0,
        }
    };

    // Colour index bits, then (for modes 4/5) a second index plane.
    let mut cidx = [0u32; 16];
    for (i, ci) in cidx.iter_mut().enumerate() {
        let s = subset(i);
        let bits = if i == anchor(s) { m.ib - 1 } else { m.ib };
        *ci = r.bits(bits as u32);
    }
    let mut aidx = [0u32; 16];
    if m.ib2 > 0 {
        for (i, ai) in aidx.iter_mut().enumerate() {
            let bits = if i == 0 { m.ib2 - 1 } else { m.ib2 };
            *ai = r.bits(bits as u32);
        }
    }

    for i in 0..16 {
        let s = subset(i);
        let (cw, aw, cbits, abits) = if m.ib2 == 0 {
            (cidx[i], cidx[i], m.ib, m.ib)
        } else if idx_sel == 0 {
            (cidx[i], aidx[i], m.ib, m.ib2)
        } else {
            (aidx[i], cidx[i], m.ib2, m.ib)
        };
        let mut out = [0u8; 4];
        for c in 0..3 {
            out[c] = bc7_interp(ep[s][0][c], ep[s][1][c], cw, cbits);
        }
        out[3] = if m.ab > 0 {
            bc7_interp(ep[s][0][3], ep[s][1][3], aw, abits)
        } else {
            255
        };
        // Rotation swaps alpha with a colour channel (modes 4/5).
        match rotation {
            1 => out.swap(0, 3),
            2 => out.swap(1, 3),
            3 => out.swap(2, 3),
            _ => {}
        }
        px[i] = out;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal DX10 BC1 DDS: 4×4, one block, colour0=red,
    /// colour1=blue, all indices 0 → whole block red.
    fn synth_bc1() -> Vec<u8> {
        let mut d = vec![0u8; 148];
        d[0..4].copy_from_slice(b"DDS ");
        d[4..8].copy_from_slice(&124u32.to_le_bytes()); // dwSize
        d[12..16].copy_from_slice(&4u32.to_le_bytes()); // height
        d[16..20].copy_from_slice(&4u32.to_le_bytes()); // width
        d[80..84].copy_from_slice(&0x4u32.to_le_bytes()); // DDPF_FOURCC
        d[84..88].copy_from_slice(b"DX10");
        d[128..132].copy_from_slice(&71u32.to_le_bytes()); // dxgi BC1
        // one BC1 block: c0 = red (0xF800), c1 = blue (0x001F), idx = 0.
        let block = [0x00u8, 0xF8, 0x1F, 0x00, 0, 0, 0, 0];
        d.extend_from_slice(&block);
        d
    }

    #[test]
    fn decodes_bc1_solid() {
        let d = synth_bc1();
        assert_eq!(dimensions(&d).unwrap(), (4, 4));
        let img = decode(&d).expect("decode");
        assert_eq!((img.width, img.height), (4, 4));
        // every pixel red, opaque
        for px in img.rgba.chunks_exact(4) {
            assert_eq!(px[0], 255, "red");
            assert_eq!(px[1], 0);
            assert_eq!(px[2], 0);
            assert_eq!(px[3], 255);
        }
    }

    #[test]
    fn rejects_non_dds() {
        assert!(matches!(
            decode(b"not a dds file............"),
            Err(DdsError::NotDds)
        ));
    }
}
