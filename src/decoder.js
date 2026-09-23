// Decode-only entry: restores scrambled images. Contains no encoding options.

import { pick, toBytes, detectFormat } from './formats/index.js';
import { unscramblePng, unscramblePngDetailed, inspectPng } from './formats/png/index.js';
import { unscrambleJpeg, unscrambleJpegDetailed, inspectJpeg } from './formats/jpeg/index.js';
import { unscrambleJxl, unscrambleJxlDetailed, inspectJxl } from './formats/jxl/index.js';
import { PixmixError } from './core/params.js';
import { loadPainter } from './watermark/load.js';

export { configureJxl } from './formats/jxl/load.js';
export { configureWatermarks } from './watermark/load.js';

// JPEG XL only decodes asynchronously (its codec is WASM, loaded on first use).
const DECODERS = {
  png: { unscramble: unscramblePng, inspect: inspectPng },
  jpeg: { unscramble: unscrambleJpeg, inspect: inspectJpeg },
  jxl: { unscrambleAsync: unscrambleJxl, inspect: inspectJxl },
};

export { detectFormat };
export { PixmixError, WrongKeyError } from './core/params.js';

/**
 * Restores the original image.
 * @param {Uint8Array|ArrayBuffer} input scrambled image bytes
 * @param {{key: string|Uint8Array, level?: number}} opts
 * @returns {Uint8Array}
 */
export function decode(input, opts) {
  const bytes = toBytes(input);
  const d = pick(DECODERS, bytes);
  if (opts?.watermark) throw new PixmixError('Drawing a watermark is async; use decodeAsync', 'ASYNC_DECODER');
  if (!d.unscramble) throw new PixmixError('JPEG XL decoding is async; use decodeAsync', 'ASYNC_DECODER');
  return d.unscramble(bytes, opts);
}

/**
 * decode for every format, including JPEG XL (which comes back as lossless JPEG XL).
 * Restoring is exact unless `watermark` asks for one to be drawn on the result:
 * - a compiled watermark (see watermark/compile.js), or {id} / an id string, looked up with
 *   `resolveWatermark(id)`;
 * - true or 'embedded': the one the file carries (nothing is drawn if it carries none).
 * @param {{key: string|Uint8Array, level?: number, watermark?: object|string|boolean,
 *   resolveWatermark?: (id: string) => object|Promise<object>}} opts
 */
export async function decodeAsync(input, opts) {
  const bytes = toBytes(input);
  const d = pick(DECODERS, bytes);
  if (!opts?.watermark) return d.unscramble ? d.unscramble(bytes, opts) : d.unscrambleAsync(bytes, opts);
  const format = detectFormat(bytes);
  const detail = format === 'png' ? unscramblePngDetailed(bytes, opts)
    : format === 'jpeg' ? unscrambleJpegDetailed(bytes, opts) : await unscrambleJxlDetailed(bytes, opts);
  const watermark = await chooseWatermark(opts.watermark, detail.watermark, opts.resolveWatermark);
  const paint = watermark ? { painter: await loadPainter(), watermark } : null;
  return format === 'png' ? detail.toPng(paint) : format === 'jpeg' ? detail.toJpeg(paint) : detail.toJxl(paint);
}

/**
 * Which compiled watermark to draw: the one asked for, or the one the file carries
 * (`embedded` is what the format module read: {id, compiled}).
 * @returns {Promise<object|null>}
 */
export async function chooseWatermark(requested, embedded, resolve) {
  const lookUp = async (id) => {
    if (!resolve) throw new PixmixError(`Watermark "${id}" needs resolveWatermark to be looked up`, 'BAD_WATERMARK');
    return resolve(id);
  };
  if (!requested) return null;
  if (requested === true || requested === 'embedded') {
    if (!embedded) return null;
    return embedded.compiled ?? lookUp(embedded.id);
  }
  if (typeof requested === 'string') return lookUp(requested);
  if (typeof requested === 'object' && !requested.format && typeof requested.id === 'string') return lookUp(requested.id);
  return requested;
}

/** Describes an image and whether it carries a pixmix marker. */
export function inspect(input) {
  const bytes = toBytes(input);
  return pick(DECODERS, bytes).inspect(bytes);
}
