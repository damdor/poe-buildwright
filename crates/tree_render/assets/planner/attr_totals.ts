// ---------------------------------------------------------------------
// PoE1 centre-medallion attribute totals
// ---------------------------------------------------------------------
// GGG's skilltree.js drawStartNodeBackground draws, for the CURRENT
// class only, the character's Str/Dex/Int totals as text over the
// three coloured rings of the centre medallion. Their exact rule:
//
//   r = constants.PSSCentreInnerRadius (130 tree units)
//   pos = start + r * (sin a, cos a)     // y-down world
//   Str a=300deg  rgb(235,46,16)   → bottom-left (red ring)
//   Dex a= 60deg  rgb(1,217,1)     → bottom-right (green ring)
//   Int a=180deg  rgb(88,130,255)  → top (blue ring)
//   font 25pt FontinRegular * zoom → constant world size (~33 units)
//
// The totals GGG shows are the sum of grantedStrength / Dexterity /
// Intelligence over ALLOCATED nodes only — no class base attributes,
// so an empty build reads 0 / 0 / 0 like pathofexile.com does. We
// don't ship the granted* fields, but the stats text we do ship
// encodes the same numbers ("+N to Strength", "+N to Strength and
// Dexterity", "+N to all Attributes") — verified equal to granted*
// for every node of the 3.26 embed.

import { gl, state } from "./state.ts";

const PSS_CENTRE_INNER_RADIUS = 130;   // tree.json constants.PSSCentreInnerRadius
const FONT_WORLD = 25 * (4 / 3);       // 25pt in canvas px at zoom 1 = world units
// Angle (deg) and fill per attribute, in GGG's draw order.
const ATTRS: Array<{ angle: number; color: string }> = [
  { angle: 300, color: 'rgb(235,46,16)' },   // Str
  { angle:  60, color: 'rgb(1,217,1)' },     // Dex
  { angle: 180, color: 'rgb(88,130,255)' },  // Int
];
// World span of the baked texture, centred on the class start. Big
// enough for r=130 placement + 3-digit numbers at ~33-unit glyphs.
const SPAN_WORLD = 512;
const PX_PER_WORLD = 2;                // texture density (crisp to ~2x zoom)

const STAT_LINE = /^\+(\d+) to (.+)$/;

// Sum Str/Dex/Int granted by every allocated node (main + ascendancy,
// matching GGG's passiveAllocated accumulator).
export function attrTotals(): [number, number, number] {
  let s = 0, d = 0, i = 0;
  for (const id of state.selected.keys()) {
    const n = TREE.nodes[id];
    if (!n || !n.s) continue;
    // Stats arrive "; "-joined from the poe1 shaper (newline-joined on
    // other pipelines) — split on both.
    for (const line of n.s.split(/;\s*|\n/)) {
      const m = STAT_LINE.exec(line);
      if (!m) continue;
      const v = parseInt(m[1]!, 10);
      const what = m[2]!;
      if (what === 'all Attributes') { s += v; d += v; i += v; continue; }
      for (const part of what.split(' and ')) {
        if (part === 'Strength') s += v;
        else if (part === 'Dexterity') d += v;
        else if (part === 'Intelligence') i += v;
      }
    }
  }
  return [s, d, i];
}

let cachedTex: WebGLTexture | null = null;
let cachedKey = '';

// Texture with the three totals laid out at their world offsets, ready
// to stamp as one SPAN_WORLD-sized sprite centred on the class start.
// Rebuilt only when a total changes.
export function attrTotalsSprite(): { tex: WebGLTexture; w: number; h: number } | null {
  const totals = attrTotals();
  const key = totals.join('|');
  if (!cachedTex || key !== cachedKey) {
    const size = SPAN_WORLD * PX_PER_WORLD;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    // Fontin is GGG's face; the serif fallbacks keep the same lining-
    // figure look without shipping a font.
    ctx.font = `${FONT_WORLD * PX_PER_WORLD}px Fontin, "Times New Roman", serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const mid = size / 2, r = PSS_CENTRE_INNER_RADIUS * PX_PER_WORLD;
    ATTRS.forEach(({ angle, color }, idx) => {
      const a = angle * (Math.PI / 180);
      ctx.fillStyle = color;
      ctx.fillText(String(totals[idx]), mid + r * Math.sin(a), mid + r * Math.cos(a));
    });
    if (!cachedTex) {
      cachedTex = gl.createTexture();
      if (!cachedTex) return null;
    }
    gl.bindTexture(gl.TEXTURE_2D, cachedTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    cachedKey = key;
  }
  return { tex: cachedTex, w: SPAN_WORLD, h: SPAN_WORLD };
}
