//! Edge geometry: arc center/radius/sweep + SVG path-piece emission.
//! Reverse-engineered from PoB's PassiveTree.lua BuildConnector +
//! BuildArc functions (data/pob2/src/Classes/PassiveTree.lua).

use std::fmt::Write as _;

use crate::model::{ArcGeom, Canvas, Node};

// =========================================================================
// === Connection rendering: orbit-PNG arcs (PoB-faithful).               ===
// =========================================================================
//
// Algorithm reverse-engineered from PoB's PassiveTree.lua BuildConnector
// (the source-of-truth at data/pob2/src/Classes/PassiveTree.lua:563-677)
// and BuildArc (lines 679-719).
//
// Per-connection orbit hint (`conn_orbit`, GGG's `connection.orbit` field):
//   * i32::MAX  → hidden/proxy: do not render.
//   * != 0      → draw an arc on orbit |conn_orbit| (radius from orbitRadii).
//                 The arc's CENTER is *not* either node's group; it's the
//                 unique point equidistant (= r) from both nodes, on the
//                 side picked by sign(conn_orbit). Computed via the
//                 perpendicular formula PoB uses (lines 581-584).
//   * == 0 AND same-group, same-orbit → arc along that orbit, centered on
//                 the shared group's coordinate (PoB lines 625-654).
//   * == 0 otherwise → straight line between the two nodes.
//
// PoB renders each arc segment with one of nine 90° quadrant PNGs:
//   Orbit1Normal → orbit_normal9.png  (smallest)
//   Orbit2Normal → orbit_normal8.png
//   ...
//   Orbit9Normal → orbit_normal1.png  (largest)
//   plus orbit_normal7.png for orbit 7 (the in-between radius).
// We use SVG `<path d="A …">` elliptical-arc strokes instead of the
// orbit PNGs — `<image>` placement can't reproduce PoB's UV-clipped
// kite quad (which is what produces a correctly-sized arc between
// arbitrary endpoints on an orbit), so the rotated-PNG approach cuts
// arcs short whenever the synthesised orbit radius doesn't match the
// PNG's pixel radius (every cross-orbit "drape" edge in PoE2). The
// path stroke uses the GGG-supplied orbit radius and the actual
// endpoint angles (atan2), so geometry is correct by construction.
// Trade-off: we lose the PNG's subtle texture — replaced with a flat
// faint colour matching the unallocated/Normal state.

/// Compute the arc geometry (center + radius + signed sweep) for an edge,
/// or `None` if the edge should be drawn as a straight line / skipped.
/// Mirrors PoB's BuildConnector branches (PassiveTree.lua:581-655).
pub(crate) fn arc_geom_for(
    na: &Node,
    nb: &Node,
    conn_orbit: i32,
    canvas: &Canvas,
) -> Option<ArcGeom> {
    if conn_orbit == i32::MAX {
        return None;
    }
    let abs_orbit = conn_orbit.unsigned_abs() as usize;

    // Branch 1: explicit orbit hint, with a valid orbit radius.
    if conn_orbit != 0 && abs_orbit < canvas.orbit_radii.len() {
        let r = canvas.orbit_radii[abs_orbit];
        if r > 0.0 {
            let dx = nb.x - na.x;
            let dy = nb.y - na.y;
            let dist = (dx * dx + dy * dy).sqrt();
            if dist > 0.0 && dist < r * 2.0 {
                let half_chord = dist / 2.0;
                let perp_len = (r * r - half_chord * half_chord).sqrt();
                let sign = if conn_orbit > 0 { 1.0 } else { -1.0 };
                let perp = perp_len * sign;
                let cx = na.x + dx / 2.0 + perp * (dy / dist);
                let cy = na.y + dy / 2.0 - perp * (dx / dist);
                // Pick the SHORTER arc going from na to nb around (cx, cy).
                // PoB at PassiveTree.lua:591-598 sorts the endpoint angles
                // then takes 2π-arcAngle when the direct sweep is ≥ π,
                // i.e. always renders the short arc regardless of which
                // side the perp sign put the center on. Our arc_signed_sweep
                // wraps to (-π, π] which is exactly that: the signed
                // shorter sweep; sign tells SVG sweep-flag which winding.
                let sweep = arc_signed_sweep(na, nb, cx, cy);
                let mid_angle = arc_mid_angle(na, nb, cx, cy);
                return Some(ArcGeom {
                    cx,
                    cy,
                    r,
                    sweep,
                    mid_angle,
                    orbit_num: abs_orbit as u32,
                });
            }
        }
        return None;
    }

    // Branch 2: conn_orbit == 0 AND same group AND same orbit → arc
    // through the group center (PoB's `elseif` branch).
    if conn_orbit == 0 && na.group == nb.group && na.orbit == nb.orbit {
        let &(cx, cy) = canvas.groups.get(&na.group)?;
        let r = canvas
            .orbit_radii
            .get(na.orbit as usize)
            .copied()
            .unwrap_or(0.0);
        if r <= 0.0 {
            return None;
        }
        let sweep = arc_signed_sweep(na, nb, cx, cy);
        let mid_angle = arc_mid_angle(na, nb, cx, cy);
        return Some(ArcGeom {
            cx,
            cy,
            r,
            sweep,
            mid_angle,
            orbit_num: na.orbit,
        });
    }

    None
}

/// Mid-arc angle (math atan2 convention) around (cx, cy). The textured
/// PNG renderer rotates the sprite by this angle relative to its baked
/// NW midpoint (at -3π/4 in screen coords) so the arc's middle stays
/// on the chord midpoint.
pub(crate) fn arc_mid_angle(na: &Node, nb: &Node, cx: f64, cy: f64) -> f64 {
    let a = (na.y - cy).atan2(na.x - cx);
    let b = (nb.y - cy).atan2(nb.x - cx);
    let mut delta = b - a;
    let pi = std::f64::consts::PI;
    while delta > pi {
        delta -= 2.0 * pi;
    }
    while delta < -pi {
        delta += 2.0 * pi;
    }
    a + delta / 2.0
}

/// Signed shorter-arc sweep from na to nb around (cx, cy), in radians.
/// Returns the delta in (-π, π], so |sweep| is always the shorter arc.
/// Sign: positive = CCW in math (= CW in screen y-down).
pub(crate) fn arc_signed_sweep(na: &Node, nb: &Node, cx: f64, cy: f64) -> f64 {
    let a = (na.y - cy).atan2(na.x - cx);
    let b = (nb.y - cy).atan2(nb.x - cx);
    let mut delta = b - a;
    let pi = std::f64::consts::PI;
    while delta > pi {
        delta -= 2.0 * pi;
    }
    while delta < -pi {
        delta += 2.0 * pi;
    }
    delta
}

/// One SVG <path d="..."> piece for a single edge, expressed in canvas
/// coords. Geometry-only — no styling. Used both for the static base
/// layer (concatenated into one `<path>`) and for the dynamic
/// `edges-sel` gold overlay (rebuilt by JS from EDGE_DATA on selection
/// change).
///
/// Returns the SVG-path piece for one edge. Always emits geometry —
/// even orbit == i32::MAX gets a straight line. PoB's BuildConnector
/// falls through both arc branches for MAX (orbitRadii lookup misses,
/// elseif fails) and lands on the LineConnector path at
/// PassiveTree.lua:660 — drawing a plain straight line. Previously we
/// were skipping these 124 edges entirely as "hidden proxies", which
/// left nodes like Deep Freeze and Nurturing Guardian isolated.
pub(crate) fn edge_path_piece(na: &Node, nb: &Node, conn_orbit: i32, canvas: &Canvas) -> String {
    let mut piece = String::with_capacity(80);
    if let Some(geom) = arc_geom_for(na, nb, conn_orbit, canvas) {
        // SVG elliptical arc: A rx ry x-axis-rotation large-arc-flag sweep-flag x y
        // sweep-flag follows screen-y-down convention: 1 = CW in SVG,
        // which corresponds to positive math-angle delta (= CCW math).
        // large-arc-flag is 0 since arc_signed_sweep clamps |sweep| ≤ π.
        let large_arc = 0;
        let sweep = if geom.sweep > 0.0 { 1 } else { 0 };
        let _ = write!(
            piece,
            "M{:.1} {:.1}A{:.1} {:.1} 0 {} {} {:.1} {:.1}",
            na.x, na.y, geom.r, geom.r, large_arc, sweep, nb.x, nb.y
        );
        return piece;
    }
    // Straight line fallback (also the conn_orbit == 0 cross-group case).
    let _ = write!(piece, "M{:.1} {:.1}L{:.1} {:.1}", na.x, na.y, nb.x, nb.y);
    piece
}
