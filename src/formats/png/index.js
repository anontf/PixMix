// PNG and APNG in, PNG and APNG out. Only image data (IDAT, fdAT) is rewritten; every other
// chunk is copied through untouched and in its original order (APNG sequence numbers are
// renumbered, since frame data may have been split over a different number of chunks).
// The scramble parameters go in a private, ancillary, safe-to-copy `pmIx` chunk right
// before the image data.
//
// Frames: frame 0 is always the IDAT image (the one non-APNG viewers show, whether or not
// it is also the first animation frame); frames 1.. are the fdAT frames, each its own
// width x height sub-image. Every frame gets its own permutation (the frame index is part
// of the seed), so identical frames do not scramble identically.
//
// Watermarks (see watermark/embed.js): a `pmWm` chunk names the watermark the decoder draws
// on the restored image; a `pmWs` chunk holds the scrambled pixels under a watermark drawn
// on the scrambled image itself. Neither is copied into the restored file.

import { readChunks, writeChunks, isPng } from './chunks.js';
import {
  parseIhdr, pixelBytesOf, decodeRaster, encodeRaster, decodeRasterAsync, encodeRasterAsync,
} from './raster.js';
import { computeLayout, applyMap } from '../../core/layout.js';
import {
  makeParams, writeMarker, readMarker, checksEqual, PixmixError, WrongKeyError, FLAG_STASH,
} from '../../core/params.js';
import { readOrientation } from '../../meta/exif.js';
import { WATERMARK_TAG, STASH_TAG, encodeWatermark, decodeWatermark, restorePixelStash } from '../../watermark/embed.js';
import { stashPng } from '../../watermark/paint.js';

export const MARKER_CHUNK = 'pmIx';
export { isPng };

/**
 * @typedef {object} Frame
 * @property {number} width @property {number} height
 * @property {number[]} chunkIndexes  the IDAT / fdAT chunks holding its data
 * @property {Uint8Array} zdata
 *
 * @typedef {object} PngImage
 * @property {import('./chunks.js').Chunk[]} chunks
 * @property {import('./raster.js').Ihdr} ihdr
 * @property {Uint8Array} pixels       frame 0 (the IDAT image)
 * @property {Uint8Array[]} frames     all frames' pixels, frame 0 first
 * @property {{width: number, height: number}[]} frameSizes
 * @property {boolean} animated
 * @property {number} pixelBytes
 */

function parsePng(bytes) {
  const chunks = readChunks(bytes);
  const ihdr = parseIhdr(chunks[0].data);
  const frames = parseFrames(chunks, ihdr);
  return { chunks, ihdr, frames, animated: chunks.some((c) => c.type === 'acTL'), pixelBytes: pixelBytesOf(ihdr) };
}

function parseFrames(chunks, ihdr) {
  const frames = [];
  let pending = null; // fcTL waiting for its fdAT data
  let current = null;
  chunks.forEach((c, i) => {
    if (c.type === 'fcTL') {
      if (c.data.length !== 26) throw new PixmixError('Bad APNG fcTL chunk', 'BAD_PNG');
      const dv = new DataView(c.data.buffer, c.data.byteOffset, 26);
      pending = { width: dv.getUint32(4), height: dv.getUint32(8), x: dv.getUint32(12), y: dv.getUint32(16) };
      if (!pending.width || !pending.height || pending.x + pending.width > ihdr.width || pending.y + pending.height > ihdr.height) {
        throw new PixmixError('APNG frame lies outside the image', 'BAD_PNG');
      }
      current = null;
    } else if (c.type === 'IDAT') {
      if (!frames.length) frames.push({ width: ihdr.width, height: ihdr.height, x: 0, y: 0, chunkIndexes: [], parts: [] });
      frames[0].chunkIndexes.push(i);
      frames[0].parts.push(c.data);
      pending = null;
    } else if (c.type === 'fdAT') {
      if (c.data.length < 4) throw new PixmixError('Bad APNG fdAT chunk', 'BAD_PNG');
      if (pending) {
        current = { width: pending.width, height: pending.height, x: pending.x, y: pending.y, chunkIndexes: [], parts: [] };
        frames.push(current);
        pending = null;
      }
      if (!current || !frames.length) throw new PixmixError('APNG fdAT without a frame', 'BAD_PNG');
      current.chunkIndexes.push(i);
      current.parts.push(c.data.subarray(4));
    }
  });
  if (!frames.length) throw new PixmixError('PNG has no image data', 'BAD_PNG');
  return frames.map(({ parts, ...f }) => ({ ...f, zdata: concat(parts) }));
}

const frameIhdr = (ihdr, f) => ({ ...ihdr, width: f.width, height: f.height });

/** @returns {PngImage} */
export function readPng(bytes) {
  const { frames, ...img } = parsePng(bytes);
  const pixels = frames.map((f) => decodeRaster(frameIhdr(img.ihdr, f), f.zdata));
  return withFrames(img, frames, pixels);
}

/** Same as readPng, using native async inflate where the platform has it. */
export async function readPngAsync(bytes) {
  const { frames, ...img } = parsePng(bytes);
  const pixels = [];
  for (const f of frames) pixels.push(await decodeRasterAsync(frameIhdr(img.ihdr, f), f.zdata));
  return withFrames(img, frames, pixels);
}

function withFrames(img, frames, pixels) {
  return {
    ...img,
    pixels: pixels[0],
    frames: pixels,
    frameSizes: frames.map(({ width, height, x, y }) => ({ width, height, x, y })),
    frameChunks: frames.map((f) => f.chunkIndexes),
  };
}

/**
 * Rebuilds the file: original chunks in order, frame data swapped, marker set or removed.
 * `extra` holds the watermark chunks to write (pmWm, pmWs); existing ones are dropped.
 */
function writePng(img, frames, marker, raster, extra) {
  return assemble(img, frames.map((px, i) => encodeRaster(frameIhdr(img.ihdr, img.frameSizes[i]), px, raster)), marker, extra);
}

async function writePngAsync(img, frames, marker, raster, extra) {
  const data = [];
  for (let i = 0; i < frames.length; i++) data.push(await encodeRasterAsync(frameIhdr(img.ihdr, img.frameSizes[i]), frames[i], raster));
  return assemble(img, data, marker, extra);
}

function assemble(img, frameData, marker, { watermark, stash } = {}) {
  const firstChunkOf = new Map(img.frameChunks.map((idx, f) => [idx[0], f]));
  const dataChunks = new Set(img.frameChunks.flat());
  // The marker goes right before the image data, or before frame 0's fcTL when the IDAT
  // image is also the first animation frame (keeping fcTL + IDAT adjacent).
  const idat0 = img.frameChunks[0][0];
  const before = img.chunks[idat0 - 1]?.type === 'fcTL' ? idat0 - 1 : idat0;
  const out = [];
  img.chunks.forEach((c, i) => {
    if (c.type === MARKER_CHUNK || c.type === WATERMARK_TAG || c.type === STASH_TAG) return;
    if (i === before && marker) out.push({ type: MARKER_CHUNK, data: marker });
    if (i === before && watermark) out.push({ type: WATERMARK_TAG, data: watermark });
    if (c.type === 'IEND' && stash) out.push({ type: STASH_TAG, data: stash });
    if (!dataChunks.has(i)) { out.push(c); return; }
    if (!firstChunkOf.has(i)) return; // continuation chunk: merged into the first one
    const f = firstChunkOf.get(i);
    if (f === 0) {
      out.push({ type: 'IDAT', data: frameData[0] });
    } else {
      const d = new Uint8Array(4 + frameData[f].length);
      d.set(frameData[f], 4);
      out.push({ type: 'fdAT', data: d });
    }
  });
  if (img.animated) renumber(out);
  return writeChunks(out);
}

/** APNG sequence numbers run 0, 1, 2 … across fcTL and fdAT chunks, in file order. */
function renumber(chunks) {
  let seq = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c.type !== 'fcTL' && c.type !== 'fdAT') continue;
    const data = c.data.slice();
    new DataView(data.buffer).setUint32(0, seq++);
    chunks[i] = { type: c.type, data };
  }
}

export function readPngMarker(chunks) {
  const c = chunks.find((ch) => ch.type === MARKER_CHUNK);
  return c ? readMarker(c.data) : null;
}

/** Frame 0's layout carries the key check; throws WrongKeyError on mismatch. */
function layoutsFor(key, params, img, expectedCheck) {
  return img.frameSizes.map(({ width, height }, i) => {
    const layout = computeLayout(key, params, width, height, i);
    if (i === 0 && expectedCheck && !checksEqual(layout.check, expectedCheck)) throw new WrongKeyError();
    return layout;
  });
}

const mapFrames = (img, layouts, direction) => img.frames.map((px, i) => applyMap(px, layouts[i].map, img.pixelBytes, direction));

/**
 * @param {Uint8Array} bytes PNG or APNG
 * @param {{key: string|Uint8Array, mode?: 'pixel'|'block', block?: number, level?: number, salt?: Uint8Array}} opts
 */
export function scramblePng(bytes, { key, mode, block, level, salt, watermark, visibleWatermark } = {}) {
  const img = readPng(bytes);
  if (readPngMarker(img.chunks)) {
    throw new PixmixError('Image is already scrambled (decode it first, or use rekey)', 'ALREADY_SCRAMBLED');
  }
  if (mode === 'mcu') throw new PixmixError('Mode "mcu" only applies to JPEG and JPEG XL output', 'BAD_OPTION');
  const params = makeParams({ mode, block, salt });
  const layouts = layoutsFor(key, params, img);
  return finishScramble(img, mapFrames(img, layouts, 'scramble'), params, layouts[0].check, { key, level, watermark, visibleWatermark });
}

/**
 * Writes scrambled frames with the marker and the watermark chunks: `watermark` (compiled,
 * or {id}) is carried for the decoder; `visibleWatermark` (compiled) is drawn onto the
 * scrambled frames, whose covered pixels go into the stash.
 */
function finishScramble(img, frames, params, check, { key, level, watermark, visibleWatermark }) {
  let stash = null;
  if (visibleWatermark) {
    stash = stashPng(img, frames, visibleWatermark, pngOrientation(img.chunks), key, params.salt);
    if (stash) params = { ...params, flags: FLAG_STASH };
  }
  return writePng(img, frames, writeMarker(params, check), scrambledRaster(params, level), {
    watermark: watermark ? encodeWatermark(watermark) : null,
    stash,
  });
}

const pngOrientation = (chunks) => {
  const exif = chunks.find((c) => c.type === 'eXIf');
  return exif ? readOrientation(exif.data) : 1;
};

// Pixel-scrambled data is noise: prediction filters and slow deflate levels only cost time.
function scrambledRaster(params, level) {
  return params.mode === 'pixel' ? { level: level ?? 1, filter: 'none' } : { level };
}

function unscrambled(img, key) {
  const marker = readPngMarker(img.chunks);
  if (!marker) throw new PixmixError('Image carries no pixmix marker', 'NOT_SCRAMBLED');
  const layouts = layoutsFor(key, marker.params, img, marker.check);
  // A visible watermark: put the scrambled pixels it covers back first.
  let visible = null;
  if (marker.params.flags & FLAG_STASH) {
    const chunk = img.chunks.find((c) => c.type === STASH_TAG);
    if (!chunk) throw new PixmixError('Image lost the pixels under its visible watermark (pmWs chunk)', 'BAD_PNG');
    const frames = img.frames.map((pixels, i) => ({ pixels, width: img.frameSizes[i].width, height: img.frameSizes[i].height, bpp: img.pixelBytes }));
    visible = restorePixelStash(frames, chunk.data, key, marker.params.salt);
  }
  const frames = mapFrames(img, layouts, 'unscramble');
  return { marker, layouts, frames, visible };
}

/** The watermark a PNG carries for its restored image ({id, name, compiled}), or null. */
export function pngWatermark(chunks) {
  const c = chunks.find((ch) => ch.type === WATERMARK_TAG);
  return c ? decodeWatermark(c.data) : null;
}

/**
 * The restored frames with a watermark drawn on them. `paint` is {painter, watermark}:
 * painter is watermark/paint.js (loaded by the caller, so decoders only fetch it when
 * needed), watermark a compiled watermark.
 */
function painted(img, frames, paint) {
  if (!paint?.watermark) return { img, frames };
  return paint.painter.paintPng(img, frames, paint.watermark, pngOrientation(img.chunks)) ?? { img, frames };
}

/**
 * Full decode with every intermediate the browser reveal needs. `layout` and `pixels` are
 * frame 0's; `toPng` rebuilds the whole file, every frame included.
 * @param {Uint8Array} bytes scrambled PNG
 */
export function unscramblePngDetailed(bytes, { key, level } = {}) {
  const img = readPng(bytes);
  const { marker, layouts, frames } = unscrambled(img, key);
  return {
    img,
    layout: layouts[0],
    params: marker.params,
    pixels: frames[0],
    watermark: pngWatermark(img.chunks),
    /** Lazily encode, the deflate step is the slow part. `paint`: see painted(). */
    toPng: (paint) => { const p = painted(img, frames, paint); return writePng(p.img, p.frames, null, { level }); },
  };
}

/**
 * Async flavour of unscramblePngDetailed for browsers (native inflate/deflate).
 * `toPng` returns a Promise here.
 */
export async function unscramblePngDetailedAsync(bytes, { key, level } = {}) {
  const img = await readPngAsync(bytes);
  const { marker, layouts, frames } = unscrambled(img, key);
  return {
    img,
    layout: layouts[0],
    params: marker.params,
    pixels: frames[0],
    watermark: pngWatermark(img.chunks),
    toPng: (paint) => { const p = painted(img, frames, paint); return writePngAsync(p.img, p.frames, null, { level }); },
  };
}

export function unscramblePng(bytes, opts) {
  return unscramblePngDetailed(bytes, opts).toPng();
}

/**
 * Re-scrambles with a new key (and optionally new mode/block) in one pass. Watermarks stay
 * as they are unless `watermark` / `visibleWatermark` are given (null removes them).
 */
export function rekeyPng(bytes, { from, to, mode, block, level, salt, watermark, visibleWatermark } = {}) {
  const img = readPng(bytes);
  const { marker, frames, visible } = unscrambled(img, from);
  const params = makeParams({
    mode: mode ?? marker.params.mode,
    block: block ?? (marker.params.block || undefined),
    salt,
  });
  const layouts = layoutsFor(to, params, img);
  const plain = { ...img, frames };
  return finishScramble(img, mapFrames(plain, layouts, 'scramble'), params, layouts[0].check, {
    key: to, level,
    watermark: watermark === undefined ? carried(pngWatermark(img.chunks)) : watermark,
    visibleWatermark: visibleWatermark === undefined ? visible : visibleWatermark,
  });
}

/** What rekey carries over: the compiled watermark, or just its id. */
export const carried = (w) => (w ? w.compiled ?? { id: w.id } : null);

/** Cheap: parses chunks only, no inflate. */
export function inspectPng(bytes) {
  const chunks = readChunks(bytes);
  const ihdr = parseIhdr(chunks[0].data);
  const marker = readPngMarker(chunks);
  const actl = chunks.find((c) => c.type === 'acTL');
  const dv = actl?.data.length === 8 ? new DataView(actl.data.buffer, actl.data.byteOffset, 8) : null;
  return {
    format: 'png',
    width: ihdr.width,
    height: ihdr.height,
    bitDepth: ihdr.depth,
    colorType: ihdr.colorType,
    interlaced: !!ihdr.interlace,
    animated: !!actl,
    ...(dv ? { frames: dv.getUint32(0), plays: dv.getUint32(4) } : {}),
    scrambled: !!marker,
    mode: marker?.params.mode ?? null,
    block: marker?.params.block || null,
    ...watermarkInfo(pngWatermark(chunks), marker),
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

/** For inspect(): which watermarks a scrambled file carries. */
export function watermarkInfo(wm, marker) {
  return {
    watermark: wm ? { id: wm.id, ...(wm.name ? { name: wm.name } : {}), embedded: !!wm.compiled } : null,
    visibleWatermark: !!(marker && marker.params.flags & FLAG_STASH),
  };
}
