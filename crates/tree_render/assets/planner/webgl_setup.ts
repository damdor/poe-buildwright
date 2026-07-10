// ============================================================================
// === WebGL2 rendering =====================================================
// ============================================================================
//
// Architecture:
//   * One shader program handles every sprite + every line segment.
//     Sprites pass a_offset=(0,0); edges pass a normal direction in
//     a_offset and the shader scales it by u_offset_scale (so the
//     line stays at a constant CSS-pixel width as the user zooms).
//   * Per-vertex a_local encodes the icon's circle-clip coordinates
//     (zero for non-clipped sprites; unit-corner coords for clipped
//     icons). The fragment shader discards pixels outside the unit
//     circle iff u_clip=1.
//   * Static geometry (all unallocated main-tree nodes + main edges)
//     is built once after preload finishes and lives in a single
//     VBO. Per-frame work is then ~constant in node count: bind the
//     static VBO, iterate per-texture sub-batches.
//   * Dynamic overlays (selected frames, picked-attribute icon swaps,
//     class portrait, BGTreeActive, ascendancy panel, hover popout)
//     are emitted into a small streaming VBO that's rewritten as
//     state changes — never larger than a few hundred quads.
//   * Edges tessellate arcs into 6..24 polyline segments depending
//     on arc sweep; each segment is one quad with the normal
//     direction baked. Lines are a single quad each. All edge geometry
//     lives in the same static VBO as sprites.


import { imgCache, texCache } from "./image_preload.ts";
import { gl } from "./state.ts";

export const VS_SRC = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
layout(location=1) in vec2 a_uv;
layout(location=2) in vec4 a_tint;
layout(location=3) in vec2 a_offset;
layout(location=4) in vec2 a_local;
uniform mat3 u_view;
uniform vec2 u_offset_scale;
uniform vec2 u_translate;
out vec2 v_uv;
out vec4 v_tint;
out vec2 v_local;
out vec2 v_offset;
void main() {
vec2 p = a_pos + u_translate + a_offset * u_offset_scale;
vec3 cs = u_view * vec3(p, 1.0);
gl_Position = vec4(cs.xy, 0.0, 1.0);
v_uv = a_uv;
v_tint = a_tint;
v_local = a_local;
v_offset = a_offset;
}`;

// Fragment shader: textured-quad with circle-clip + anti-aliased line
// edges + optional screen-space dash pattern for preview overlays.
//
// - a_offset is the unit normal at each line-edge vertex (0 in the
//   middle, ±1 at the edges). Interpolated, length(v_offset) goes 0
//   at the centerline to 1 at the stroke boundary. fwidth gives the
//   per-pixel rate of change so alpha fades smoothly in the last
//   pixel before the boundary.
// - Sprites bake a_offset=(0,0) everywhere → d=0, fwidth=~0,
//   smoothstep returns 0, aa=1 → no effect.
// - For preview/dashed strokes, the tessellator bakes cumulative
//   world-distance into v_uv.x. The fragment shader takes
//   mod(v_uv.x, period) and discards the gap portion. period/solid
//   are world-units sized per frame from CSS pixels / state.scale
//   so dashes stay constant-size in screen space.
export const FS_SRC = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec4 v_tint;
in vec2 v_local;
in vec2 v_offset;
uniform sampler2D u_tex;
uniform float u_clip;
uniform float u_dash_mode;
uniform float u_dash_period;
uniform float u_dash_solid;
uniform float u_pulse;     // alpha multiplier (1.0 = no effect) for pulsating overlays
out vec4 outColor;
void main() {
if (u_clip > 0.5 && dot(v_local, v_local) > 1.0) discard;
if (u_dash_mode > 0.5) {
  float p = mod(v_uv.x, u_dash_period);
  if (p > u_dash_solid) discard;
}
vec4 c = texture(u_tex, v_uv);
float d = length(v_offset);
float w = max(fwidth(d), 0.001);
float aa = 1.0 - smoothstep(1.0 - w, 1.0, d);
outColor = c * v_tint * aa * u_pulse;
}`;

export function compile(type: number, src: string): WebGLShader {
  // gl.createShader returns nullable; failure to allocate a shader
  // object is a hard "your GL context is broken" error. Throwing is
  // honest — we can't recover.
  const sh = gl.createShader(type);
  if (!sh) throw new Error('gl.createShader returned null');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('shader compile error:', gl.getShaderInfoLog(sh));
    console.error(src);
    gl.deleteShader(sh);
    throw new Error('shader compile failed');
  }
  return sh;
}
export const prog = gl.createProgram();
if (!prog) throw new Error('gl.createProgram returned null');
gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS_SRC));
gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS_SRC));
gl.linkProgram(prog);
if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
  console.error('link error:', gl.getProgramInfoLog(prog));
}
gl.useProgram(prog);
export const uView = gl.getUniformLocation(prog, 'u_view');
export const uTex = gl.getUniformLocation(prog, 'u_tex');
export const uClip = gl.getUniformLocation(prog, 'u_clip');
export const uOffsetScale = gl.getUniformLocation(prog, 'u_offset_scale');
export const uTranslate = gl.getUniformLocation(prog, 'u_translate');
export const uDashMode = gl.getUniformLocation(prog, 'u_dash_mode');
export const uDashPeriod = gl.getUniformLocation(prog, 'u_dash_period');
export const uDashSolid = gl.getUniformLocation(prog, 'u_dash_solid');
export const uPulse = gl.getUniformLocation(prog, 'u_pulse');
gl.uniform1i(uTex, 0);
gl.uniform1f(uDashMode, 0);
gl.uniform1f(uPulse, 1.0);

gl.enable(gl.BLEND);
// We pre-multiply alpha at texture upload, so the correct blend func
// for sprites with transparent edges is ONE/ONE_MINUS_SRC_ALPHA.
gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
gl.disable(gl.DEPTH_TEST);
gl.clearColor(11/255, 13/255, 18/255, 1);

// Vertex format: 12 floats × 4 bytes = 48-byte stride.
//   pos (vec2) | uv (vec2) | tint (vec4) | offset (vec2) | local (vec2)
export const STRIDE_FLOATS = 12;
export const STRIDE_BYTES = STRIDE_FLOATS * 4;

// Wire up the 5 vertex attributes (pos/uv/tint/offset/local) for
// whatever ARRAY_BUFFER is bound RIGHT NOW. We call this once per
// VAO at VAO creation time; the VAO then captures the buffer +
// attribute config, so per-frame we only need bindVertexArray to
// switch geometry sources — no more enableVertexAttribArray /
// vertexAttribPointer churn.
export function setupAttribPointers() {
  gl.enableVertexAttribArray(0);
  gl.enableVertexAttribArray(1);
  gl.enableVertexAttribArray(2);
  gl.enableVertexAttribArray(3);
  gl.enableVertexAttribArray(4);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, STRIDE_BYTES,  0);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STRIDE_BYTES,  8);
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, STRIDE_BYTES, 16);
  gl.vertexAttribPointer(3, 2, gl.FLOAT, false, STRIDE_BYTES, 32);
  gl.vertexAttribPointer(4, 2, gl.FLOAT, false, STRIDE_BYTES, 40);
}

// VAOs are owned by the file that creates them (static_geom for
// staticVAO; overlay for dynVAO + selEdgeVAO) so the let-binding
// and its reassignment live in one module — required because ES
// module imports are readonly.
export function makeVAO(buf: WebGLBuffer): WebGLVertexArrayObject {
  const v = gl.createVertexArray();
  if (!v) throw new Error('gl.createVertexArray returned null');
  gl.bindVertexArray(v);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  setupAttribPointers();
  return v;
}

// 1×1 opaque white texture, bound for any draw that wants solid
// color (lines, etc.) — texture sample is white(1,1,1,1), multiplied
// by a_tint gives the final color.
export const whiteTex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, whiteTex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
              new Uint8Array([255, 255, 255, 255]));
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

export function uploadOne(url: string, bitmap: ImageBitmap): void {
  const tex = gl.createTexture();
  if (!tex) throw new Error('gl.createTexture returned null');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  // Bitmaps came in with premultiplyAlpha:'premultiply' so we DON'T
  // ask WebGL to premultiply again — that would double-premultiply.
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  texCache.set(url, tex);
}
export function uploadAllTextures(): void {
  for (const [url, bitmap] of imgCache) uploadOne(url, bitmap);
  // The background tile should wrap so we can cover the viewport
  // with a single repeating quad. NPOT REPEAT is supported in
  // WebGL2.
  if (TREE.bg_tile && texCache.has(TREE.bg_tile)) {
    // texCache.has() narrows but the .get() return is still
    // T | undefined under noUncheckedIndexedAccess-style strictness.
    // The `??` keeps the original "no-op if absent" behaviour.
    gl.bindTexture(gl.TEXTURE_2D, texCache.get(TREE.bg_tile) ?? null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  }
  // Release ImageBitmap memory — the GPU has its own copy now.
  for (const bm of imgCache.values()) {
    if (bm && bm.close) try { bm.close(); } catch (e) {}
  }
  imgCache.clear();
}
export function getTex(url: string | null | undefined): WebGLTexture | null {
  return url ? (texCache.get(url) ?? null) : null;
}

