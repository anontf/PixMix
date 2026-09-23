// Builds a PNG from decoded 8-bit RGBA plus container-independent metadata.
//
// The colour type is the smallest one that loses nothing: grey, grey+alpha, palette (up to
// 256 colours, with 1/2/4-bit indices when few enough), RGB or RGBA. Palette output also
// pays off after pixel scrambling, since indices compress far better than RGB noise.

import { writeChunks } from '../formats/png/chunks.js';
import { encodeRaster } from '../formats/png/raster.js';
import { PixmixError } from '../core/params.js';
// Metadata is compressed with fflate everywhere (not native zlib) so the same input gives
// byte-identical chunks on servers and in browsers.
import { zlibSync } from 'fflate';

const utf8 = new TextEncoder();
const latin1Bytes = (s) => Uint8Array.from(s, (c) => { const n = c.charCodeAt(0); return n < 256 ? n : 63; });

/**
 * @param {{width: number, height: number, data: Uint8Array,
 *   animation?: {frames: {data: Uint8Array, delay: [number, number]}[], plays: number}}} image
 *   RGBA8; with `animation` (full-canvas frames) the result is an APNG
 * @param {import('../meta/jpeg.js').Metadata} [meta]
 * @returns {{png: Uint8Array, transferred: string[], dropped: string[]}}
 */
export function buildPng(image, meta = {}) {
  const { width, height } = image;
  if (image.depth === 16) {
    // 16-bit RGBA (a Uint16Array). If every sample is exactly an 8-bit value (v * 257),
    // 8 bits lose nothing, so take the smaller 8-bit route.
    const d = image.data;
    let exact8 = true;
    for (let i = 0; i < d.length; i++) if (d[i] % 257) { exact8 = false; break; }
    if (exact8) return buildPng({ ...image, depth: 8, data: Uint8Array.from(d, (v) => v / 257) }, meta);
  }
  const frames = image.depth !== 16 && image.animation?.frames.length > 1 ? image.animation.frames : null;
  // All frames share one colour type (and palette), so analyse them together; Uint32 views
  // below need 4-byte alignment (pooled Node Buffers may not have it).
  let data = frames ? concatAll(frames.map((f) => f.data)) : image.data.byteOffset % 4 ? image.data.slice() : image.data;
  if (data.length !== width * height * 4 * (frames?.length ?? 1)) throw new PixmixError('Decoder must return width*height RGBA samples', 'DECODER');
  const transferred = frames ? ['animation'] : [];
  const dropped = [...(meta.dropped ?? [])].filter((d) => !(frames && d.startsWith('animation')));

  // An ICC profile constrains the colour type: GRAY profiles need grey PNGs, RGB profiles
  // need colour ones, anything else (e.g. CMYK) cannot be embedded in a PNG at all.
  let icc = meta.icc;
  const iccSpace = icc?.length >= 20 ? String.fromCharCode(...icc.subarray(16, 20)) : null;
  if (icc && iccSpace !== 'RGB ' && iccSpace !== 'GRAY') {
    dropped.push(`ICC profile (${iccSpace?.trim() || 'invalid'} colour space)`);
    icc = undefined;
  }
  const rows = height * (frames?.length ?? 1);
  const pick = image.depth === 16 ? pickRaster16 : pickRaster;
  let raster = pick(width, rows, data, icc ? iccSpace : null);
  if (raster.iccMismatch) {
    dropped.push('ICC profile (GRAY profile on a colour image)');
    icc = undefined;
    raster = pick(width, rows, data, null);
  }

  const chunks = [{ type: 'IHDR', data: ihdr(width, height, raster.depth, raster.colorType) }];
  if (icc) {
    chunks.push({ type: 'iCCP', data: concat(latin1Bytes('ICC profile'), new Uint8Array([0, 0]), zlibSync(icc, { level: 9 })) });
    transferred.push('ICC profile');
  }
  if (meta.density) {
    const d = new Uint8Array(9);
    const dv = new DataView(d.buffer);
    dv.setUint32(0, meta.density.x);
    dv.setUint32(4, meta.density.y);
    d[8] = meta.density.unit === 'meter' ? 1 : 0;
    chunks.push({ type: 'pHYs', data: d });
    transferred.push('density');
  }
  if (meta.exif?.length) {
    chunks.push({ type: 'eXIf', data: meta.exif });
    transferred.push('EXIF');
  }
  if (meta.xmp) {
    chunks.push({ type: 'iTXt', data: concat(latin1Bytes('XML:com.adobe.xmp'), new Uint8Array([0, 0, 0, 0, 0]), utf8.encode(meta.xmp)) });
    transferred.push('XMP');
  }
  for (const text of meta.comments ?? []) {
    chunks.push({ type: 'tEXt', data: concat(latin1Bytes('Comment'), new Uint8Array([0]), latin1Bytes(text)) });
    if (!transferred.includes('comments')) transferred.push('comments');
  }
  if (raster.plte) chunks.push({ type: 'PLTE', data: raster.plte });
  if (raster.trns) chunks.push({ type: 'tRNS', data: raster.trns });
  const header = { width, height, depth: raster.depth, colorType: raster.colorType, interlace: 0 };
  if (!frames) {
    chunks.push({ type: 'IDAT', data: encodeRaster(header, raster.pixels) });
  } else {
    // APNG: every frame full-size, replacing the previous one (dispose none, blend source).
    const per = raster.pixels.length / frames.length;
    chunks.push({ type: 'acTL', data: u32(frames.length, image.animation.plays) });
    let seq = 0;
    frames.forEach((f, i) => {
      const fctl = new Uint8Array(26);
      fctl.set(u32(seq++, width, height, 0, 0));
      new DataView(fctl.buffer).setUint16(20, f.delay[0]);
      new DataView(fctl.buffer).setUint16(22, f.delay[1]);
      chunks.push({ type: 'fcTL', data: fctl });
      const z = encodeRaster(header, raster.pixels.subarray(i * per, (i + 1) * per));
      chunks.push(i === 0 ? { type: 'IDAT', data: z } : { type: 'fdAT', data: concat(u32(seq++), z) });
    });
  }
  chunks.push({ type: 'IEND', data: new Uint8Array(0) });
  return { png: writeChunks(chunks), transferred, dropped };
}

function pickRaster(width, height, rgba, iccSpace) {
  const n = width * height;
  const px = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  let grey = true, opaque = true;
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    if (grey && (rgba[o] !== rgba[o + 1] || rgba[o] !== rgba[o + 2])) grey = false;
    if (opaque && rgba[o + 3] !== 255) opaque = false;
    if (!grey && !opaque) break;
  }
  if (iccSpace === 'GRAY' && !grey) return { iccMismatch: true };
  if (iccSpace === 'RGB ') grey = false; // RGB profiles are not allowed on grey PNGs

  if (grey) {
    const pb = opaque ? 1 : 2;
    const pixels = new Uint8Array(n * pb);
    for (let i = 0; i < n; i++) {
      pixels[i * pb] = rgba[i * 4];
      if (!opaque) pixels[i * pb + 1] = rgba[i * 4 + 3];
    }
    return { colorType: opaque ? 0 : 4, depth: 8, pixels };
  }

  const palette = new Map();
  for (let i = 0; i < n && palette.size <= 256; i++) {
    if (!palette.has(px[i])) palette.set(px[i], palette.size);
  }
  if (palette.size <= 256) {
    const count = palette.size;
    const plte = new Uint8Array(count * 3);
    const alphas = new Uint8Array(count);
    for (const [c, idx] of palette) {
      const b = new Uint8Array(new Uint32Array([c]).buffer);
      plte.set(b.subarray(0, 3), idx * 3);
      alphas[idx] = b[3];
    }
    let lastAlpha = -1;
    for (let i = 0; i < count; i++) if (alphas[i] !== 255) lastAlpha = i;
    const pixels = new Uint8Array(n);
    for (let i = 0; i < n; i++) pixels[i] = palette.get(px[i]);
    const depth = count <= 2 ? 1 : count <= 4 ? 2 : count <= 16 ? 4 : 8;
    return { colorType: 3, depth, pixels, plte, trns: lastAlpha >= 0 ? alphas.slice(0, lastAlpha + 1) : null };
  }

  if (opaque) {
    const pixels = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      pixels[i * 3] = rgba[i * 4]; pixels[i * 3 + 1] = rgba[i * 4 + 1]; pixels[i * 3 + 2] = rgba[i * 4 + 2];
    }
    return { colorType: 2, depth: 8, pixels };
  }
  return { colorType: 6, depth: 8, pixels: rgba };
}

function u32(...values) {
  const b = new Uint8Array(values.length * 4);
  const dv = new DataView(b.buffer);
  values.forEach((v, i) => dv.setUint32(i * 4, v));
  return b;
}

const concatAll = (parts) => concat(...parts);

/** 16-bit counterpart of pickRaster: grey / grey+alpha / RGB / RGBA, big-endian samples. */
function pickRaster16(width, height, d, iccSpace) {
  const n = width * height;
  let grey = true, opaque = true;
  for (let o = 0; o < n * 4 && (grey || opaque); o += 4) {
    if (grey && (d[o] !== d[o + 1] || d[o] !== d[o + 2])) grey = false;
    if (opaque && d[o + 3] !== 65535) opaque = false;
  }
  if (iccSpace === 'GRAY' && !grey) return { iccMismatch: true };
  if (iccSpace === 'RGB ') grey = false;
  const keep = grey ? (opaque ? [0] : [0, 3]) : opaque ? [0, 1, 2] : [0, 1, 2, 3];
  const pixels = new Uint8Array(n * keep.length * 2);
  for (let i = 0, o = 0; i < n; i++) {
    for (const c of keep) {
      const v = d[i * 4 + c];
      pixels[o++] = v >> 8;
      pixels[o++] = v & 255;
    }
  }
  const colorType = grey ? (opaque ? 0 : 4) : opaque ? 2 : 6;
  return { colorType, depth: 16, pixels };
}

function ihdr(width, height, depth, colorType) {
  const d = new Uint8Array(13);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  d[8] = depth;
  d[9] = colorType;
  return d;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
