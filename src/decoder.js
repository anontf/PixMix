// Decode-only entry: restores scrambled images. Contains no encoding options.

import { pick, toBytes, detectFormat } from './formats/index.js';
import { unscramblePng, inspectPng } from './formats/png/index.js';
import { unscrambleJpeg, inspectJpeg } from './formats/jpeg/index.js';

const DECODERS = {
  png: { unscramble: unscramblePng, inspect: inspectPng },
  jpeg: { unscramble: unscrambleJpeg, inspect: inspectJpeg },
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
  return pick(DECODERS, bytes).unscramble(bytes, opts);
}

/** Describes an image and whether it carries a pixmix marker. */
export function inspect(input) {
  const bytes = toBytes(input);
  return pick(DECODERS, bytes).inspect(bytes);
}
