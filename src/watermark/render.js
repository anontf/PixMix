// Draws a compiled watermark for a given image size, in plain JavaScript: its own
// anti-aliased scanline rasteriser (signed-area accumulation, as in font-rs), the stroke as a
// dilation of the shapes' coverage, the shadow as an offset (and box-blurred) copy of the
// result. Only + - * / Math.sqrt / Math.round / Math.floor are used, all exactly specified
// by IEEE 754 and ECMAScript, so Node and every browser produce the same bytes, and nothing
// depends on installed fonts or on a canvas.
//
// The result is a patch: premultiplied RGBA floats (0..1, sRGB) over the pixels it covers.

import { UNITS } from './schema.js';
import { PixmixError } from '../core/params.js';
import { resolveLimits } from '../core/limits.js';

const TOLERANCE = 0.2; // px, curve flattening
// A watermark is a footer, never the whole image: bounds for what a (possibly hostile)
// compiled watermark can make the renderer allocate and loop over.
export const MAX_PATCH_PIXELS = 4_000_000;
const MAX_RADIUS = 32; // px, outline and blur

/**
 * Where the watermark goes on a width x height image and at what size, or null when it
 * would be smaller than fit.minSize.
 * @returns {null | {em: number, s: number, ox: number, oy: number, rect: number[],
 *   bg: number[]|null, ink: number[]}}  s = px per unit; ox, oy = where unit 0,0 lands; rect,
 *   bg and ink are [x0, y0, x1, y1] in px (rect: whole pixels, clipped to the image)
 */
export function placeWatermark(c, width, height) {
  const ref = { short: Math.min(width, height), long: Math.max(width, height), width, height, diagonal: Math.sqrt(width * width + height * height) }[c.size.of];
  const [bx0, by0, bx1, by1] = c.box;
  const bg = c.background;
  const strip = bg?.shape === 'strip';
  // What gets anchored: the background box, or the ink with its stroke.
  const grow = (bg ? 0 : c.stroke?.width ?? 0) * UNITS;
  const px = bg ? bg.padding.x * UNITS : grow, py = bg ? bg.padding.y * UNITS : grow;
  const a = [bx0 - px, by0 - py, bx1 + px, by1 + py];

  let em = c.size.px ?? Math.min(c.size.max, Math.max(c.size.min, c.size.relative * ref));
  const fitW = strip ? Infinity : (c.fit.maxWidth * width * UNITS) / (a[2] - a[0] || 1);
  em = Math.min(em, fitW, (c.fit.maxHeight * height * UNITS) / (a[3] - a[1] || 1));
  if (c.size.snap > 0 && em >= c.size.snap) em = Math.floor(em / c.size.snap) * c.size.snap;
  if (em < c.fit.minSize || em <= 0) return null;
  const s = em / UNITS;
  const margin = Math.min(c.margin.max, Math.max(c.margin.min, c.margin.relative * ref));

  const [col, row] = anchorOf(c.anchor);
  const along = (lo, hi, size, side, m) => (side < 0 ? m - lo * s : side > 0 ? size - m - hi * s : (size - (hi - lo) * s) / 2 - lo * s);
  const ox = Math.round(along(a[0], a[2], width, col, margin) + c.offset.x * em);
  const oy = Math.round(along(a[1], a[3], height, row, strip ? 0 : margin) + c.offset.y * em);
  const toPx = (b) => [ox + b[0] * s, oy + b[1] * s, ox + b[2] * s, oy + b[3] * s];

  const bgBox = bg ? (strip ? [0, oy + a[1] * s, width, oy + a[3] * s] : toPx(a)) : null;
  // Everything that can get paint: the shapes with their stroke, the background, and then
  // the shadow's copy of those.
  const g = (c.stroke?.width ?? 0) * UNITS;
  const ink = toPx([bx0 - g, by0 - g, bx1 + g, by1 + g]);
  if (bgBox) for (let i = 0; i < 4; i++) ink[i] = (i < 2 ? Math.min : Math.max)(ink[i], bgBox[i]);
  const all = [...ink];
  if (c.shadow) {
    const { dx, dy, blur } = shadowPx(c.shadow, em);
    const spread = blur * 3;
    all[0] = Math.min(all[0], ink[0] + dx - spread); all[1] = Math.min(all[1], ink[1] + dy - spread);
    all[2] = Math.max(all[2], ink[2] + dx + spread); all[3] = Math.max(all[3], ink[3] + dy + spread);
  }
  const rect = [
    Math.max(0, Math.floor(all[0]) - 1), Math.max(0, Math.floor(all[1]) - 1),
    Math.min(width, Math.ceil(all[2]) + 1), Math.min(height, Math.ceil(all[3]) + 1),
  ];
  if (rect[2] <= rect[0] || rect[3] <= rect[1]) return null;
  return { em, s, ox, oy, rect, bg: bgBox, ink };
}

const anchorOf = (a) => [a.endsWith('left') ? -1 : a.endsWith('right') ? 1 : 0, a.startsWith('top') ? -1 : a.startsWith('bottom') ? 1 : 0];
const shadowPx = (sh, em) => ({ dx: Math.round(sh.x * em), dy: Math.round(sh.y * em), blur: Math.min(MAX_RADIUS, Math.round((sh.blur * em) / 2)) });

/**
 * Renders the watermark for a width x height image.
 * @returns {null | {x: number, y: number, width: number, height: number, data: Float32Array}}
 *          premultiplied RGBA (0..1) for the pixels x..x+width, y..y+height
 */
export function renderWatermark(c, width, height, limits) {
  const place = placeWatermark(c, width, height);
  if (!place) return null;
  const { s, em, rect: [rx0, ry0, rx1, ry1] } = place;
  const w = rx1 - rx0, h = ry1 - ry0;
  const cap = Math.min(MAX_PATCH_PIXELS, resolveLimits(limits).maxPixels);
  if (w * h > cap) throw new PixmixError(`Watermark would cover ${w}x${h} pixels, over the limit of ${cap}`, 'LIMIT');
  const ox = place.ox - rx0, oy = place.oy - ry0;
  const out = new Float32Array(w * h * 4);
  const crisp = c.crisp;
  const shapeBox = [ox + c.box[0] * s, oy + c.box[1] * s, ox + c.box[2] * s, oy + c.box[3] * s];

  if (place.bg) {
    const b = c.background;
    const [x0, y0, x1, y1] = [place.bg[0] - rx0, place.bg[1] - ry0, place.bg[2] - rx0, place.bg[3] - ry0];
    const r = b.shape === 'pill' ? (y1 - y0) / 2 : b.shape === 'strip' ? 0 : Math.min(b.radius * em, (y1 - y0) / 2, (x1 - x0) / 2);
    const outer = coverage(roundRect(x0, y0, x1, y1, r), w, h, crisp);
    if (b.border) {
      const bw = Math.max(crisp ? 1 : 0, b.border.width * em);
      const inner = coverage(roundRect(x0 + bw, y0 + bw, x1 - bw, y1 - bw, Math.max(0, r - bw)), w, h, crisp);
      paintOver(out, inner, w, h, b.fill, [x0, y0, x1, y1], b.opacity);
      for (let i = 0; i < outer.length; i++) outer[i] = Math.max(0, outer[i] - inner[i]);
      paintOver(out, outer, w, h, b.border.fill, [x0, y0, x1, y1], 1);
    } else paintOver(out, outer, w, h, b.fill, [x0, y0, x1, y1], b.opacity);
  }

  const masks = c.shapes.map((sh) => (sh.image ? imageCoverage(sh.image, s, ox, oy, w, h) : { cov: coverage(transformPath(parsed(sh.d), s, ox, oy), w, h, crisp) }));
  if (c.stroke) {
    const union = new Float32Array(w * h);
    c.shapes.forEach((sh, i) => {
      if (!sh.outline) return;
      const cov = masks[i].cov;
      for (let k = 0; k < union.length; k++) if (cov[k] > union[k]) union[k] = cov[k];
    });
    const r = Math.min(MAX_RADIUS, Math.max(crisp ? 1 : 0.25, c.stroke.width * em));
    paintOver(out, dilate(union, w, h, crisp ? Math.round(r) : r, c.stroke.join === 'square', crisp), w, h, c.stroke.color, shapeBox, c.stroke.opacity);
  }
  c.shapes.forEach((sh, i) => {
    if (masks[i].rgba) paintImage(out, masks[i]);
    else paintOver(out, masks[i].cov, w, h, sh.fill, shapeBox, 1);
  });

  if (c.shadow) {
    const { dx, dy, blur } = shadowPx(c.shadow, em);
    let a = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const sy = y - dy;
      if (sy < 0 || sy >= h) continue;
      for (let x = 0; x < w; x++) {
        const sx = x - dx;
        if (sx >= 0 && sx < w) a[y * w + x] = out[(sy * w + sx) * 4 + 3];
      }
    }
    for (let pass = 0; pass < (blur ? 3 : 0); pass++) a = boxBlur(a, w, h, blur);
    const [sr, sg, sb, sa] = rgba(c.shadow.color);
    const k = sa * c.shadow.opacity;
    for (let i = 0; i < w * h; i++) {
      const o = i * 4, under = a[i] * k * (1 - out[o + 3]);
      out[o] += sr * under; out[o + 1] += sg * under; out[o + 2] += sb * under; out[o + 3] += under;
    }
  }
  if (c.opacity < 1) for (let i = 0; i < out.length; i++) out[i] *= c.opacity;
  return { x: rx0, y: ry0, width: w, height: h, data: out };
}

// --- geometry --------------------------------------------------------------------------

const cache = new Map();
/** Parsed path commands, cached by the path string (watermarks are drawn many times). */
function parsed(d) {
  let p = cache.get(d);
  if (!p) {
    p = [];
    const re = /([MLQCZ])|(-?\d+(?:\.\d+)?)/g;
    let m, cur = null;
    while ((m = re.exec(d))) {
      if (m[1]) { cur = [m[1]]; p.push(cur); } else if (cur) cur.push(Number(m[2]));
    }
    if (cache.size > 64) cache.clear();
    cache.set(d, p);
  }
  return p;
}

/** Path commands in units -> closed polylines in patch pixels. */
function transformPath(cmds, s, ox, oy) {
  const polys = [];
  let poly = null, px = 0, py = 0;
  const X = (v) => ox + v * s, Y = (v) => oy + v * s;
  for (const [t, ...v] of cmds) {
    if (t === 'M') { poly = [X(v[0]), Y(v[1])]; polys.push(poly); [px, py] = [poly[0], poly[1]]; continue; }
    if (!poly || t === 'Z') continue;
    if (t === 'L') { px = X(v[0]); py = Y(v[1]); poly.push(px, py); continue; }
    const pts = [px, py];
    for (let k = 0; k < v.length; k += 2) pts.push(X(v[k]), Y(v[k + 1]));
    flatten(pts, poly);
    px = pts.at(-2); py = pts.at(-1);
  }
  return polys;
}

/** Appends a quadratic or cubic Bézier as line segments (count from its flatness). */
function flatten(p, poly) {
  const cubic = p.length === 8;
  const dev = (a, b, c) => {
    const x = p[a] - 2 * p[b] + p[c], y = p[a + 1] - 2 * p[b + 1] + p[c + 1];
    return Math.sqrt(x * x + y * y);
  };
  const d = cubic ? Math.max(dev(0, 2, 4), dev(2, 4, 6)) * 0.75 : dev(0, 2, 4) * 0.25;
  const n = Math.min(64, Math.max(1, Math.ceil(Math.sqrt(d / TOLERANCE))));
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    if (cubic) {
      const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t;
      poly.push(a * p[0] + b * p[2] + c * p[4] + e * p[6], a * p[1] + b * p[3] + c * p[5] + e * p[7]);
    } else {
      const a = u * u, b = 2 * u * t, c = t * t;
      poly.push(a * p[0] + b * p[2] + c * p[4], a * p[1] + b * p[3] + c * p[5]);
    }
  }
}

function roundRect(x0, y0, x1, y1, r) {
  if (x1 <= x0 || y1 <= y0) return [];
  if (r <= 0) return [[x0, y0, x1, y0, x1, y1, x0, y1]];
  const k = r * 0.5522847498;
  const poly = [x0 + r, y0, x1 - r, y0];
  flatten([x1 - r, y0, x1 - r + k, y0, x1, y0 + r - k, x1, y0 + r], poly);
  poly.push(x1, y1 - r);
  flatten([x1, y1 - r, x1, y1 - r + k, x1 - r + k, y1, x1 - r, y1], poly);
  poly.push(x0 + r, y1);
  flatten([x0 + r, y1, x0 + r - k, y1, x0, y1 - r + k, x0, y1 - r], poly);
  poly.push(x0, y0 + r);
  flatten([x0, y0 + r, x0, y0 + r - k, x0 + r - k, y0, x0 + r, y0], poly);
  return [poly];
}

// --- rasteriser ------------------------------------------------------------------------

/**
 * Coverage (0..1) of closed polylines on a w x h grid, non-zero-ish: the accumulated signed
 * area is clamped, so overlapping contours of one direction add up to 1 and holes (the other
 * direction) cancel. `crisp` thresholds at one half.
 */
export function coverage(polys, w, h, crisp = false) {
  const stride = w + 2;
  const acc = new Float64Array(stride * h + 1);
  for (const p of polys) {
    const n = p.length;
    for (let i = 0; i < n; i += 2) {
      const j = (i + 2) % n;
      line(acc, stride, w, h, p[i], p[i + 1], p[j], p[j + 1]);
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = 0; x < w; x++) {
      sum += acc[y * stride + x];
      const a = Math.min(1, Math.abs(sum));
      out[y * w + x] = crisp ? (a >= 0.5 ? 1 : 0) : a;
    }
  }
  return out;
}

function line(acc, stride, w, h, x0, y0, x1, y1) {
  if (y0 === y1) return;
  let dir = 1;
  if (y0 > y1) { dir = -1; [x0, y0, x1, y1] = [x1, y1, x0, y0]; }
  const dxdy = (x1 - x0) / (y1 - y0);
  let x = x0;
  if (y0 < 0) { x -= y0 * dxdy; y0 = 0; }
  const yEnd = Math.min(y1, h);
  if (y0 >= yEnd) return;
  // Clamping x to the grid keeps the coverage inside it exact.
  const clampX = (v) => (v < 0 ? 0 : v > w ? w : v);
  for (let y = Math.floor(y0); y < yEnd; y++) {
    const row = y * stride;
    const dy = Math.min(y + 1, yEnd) - Math.max(y, y0);
    const xnext = x + dxdy * dy;
    const d = dy * dir;
    let a = clampX(x), b = clampX(xnext);
    if (a > b) [a, b] = [b, a];
    const af = Math.floor(a), bc = Math.ceil(b);
    if (bc <= af + 1) {
      const mid = 0.5 * (a + b) - af;
      acc[row + af] += d - d * mid;
      acc[row + af + 1] += d * mid;
    } else {
      const inv = 1 / (b - a);
      const f0 = a - af;
      const a0 = 0.5 * inv * (1 - f0) * (1 - f0);
      const f1 = b - bc + 1;
      const am = 0.5 * inv * f1 * f1;
      acc[row + af] += d * a0;
      if (bc === af + 2) acc[row + af + 1] += d * (1 - a0 - am);
      else {
        const a1 = inv * (1.5 - f0);
        acc[row + af + 1] += d * (a1 - a0);
        for (let k = af + 2; k < bc - 1; k++) acc[row + k] += d * inv;
        const a2 = a1 + (bc - af - 3) * inv;
        acc[row + bc - 1] += d * (1 - a2 - am);
      }
      acc[row + bc] += d * am;
    }
    x = xnext;
  }
}

/** Morphological dilation by a disc (or square) of radius r px, anti-aliased at its rim. */
function dilate(src, w, h, r, square, crisp) {
  const R = Math.ceil(r + 0.5);
  const taps = [];
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const dist = square ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.sqrt(dx * dx + dy * dy);
      let k = Math.min(1, Math.max(0, r + 0.5 - dist));
      if (crisp) k = k >= 0.5 ? 1 : 0;
      if (k > 0) taps.push(dx, dy, k);
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = src[y * w + x];
      if (!v) continue;
      for (let t = 0; t < taps.length; t += 3) {
        const X = x + taps[t], Y = y + taps[t + 1];
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const o = Y * w + X, c = v * taps[t + 2];
        if (c > out[o]) out[o] = c;
      }
    }
  }
  return out;
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) { const X = x + k; if (X >= 0 && X < w) s += src[y * w + X]; }
      tmp[y * w + x] = s / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) { const Y = y + k; if (Y >= 0 && Y < h) s += tmp[Y * w + x]; }
      out[y * w + x] = s / n;
    }
  }
  return out;
}

// --- paint -------------------------------------------------------------------------------

/** '#rrggbb' / '#rrggbbaa' -> [r, g, b, a] in 0..1. */
export function rgba(hex) {
  const n = (i) => parseInt(hex.slice(i, i + 2), 16) / 255;
  return [n(1), n(3), n(5), hex.length > 7 ? n(7) : 1];
}

/** A paint sampler: (x, y) -> premultiplied [r, g, b, a], over a reference box. */
function sampler(paint, box) {
  if (typeof paint === 'string') {
    const [r, g, b, a] = rgba(paint);
    const c = [r * a, g * a, b * a, a];
    return () => c;
  }
  const [dx, dy] = paint.dir;
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  const len = Math.abs((box[2] - box[0]) * dx) + Math.abs((box[3] - box[1]) * dy) || 1;
  const stops = paint.stops.map((st) => { const [r, g, b, a] = rgba(st.color); return [st.at, r * a, g * a, b * a, a]; });
  const out = [0, 0, 0, 0];
  return (x, y) => {
    const t = ((x + 0.5 - cx) * dx + (y + 0.5 - cy) * dy) / len + 0.5;
    let i = 0;
    while (i < stops.length - 1 && t > stops[i + 1][0]) i++;
    const a = stops[i], b = stops[Math.min(i + 1, stops.length - 1)];
    const f = t <= a[0] ? 0 : t >= b[0] ? 1 : (t - a[0]) / (b[0] - a[0] || 1);
    for (let k = 0; k < 4; k++) out[k] = a[k + 1] + (b[k + 1] - a[k + 1]) * f;
    return out;
  };
}

/** Source-over of paint x coverage x opacity onto the premultiplied patch. */
function paintOver(out, cov, w, h, paint, box, opacity) {
  const at = sampler(paint, box);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const k = cov[i] * opacity;
      if (!k) continue;
      const p = at(x, y), o = i * 4, keep = 1 - p[3] * k;
      out[o] = p[0] * k + out[o] * keep;
      out[o + 1] = p[1] * k + out[o + 1] * keep;
      out[o + 2] = p[2] * k + out[o + 2] * keep;
      out[o + 3] = p[3] * k + out[o + 3] * keep;
    }
  }
}

/**
 * A logo resampled onto the patch: each pixel averages the source pixels whose centres
 * fall inside it (nearest when enlarging, which keeps pixel art crisp).
 */
function imageCoverage(img, s, ox, oy, w, h) {
  let bin;
  try { bin = atob(img.rgba); } catch { throw new PixmixError('watermark image: not base64', 'BAD_WATERMARK'); }
  const src = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) src[i] = bin.charCodeAt(i);
  const [bx0, by0, bx1, by1] = img.box.map((v, i) => (i % 2 ? oy : ox) + v * s);
  const sx = img.width / (bx1 - bx0), sy = img.height / (by1 - by0);
  const rgbaOut = new Float32Array(w * h * 4), cov = new Float32Array(w * h);
  for (let y = Math.max(0, Math.floor(by0)); y < Math.min(h, Math.ceil(by1)); y++) {
    for (let x = Math.max(0, Math.floor(bx0)); x < Math.min(w, Math.ceil(bx1)); x++) {
      const u0 = (x - bx0) * sx, u1 = (x + 1 - bx0) * sx, v0 = (y - by0) * sy, v1 = (y + 1 - by0) * sy;
      let cu0 = Math.max(0, Math.ceil(u0 - 0.5)), cu1 = Math.min(img.width - 1, Math.ceil(u1 - 0.5) - 1);
      let cv0 = Math.max(0, Math.ceil(v0 - 0.5)), cv1 = Math.min(img.height - 1, Math.ceil(v1 - 0.5) - 1);
      if (cu1 < cu0) { cu0 = cu1 = Math.min(img.width - 1, Math.max(0, Math.floor((u0 + u1) / 2))); }
      if (cv1 < cv0) { cv0 = cv1 = Math.min(img.height - 1, Math.max(0, Math.floor((v0 + v1) / 2))); }
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let v = cv0; v <= cv1; v++) {
        for (let u = cu0; u <= cu1; u++) {
          const o = (v * img.width + u) * 4, al = src[o + 3] / 255;
          r += (src[o] / 255) * al; g += (src[o + 1] / 255) * al; b += (src[o + 2] / 255) * al; a += al; n++;
        }
      }
      // Partial edge pixels are weighted by how much of them the logo covers.
      const edge = (Math.min(x + 1, bx1) - Math.max(x, bx0)) * (Math.min(y + 1, by1) - Math.max(y, by0));
      const k = Math.min(1, Math.max(0, edge)) / n, o = (y * w + x) * 4;
      rgbaOut[o] = r * k; rgbaOut[o + 1] = g * k; rgbaOut[o + 2] = b * k; rgbaOut[o + 3] = a * k;
      cov[y * w + x] = a * k;
    }
  }
  return { cov, rgba: rgbaOut };
}

function paintImage(out, { rgba: src }) {
  for (let o = 0; o < out.length; o += 4) {
    const a = src[o + 3];
    if (!a) continue;
    const keep = 1 - a;
    out[o] = src[o] + out[o] * keep; out[o + 1] = src[o + 1] + out[o + 1] * keep;
    out[o + 2] = src[o + 2] + out[o + 2] * keep; out[o + 3] = a + out[o + 3] * keep;
  }
}

/** The patch as straight-alpha 8-bit RGBA (for a canvas ImageData). */
export function patchToRGBA8(patch) {
  const d = patch.data, out = new Uint8ClampedArray(d.length);
  for (let o = 0; o < d.length; o += 4) {
    const a = d[o + 3];
    if (!a) continue;
    out[o] = Math.round((d[o] / a) * 255); out[o + 1] = Math.round((d[o + 1] / a) * 255);
    out[o + 2] = Math.round((d[o + 2] / a) * 255); out[o + 3] = Math.round(a * 255);
  }
  return out;
}
