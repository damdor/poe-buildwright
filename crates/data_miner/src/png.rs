//! Minimal PNG encoder + decoder for RGBA8 images — zero dependencies.
//!
//! The encoder does real compression: adaptive per-row filtering
//! (RFC 2083 §6, minimum-sum-of-absolute-differences heuristic) over a
//! from-scratch DEFLATE (RFC 1951) with LZ77 hash-chain matching, lazy
//! evaluation, and per-block dynamic Huffman codes built by
//! package-merge. The original encoder wrote *stored* (uncompressed)
//! DEFLATE blocks on the theory that icons are tiny; the 1500×1500
//! panel art went through the same path and came out at raw-pixel size
//! (9 MB each, ~434 MB across the sprite set), which dominated
//! first-visit load time. Compression is lossless — output decodes to
//! the exact input RGBA.
//!
//! The decoder (`decode_rgba`) accepts any 8-bit-RGBA non-interlaced
//! PNG with a conformant zlib stream (stored, fixed, or dynamic
//! blocks). It exists so round-trip tests can prove losslessness and
//! so tooling can re-encode sprites produced by the old encoder.

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

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

    let filtered = filter_scanlines(width as usize, height as usize, rgba);
    let mut idat = vec![0x78, 0x01]; // zlib header: deflate, 32K window
    deflate(&filtered, &mut idat);
    idat.extend_from_slice(&adler32(&filtered).to_be_bytes());
    chunk(&mut out, b"IDAT", &idat);
    chunk(&mut out, b"IEND", &[]);
    out
}

/// Bytes per pixel — everything here is RGBA8.
const BPP: usize = 4;

/// Prefix every scanline with a filter byte, choosing per row the
/// filter (None/Sub/Up/Average/Paeth) that minimises the sum of
/// absolute filtered values — the standard heuristic for "most
/// compressible". This is where most of the compression win comes
/// from: DEFLATE sees near-zero residuals instead of raw pixels.
fn filter_scanlines(width: usize, height: usize, rgba: &[u8]) -> Vec<u8> {
    let stride = width * BPP;
    let mut out = Vec::with_capacity((stride + 1) * height);
    let mut candidate = vec![0u8; stride];
    let mut best = vec![0u8; stride];
    for y in 0..height {
        let row = &rgba[y * stride..(y + 1) * stride];
        let prev = if y > 0 { &rgba[(y - 1) * stride..y * stride] } else { &[][..] };
        let mut best_filter = 0u8;
        let mut best_cost = u64::MAX;
        for filter in 0u8..=4 {
            let mut cost = 0u64;
            for x in 0..stride {
                let a = if x >= BPP { row[x - BPP] } else { 0 }; // left
                let b = if y > 0 { prev[x] } else { 0 }; // up
                let c = if y > 0 && x >= BPP { prev[x - BPP] } else { 0 }; // up-left
                let v = match filter {
                    0 => row[x],
                    1 => row[x].wrapping_sub(a),
                    2 => row[x].wrapping_sub(b),
                    3 => row[x].wrapping_sub(((a as u16 + b as u16) / 2) as u8),
                    _ => row[x].wrapping_sub(paeth(a, b, c)),
                };
                candidate[x] = v;
                cost += (v as i8).unsigned_abs() as u64;
            }
            if cost < best_cost {
                best_cost = cost;
                best_filter = filter;
                std::mem::swap(&mut best, &mut candidate);
            }
        }
        out.push(best_filter);
        out.extend_from_slice(&best);
    }
    out
}

/// Paeth predictor (RFC 2083 §6.6).
fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let p = a as i32 + b as i32 - c as i32;
    let (pa, pb, pc) = ((p - a as i32).abs(), (p - b as i32).abs(), (p - c as i32).abs());
    if pa <= pb && pa <= pc {
        a
    } else if pb <= pc {
        b
    } else {
        c
    }
}

// ---------------------------------------------------------------------------
// DEFLATE (RFC 1951)
// ---------------------------------------------------------------------------

const WINDOW: usize = 32 * 1024;
const MIN_MATCH: usize = 3;
const MAX_MATCH: usize = 258;
/// Chain-walk budget per position. 128 lands within a few percent of
/// zlib -9 on filtered image data at a fraction of the cost.
const MAX_CHAIN: usize = 128;
/// Stop searching once a match this long is found.
const NICE_LEN: usize = 130;
const HASH_BITS: u32 = 15;
/// Tokens per dynamic-Huffman block: large enough that the ~80-byte
/// block header is noise, small enough that the code adapts across an
/// image's regions.
const BLOCK_TOKENS: usize = 1 << 17;

/// Length codes 257..=285: (base, extra bits), RFC 1951 §3.2.5.
const LEN_BASE: [u16; 29] = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
    163, 195, 227, 258,
];
const LEN_EXTRA: [u8; 29] = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
/// Distance codes 0..=29: (base, extra bits).
const DIST_BASE: [u16; 30] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
    2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA: [u8; 30] = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13,
];
/// Order in which code-length-code lengths are transmitted (§3.2.7).
const CL_ORDER: [usize; 19] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

fn length_index(len: usize) -> usize {
    LEN_BASE.partition_point(|&b| (b as usize) <= len) - 1
}

fn dist_index(dist: usize) -> usize {
    DIST_BASE.partition_point(|&b| (b as usize) <= dist) - 1
}

enum Tok {
    Lit(u8),
    Match { len: u16, dist: u16 },
}

/// LSB-first bit writer (DEFLATE bit order). Huffman codes are written
/// via `put_huff`, which bit-reverses the canonical code first.
struct BitWriter<'a> {
    out: &'a mut Vec<u8>,
    buf: u64,
    n: u32,
}

impl<'a> BitWriter<'a> {
    fn new(out: &'a mut Vec<u8>) -> Self {
        BitWriter { out, buf: 0, n: 0 }
    }
    fn put(&mut self, v: u32, bits: u32) {
        debug_assert!(bits <= 32 && (bits == 32 || v < (1 << bits)));
        self.buf |= (v as u64) << self.n;
        self.n += bits;
        while self.n >= 8 {
            self.out.push((self.buf & 0xFF) as u8);
            self.buf >>= 8;
            self.n -= 8;
        }
    }
    fn put_huff(&mut self, code: u16, len: u8) {
        debug_assert!(len > 0);
        self.put(reverse_bits(code, len) as u32, len as u32);
    }
    fn align_byte(&mut self) {
        if self.n > 0 {
            self.put(0, 8 - self.n);
        }
    }
    /// Byte-aligned raw copy (stored blocks).
    fn put_bytes(&mut self, bytes: &[u8]) {
        debug_assert_eq!(self.n, 0);
        self.out.extend_from_slice(bytes);
    }
    fn finish(mut self) {
        self.align_byte();
    }
}

fn reverse_bits(mut v: u16, n: u8) -> u16 {
    let mut r = 0;
    for _ in 0..n {
        r = (r << 1) | (v & 1);
        v >>= 1;
    }
    r
}

/// Length-limited Huffman code lengths via package-merge. Optimal for
/// the given limit; returns all-zero lengths for unused symbols.
fn huff_lengths(freqs: &[u64], limit: u8) -> Vec<u8> {
    let mut lens = vec![0u8; freqs.len()];
    let mut leaves: Vec<(u64, u16)> = freqs
        .iter()
        .enumerate()
        .filter(|&(_, &f)| f > 0)
        .map(|(s, &f)| (f, s as u16))
        .collect();
    match leaves.len() {
        0 => return lens,
        1 => {
            // A single symbol still needs a 1-bit code (DEFLATE has no
            // 0-bit codes for used symbols).
            lens[leaves[0].1 as usize] = 1;
            return lens;
        }
        n => debug_assert!(n < (1usize << limit)),
    }
    leaves.sort_unstable();

    // Boundary package-merge: list₁ = leaves; listₖ = merge(leaves,
    // pairs(listₖ₋₁)). Each item carries the set of leaf symbols it
    // contains; a symbol's code length = its occurrence count among
    // the first 2n-2 items of the final list. Sizes here are tiny
    // (≤286 symbols, ≤15 levels), so the Vec-of-Vecs is fine.
    let mut list: Vec<(u64, Vec<u16>)> = leaves.iter().map(|&(f, s)| (f, vec![s])).collect();
    for _ in 1..limit {
        let mut next: Vec<(u64, Vec<u16>)> =
            leaves.iter().map(|&(f, s)| (f, vec![s])).collect();
        for pair in list.chunks_exact(2) {
            let mut syms = pair[0].1.clone();
            syms.extend_from_slice(&pair[1].1);
            next.push((pair[0].0 + pair[1].0, syms));
        }
        next.sort_by_key(|item| (item.0, item.1.len()));
        list = next;
    }
    for (_, syms) in list.iter().take(2 * leaves.len() - 2) {
        for &s in syms {
            lens[s as usize] += 1;
        }
    }
    // Kraft equality must hold or the canonical code is malformed.
    debug_assert_eq!(
        lens.iter().filter(|&&l| l > 0).map(|&l| 1u64 << (limit - l)).sum::<u64>(),
        1u64 << limit
    );
    lens
}

/// Canonical code assignment from lengths (RFC 1951 §3.2.2).
fn canonical_codes(lens: &[u8]) -> Vec<u16> {
    let mut bl_count = [0u16; 16];
    for &l in lens {
        bl_count[l as usize] += 1;
    }
    bl_count[0] = 0;
    let mut next = [0u16; 16];
    let mut code = 0u16;
    for bits in 1..16 {
        code = (code + bl_count[bits - 1]) << 1;
        next[bits] = code;
    }
    lens.iter()
        .map(|&l| {
            if l == 0 {
                0
            } else {
                let c = next[l as usize];
                next[l as usize] += 1;
                c
            }
        })
        .collect()
}

/// RLE-encode the concatenated litlen+dist code lengths using symbols
/// 16 (repeat previous 3–6), 17 (zeros 3–10), 18 (zeros 11–138).
/// Returns (symbol, extra-bit count, extra-bit value) triples.
fn rle_code_lengths(seq: &[u8]) -> Vec<(u8, u8, u8)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < seq.len() {
        let v = seq[i];
        let mut run = 1;
        while i + run < seq.len() && seq[i + run] == v {
            run += 1;
        }
        i += run;
        if v == 0 {
            while run >= 11 {
                let take = run.min(138);
                out.push((18, 7, (take - 11) as u8));
                run -= take;
            }
            if run >= 3 {
                out.push((17, 3, (run - 3) as u8));
                run = 0;
            }
            for _ in 0..run {
                out.push((0, 0, 0));
            }
        } else {
            out.push((v, 0, 0));
            run -= 1;
            while run >= 3 {
                let take = run.min(6);
                out.push((16, 2, (take - 3) as u8));
                run -= take;
            }
            for _ in 0..run {
                out.push((v, 0, 0));
            }
        }
    }
    out
}

/// Compress `data` as a raw DEFLATE stream appended to `out`.
fn deflate(data: &[u8], out: &mut Vec<u8>) {
    let mut bw = BitWriter::new(out);
    if data.is_empty() {
        write_stored(&mut bw, data, true);
        bw.finish();
        return;
    }

    // Hash chains: head[h] = most recent position with hash h,
    // prev[pos & (WINDOW-1)] = previous position in that chain.
    // Positions are absolute (u32; inputs here are ≪ 4 GiB); a chain
    // entry pointing forward or out of the window marks a stale slot
    // from a previous wrap, which terminates the walk.
    let mut head = vec![u32::MAX; 1 << HASH_BITS];
    let mut prev = vec![u32::MAX; WINDOW];
    let hash = |p: usize| -> usize {
        let v = (data[p] as u32) << 16 | (data[p + 1] as u32) << 8 | (data[p + 2] as u32);
        (v.wrapping_mul(0x9E37_79B1) >> (32 - HASH_BITS)) as usize
    };
    let insert = |head: &mut Vec<u32>, prev: &mut Vec<u32>, p: usize| {
        if p + MIN_MATCH <= data.len() {
            let h = hash(p);
            prev[p & (WINDOW - 1)] = head[h];
            head[h] = p as u32;
        }
    };
    let longest_match = |head: &Vec<u32>, prev: &Vec<u32>, i: usize| -> (usize, usize) {
        let max_len = (data.len() - i).min(MAX_MATCH);
        if max_len < MIN_MATCH {
            return (0, 0);
        }
        let min_pos = i.saturating_sub(WINDOW);
        let mut p = head[hash(i)];
        let (mut best_len, mut best_dist) = (MIN_MATCH - 1, 0);
        let mut chain = MAX_CHAIN;
        while p != u32::MAX && (p as usize) >= min_pos && (p as usize) < i && chain > 0 {
            let pp = p as usize;
            // Cheap reject: a longer match must improve the byte at
            // offset best_len.
            if data[pp + best_len] == data[i + best_len] {
                let mut l = 0;
                while l < max_len && data[pp + l] == data[i + l] {
                    l += 1;
                }
                if l > best_len {
                    best_len = l;
                    best_dist = i - pp;
                    if best_len >= NICE_LEN.min(max_len) {
                        break;
                    }
                }
            }
            let nxt = prev[pp & (WINDOW - 1)];
            if nxt == u32::MAX || nxt as usize >= pp {
                break;
            }
            p = nxt;
            chain -= 1;
        }
        if best_len >= MIN_MATCH { (best_len, best_dist) } else { (0, 0) }
    };

    let mut toks: Vec<Tok> = Vec::with_capacity(BLOCK_TOKENS);
    let mut block_start = 0usize; // input byte where the current block began
    let mut i = 0usize;
    while i < data.len() {
        let (len, dist) = longest_match(&head, &prev, i);
        insert(&mut head, &mut prev, i);
        if len >= MIN_MATCH {
            // Lazy evaluation: if the next position matches longer,
            // emit a literal here and let it win.
            let (len2, _) = if len < NICE_LEN && i + 1 < data.len() {
                longest_match(&head, &prev, i + 1)
            } else {
                (0, 0)
            };
            if len2 > len {
                toks.push(Tok::Lit(data[i]));
                i += 1;
            } else {
                toks.push(Tok::Match { len: len as u16, dist: dist as u16 });
                for j in i + 1..i + len {
                    insert(&mut head, &mut prev, j);
                }
                i += len;
            }
        } else {
            toks.push(Tok::Lit(data[i]));
            i += 1;
        }
        if toks.len() >= BLOCK_TOKENS {
            write_block(&mut bw, &toks, &data[block_start..i], false);
            toks.clear();
            block_start = i;
        }
    }
    write_block(&mut bw, &toks, &data[block_start..], true);
    bw.finish();
}

/// Emit one block: dynamic Huffman, or stored if that is smaller
/// (incompressible input; the header alone can exceed a tiny span).
fn write_block(bw: &mut BitWriter, toks: &[Tok], span: &[u8], bfinal: bool) {
    // Symbol frequencies (litlen includes the mandatory end-of-block).
    let mut lit_freq = [0u64; 286];
    let mut dist_freq = [0u64; 30];
    lit_freq[256] = 1;
    for t in toks {
        match *t {
            Tok::Lit(b) => lit_freq[b as usize] += 1,
            Tok::Match { len, dist } => {
                lit_freq[257 + length_index(len as usize)] += 1;
                dist_freq[dist_index(dist as usize)] += 1;
            }
        }
    }
    let lit_lens = huff_lengths(&lit_freq, 15);
    let dist_lens = huff_lengths(&dist_freq, 15);
    let lit_codes = canonical_codes(&lit_lens);
    let dist_codes = canonical_codes(&dist_lens);

    // HLIT/HDIST: trailing zero lengths are not transmitted.
    let hlit = lit_lens.iter().rposition(|&l| l > 0).unwrap() + 1; // ≥257: EOB is used
    let hdist = dist_lens.iter().rposition(|&l| l > 0).map_or(1, |p| p + 1);

    let mut seq = Vec::with_capacity(hlit + hdist);
    seq.extend_from_slice(&lit_lens[..hlit]);
    seq.extend_from_slice(&dist_lens[..hdist]);
    let rle = rle_code_lengths(&seq);
    let mut cl_freq = [0u64; 19];
    for &(sym, _, _) in &rle {
        cl_freq[sym as usize] += 1;
    }
    let cl_lens = huff_lengths(&cl_freq, 7);
    let cl_codes = canonical_codes(&cl_lens);
    let hclen = (4..=19)
        .rev()
        .find(|&n| cl_lens[CL_ORDER[n - 1]] > 0)
        .unwrap_or(4);

    // Exact size of the dynamic block vs. stored fallback.
    let mut dyn_bits: u64 = 3 + 5 + 5 + 4 + (hclen as u64) * 3;
    for &(sym, ebits, _) in &rle {
        dyn_bits += cl_lens[sym as usize] as u64 + ebits as u64;
    }
    for s in 0..286 {
        let extra = if s >= 257 { LEN_EXTRA[s - 257] as u64 } else { 0 };
        dyn_bits += lit_freq[s] * (lit_lens[s] as u64 + extra);
    }
    for d in 0..30 {
        dyn_bits += dist_freq[d] * (dist_lens[d] as u64 + DIST_EXTRA[d] as u64);
    }
    let stored_subblocks = span.len().div_ceil(0xFFFF).max(1) as u64;
    let stored_bits = 8 * span.len() as u64 + 48 * stored_subblocks;
    if stored_bits < dyn_bits {
        write_stored(bw, span, bfinal);
        return;
    }

    bw.put(bfinal as u32, 1);
    bw.put(0b10, 2); // BTYPE=10: dynamic Huffman
    bw.put((hlit - 257) as u32, 5);
    bw.put((hdist - 1) as u32, 5);
    bw.put((hclen - 4) as u32, 4);
    for &ord in &CL_ORDER[..hclen] {
        bw.put(cl_lens[ord] as u32, 3);
    }
    for &(sym, ebits, eval) in &rle {
        bw.put_huff(cl_codes[sym as usize], cl_lens[sym as usize]);
        if ebits > 0 {
            bw.put(eval as u32, ebits as u32);
        }
    }
    for t in toks {
        match *t {
            Tok::Lit(b) => bw.put_huff(lit_codes[b as usize], lit_lens[b as usize]),
            Tok::Match { len, dist } => {
                let (li, di) = (length_index(len as usize), dist_index(dist as usize));
                bw.put_huff(lit_codes[257 + li], lit_lens[257 + li]);
                if LEN_EXTRA[li] > 0 {
                    bw.put((len - LEN_BASE[li]) as u32, LEN_EXTRA[li] as u32);
                }
                bw.put_huff(dist_codes[di], dist_lens[di]);
                if DIST_EXTRA[di] > 0 {
                    bw.put((dist - DIST_BASE[di]) as u32, DIST_EXTRA[di] as u32);
                }
            }
        }
    }
    bw.put_huff(lit_codes[256], lit_lens[256]);
}

/// Emit `span` as stored (BTYPE=00) sub-blocks of ≤65535 bytes.
fn write_stored(bw: &mut BitWriter, span: &[u8], bfinal: bool) {
    let mut off = 0;
    loop {
        let n = (span.len() - off).min(0xFFFF);
        let last = off + n == span.len();
        bw.put((bfinal && last) as u32, 1);
        bw.put(0b00, 2);
        bw.align_byte();
        bw.put_bytes(&(n as u16).to_le_bytes());
        bw.put_bytes(&(!(n as u16)).to_le_bytes());
        bw.put_bytes(&span[off..off + n]);
        off += n;
        if last {
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

/// Decode an 8-bit RGBA non-interlaced PNG (the only shape this
/// pipeline produces). Verifies chunk CRCs and the zlib Adler-32.
/// Returns (width, height, rgba).
pub fn decode_rgba(png: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    if png.len() < 8 || png[..8] != [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
        return Err("not a PNG (bad signature)".into());
    }
    let (mut width, mut height, mut seen_ihdr) = (0u32, 0u32, false);
    let mut bpp = 4usize;
    let mut zdata = Vec::new();
    let mut pos = 8;
    loop {
        if pos + 8 > png.len() {
            return Err("truncated chunk header".into());
        }
        let len = u32::from_be_bytes(png[pos..pos + 4].try_into().unwrap()) as usize;
        let kind = &png[pos + 4..pos + 8];
        if pos + 8 + len + 4 > png.len() {
            return Err("truncated chunk payload".into());
        }
        let payload = &png[pos + 8..pos + 8 + len];
        let mut crc = Crc::new();
        crc.update(kind);
        crc.update(payload);
        let want = u32::from_be_bytes(png[pos + 8 + len..pos + 12 + len].try_into().unwrap());
        if crc.finish() != want {
            return Err(format!("bad CRC in {} chunk", String::from_utf8_lossy(kind)));
        }
        match kind {
            b"IHDR" => {
                if payload.len() != 13 {
                    return Err("bad IHDR length".into());
                }
                width = u32::from_be_bytes(payload[0..4].try_into().unwrap());
                height = u32::from_be_bytes(payload[4..8].try_into().unwrap());
                // 8-bit non-interlaced RGBA (6) or RGB (2 — what sips
                // emits when converting the alpha-less JPG atlases);
                // RGB expands to RGBA after unfiltering.
                if payload[8..13] == [8, 6, 0, 0, 0] {
                    bpp = 4;
                } else if payload[8..13] == [8, 2, 0, 0, 0] {
                    bpp = 3;
                } else {
                    return Err("unsupported PNG (need 8-bit RGB/RGBA, non-interlaced)".into());
                }
                seen_ihdr = true;
            }
            b"IDAT" => zdata.extend_from_slice(payload),
            b"IEND" => break,
            _ => {} // ancillary chunks: ignore
        }
        pos += 12 + len;
    }
    if !seen_ihdr {
        return Err("missing IHDR".into());
    }
    if zdata.len() < 6 {
        return Err("zlib stream too short".into());
    }
    if zdata[0] & 0x0F != 8 || (u16::from_be_bytes([zdata[0], zdata[1]])) % 31 != 0 {
        return Err("bad zlib header".into());
    }
    let raw = inflate(&zdata[2..zdata.len() - 4])?;
    let want_adler = u32::from_be_bytes(zdata[zdata.len() - 4..].try_into().unwrap());
    if adler32(&raw) != want_adler {
        return Err("Adler-32 mismatch".into());
    }
    let px = unfilter(width as usize, height as usize, &raw, bpp)?;
    let rgba = if bpp == 4 {
        px
    } else {
        let mut out = Vec::with_capacity(px.len() / 3 * 4);
        for p in px.chunks_exact(3) {
            out.extend_from_slice(&[p[0], p[1], p[2], 255]);
        }
        out
    };
    Ok((width, height, rgba))
}

/// Reverse per-row filtering: `data` is height rows of
/// (filter byte + width*bpp filtered bytes).
fn unfilter(width: usize, height: usize, data: &[u8], bpp: usize) -> Result<Vec<u8>, String> {
    let stride = width * bpp;
    if data.len() != (stride + 1) * height {
        return Err("decompressed size does not match dimensions".into());
    }
    let mut out = vec![0u8; stride * height];
    for y in 0..height {
        let ft = data[y * (stride + 1)];
        let row = &data[y * (stride + 1) + 1..(y + 1) * (stride + 1)];
        for x in 0..stride {
            let a = if x >= bpp { out[y * stride + x - bpp] } else { 0 };
            let b = if y > 0 { out[(y - 1) * stride + x] } else { 0 };
            let c = if y > 0 && x >= bpp { out[(y - 1) * stride + x - bpp] } else { 0 };
            out[y * stride + x] = match ft {
                0 => row[x],
                1 => row[x].wrapping_add(a),
                2 => row[x].wrapping_add(b),
                3 => row[x].wrapping_add(((a as u16 + b as u16) / 2) as u8),
                4 => row[x].wrapping_add(paeth(a, b, c)),
                _ => return Err(format!("bad filter type {ft}")),
            };
        }
    }
    Ok(out)
}

/// LSB-first bit reader over a raw DEFLATE stream.
struct BitReader<'a> {
    d: &'a [u8],
    pos: usize,
    buf: u64,
    n: u32,
}

impl<'a> BitReader<'a> {
    fn new(d: &'a [u8]) -> Self {
        BitReader { d, pos: 0, buf: 0, n: 0 }
    }
    fn bits(&mut self, want: u32) -> Result<u32, String> {
        while self.n < want {
            if self.pos >= self.d.len() {
                return Err("unexpected end of deflate stream".into());
            }
            self.buf |= (self.d[self.pos] as u64) << self.n;
            self.pos += 1;
            self.n += 8;
        }
        let v = (self.buf & ((1u64 << want) - 1)) as u32;
        self.buf >>= want;
        self.n -= want;
        Ok(v)
    }
    fn align_byte(&mut self) {
        let drop = self.n % 8;
        self.buf >>= drop;
        self.n -= drop;
    }
}

/// Canonical Huffman decoding table: symbol counts per code length +
/// symbols sorted by (length, symbol). Decoding walks lengths
/// bit-by-bit (Mark Adler's `puff` scheme) — plenty fast for the
/// pipeline's decode-verify-recompress uses.
struct HuffDec {
    counts: [u16; 16],
    syms: Vec<u16>,
}

impl HuffDec {
    fn new(lens: &[u8]) -> Self {
        let mut counts = [0u16; 16];
        for &l in lens {
            counts[l as usize] += 1;
        }
        counts[0] = 0;
        let mut offs = [0usize; 16];
        for l in 1..15 {
            offs[l + 1] = offs[l] + counts[l] as usize;
        }
        let mut syms = vec![0u16; lens.iter().filter(|&&l| l > 0).count()];
        for (s, &l) in lens.iter().enumerate() {
            if l > 0 {
                syms[offs[l as usize]] = s as u16;
                offs[l as usize] += 1;
            }
        }
        HuffDec { counts, syms }
    }
    fn decode(&self, br: &mut BitReader) -> Result<u16, String> {
        let (mut code, mut first, mut index) = (0usize, 0usize, 0usize);
        for len in 1..=15 {
            code |= br.bits(1)? as usize;
            let count = self.counts[len] as usize;
            if code < first + count {
                return Ok(self.syms[index + code - first]);
            }
            index += count;
            first = (first + count) << 1;
            code <<= 1;
        }
        Err("invalid Huffman code".into())
    }
}

/// Inflate a raw DEFLATE stream (stored, fixed, and dynamic blocks).
fn inflate(d: &[u8]) -> Result<Vec<u8>, String> {
    let mut br = BitReader::new(d);
    let mut out = Vec::new();
    loop {
        let bfinal = br.bits(1)?;
        match br.bits(2)? {
            0b00 => {
                br.align_byte();
                let len = br.bits(16)? as usize;
                let nlen = br.bits(16)? as usize;
                if len != !nlen & 0xFFFF {
                    return Err("stored block LEN/NLEN mismatch".into());
                }
                // Drain whole bytes buffered in the reader, then bulk-copy.
                let mut remaining = len;
                while remaining > 0 && br.n >= 8 {
                    out.push(br.bits(8)? as u8);
                    remaining -= 1;
                }
                if br.pos + remaining > br.d.len() {
                    return Err("stored block overruns input".into());
                }
                out.extend_from_slice(&br.d[br.pos..br.pos + remaining]);
                br.pos += remaining;
            }
            btype @ (0b01 | 0b10) => {
                let (lit_dec, dist_dec) = if btype == 0b01 {
                    let mut ll = [8u8; 288];
                    ll[144..256].fill(9);
                    ll[256..280].fill(7);
                    (HuffDec::new(&ll), HuffDec::new(&[5u8; 30]))
                } else {
                    let hlit = br.bits(5)? as usize + 257;
                    let hdist = br.bits(5)? as usize + 1;
                    let hclen = br.bits(4)? as usize + 4;
                    let mut cl_lens = [0u8; 19];
                    for &ord in &CL_ORDER[..hclen] {
                        cl_lens[ord] = br.bits(3)? as u8;
                    }
                    let cl_dec = HuffDec::new(&cl_lens);
                    let mut lens = Vec::with_capacity(hlit + hdist);
                    while lens.len() < hlit + hdist {
                        match cl_dec.decode(&mut br)? {
                            16 => {
                                let &last =
                                    lens.last().ok_or("repeat code with no previous length")?;
                                for _ in 0..3 + br.bits(2)? {
                                    lens.push(last);
                                }
                            }
                            17 => {
                                let n = 3 + br.bits(3)? as usize;
                                lens.extend(std::iter::repeat_n(0, n));
                            }
                            18 => {
                                let n = 11 + br.bits(7)? as usize;
                                lens.extend(std::iter::repeat_n(0, n));
                            }
                            l => lens.push(l as u8),
                        }
                    }
                    if lens.len() != hlit + hdist {
                        return Err("code length repeat overran table".into());
                    }
                    (HuffDec::new(&lens[..hlit]), HuffDec::new(&lens[hlit..]))
                };
                loop {
                    let sym = lit_dec.decode(&mut br)? as usize;
                    match sym {
                        0..=255 => out.push(sym as u8),
                        256 => break,
                        257..=285 => {
                            let li = sym - 257;
                            let len =
                                LEN_BASE[li] as usize + br.bits(LEN_EXTRA[li] as u32)? as usize;
                            let di = dist_dec.decode(&mut br)? as usize;
                            if di >= 30 {
                                return Err("invalid distance code".into());
                            }
                            let dist =
                                DIST_BASE[di] as usize + br.bits(DIST_EXTRA[di] as u32)? as usize;
                            if dist > out.len() {
                                return Err("distance beyond output start".into());
                            }
                            let start = out.len() - dist;
                            for k in 0..len {
                                out.push(out[start + k]);
                            }
                        }
                        _ => return Err("invalid literal/length symbol".into()),
                    }
                }
            }
            _ => return Err("reserved block type".into()),
        }
        if bfinal == 1 {
            return Ok(out);
        }
    }
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

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

    /// Deterministic pseudo-random bytes (no rand crate).
    fn lcg_bytes(n: usize, mut seed: u64) -> Vec<u8> {
        let mut v = Vec::with_capacity(n);
        for _ in 0..n {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            v.push((seed >> 33) as u8);
        }
        v
    }

    fn roundtrip(w: u32, h: u32, rgba: &[u8]) {
        let png = encode_rgba(w, h, rgba);
        let (dw, dh, back) = decode_rgba(&png).expect("decode failed");
        assert_eq!((dw, dh), (w, h));
        assert!(back == rgba, "pixels changed in {w}x{h} roundtrip");
    }

    #[test]
    fn roundtrip_gradient_is_lossless_and_compresses() {
        // Smooth gradient + alpha ramp: the dynamic-Huffman path.
        let (w, h) = (257u32, 91u32);
        let mut rgba = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                rgba.extend_from_slice(&[
                    (x % 256) as u8,
                    (y % 256) as u8,
                    ((x + y) % 256) as u8,
                    (255 - (y % 128)) as u8,
                ]);
            }
        }
        let png = encode_rgba(w, h, &rgba);
        roundtrip(w, h, &rgba);
        // Raw is ~93 KB; the gradient must compress far below stored size.
        assert!(
            png.len() < rgba.len() / 4,
            "gradient compressed poorly: {} vs raw {}",
            png.len(),
            rgba.len()
        );
    }

    #[test]
    fn roundtrip_random_is_lossless() {
        // High-entropy input: exercises the stored-block fallback.
        let (w, h) = (129u32, 64u32);
        let rgba = lcg_bytes((w * h * 4) as usize, 0xC0FFEE);
        roundtrip(w, h, &rgba);
    }

    #[test]
    fn roundtrip_edge_shapes() {
        roundtrip(1, 1, &[7, 8, 9, 10]);
        roundtrip(1, 300, &lcg_bytes(1200, 42)); // tall & thin
        roundtrip(300, 1, &vec![128; 1200]); // solid colour row
        // Long solid image: exercises long matches + 16/17/18 RLE codes.
        roundtrip(64, 64, &vec![0; 64 * 64 * 4]);
    }

    #[test]
    fn decodes_legacy_stored_block_pngs() {
        // The pre-compression encoder emitted stored DEFLATE blocks;
        // the decoder must keep reading those files (recompress tooling).
        let rgba = [1, 2, 3, 4, 5, 6, 7, 8];
        let mut png = Vec::new();
        png.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&2u32.to_be_bytes());
        ihdr.extend_from_slice(&1u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
        chunk(&mut png, b"IHDR", &ihdr);
        let raw = [0u8, 1, 2, 3, 4, 5, 6, 7, 8]; // filter 0 + pixels
        let mut idat = vec![0x78, 0x01, 0x01]; // zlib hdr + BFINAL/stored
        idat.extend_from_slice(&9u16.to_le_bytes());
        idat.extend_from_slice(&(!9u16).to_le_bytes());
        idat.extend_from_slice(&raw);
        idat.extend_from_slice(&adler32(&raw).to_be_bytes());
        chunk(&mut png, b"IDAT", &idat);
        chunk(&mut png, b"IEND", &[]);
        let (w, h, back) = decode_rgba(&png).expect("legacy decode failed");
        assert_eq!((w, h), (2, 1));
        assert_eq!(back, rgba);
    }
}
