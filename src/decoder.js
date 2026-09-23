// Decode-only entry: restores scrambled images. Contains no encoding options.

import { pick, toBytes, detectFormat } from './formats/index.js';
import { unscramblePng, inspectPng } from './formats/png/index.js';
import { unscrambleJpeg, inspectJpeg } from './formats/jpeg/index.js';
import { unscrambleJxl, inspectJxl } from './formats/jxl/index.js';
import { PixmixError } from './core/params.js';
import { withLimits } from './core/limits.js';

export { configureJxl } from './formats/jxl/load.js';

// JPEG XL only decodes asynchronously (its codec is WASM, loaded on first use).
const DECODERS = {
  png: { unscramble: unscramblePng, inspect: inspectPng },
  jpeg: { unscramble: unscrambleJpeg, inspect: inspectJpeg },
  jxl: { unscrambleAsync: unscrambleJxl, inspect: inspectJxl },
};

export { detectFormat };
export { PixmixError, WrongKeyError } from './core/params.js';
export { DEFAULT_LIMITS } from './core/limits.js';

/**
 * Restores the original image.
 * @param {Uint8Array|ArrayBuffer} input scrambled image bytes
 * @param {{key: string|Uint8Array, level?: number, limits?: Partial<import('./core/limits.js').Limits>}} opts
 *        limits: resource limits for untrusted input (see core/limits.js)
 * @returns {Uint8Array}
 */
export function decode(input, opts) {
  const bytes = toBytes(input);
  const d = pick(DECODERS, bytes);
  if (!d.unscramble) throw new PixmixError('JPEG XL decoding is async; use decodeAsync', 'ASYNC_DECODER');
  return d.unscramble(bytes, withLimits(bytes, opts));
}

/** decode for every format, including JPEG XL (which comes back as lossless JPEG XL). */
export async function decodeAsync(input, opts) {
  const bytes = toBytes(input);
  const d = pick(DECODERS, bytes);
  opts = withLimits(bytes, opts);
  return d.unscramble ? d.unscramble(bytes, opts) : d.unscrambleAsync(bytes, opts);
}

/** Describes an image and whether it carries a pixmix marker (checking the limits too). */
export function inspect(input, opts) {
  const bytes = toBytes(input);
  const { limits } = withLimits(bytes, opts);
  return pick(DECODERS, bytes).inspect(bytes, limits);
}
