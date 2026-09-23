// PNG pixel data <-> flat pixel buffer, in the image's native sample format.
//
// The buffer holds width*height pixels, `pixelBytes` bytes each, row-major:
//   - depth >= 8: the PNG sample bytes verbatim (16-bit stays big-endian);
//   - depth 1/2/4 (grey or palette only): one byte per pixel holding the raw value.
// Interlaced images are de-interlaced here and re-interlaced on write, so the
// permutation always works on the real pixel grid.

import { deflate, inflateUpTo, deflateAsync, inflateUpToAsync } from './zlib.js';
import { PixmixError } from '../../core/params.js';
import { resolveLimits, decompressedLimitError } from '../../core/limits.js';

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const VALID_DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const ADAM7 = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
];

/**
 * @typedef {object} Ihdr
 * @property {number} width @property {number} height @property {number} depth
 * @property {number} colorType @property {number} interlace
 */

/** @param {Uint8Array} data @returns {Ihdr} */
export function parseIhdr(data) {
  if (data.length !== 13) throw new PixmixError('Bad IHDR length', 'BAD_PNG');
  const dv = new DataView(data.buffer, data.byteOffset, 13);
  const ihdr = {
    width: dv.getUint32(0),
    height: dv.getUint32(4),
    depth: data[8],
    colorType: data[9],
    interlace: data[12],
  };
  if (!ihdr.width || !ihdr.height) throw new PixmixError('PNG has zero size', 'BAD_PNG');
  if (!VALID_DEPTHS[ihdr.colorType]?.includes(ihdr.depth)) {
    throw new PixmixError('Invalid PNG colour type / bit depth', 'BAD_PNG');
  }
  if (data[10] !== 0 || data[11] !== 0 || ihdr.interlace > 1) {
    throw new PixmixError('Unsupported PNG compression/filter/interlace method', 'BAD_PNG');
  }
  return ihdr;
}

export function pixelBytesOf(ihdr) {
  return ihdr.depth < 8 ? 1 : (CHANNELS[ihdr.colorType] * ihdr.depth) / 8;
}

function passes(ihdr) {
  if (!ihdr.interlace) return [{ x0: 0, y0: 0, dx: 1, dy: 1, w: ihdr.width, h: ihdr.height }];
  return ADAM7.map(([x0, y0, dx, dy]) => ({
    x0, y0, dx, dy,
    w: Math.ceil(Math.max(0, ihdr.width - x0) / dx),
    h: Math.ceil(Math.max(0, ihdr.height - y0) / dy),
  })).filter((p) => p.w > 0 && p.h > 0);
}

const bitsPerPixel = (ihdr) => CHANNELS[ihdr.colorType] * ihdr.depth;
const rowBytes = (ihdr, w) => Math.ceil((w * bitsPerPixel(ihdr)) / 8);

/** Size of the filtered raster the IHDR describes: what the image data must inflate to. */
export function rawSize(ihdr) {
  let total = 0;
  for (const p of passes(ihdr)) total += p.h * (1 + rowBytes(ihdr, p.w));
  return total;
}

// The raster's size is known up front, so inflating never goes past it: a decompression
// bomb stops there, and data beyond the image (tolerated, as by libpng) is not inflated.
function rasterSize(ihdr, limits) {
  const size = rawSize(ihdr);
  const { maxDecompressedBytes } = resolveLimits(limits);
  if (size > maxDecompressedBytes) throw decompressedLimitError(maxDecompressedBytes);
  return size;
}

/**
 * @param {Ihdr} ihdr @param {Uint8Array} zdata concatenated IDAT payloads
 * @param {Partial<import('../../core/limits.js').Limits>} [limits]
 */
export function decodeRaster(ihdr, zdata, limits) {
  const size = rasterSize(ihdr, limits);
  let raw;
  try {
    raw = inflateUpTo(zdata, size);
  } catch {
    throw new PixmixError('Corrupt PNG image data', 'BAD_PNG');
  }
  return unfilterRaster(ihdr, raw);
}

export async function decodeRasterAsync(ihdr, zdata, limits) {
  const size = rasterSize(ihdr, limits);
  let raw;
  try {
    raw = await inflateUpToAsync(zdata, size);
  } catch {
    throw new PixmixError('Corrupt PNG image data', 'BAD_PNG');
  }
  return unfilterRaster(ihdr, raw);
}

function unfilterRaster(ihdr, raw) {
  const pb = pixelBytesOf(ihdr);
  const fbpp = Math.max(1, bitsPerPixel(ihdr) >> 3);
  const out = new Uint8Array(ihdr.width * ihdr.height * pb);
  let pos = 0;
  for (const p of passes(ihdr)) {
    const rb = rowBytes(ihdr, p.w);
    let prev = new Uint8Array(rb);
    let cur = new Uint8Array(rb);
    for (let r = 0; r < p.h; r++) {
      if (pos + 1 + rb > raw.length) throw new PixmixError('PNG image data is truncated', 'BAD_PNG');
      const filter = raw[pos];
      cur.set(raw.subarray(pos + 1, pos + 1 + rb));
      pos += 1 + rb;
      unfilter(filter, cur, prev, fbpp);
      storeRow(ihdr, cur, out, p, r, pb);
      [prev, cur] = [cur, prev];
    }
  }
  return out;
}

/**
 * @param {Ihdr} ihdr @param {Uint8Array} pixels
 * @param {{level?: number, filter?: 'adaptive'|'none'}} [opts]
 *   'none' suits scrambled noise, where prediction filters cannot help.
 */
export function encodeRaster(ihdr, pixels, opts = {}) {
  return deflate(filterRaster(ihdr, pixels, opts.filter), opts.level ?? 6);
}

export function encodeRasterAsync(ihdr, pixels, opts = {}) {
  return deflateAsync(filterRaster(ihdr, pixels, opts.filter), opts.level ?? 6);
}

function filterRaster(ihdr, pixels, filter = 'adaptive') {
  const pb = pixelBytesOf(ihdr);
  const fbpp = Math.max(1, bitsPerPixel(ihdr) >> 3);
  const ps = passes(ihdr);
  const raw = new Uint8Array(rawSize(ihdr));
  // Filtering does not help sub-byte or palette images (per the PNG spec's advice).
  const adaptive = filter === 'adaptive' && ihdr.depth >= 8 && ihdr.colorType !== 3;
  let pos = 0;
  for (const p of ps) {
    const rb = rowBytes(ihdr, p.w);
    let prev = new Uint8Array(rb);
    let cur = new Uint8Array(rb);
    for (let r = 0; r < p.h; r++) {
      if (ihdr.depth < 8) cur.fill(0);
      loadRow(ihdr, pixels, cur, p, r, pb);
      const type = adaptive ? pickFilter(cur, prev, fbpp) : 0;
      raw[pos] = type;
      writeFiltered(type, cur, prev, fbpp, raw, pos + 1);
      pos += 1 + rb;
      const t = prev; prev = cur; cur = t;
    }
  }
  return raw;
}

function storeRow(ihdr, row, out, p, r, pb) {
  const y = p.y0 + r * p.dy;
  const base = y * ihdr.width;
  if (ihdr.depth >= 8) {
    if (p.dx === 1) { out.set(row.subarray(0, p.w * pb), base * pb); return; }
    for (let i = 0; i < p.w; i++) {
      const o = (base + p.x0 + i * p.dx) * pb;
      for (let k = 0; k < pb; k++) out[o + k] = row[i * pb + k];
    }
    return;
  }
  const d = ihdr.depth, mask = (1 << d) - 1, perByte = 8 / d;
  for (let i = 0; i < p.w; i++) {
    const shift = 8 - d * (1 + (i % perByte));
    out[base + p.x0 + i * p.dx] = (row[(i / perByte) | 0] >> shift) & mask;
  }
}

function loadRow(ihdr, pixels, row, p, r, pb) {
  const y = p.y0 + r * p.dy;
  const base = y * ihdr.width;
  if (ihdr.depth >= 8) {
    if (p.dx === 1) { row.set(pixels.subarray(base * pb, (base + p.w) * pb)); return; }
    for (let i = 0; i < p.w; i++) {
      const o = (base + p.x0 + i * p.dx) * pb;
      for (let k = 0; k < pb; k++) row[i * pb + k] = pixels[o + k];
    }
    return;
  }
  const d = ihdr.depth, perByte = 8 / d;
  for (let i = 0; i < p.w; i++) {
    const shift = 8 - d * (1 + (i % perByte));
    row[(i / perByte) | 0] |= pixels[base + p.x0 + i * p.dx] << shift;
  }
}

function unfilter(type, cur, prev, bpp) {
  const n = cur.length;
  switch (type) {
    case 0: return;
    case 1: for (let i = bpp; i < n; i++) cur[i] = (cur[i] + cur[i - bpp]) & 255; return;
    case 2: for (let i = 0; i < n; i++) cur[i] = (cur[i] + prev[i]) & 255; return;
    case 3:
      for (let i = 0; i < n; i++) cur[i] = (cur[i] + (((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1)) & 255;
      return;
    case 4:
      for (let i = 0; i < n; i++) {
        cur[i] = (cur[i] + paeth(i >= bpp ? cur[i - bpp] : 0, prev[i], i >= bpp ? prev[i - bpp] : 0)) & 255;
      }
      return;
    default: throw new PixmixError(`Invalid PNG filter type ${type}`, 'BAD_PNG');
  }
}

// Minimum sum of absolute differences (bytes read as signed) over all five filters,
// computed in one pass.
function pickFilter(cur, prev, bpp) {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  for (let i = 0; i < cur.length; i++) {
    const x = cur[i];
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    let v;
    v = x; s0 += v < 128 ? v : 256 - v;
    v = (x - a) & 255; s1 += v < 128 ? v : 256 - v;
    v = (x - b) & 255; s2 += v < 128 ? v : 256 - v;
    v = (x - ((a + b) >> 1)) & 255; s3 += v < 128 ? v : 256 - v;
    v = (x - paeth(a, b, c)) & 255; s4 += v < 128 ? v : 256 - v;
  }
  let best = 0, score = s0;
  if (s1 < score) { best = 1; score = s1; }
  if (s2 < score) { best = 2; score = s2; }
  if (s3 < score) { best = 3; score = s3; }
  if (s4 < score) best = 4;
  return best;
}

function writeFiltered(type, cur, prev, bpp, out, o) {
  const n = cur.length;
  switch (type) {
    case 0: out.set(cur, o); return;
    case 1:
      for (let i = 0; i < n; i++) out[o + i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
      return;
    case 2:
      for (let i = 0; i < n; i++) out[o + i] = cur[i] - prev[i];
      return;
    case 3:
      for (let i = 0; i < n; i++) out[o + i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1);
      return;
    default:
      for (let i = 0; i < n; i++) {
        out[o + i] = cur[i] - (i >= bpp ? paeth(cur[i - bpp], prev[i], prev[i - bpp]) : prev[i]);
      }
  }
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
