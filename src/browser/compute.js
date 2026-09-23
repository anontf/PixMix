// The decoding half of the reveal: no DOM, so it runs in a Web Worker (worker.js) or inline.
// Returns plain data (typed arrays and numbers) that can be transferred to the page.

import { detectFormat, inspect, PixmixError } from '../decoder.js';
import { unscramblePngDetailedAsync } from '../formats/png/index.js';
import { unscrambleJpegDetailed } from '../formats/jpeg/index.js';
import { unscrambleJxlDetailed, scrambledJpegOf } from '../formats/jxl/index.js';
import { toRGBA8 } from '../formats/png/rgba.js';
import { writeChunks } from '../formats/png/chunks.js';
import { encodeRasterAsync } from '../formats/png/raster.js';
import { checkInputSize } from '../core/limits.js';

/**
 * @typedef {object} PixelsResult  PNG, and JPEG XL on the pixel route
 * @property {'pixels'} kind @property {string} type  MIME type of `restored`
 * @property {Uint8Array} restored  file for the <img>
 * @property {Uint8Array|null} exif PNG eXIf payload (for orientation)
 * @property {object} layout        width, height, map, tiles
 * @property {Uint8ClampedArray} [scrambled]  frame 0 as RGBA (only when animating)
 *
 * @typedef {object} JpegResult  JPEG, and JPEG XL on the JPEG route
 * @property {'jpeg'} kind @property {string} type @property {Uint8Array} restored
 * @property {Uint8Array} scrambled  the scrambled JPEG (the browser decodes both for frames)
 * @property {Uint8Array|null} exif  APP1 TIFF payload
 * @property {object} layout         perm, transforms, cols, rows, tileW, tileH, width, height
 */

/** @returns {Promise<PixelsResult|JpegResult>} */
export async function compute(bytes, key, { animated = true, limits } = {}) {
  checkInputSize(bytes, limits);
  const format = detectFormat(bytes);
  if (format === 'png') {
    const d = await unscramblePngDetailedAsync(bytes, { key, limits });
    return {
      kind: 'pixels',
      type: 'image/png',
      restored: await d.toPng(),
      exif: d.img.chunks.find((c) => c.type === 'eXIf')?.data.slice() ?? null,
      layout: plainLayout(d.layout),
      ...(animated ? { scrambled: toRGBA8(d.img, d.img.pixels) } : {}),
    };
  }
  if (format === 'jpeg') {
    const d = unscrambleJpegDetailed(bytes, { key, limits });
    const app1 = d.segments.find((s) => s.marker === 0xe1 && s.data[0] === 0x45 && s.data[4] === 0 && s.data[5] === 0);
    const { perm, transforms, cols, rows, tileW, tileH, width, height } = d.layout;
    return {
      kind: 'jpeg',
      type: 'image/jpeg',
      restored: d.toJpeg(),
      scrambled: bytes,
      exif: app1 ? app1.data.slice(6) : null,
      layout: { perm, transforms, cols, rows, tileW, tileH, width, height },
    };
  }
  if (format === 'jxl') {
    // JPEG route: rebuild the scrambled JPEG and reveal that; visitors get the JPEG.
    if (inspect(bytes, { limits }).mode === 'mcu') return compute(await scrambledJpegOf(bytes, limits), key, { animated, limits });
    // Pixel route: the <img> gets a PNG (an APNG for an animation), since most browsers
    // cannot display JPEG XL. The reveal animates frame 0.
    const d = await unscrambleJxlDetailed(bytes, { key, display: true, limits });
    return {
      kind: 'pixels',
      type: 'image/png',
      restored: await rgbaPng(d.layout.width, d.layout.height, d.image.frames ?? [{ data: d.pixels }], d.image.plays),
      exif: null,
      layout: plainLayout(d.layout),
      ...(animated ? { scrambled: new Uint8ClampedArray(d.scrambled.buffer, d.scrambled.byteOffset, d.scrambled.length) } : {}),
    };
  }
  throw new PixmixError(`${format ? format.toUpperCase() : 'This format'} cannot be revealed`, 'UNSUPPORTED');
}

const plainLayout = ({ width, height, map, tiles }) => ({ width, height, map, tiles });

/** Buffers worth transferring rather than copying. */
export function transferables(r) {
  const list = [r.restored, r.scrambled, r.layout.map, r.layout.perm, r.layout.transforms, r.layout.tiles?.perm]
    .filter((a) => a && a.byteLength).map((a) => a.buffer);
  return [...new Set(list)];
}

/** 8-bit RGBA frames as a PNG, or as an APNG (full-canvas frames, delays [num, den]). */
async function rgbaPng(width, height, frames, plays = 0) {
  const u32 = (...values) => {
    const b = new Uint8Array(values.length * 4);
    values.forEach((v, i) => new DataView(b.buffer).setUint32(i * 4, v));
    return b;
  };
  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width, height));
  ihdr[8] = 8;
  ihdr[9] = 6;
  const header = { width, height, depth: 8, colorType: 6, interlace: 0 };
  const chunks = [{ type: 'IHDR', data: ihdr }];
  if (frames.length > 1) chunks.push({ type: 'acTL', data: u32(frames.length, plays) });
  let seq = 0;
  for (const [i, f] of frames.entries()) {
    const idat = await encodeRasterAsync(header, f.data);
    if (frames.length > 1) {
      const fctl = new Uint8Array(26);
      fctl.set(u32(seq++, width, height, 0, 0));
      new DataView(fctl.buffer).setUint16(20, Math.min(f.delay[0], 65535));
      new DataView(fctl.buffer).setUint16(22, f.delay[1]);
      chunks.push({ type: 'fcTL', data: fctl });
    }
    if (i === 0) chunks.push({ type: 'IDAT', data: idat });
    else {
      const fdat = new Uint8Array(4 + idat.length);
      fdat.set(u32(seq++));
      fdat.set(idat, 4);
      chunks.push({ type: 'fdAT', data: fdat });
    }
  }
  chunks.push({ type: 'IEND', data: new Uint8Array(0) });
  return writeChunks(chunks);
}
