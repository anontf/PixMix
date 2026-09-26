// The decoding half of the reveal: no DOM, so it runs in a Web Worker (worker.js) or inline.
// Returns plain data (typed arrays and numbers) that can be transferred to the page.

import { detectFormat, inspect, PixmixError } from '../decoder.js';
import { unscramblePngDetailedAsync } from '../formats/png/index.js';
import { unscrambleJpegDetailed } from '../formats/jpeg/index.js';
import { unscrambleJxlDetailed, scrambledJpegOf } from '../formats/jxl/index.js';
import { toRGBA8 } from '../formats/png/rgba.js';
import { writeChunks } from '../formats/png/chunks.js';
import { encodeRasterAsync } from '../formats/png/raster.js';
import { readOrientation } from '../meta/exif.js';
import { loadPainter } from '../watermark/load.js';
import { loadMetadataTools } from '../meta/load.js';
import { checkInputSize } from '../core/limits.js';
import { orientRgba } from '../core/orient.js';
import { apngDelay } from '../core/delay.js';

/**
 * @typedef {object} PixelsResult  PNG, and JPEG XL on the pixel route
 * @property {'pixels'} kind @property {string} type  MIME type of `restored`
 * @property {Uint8Array} restored  file for the <img>
 * @property {Uint8Array|null} exif PNG eXIf payload (for orientation)
 * @property {number} [orientation] JPEG XL: the header's orientation, which `restored` (a PNG
 *           of the pixels as displayed) has applied; the reveal draws through it too
 * @property {object} layout        width, height, map, tiles (the stored pixel grid)
 * @property {Uint8ClampedArray} [scrambled]  frame 0 as RGBA (only when animating)
 *
 * @typedef {object} JpegResult  JPEG, and JPEG XL on the JPEG route
 * @property {'jpeg'} kind @property {string} type @property {Uint8Array} restored
 * @property {Uint8Array} scrambled  the scrambled JPEG (the browser decodes both for frames)
 * @property {Uint8Array|null} exif  APP1 TIFF payload
 * @property {object} layout         perm, transforms, cols, rows, tileW, tileH, width, height
 *
 * Both may also have `overlay` ({x, y, width, height, rgba}: the watermark drawn into
 * `restored`, for fading it in on the canvas) or `watermarkError` (it could not be drawn).
 */

/**
 * @param {{animated?: boolean, limits?: object, watermark?: object|'embedded'|null, metadata?: object|string}} [opts]
 *        watermark: a compiled watermark to draw on the restored image, or 'embedded' for the
 *        file's own. metadata: a policy for the restored file (the <img>'s); its tools are
 *        fetched (dist/pixmix-metadata.mjs) only when one is given
 * @returns {Promise<PixelsResult|JpegResult>}
 */
export async function compute(bytes, key, { animated = true, limits, watermark = null, metadata } = {}) {
  checkInputSize(bytes, limits);
  const format = detectFormat(bytes);
  if (metadata && (format === 'png' || format === 'jpeg')) {
    // Applied to the scrambled file, whose metadata the restored one copies: the orientation
    // the animation and the watermark use is then the one the <img> ends up with.
    bytes = (await loadMetadataTools()).applyMetadata(bytes, metadata, { limits }).bytes;
  }
  if (format === 'png') {
    const d = await unscramblePngDetailedAsync(bytes, { key, limits });
    const exif = d.img.chunks.find((c) => c.type === 'eXIf')?.data.slice() ?? null;
    const w = await painting(watermark, d.watermark, d.layout, exif ? readOrientation(exif) : 1, (paint) => d.toPng(paint), limits);
    return {
      kind: 'pixels',
      type: 'image/png',
      ...w,
      exif,
      layout: plainLayout(d.layout),
      ...(animated ? { scrambled: toRGBA8(d.img, d.img.pixels) } : {}),
    };
  }
  if (format === 'jpeg') {
    const d = unscrambleJpegDetailed(bytes, { key, limits });
    const app1 = d.segments.find((s) => s.marker === 0xe1 && s.data[0] === 0x45 && s.data[4] === 0 && s.data[5] === 0);
    const exif = app1 ? app1.data.slice(6) : null;
    const { perm, transforms, cols, rows, tileW, tileH, width, height } = d.layout;
    return {
      kind: 'jpeg',
      type: 'image/jpeg',
      ...(await painting(watermark, d.watermark, d.layout, exif ? readOrientation(exif) : 1, (paint) => d.toJpeg(paint), limits)),
      scrambled: bytes,
      exif,
      layout: { perm, transforms, cols, rows, tileW, tileH, width, height },
    };
  }
  if (format === 'jxl') {
    // JPEG route: rebuild the scrambled JPEG and reveal that; visitors get the JPEG.
    if (inspect(bytes, { limits }).mode === 'mcu') return compute(await scrambledJpegOf(bytes, limits), key, { animated, limits, watermark, metadata });
    // Pixel route: the <img> gets a PNG (an APNG for an animation), since most browsers
    // cannot display JPEG XL. The reveal animates frame 0.
    // The pixels (and the scramble) are on the stored grid; the PNG gets them as displayed,
    // so every browser shows it the way the JPEG XL header says.
    const d = await unscrambleJxlDetailed(bytes, { key, display: true, limits });
    const o = d.image.orientation ?? 1;
    const tools = metadata ? await loadMetadataTools() : null;
    const w = await painting(watermark, d.watermark, d.layout, o, async (paint) => {
      const image = d.paint(paint);
      const { width, height } = d.layout;
      const frames = (image.frames ?? [{ data: image.data }]).map((f) => ({ ...f, data: orientRgba(f.data, width, height, o).data }));
      const png = await rgbaPng(o >= 5 ? height : width, o >= 5 ? width : height, frames, image.plays);
      // The PNG holds display pixels and nothing else: only what the policy sets applies.
      return tools ? tools.applyMetadata(png, metadata, { limits }).bytes : png;
    }, limits);
    return {
      kind: 'pixels',
      type: 'image/png',
      ...w,
      exif: null,
      orientation: o,
      layout: plainLayout(d.layout),
      ...(animated ? { scrambled: new Uint8ClampedArray(d.scrambled.buffer, d.scrambled.byteOffset, d.scrambled.length) } : {}),
    };
  }
  throw new PixmixError(`${format ? format.toUpperCase() : 'This format'} cannot be revealed`, 'UNSUPPORTED');
}

/**
 * The restored file, with the watermark drawn when one is wanted. A watermark that cannot
 * be drawn (it failed to validate, say) leaves the image as it is and says why.
 */
async function painting(requested, embedded, { width, height }, o, write, limits) {
  const watermark = requested === 'embedded' ? embedded?.compiled ?? null : requested;
  if (!watermark) return { restored: await write(null) };
  try {
    const painter = await loadPainter();
    const restored = await write({ painter, watermark, limits });
    return { restored, overlay: painter.overlayFor(watermark, width, height, o, limits) };
  } catch (err) {
    // Only pixmix's own refusals (a bad or oversized watermark); anything else is a bug.
    if (err?.name !== 'PixmixError' && !err?.message?.startsWith('Watermark support could not be loaded')) throw err;
    return { restored: await write(null), watermarkError: err.message };
  }
}

const plainLayout = ({ width, height, map, tiles }) => ({ width, height, map, tiles });

/** Buffers worth transferring rather than copying. */
export function transferables(r) {
  const list = [r.restored, r.scrambled, r.layout.map, r.layout.perm, r.layout.transforms, r.layout.tiles?.perm, r.overlay?.rgba]
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
      const [num, den] = apngDelay(f.delay);
      new DataView(fctl.buffer).setUint16(20, num);
      new DataView(fctl.buffer).setUint16(22, den);
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
