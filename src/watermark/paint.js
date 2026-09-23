// Puts a rendered watermark patch (render.js) into images, in whatever form they are stored:
// native PNG / JPEG XL samples (grey, grey+alpha, RGB, RGBA; 1–16 bits), palette indices
// (nearest colour), or JPEG DCT coefficients. JPEG is painted in the DCT domain: only the
// blocks under the watermark are decoded, painted and quantised again with the image's own
// tables; every other block keeps its coefficients exactly.
//
// This module is the lazily loaded half of watermarking (dist/pixmix-watermark.mjs): the
// decoder only fetches it when a watermark is actually drawn.

import { renderWatermark, placeWatermark, patchToRGBA8 } from './render.js';
import { validateCompiled } from './schema.js';
import { fdct, divisors } from '../formats/jpeg/fdct.js';
import { ZIGZAG } from '../formats/jpeg/decode.js';
import { orientationTransform, swapsAxes } from '../browser/orient.js';
import { PixmixError } from '../core/params.js';
import { toRGBA8 } from '../formats/png/rgba.js';
import { encodeStash, copyRect, jpegRect, jpegRectBytes } from './embed.js';

export { renderWatermark, placeWatermark, patchToRGBA8, validateCompiled };

/**
 * Renders for a stored width x height image whose EXIF orientation is `o`: the watermark is
 * laid out on the image as displayed (bottom-right stays bottom-right, text upright), then
 * mapped back onto the stored pixel grid.
 */
export function renderFor(c, width, height, o = 1, limits) {
  if (o === 1 || !(o >= 2 && o <= 8)) return renderWatermark(c, width, height, limits);
  const dw = swapsAxes(o) ? height : width, dh = swapsAxes(o) ? width : height;
  const p = renderWatermark(c, dw, dh, limits);
  if (!p) return null;
  // stored -> displayed is m; walk the stored pixels of the patch's preimage.
  const [a, b, cc, d, e, f] = orientationTransform(o, width, height);
  const toStored = (X, Y) => { // inverse of X = a x + cc y + e, Y = b x + d y + f
    const det = a * d - b * cc;
    return [(d * (X - e) - cc * (Y - f)) / det, (a * (Y - f) - b * (X - e)) / det];
  };
  const corners = [[p.x, p.y], [p.x + p.width, p.y], [p.x, p.y + p.height], [p.x + p.width, p.y + p.height]].map(([X, Y]) => toStored(X, Y));
  const x0 = Math.min(...corners.map((q) => q[0])), y0 = Math.min(...corners.map((q) => q[1]));
  const w = Math.round(Math.max(...corners.map((q) => q[0])) - x0), h = Math.round(Math.max(...corners.map((q) => q[1])) - y0);
  const data = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x0 + x + 0.5, sy = y0 + y + 0.5;
      const X = Math.floor(a * sx + cc * sy + e) - p.x, Y = Math.floor(b * sx + d * sy + f) - p.y;
      const src = (Y * p.width + X) * 4, dst = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) data[dst + k] = p.data[src + k];
    }
  }
  return { x: Math.round(x0), y: Math.round(y0), width: w, height: h, data };
}

/**
 * Composites a patch into native samples, in place.
 * @param {{x: number, y: number, width: number, height: number, data: Float32Array}} patch
 * @param {{width: number, height: number, channels: 1|2|3|4, depth: number,
 *   data: Uint8Array|Uint16Array, x?: number, y?: number}} target  interleaved samples; 16-bit
 *   as a Uint16Array, or big-endian bytes in a Uint8Array (PNG); x, y: where the target sits
 *   in the patch's coordinates (APNG sub-frames)
 * @returns {boolean} whether any pixel changed
 */
export function paintSamples(patch, target) {
  if (!patch) return false;
  const { width, height, channels, depth, data } = target;
  const tx = target.x ?? 0, ty = target.y ?? 0;
  const max = depth === 16 ? 65535 : (1 << depth) - 1;
  const wide = depth === 16 && !(data instanceof Uint16Array);
  const get = wide ? (i) => (data[i * 2] << 8) | data[i * 2 + 1] : (i) => data[i];
  const set = wide ? (i, v) => { data[i * 2] = v >> 8; data[i * 2 + 1] = v & 255; } : (i, v) => { data[i] = v; };
  const grey = channels < 3, alpha = channels === 2 || channels === 4;
  const q = (v) => Math.round(Math.min(1, Math.max(0, v)) * max);
  let changed = false;
  forPatch(patch, tx, ty, width, height, (p, x, y) => {
    const [r, g, b, a] = p;
    const i = (y * width + x) * channels;
    const src = grey ? [0.299 * r + 0.587 * g + 0.114 * b] : [r, g, b];
    const n = src.length;
    const da = alpha ? get(i + n) / max : 1;
    const oa = a + da * (1 - a);
    for (let k = 0; k < n; k++) {
      const dc = get(i + k) / max;
      set(i + k, q(oa ? (src[k] + dc * da * (1 - a)) / oa : 0));
    }
    if (alpha) set(i + n, q(oa));
    changed = true;
  });
  return changed;
}

/**
 * Composites a patch into palette indices by picking the nearest palette entry (RGBA
 * distance) for every painted pixel. Used on scrambled palette PNGs, whose palette must
 * stay as it is.
 * @param {{width: number, height: number, data: Uint8Array, palette: Uint8Array,
 *   alphas?: Uint8Array|null, x?: number, y?: number}} target
 */
export function paintIndexed(patch, target) {
  if (!patch) return false;
  const { width, height, data, palette } = target;
  const count = palette.length / 3;
  const alphaOf = (k) => (target.alphas && k < target.alphas.length ? target.alphas[k] : 255);
  let changed = false;
  forPatch(patch, target.x ?? 0, target.y ?? 0, width, height, (p, x, y) => {
    const i = y * width + x, cur = data[i];
    const da = alphaOf(cur) / 255, oa = p[3] + da * (1 - p[3]);
    const want = [0, 1, 2].map((k) => (oa ? ((p[k] + (palette[cur * 3 + k] / 255) * da * (1 - p[3])) / oa) * 255 : 0));
    let best = cur, bestD = Infinity;
    for (let k = 0; k < count; k++) {
      const dr = palette[k * 3] - want[0], dg = palette[k * 3 + 1] - want[1], db = palette[k * 3 + 2] - want[2], dA = alphaOf(k) - oa * 255;
      const dist = dr * dr + dg * dg + db * db + dA * dA;
      if (dist < bestD) { bestD = dist; best = k; }
    }
    data[i] = best;
    changed = true;
  });
  return changed;
}

function forPatch(patch, tx, ty, width, height, visit) {
  const px = [0, 0, 0, 0];
  const x0 = Math.max(0, patch.x - tx), y0 = Math.max(0, patch.y - ty);
  const x1 = Math.min(width, patch.x + patch.width - tx), y1 = Math.min(height, patch.y + patch.height - ty);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = ((y + ty - patch.y) * patch.width + (x + tx - patch.x)) * 4;
      if (!patch.data[o + 3]) continue;
      px[0] = patch.data[o]; px[1] = patch.data[o + 1]; px[2] = patch.data[o + 2]; px[3] = patch.data[o + 3];
      visit(px, x, y);
    }
  }
}

// --- JPEG ---------------------------------------------------------------------------------

/** Quantisation tables by id, in natural (row-major) order, from DQT segments. */
export function quantTables(segments) {
  const tables = [];
  for (const seg of segments) {
    if (seg.marker !== 0xdb) continue;
    for (let pos = 0; pos < seg.data.length;) {
      const pq = seg.data[pos] >> 4, tq = seg.data[pos] & 15;
      const t = new Uint16Array(64);
      for (let k = 0; k < 64; k++) t[ZIGZAG[k]] = pq ? (seg.data[pos + 1 + 2 * k] << 8) | seg.data[pos + 2 + 2 * k] : seg.data[pos + 1 + k];
      tables[tq] = t;
      pos += 1 + 64 * (pq + 1);
    }
  }
  return tables;
}

/** How the components encode colour: 'grey', 'ycc' (JFIF) or 'rgb' (Adobe, transform 0). */
export function jpegColour(segments, frame) {
  const n = frame.components.length;
  if (n === 1) return 'grey';
  if (n !== 3) return null;
  const adobe = segments.find((s) => s.marker === 0xee && String.fromCharCode(...s.data.subarray(0, 5)) === 'Adobe');
  return adobe && adobe.data.length >= 12 && adobe.data[11] === 0 ? 'rgb' : 'ycc';
}

// cos(kπ/16), k = 0..8, as literals: Math.cos is not exactly specified, and every engine
// must get the same coefficients.
const COS = [1, 0.9807852804032304, 0.9238795325112867, 0.8314696123025452, 0.7071067811865476, 0.5555702330196022, 0.3826834323650898, 0.19509032201612825, 0];
const cosPi16 = (m) => { // cos(m π / 16) for any integer m >= 0
  m %= 32;
  if (m <= 8) return COS[m];
  if (m <= 16) return -COS[16 - m];
  if (m <= 24) return -COS[m - 16];
  return COS[32 - m];
};
// IDCT basis: T[x * 8 + u] = C(u) / 2 * cos((2x + 1) u π / 16)
const T = /* @__PURE__ */ (() => {
  const t = new Float64Array(64);
  for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) t[x * 8 + u] = ((u ? 1 : 0.7071067811865476) / 2) * cosPi16((2 * x + 1) * u);
  return t;
})();

function idct(coefs, off, q, out) {
  const f = new Float64Array(64), tmp = new Float64Array(64);
  for (let i = 0; i < 64; i++) f[i] = coefs[off + i] * q[i];
  for (let v = 0; v < 8; v++) {
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let u = 0; u < 8; u++) s += T[x * 8 + u] * f[v * 8 + u];
      tmp[v * 8 + x] = s;
    }
  }
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let s = 0;
      for (let v = 0; v < 8; v++) s += T[y * 8 + v] * tmp[v * 8 + x];
      out[y * 8 + x] = s;
    }
  }
}

/**
 * Paints a patch into a JPEG frame's coefficients, in place. Only MCUs under painted pixels
 * are touched; there, the samples are rebuilt (IDCT, chroma replicated), painted, and
 * quantised again (the image's tables, chroma box-averaged back) block by block, and only
 * blocks that actually contain painted samples get new coefficients.
 * @returns {boolean} whether anything changed
 */
export function paintJpeg(patch, frame, tables, colour) {
  if (!patch) return false;
  if (!colour) throw new PixmixError('Watermarks need a grey, YCbCr or RGB JPEG (not CMYK)', 'UNSUPPORTED');
  const { hmax, vmax, mcusX, mcusY, width, height } = frame;
  const tw = 8 * hmax, th = 8 * vmax;
  const comps = frame.components;
  for (const c of comps) {
    if (hmax % c.h || vmax % c.v) throw new PixmixError('Unusual JPEG chroma subsampling; cannot paint a watermark', 'UNSUPPORTED');
    if (!tables[c.tq]) throw new PixmixError(`JPEG has no quantisation table ${c.tq}`, 'BAD_JPEG');
  }
  const divs = comps.map((c) => divisors(tables[c.tq]));
  const planes = comps.map(() => new Float64Array(tw * th)); // full resolution, per component
  const block = new Float64Array(64), fblock = new Float32Array(64);
  const touched = new Uint8Array(tw * th);
  let changed = false;
  const mx0 = Math.max(0, Math.floor(patch.x / tw)), mx1 = Math.min(mcusX, Math.ceil((patch.x + patch.width) / tw));
  const my0 = Math.max(0, Math.floor(patch.y / th)), my1 = Math.min(mcusY, Math.ceil((patch.y + patch.height) / th));
  for (let my = my0; my < my1; my++) {
    for (let mx = mx0; mx < mx1; mx++) {
      touched.fill(0);
      let any = false;
      forPatch(patch, mx * tw, my * th, Math.min(tw, width - mx * tw), Math.min(th, height - my * th), (p, x, y) => { touched[y * tw + x] = 1; any = true; });
      if (!any) continue;
      // Decode the MCU's blocks, replicating subsampled components to full resolution.
      comps.forEach((c, ci) => {
        const fx = hmax / c.h, fy = vmax / c.v;
        for (let by = 0; by < c.v; by++) {
          for (let bx = 0; bx < c.h; bx++) {
            idct(c.coefs, ((my * c.v + by) * c.blocksW + mx * c.h + bx) * 64, tables[c.tq], block);
            for (let y = 0; y < 8; y++) {
              for (let x = 0; x < 8; x++) {
                const v = block[y * 8 + x];
                for (let yy = 0; yy < fy; yy++) for (let xx = 0; xx < fx; xx++) planes[ci][((by * 8 + y) * fy + yy) * tw + (bx * 8 + x) * fx + xx] = v;
              }
            }
          }
        }
      });
      forPatch(patch, mx * tw, my * th, Math.min(tw, width - mx * tw), Math.min(th, height - my * th), (p, x, y) => {
        const i = y * tw + x, keep = 1 - p[3];
        if (colour === 'grey') {
          const Y = clamp255(planes[0][i] + 128);
          planes[0][i] = (0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]) * 255 + Y * keep - 128;
          return;
        }
        let r, g, b;
        if (colour === 'rgb') { r = planes[0][i] + 128; g = planes[1][i] + 128; b = planes[2][i] + 128; } else {
          const Y = planes[0][i] + 128, cb = planes[1][i], cr = planes[2][i];
          r = Y + 1.402 * cr; g = Y - 0.344136286 * cb - 0.714136286 * cr; b = Y + 1.772 * cb;
        }
        r = p[0] * 255 + clamp255(r) * keep; g = p[1] * 255 + clamp255(g) * keep; b = p[2] * 255 + clamp255(b) * keep;
        if (colour === 'rgb') { planes[0][i] = r - 128; planes[1][i] = g - 128; planes[2][i] = b - 128; return; }
        planes[0][i] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
        planes[1][i] = -0.168735892 * r - 0.331264108 * g + 0.5 * b;
        planes[2][i] = 0.5 * r - 0.418687589 * g - 0.081312411 * b;
      });
      // Re-encode the blocks that hold painted samples.
      comps.forEach((c, ci) => {
        const fx = hmax / c.h, fy = vmax / c.v;
        for (let by = 0; by < c.v; by++) {
          for (let bx = 0; bx < c.h; bx++) {
            let hit = false;
            for (let y = by * 8 * fy; y < (by + 1) * 8 * fy && !hit; y++) for (let x = bx * 8 * fx; x < (bx + 1) * 8 * fx; x++) if (touched[y * tw + x]) { hit = true; break; }
            if (!hit) continue;
            for (let y = 0; y < 8; y++) {
              for (let x = 0; x < 8; x++) {
                let s = 0;
                for (let yy = 0; yy < fy; yy++) for (let xx = 0; xx < fx; xx++) s += planes[ci][((by * 8 + y) * fy + yy) * tw + (bx * 8 + x) * fx + xx];
                fblock[y * 8 + x] = s / (fx * fy);
              }
            }
            fdct(fblock);
            const o = ((my * c.v + by) * c.blocksW + mx * c.h + bx) * 64;
            for (let k = 0; k < 64; k++) {
              const v = fblock[k] * divs[ci][k];
              c.coefs[o + k] = Math.max(-32767, Math.min(32767, v < 0 ? -Math.round(-v) : Math.round(v)));
            }
            changed = true;
          }
        }
      });
    }
  }
  return changed;
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** The patch as straight 8-bit RGBA, for drawing on a canvas. */
export const overlayPixels = (patch) => (patch ? { x: patch.x, y: patch.y, width: patch.width, height: patch.height, rgba: patchToRGBA8(patch) } : null);

// --- whole images -----------------------------------------------------------------------
// The format modules hand over their decoded structures; these paint them.

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };
const DROP_WHEN_PROMOTED = new Set(['PLTE', 'tRNS', 'bKGD', 'hIST', 'sBIT']);

/**
 * Paints the watermark into a restored PNG/APNG's frames (the IDAT image, and each
 * animation frame that holds the whole watermark). Palette and 1/2/4-bit images become
 * 8-bit RGBA first (their palette cannot hold the watermark's colours); everything else
 * keeps its colour type and bit depth, and every chunk.
 * @param {import('../formats/png/index.js').PngImage} img
 * @param {Uint8Array[]} frames  native samples, frame 0 first
 * @returns {{img: object, frames: Uint8Array[]}|null}  null: nothing drawn
 */
export function paintPng(img, frames, c, o = 1, limits) {
  const { width, height, colorType, depth } = img.ihdr;
  const patch = renderFor(validateCompiled(c), width, height, o, limits);
  if (!patch) return null;
  if (colorType === 3 || depth < 8) {
    const ihdrBytes = img.chunks[0].data.slice();
    ihdrBytes[8] = 8; ihdrBytes[9] = 6;
    frames = frames.map((px, i) => {
      const size = img.frameSizes[i];
      return new Uint8Array(toRGBA8({ ...img, ihdr: { ...img.ihdr, width: size.width, height: size.height } }, px).buffer);
    });
    // Drop the palette's chunks, keeping frameChunks (indexes into chunks) in step.
    const index = [];
    const chunks = [];
    img.chunks.forEach((ch, i) => {
      index[i] = chunks.length;
      if (!DROP_WHEN_PROMOTED.has(ch.type)) chunks.push(i === 0 ? { type: 'IHDR', data: ihdrBytes } : ch);
    });
    img = {
      ...img, ihdr: { ...img.ihdr, colorType: 6, depth: 8 }, pixelBytes: 4, chunks,
      frameChunks: img.frameChunks.map((list) => list.map((i) => index[i])),
    };
  } else frames = frames.map((f) => f.slice());
  const { colorType: ct, depth: bits } = img.ihdr;
  frames.forEach((px, i) => {
    const f = img.frameSizes[i];
    if (i && !holds(f, patch)) return;
    paintSamples(patch, { width: f.width, height: f.height, channels: CHANNELS[ct], depth: bits, data: px, x: f.x ?? 0, y: f.y ?? 0 });
  });
  return { img, frames };
}

const holds = (f, p) => (f.x ?? 0) <= p.x && (f.y ?? 0) <= p.y && (f.x ?? 0) + f.width >= p.x + p.width && (f.y ?? 0) + f.height >= p.y + p.height;

/** Paints a restored JPEG frame (its coefficients) in place. */
export function paintJpegImage(frame, segments, c, o = 1, limits) {
  const patch = renderFor(validateCompiled(c), frame.width, frame.height, o, limits);
  return paintJpeg(patch, frame, quantTables(segments), jpegColour(segments, frame));
}

/**
 * Paints full-canvas RGBA frames (JPEG XL pixels: 8-bit, or 16-bit in a Uint16Array) in place.
 * @param {{width: number, height: number, frames: (Uint8Array|Uint16Array)[]}} image
 */
export function paintRgba({ width, height, frames }, c, limits) {
  const patch = renderFor(validateCompiled(c), width, height, 1, limits);
  for (const data of frames) paintSamples(patch, { width, height, channels: 4, depth: data instanceof Uint16Array ? 16 : 8, data });
  return !!patch;
}

/** The watermark as a straight RGBA patch for a canvas overlay (stored pixel grid). */
export function overlayFor(c, width, height, o = 1, limits) {
  return overlayPixels(renderFor(validateCompiled(c), width, height, o, limits));
}

// --- visible watermarks on scrambled images ------------------------------------------
// Each paints in place and returns the stash payload (see embed.js), or null if nothing
// was drawn. What gets stashed is exactly the area that gets painted over.

/** PNG: frames (native scrambled samples) are painted in place. */
export function stashPng(img, frames, c, o, key, salt) {
  c = validateCompiled(c);
  const { width, height, colorType, depth } = img.ihdr;
  const patch = renderFor(c, width, height, o);
  if (!patch) return null;
  const pb = img.pixelBytes;
  const regions = [];
  frames.forEach((px, i) => {
    const f = img.frameSizes[i];
    if (i && !holds(f, patch)) return;
    const fx = f.x ?? 0, fy = f.y ?? 0;
    const x0 = Math.max(0, patch.x - fx), y0 = Math.max(0, patch.y - fy);
    const x1 = Math.min(f.width, patch.x + patch.width - fx), y1 = Math.min(f.height, patch.y + patch.height - fy);
    if (x1 > x0 && y1 > y0) regions.push({ frame: i, x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  });
  const raw = new Uint8Array(regions.reduce((n, r) => n + r.width * r.height * pb, 0));
  let at = 0;
  for (const r of regions) at = copyRect(frames[r.frame], img.frameSizes[r.frame].width, pb, r, raw, at, true);
  const plte = img.chunks.find((ch) => ch.type === 'PLTE')?.data;
  const trns = img.chunks.find((ch) => ch.type === 'tRNS')?.data ?? null;
  for (const r of regions) {
    const f = img.frameSizes[r.frame];
    const target = { width: f.width, height: f.height, data: frames[r.frame], x: f.x ?? 0, y: f.y ?? 0 };
    if (colorType === 3) paintIndexed(patch, { ...target, palette: plte, alphas: trns });
    else paintSamples(patch, { ...target, channels: CHANNELS[colorType], depth });
  }
  return encodeStash({ watermark: c, regions, raw, key, salt });
}

/** JPEG: the scrambled frame's coefficients under the watermark are stashed, then painted. */
export function stashJpeg(frame, segments, c, o, key, salt) {
  c = validateCompiled(c);
  const patch = renderFor(c, frame.width, frame.height, o);
  if (!patch) return null;
  const tw = 8 * frame.hmax, th = 8 * frame.vmax;
  const x0 = Math.floor(patch.x / tw), y0 = Math.floor(patch.y / th);
  const r = {
    frame: 0, x: x0, y: y0,
    width: Math.min(frame.mcusX, Math.ceil((patch.x + patch.width) / tw)) - x0,
    height: Math.min(frame.mcusY, Math.ceil((patch.y + patch.height) / th)) - y0,
  };
  const raw = new Uint8Array(jpegRectBytes(frame, r));
  jpegRect(frame, r, raw, true);
  paintJpeg(patch, frame, quantTables(segments), jpegColour(segments, frame));
  return encodeStash({ watermark: c, regions: [r], raw, key, salt });
}

/** JPEG XL: full-canvas 8-bit RGBA frames (the only depth whose display pixels match). */
export function stashRgba({ width, height, frames }, c, key, salt) {
  c = validateCompiled(c);
  const patch = renderFor(c, width, height, 1);
  if (!patch) return null;
  const r0 = { x: patch.x, y: patch.y, width: Math.min(width, patch.x + patch.width) - patch.x, height: Math.min(height, patch.y + patch.height) - patch.y };
  const regions = frames.map((_, i) => ({ frame: i, ...r0 }));
  const raw = new Uint8Array(regions.length * r0.width * r0.height * 4);
  let at = 0;
  for (const r of regions) at = copyRect(frames[r.frame], width, 4, r, raw, at, true);
  for (const data of frames) paintSamples(patch, { width, height, channels: 4, depth: 8, data });
  return encodeStash({ watermark: c, regions, raw, key, salt });
}
