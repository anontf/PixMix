// Server-side / tooling entry: everything needed to scramble and re-key images.

import { pick, toBytes, detectFormat } from './formats/index.js';
import { scramblePng, rekeyPng, inspectPng } from './formats/png/index.js';

const ENCODERS = {
  png: { scramble: scramblePng, rekey: rekeyPng, inspect: inspectPng },
};

export { detectFormat };
export { PixmixError, WrongKeyError } from './core/params.js';

/**
 * Scrambles an image with a key.
 * @param {Uint8Array|ArrayBuffer} input image bytes
 * @param {object} opts
 * @param {string|Uint8Array} opts.key
 * @param {string} [opts.format]  output format; defaults to the input format
 * @param {'pixel'|'block'} [opts.mode='pixel']
 * @param {number} [opts.block=8]  tile size in block mode
 * @param {number} [opts.level=6]  zlib level for PNG output
 * @returns {Uint8Array}
 */
export function encode(input, opts) {
  const bytes = toBytes(input);
  return pick(ENCODERS, bytes, opts?.format).scramble(bytes, opts);
}

/**
 * Swaps the key (and optionally the mode) of a scrambled image without an
 * intermediate unscrambled file.
 * @param {Uint8Array|ArrayBuffer} input
 * @param {{from: string|Uint8Array, to: string|Uint8Array, mode?: 'pixel'|'block', block?: number, level?: number}} opts
 */
export function rekey(input, opts) {
  const bytes = toBytes(input);
  return pick(ENCODERS, bytes).rekey(bytes, opts);
}

/** Describes an image and whether it carries a pixmix marker. */
export function inspect(input) {
  const bytes = toBytes(input);
  return pick(ENCODERS, bytes).inspect(bytes);
}
