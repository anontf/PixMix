// The decoding half of the reveal: no DOM, so it runs in a Web Worker (worker.js) or inline.
// Returns plain data (typed arrays and numbers) that can be transferred to the page.

import { detectFormat, inspect, PixmixError } from '../decoder.js';
import { unscramblePngDetailedAsync } from '../formats/png/index.js';
import { unscrambleJpegDetailed } from '../formats/jpeg/index.js';
import { unscrambleJxlDetailed, reconstructJpeg } from '../formats/jxl/index.js';
import { toRGBA8 } from '../formats/png/rgba.js';
import { writeChunks } from '../formats/png/chunks.js';
import { encodeRasterAsync } from '../formats/png/raster.js';

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
export async function compute(bytes, key, { animated = true } = {}) {
  const format = detectFormat(bytes);
  if (format === 'png') {
    const d = await unscramblePngDetailedAsync(bytes, { key });
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
    const d = unscrambleJpegDetailed(bytes, { key });
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
    if (inspect(bytes).mode === 'mcu') return compute(await reconstructJpeg(bytes), key, { animated });
    // Pixel route: the <img> gets a PNG, since most browsers cannot display JPEG XL.
    const d = await unscrambleJxlDetailed(bytes, { key });
    return {
      kind: 'pixels',
      type: 'image/png',
      restored: await rgbaPng(d.layout.width, d.layout.height, d.pixels),
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

async function rgbaPng(width, height, rgba) {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = await encodeRasterAsync({ width, height, depth: 8, colorType: 6, interlace: 0 }, rgba);
  return writeChunks([{ type: 'IHDR', data: ihdr }, { type: 'IDAT', data: idat }, { type: 'IEND', data: new Uint8Array(0) }]);
}
