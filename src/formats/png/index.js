// PNG in, PNG out. Only the IDAT stream is rewritten; every other chunk is copied through
// untouched and in its original order. The scramble parameters go in a private,
// ancillary, safe-to-copy `pmIx` chunk placed right before the image data.

import { readChunks, writeChunks, isPng } from './chunks.js';
import {
  parseIhdr, pixelBytesOf, decodeRaster, encodeRaster, decodeRasterAsync, encodeRasterAsync,
} from './raster.js';
import { computeLayout, applyMap } from '../../core/layout.js';
import {
  makeParams, writeMarker, readMarker, checksEqual, PixmixError, WrongKeyError,
} from '../../core/params.js';

export const MARKER_CHUNK = 'pmIx';
export { isPng };

/**
 * @typedef {object} PngImage
 * @property {import('./chunks.js').Chunk[]} chunks
 * @property {import('./raster.js').Ihdr} ihdr
 * @property {Uint8Array} pixels
 * @property {number} pixelBytes
 */

function parsePng(bytes) {
  const chunks = readChunks(bytes);
  const ihdr = parseIhdr(chunks[0].data);
  if (chunks.some((c) => c.type === 'acTL')) {
    throw new PixmixError('Animated PNG (APNG) is not supported yet', 'UNSUPPORTED');
  }
  const idat = chunks.filter((c) => c.type === 'IDAT');
  if (!idat.length) throw new PixmixError('PNG has no image data', 'BAD_PNG');
  return { chunks, ihdr, zdata: concat(idat.map((c) => c.data)), pixelBytes: pixelBytesOf(ihdr) };
}

/** @returns {PngImage} */
export function readPng(bytes) {
  const { zdata, ...img } = parsePng(bytes);
  return { ...img, pixels: decodeRaster(img.ihdr, zdata) };
}

/** Same as readPng, using native async inflate where the platform has it. */
export async function readPngAsync(bytes) {
  const { zdata, ...img } = parsePng(bytes);
  return { ...img, pixels: await decodeRasterAsync(img.ihdr, zdata) };
}

/** Rebuilds the file: original chunks in order, image data swapped, marker set or removed. */
function writePng(img, pixels, marker, raster) {
  return assemble(img, encodeRaster(img.ihdr, pixels, raster), marker);
}

function assemble(img, idat, marker) {
  const out = [];
  let placed = false;
  for (const c of img.chunks) {
    if (c.type === MARKER_CHUNK) continue;
    if (c.type === 'IDAT') {
      if (!placed) {
        if (marker) out.push({ type: MARKER_CHUNK, data: marker });
        out.push({ type: 'IDAT', data: idat });
        placed = true;
      }
      continue;
    }
    out.push(c);
  }
  return writeChunks(out);
}

export function readPngMarker(chunks) {
  const c = chunks.find((ch) => ch.type === MARKER_CHUNK);
  return c ? readMarker(c.data) : null;
}

/** Throws WrongKeyError on mismatch. */
function layoutFor(key, params, ihdr, expectedCheck) {
  const layout = computeLayout(key, params, ihdr.width, ihdr.height);
  if (expectedCheck && !checksEqual(layout.check, expectedCheck)) throw new WrongKeyError();
  return layout;
}

/**
 * @param {Uint8Array} bytes PNG
 * @param {{key: string|Uint8Array, mode?: 'pixel'|'block', block?: number, level?: number, salt?: Uint8Array}} opts
 */
export function scramblePng(bytes, { key, mode, block, level, salt } = {}) {
  const img = readPng(bytes);
  if (readPngMarker(img.chunks)) {
    throw new PixmixError('Image is already scrambled (decode it first, or use rekey)', 'ALREADY_SCRAMBLED');
  }
  const params = makeParams({ mode, block, salt });
  const layout = layoutFor(key, params, img.ihdr);
  const pixels = applyMap(img.pixels, layout.map, img.pixelBytes, 'scramble');
  return writePng(img, pixels, writeMarker(params, layout.check), scrambledRaster(params, level));
}

// Pixel-scrambled data is noise: prediction filters and slow deflate levels only cost time.
function scrambledRaster(params, level) {
  return params.mode === 'pixel' ? { level: level ?? 1, filter: 'none' } : { level };
}

/**
 * Full decode with every intermediate the browser reveal needs.
 * @param {Uint8Array} bytes scrambled PNG
 */
export function unscramblePngDetailed(bytes, { key, level } = {}) {
  const img = readPng(bytes);
  const marker = readPngMarker(img.chunks);
  if (!marker) throw new PixmixError('Image carries no pixmix marker', 'NOT_SCRAMBLED');
  const layout = layoutFor(key, marker.params, img.ihdr, marker.check);
  const pixels = applyMap(img.pixels, layout.map, img.pixelBytes, 'unscramble');
  return {
    img,
    layout,
    params: marker.params,
    pixels,
    /** Lazily encode, the deflate step is the slow part. */
    toPng: () => writePng(img, pixels, null, { level }),
  };
}

/**
 * Async flavour of unscramblePngDetailed for browsers (native inflate/deflate).
 * `toPng` returns a Promise here.
 */
export async function unscramblePngDetailedAsync(bytes, { key, level } = {}) {
  const img = await readPngAsync(bytes);
  const marker = readPngMarker(img.chunks);
  if (!marker) throw new PixmixError('Image carries no pixmix marker', 'NOT_SCRAMBLED');
  const layout = layoutFor(key, marker.params, img.ihdr, marker.check);
  const pixels = applyMap(img.pixels, layout.map, img.pixelBytes, 'unscramble');
  return {
    img,
    layout,
    params: marker.params,
    pixels,
    toPng: async () => assemble(img, await encodeRasterAsync(img.ihdr, pixels, { level }), null),
  };
}

export function unscramblePng(bytes, opts) {
  return unscramblePngDetailed(bytes, opts).toPng();
}

/** Re-scrambles with a new key (and optionally new mode/block) in one pass. */
export function rekeyPng(bytes, { from, to, mode, block, level, salt } = {}) {
  const img = readPng(bytes);
  const marker = readPngMarker(img.chunks);
  if (!marker) throw new PixmixError('Image carries no pixmix marker', 'NOT_SCRAMBLED');
  const oldLayout = layoutFor(from, marker.params, img.ihdr, marker.check);
  const plain = applyMap(img.pixels, oldLayout.map, img.pixelBytes, 'unscramble');
  const params = makeParams({
    mode: mode ?? marker.params.mode,
    block: block ?? (marker.params.block || undefined),
    salt,
  });
  const layout = layoutFor(to, params, img.ihdr);
  const pixels = applyMap(plain, layout.map, img.pixelBytes, 'scramble');
  return writePng(img, pixels, writeMarker(params, layout.check), scrambledRaster(params, level));
}

/** Cheap: parses chunks only, no inflate. */
export function inspectPng(bytes) {
  const chunks = readChunks(bytes);
  const ihdr = parseIhdr(chunks[0].data);
  const marker = readPngMarker(chunks);
  return {
    format: 'png',
    width: ihdr.width,
    height: ihdr.height,
    bitDepth: ihdr.depth,
    colorType: ihdr.colorType,
    interlaced: !!ihdr.interlace,
    scrambled: !!marker,
    mode: marker?.params.mode ?? null,
    block: marker?.params.block || null,
    chunks: chunks.map((c) => ({ type: c.type, length: c.data.length })),
  };
}

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
