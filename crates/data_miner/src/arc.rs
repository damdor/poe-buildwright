//! Synthesise the passive-tree's per-orbit **connector arc** sprites.
//!
//! GGG ships only a straight connector *line* texture
//! (`passiveskillscreenline<state>` — a horizontal band with a soft glow
//! cross-section). The renderer, however, samples a per-orbit *arc*
//! sprite whose curvature is baked into the pixel alpha (the WebGL
//! kite-quad maps the texture onto a corner; the alpha carves the arc —
//! see `tree_render/assets/planner/edge_tessellate.ts`). GGG doesn't
//! ship those arcs, so we generate them first-party: bend the line's
//! cross-section into a quarter circle of the orbit's radius, centred at
//! the sprite's bottom-right corner (which the kite maps to the orbit
//! centre).
//!
//! Reverse-engineered from the reference sprites: for orbit 1 the sprite
//! is 91 px with the arc band at radius ≈ 82 px from the BR corner and a
//! ~11 px core — exactly the line texture's solid band.

use crate::dds::Image;

/// The perpendicular cross-section of a connector line texture: one RGBA
/// sample per row, plus the alpha-weighted centre row (the line's spine).
pub struct LineProfile {
    pub center: f32,
    pub rows: Vec<[u8; 4]>,
}

/// Extract the cross-section of a horizontal line texture (the line runs
/// along the width; the profile is a single column).
pub fn line_profile(line: &Image) -> LineProfile {
    let (w, h) = (line.width as usize, line.height as usize);
    let x = w / 2;
    let mut rows = Vec::with_capacity(h);
    let (mut wsum, mut asum) = (0.0f32, 0.0f32);
    for y in 0..h {
        let o = (y * w + x) * 4;
        let px = [
            line.rgba[o],
            line.rgba[o + 1],
            line.rgba[o + 2],
            line.rgba[o + 3],
        ];
        wsum += y as f32 * px[3] as f32;
        asum += px[3] as f32;
        rows.push(px);
    }
    let center = if asum > 0.0 {
        wsum / asum
    } else {
        h as f32 / 2.0
    };
    LineProfile { center, rows }
}

/// A `size`×`size` quarter-arc sprite: the line cross-section swept around
/// a circle of `radius`, centred at the bottom-right corner. Antialiased
/// by sampling the profile at the fractional radial offset.
pub fn synth_arc(p: &LineProfile, size: u32, radius: f32) -> Image {
    let s = size as usize;
    let mut rgba = vec![0u8; s * s * 4];
    let (cx, cy) = ((s - 1) as f32, (s - 1) as f32);
    for y in 0..s {
        for x in 0..s {
            let d = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt();
            // Radial distance from the ideal arc → position along the
            // line's cross-section.
            let row = p.center + (d - radius);
            let px = sample(p, row);
            if px[3] > 0 {
                let o = (y * s + x) * 4;
                rgba[o..o + 4].copy_from_slice(&px);
            }
        }
    }
    Image {
        width: size,
        height: size,
        rgba,
    }
}

/// A straight connector strip (orbit 0): the line cross-section stretched
/// to `width`, cropped to its non-transparent band. Used for the
/// straight-line connectors between a group's centre and its ring.
pub fn synth_line(p: &LineProfile, width: u32) -> Image {
    let first = p.rows.iter().position(|r| r[3] > 0).unwrap_or(0);
    let last = p
        .rows
        .iter()
        .rposition(|r| r[3] > 0)
        .unwrap_or(p.rows.len().saturating_sub(1));
    let h = last.saturating_sub(first) + 1;
    let mut rgba = vec![0u8; width as usize * h * 4];
    for (y, row) in (first..=last).enumerate() {
        let c = p.rows[row];
        for x in 0..width as usize {
            let o = (y * width as usize + x) * 4;
            rgba[o..o + 4].copy_from_slice(&c);
        }
    }
    Image {
        width,
        height: h as u32,
        rgba,
    }
}

/// Linearly interpolate the profile at a fractional row (antialiasing the
/// arc's soft edges); out-of-range → transparent.
fn sample(p: &LineProfile, row: f32) -> [u8; 4] {
    if row < 0.0 || row >= (p.rows.len() - 1) as f32 {
        return [0, 0, 0, 0];
    }
    let i = row.floor() as usize;
    let f = row - i as f32;
    let a = p.rows[i];
    let b = p.rows[i + 1];
    let lerp = |x: u8, y: u8| (x as f32 * (1.0 - f) + y as f32 * f).round() as u8;
    [
        lerp(a[0], b[0]),
        lerp(a[1], b[1]),
        lerp(a[2], b[2]),
        lerp(a[3], b[3]),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A synthetic line: 44 rows, solid opaque band at rows 16..27.
    fn fake_line() -> Image {
        let (w, h) = (64usize, 44usize);
        let mut rgba = vec![0u8; w * h * 4];
        for y in 16..27 {
            for x in 0..w {
                let o = (y * w + x) * 4;
                rgba[o..o + 4].copy_from_slice(&[200, 180, 120, 255]);
            }
        }
        Image {
            width: w as u32,
            height: h as u32,
            rgba,
        }
    }

    #[test]
    fn profile_centres_on_the_band() {
        let p = line_profile(&fake_line());
        assert!((p.center - 21.0).abs() < 1.0, "center {}", p.center);
        assert_eq!(p.rows.len(), 44);
    }

    #[test]
    fn arc_band_sits_at_the_radius() {
        // orbit-1-ish: 91 px sprite, radius 82.
        let p = line_profile(&fake_line());
        let img = synth_arc(&p, 91, 82.0);
        let s = 91usize;
        let al = |x: usize, y: usize| img.rgba[(y * s + x) * 4 + 3];
        // Opaque pixels must all lie ~82 px from the BR corner.
        let (cx, cy) = ((s - 1) as f32, (s - 1) as f32);
        let mut n = 0;
        for y in 0..s {
            for x in 0..s {
                if al(x, y) > 100 {
                    let d = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt();
                    assert!((d - 82.0).abs() <= 7.0, "opaque px at d={d}");
                    n += 1;
                }
            }
        }
        assert!(n > 50, "expected an arc, got {n} opaque px");
        // The corners (far from the arc band) are transparent.
        assert_eq!(al(0, 0), 0);
        assert_eq!(al(s - 1, s - 1), 0);
    }
}
