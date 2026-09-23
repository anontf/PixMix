// Decode-only entry: restores scrambled images. Contains no encoding options.

import { pick, toBytes, detectFormat } from './formats/index.js';
import { unscramblePng, inspectPng } from './formats/png/index.js';
import { unscrambleJpeg, inspectJpeg } from './formats/jpeg/index.js';
import { unscrambleJxl, inspectJxl } from './formats/jxl/index.js';
import { PixmixError } from './core/params.js';

export { configureJxl } from './formats/jxl/load.js';

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
  if (!d.unscramble) throw new PixmixError('JPEG XL decoding is async; use decodeAsync', 'ASYNC_DECODER');
  return d.unscramble(bytes, opts);
}

/** decode for every format, including JPEG XL (which comes back as lossless JPEG XL). */
export async function decodeAsync(input, opts) {
  const bytes = toBytes(input);
  const d = pick(DECODERS, bytes);
  return d.unscramble ? d.unscramble(bytes, opts) : d.unscrambleAsync(bytes, opts);
}

/** Describes an image and whether it carries a pixmix marker. */
export function inspect(input) {
  const bytes = toBytes(input);
  return pick(DECODERS, bytes).inspect(bytes);
}
