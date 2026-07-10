// ---------------------------------------------------------------------
// Vertex emission helpers
// ---------------------------------------------------------------------
//
// pushSprite emits 6 vertices (two triangles, no index buffer — the
// index overhead is negligible compared to the JS push cost). Each
// vertex carries pos/uv/tint/offset/local (12 floats). Quads are
// axis-aligned to keep the format simple; rotation is handled by the
// caller (it bakes rotated corners into pos).

// Tint is an RGBA quadruple in the 0..1 range, pushed verbatim into
// the per-vertex attribute. Keeping it as a fixed-length tuple makes
// tsc enforce "exactly four channels" at call sites.
export type Tint = readonly [number, number, number, number];
// Vertex buffer is a flat array of floats; each push appends 12.
export type VertexBuf = number[];

export function pushSprite(
  arr: VertexBuf, x: number, y: number, w: number, h: number,
  tint: Tint, clipIcon: boolean,
): void {
  // 4 corners: TL, TR, BL, BR
  const hw = w * 0.5, hh = h * 0.5;
  const x0 = x - hw, x1 = x + hw, y0 = y - hh, y1 = y + hh;
  const lx = clipIcon ? 1 : 0;
  // 6 verts = 2 triangles (TL TR BL) + (TR BR BL)
  pushVtx(arr, x0, y0, 0, 0, tint, 0, 0, -lx, -lx);  // TL
  pushVtx(arr, x1, y0, 1, 0, tint, 0, 0,  lx, -lx);  // TR
  pushVtx(arr, x0, y1, 0, 1, tint, 0, 0, -lx,  lx);  // BL
  pushVtx(arr, x1, y0, 1, 0, tint, 0, 0,  lx, -lx);  // TR
  pushVtx(arr, x1, y1, 1, 1, tint, 0, 0,  lx,  lx);  // BR
  pushVtx(arr, x0, y1, 0, 1, tint, 0, 0, -lx,  lx);  // BL
}
// Emit a quad with an explicit UV rectangle (used for the background
// tile, where UVs span world / tile-size to repeat).
export function pushSpriteUV(
  arr: VertexBuf, x: number, y: number, w: number, h: number,
  u0: number, v0: number, u1: number, v1: number, tint: Tint,
): void {
  const hw = w * 0.5, hh = h * 0.5;
  const x0 = x - hw, x1 = x + hw, y0 = y - hh, y1 = y + hh;
  pushVtx(arr, x0, y0, u0, v0, tint, 0, 0, 0, 0);
  pushVtx(arr, x1, y0, u1, v0, tint, 0, 0, 0, 0);
  pushVtx(arr, x0, y1, u0, v1, tint, 0, 0, 0, 0);
  pushVtx(arr, x1, y0, u1, v0, tint, 0, 0, 0, 0);
  pushVtx(arr, x1, y1, u1, v1, tint, 0, 0, 0, 0);
  pushVtx(arr, x0, y1, u0, v1, tint, 0, 0, 0, 0);
}
// Rotated sprite (used for BGTreeActive). Rotates the 4 corners by
// `cos/sin` around (cx, cy) before baking them as world coords.
export function pushSpriteRot(
  arr: VertexBuf, cx: number, cy: number, w: number, h: number,
  cos_: number, sin_: number, tint: Tint,
): void {
  const hw = w * 0.5, hh = h * 0.5;
  function rot(px: number, py: number): [number, number] {
    const x = px * cos_ - py * sin_;
    const y = px * sin_ + py * cos_;
    return [cx + x, cy + y];
  }
  const tl = rot(-hw, -hh);
  const tr = rot( hw, -hh);
  const bl = rot(-hw,  hh);
  const br = rot( hw,  hh);
  pushVtx(arr, tl[0], tl[1], 0, 0, tint, 0, 0, 0, 0);
  pushVtx(arr, tr[0], tr[1], 1, 0, tint, 0, 0, 0, 0);
  pushVtx(arr, bl[0], bl[1], 0, 1, tint, 0, 0, 0, 0);
  pushVtx(arr, tr[0], tr[1], 1, 0, tint, 0, 0, 0, 0);
  pushVtx(arr, br[0], br[1], 1, 1, tint, 0, 0, 0, 0);
  pushVtx(arr, bl[0], bl[1], 0, 1, tint, 0, 0, 0, 0);
}
// Straight-line segment: one quad with the perpendicular normal in
// a_offset. u_offset_scale at draw time turns this into a constant
// CSS-px-wide stroke regardless of zoom.
export function pushLineSeg(
  arr: VertexBuf, x1: number, y1: number, x2: number, y2: number, tint: Tint,
): void {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  pushVtx(arr, x1, y1, 0, 0, tint,  nx,  ny, 0, 0);
  pushVtx(arr, x2, y2, 1, 0, tint,  nx,  ny, 0, 0);
  pushVtx(arr, x1, y1, 0, 1, tint, -nx, -ny, 0, 0);
  pushVtx(arr, x2, y2, 1, 0, tint,  nx,  ny, 0, 0);
  pushVtx(arr, x2, y2, 1, 1, tint, -nx, -ny, 0, 0);
  pushVtx(arr, x1, y1, 0, 1, tint, -nx, -ny, 0, 0);
}

// Tessellated circular arc. Each polyline vertex uses the RADIAL unit
// vector (cos ang, sin ang) as its normal — geometrically exact for a
// circle, so adjacent quads share their corners and produce no joint
// notch. Compare with naive per-segment perpendicular tessellation
// which leaves tiny gaps at the outside of each kink and reads as
// visibly "crooked" curves.
//
// Subdivision: 3° per segment (Math.PI/60), minimum 24 segments. The
// chord-deviation from a true circle at this density is r*(1-cos(1.5°))
// ≈ 0.034% of r — sub-pixel at any sane zoom. Combined with the
// fragment-shader edge AA, arcs read as smooth curves rather than
// polygons.
export function pushArc(
  arr: VertexBuf, cx: number, cy: number, r: number,
  a1: number, delta: number, dx: number, dy: number, tint: Tint,
): void {
  const segs = Math.max(24, Math.ceil(Math.abs(delta) / (Math.PI / 60)));
  const prevA = a1;
  let px = cx + r * Math.cos(prevA) + dx;
  let py = cy + r * Math.sin(prevA) + dy;
  let pnx = Math.cos(prevA), pny = Math.sin(prevA);
  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    const ang = a1 + delta * t;
    const x = cx + r * Math.cos(ang) + dx;
    const y = cy + r * Math.sin(ang) + dy;
    const nx = Math.cos(ang), ny = Math.sin(ang);
    pushVtx(arr, px, py, 0, 0, tint,  pnx,  pny, 0, 0);
    pushVtx(arr,  x,  y, 1, 0, tint,   nx,   ny, 0, 0);
    pushVtx(arr, px, py, 0, 1, tint, -pnx, -pny, 0, 0);
    pushVtx(arr,  x,  y, 1, 0, tint,   nx,   ny, 0, 0);
    pushVtx(arr,  x,  y, 1, 1, tint,  -nx,  -ny, 0, 0);
    pushVtx(arr, px, py, 0, 1, tint, -pnx, -pny, 0, 0);
    px = x; py = y; pnx = nx; pny = ny;
  }
}

// Dashed-line variants — bake cumulative world-distance into v_uv.x so
// the fragment shader can mod(v_uv.x, dash_period) and discard the
// gap portion of each dash cycle. Used only for preview overlays
// (allocate/deallocate paths); main + sel edges use the plain pushArc
// / pushLineSeg above.
export function pushLineSegD(
  arr: VertexBuf, x1: number, y1: number, x2: number, y2: number,
  tint: Tint, startDist: number,
): number {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const d0 = startDist, d1 = startDist + len;
  pushVtx(arr, x1, y1, d0, 0, tint,  nx,  ny, 0, 0);
  pushVtx(arr, x2, y2, d1, 0, tint,  nx,  ny, 0, 0);
  pushVtx(arr, x1, y1, d0, 1, tint, -nx, -ny, 0, 0);
  pushVtx(arr, x2, y2, d1, 0, tint,  nx,  ny, 0, 0);
  pushVtx(arr, x2, y2, d1, 1, tint, -nx, -ny, 0, 0);
  pushVtx(arr, x1, y1, d0, 1, tint, -nx, -ny, 0, 0);
  return d1;
}
export function pushArcD(
  arr: VertexBuf, cx: number, cy: number, r: number,
  a1: number, delta: number, dx: number, dy: number, tint: Tint, startDist: number,
): number {
  const segs = Math.max(24, Math.ceil(Math.abs(delta) / (Math.PI / 60)));
  let dist = startDist;
  const prevA = a1;
  let px = cx + r * Math.cos(prevA) + dx;
  let py = cy + r * Math.sin(prevA) + dy;
  let pnx = Math.cos(prevA), pny = Math.sin(prevA);
  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    const ang = a1 + delta * t;
    const x = cx + r * Math.cos(ang) + dx;
    const y = cy + r * Math.sin(ang) + dy;
    const nx = Math.cos(ang), ny = Math.sin(ang);
    const segLen = Math.hypot(x - px, y - py);
    const newDist = dist + segLen;
    pushVtx(arr, px, py, dist,    0, tint,  pnx,  pny, 0, 0);
    pushVtx(arr,  x,  y, newDist, 0, tint,   nx,   ny, 0, 0);
    pushVtx(arr, px, py, dist,    1, tint, -pnx, -pny, 0, 0);
    pushVtx(arr,  x,  y, newDist, 0, tint,   nx,   ny, 0, 0);
    pushVtx(arr,  x,  y, newDist, 1, tint,  -nx,  -ny, 0, 0);
    pushVtx(arr, px, py, dist,    1, tint, -pnx, -pny, 0, 0);
    px = x; py = y; pnx = nx; pny = ny;
    dist = newDist;
  }
  return dist;
}

export function pushVtx(
  arr: VertexBuf, x: number, y: number, u: number, v: number, t: Tint,
  ox: number, oy: number, lx: number, ly: number,
): void {
  arr.push(x, y, u, v, t[0], t[1], t[2], t[3], ox, oy, lx, ly);
}
