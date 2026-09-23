// Server-side / tooling entry: everything needed to scramble and re-key images.

import { pick, toBytes, detectFormat } from './formats/index.js';
import { scramblePng, rekeyPng, inspectPng } from './formats/png/index.js';
import { convert, convertAsync } from './convert/index.js';
import { PixmixError } from './core/params.js';
import { readJpegMetadata } from './meta/jpeg.js';
import { readWebpMetadata } from './meta/webp.js';
import { readOrientation } from './meta/exif.js';

export { detectFormat, convert, convertAsync };
// Decoder plugins; neither imports anything platform-specific at load time.
export { sharpDecoder } from './plugins/sharp.js';
export { browserDecoder } from './plugins/browser.js';
export { PixmixError, WrongKeyError } from './core/params.js';

/** Output formats the encoder can write. */
export const OUTPUT_FORMATS = ['png'];

const SCRAMBLERS = {
  png: { scramble: scramblePng, rekey: rekeyPng, inspect: inspectPng },
};

/**
 * @typedef {object} EncodeOptions
 * @property {string|Uint8Array} key
 * @property {string} [format='png']   output format
 * @property {'pixel'|'block'} [mode='pixel']
 * @property {number} [block=8]        tile size in block mode
 * @property {number} [level]          zlib level for PNG output
 * @property {object[]} [decoders]     extra input decoders (see plugins/)
 * @property {(r: import('./convert/index.js').ConvertResult) => void} [onConvert]
 *           called with what happened to the input (decoder, metadata transferred/dropped)
 */

/**
 * Scrambles an image. Any input the decoders understand is accepted; PNG, JPEG and GIF work
 * out of the box. Synchronous, so plugins must be sync too; see encodeAsync.
 * @param {Uint8Array|ArrayBuffer} input @param {EncodeOptions} opts @returns {Uint8Array}
 */
export function encode(input, opts) {
  const target = targetFormat(opts);
  const converted = convert(input, opts);
  opts.onConvert?.(converted);
  return SCRAMBLERS[target].scramble(converted.png, opts);
}

/** Like encode, but accepts async decoder plugins (sharp, browser-native). */
export async function encodeAsync(input, opts) {
  const target = targetFormat(opts);
  const converted = await convertAsync(input, opts);
  opts.onConvert?.(converted);
  return SCRAMBLERS[target].scramble(converted.png, opts);
}

function targetFormat(opts) {
  const target = opts?.format ?? 'png';
  if (!OUTPUT_FORMATS.includes(target)) {
    throw new PixmixError(`Output format "${target}" is not supported yet (available: ${OUTPUT_FORMATS.join(', ')})`, 'UNSUPPORTED');
  }
  return target;
}

/**
 * Swaps the key (and optionally the mode) of a scrambled image without an
 * intermediate unscrambled file.
 * @param {Uint8Array|ArrayBuffer} input
 * @param {{from: string|Uint8Array, to: string|Uint8Array, mode?: 'pixel'|'block', block?: number, level?: number}} opts
 */
export function rekey(input, opts) {
  const bytes = toBytes(input);
  return pick(SCRAMBLERS, bytes).rekey(bytes, opts);
}

/** Describes an image and whether it carries a pixmix marker. */
export function inspect(input) {
  const bytes = toBytes(input);
  const format = detectFormat(bytes);
  if (SCRAMBLERS[format]) return SCRAMBLERS[format].inspect(bytes);
  if (!format) throw new PixmixError('Unrecognised image format', 'UNSUPPORTED');
  const out = { format, scrambled: false };
  const meta = format === 'jpeg' ? readJpegMetadata(bytes) : format === 'webp' ? readWebpMetadata(bytes) : null;
  if (meta) {
    if (meta.width) Object.assign(out, { width: meta.width, height: meta.height });
    out.metadata = ['exif', 'icc', 'xmp', 'density'].filter((k) => meta[k]);
    if (meta.exif) out.orientation = readOrientation(meta.exif);
  }
  return out;
}
