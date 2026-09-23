// Server-side / tooling entry: everything needed to scramble and re-key images.

import { pick, toBytes, detectFormat } from './formats/index.js';
import { scramblePng, rekeyPng, inspectPng } from './formats/png/index.js';
import { scrambleJpeg, rekeyJpeg, inspectJpeg } from './formats/jpeg/index.js';
import { convert, convertAsync, targetFormat, OUTPUT_FORMATS } from './convert/index.js';
import { PixmixError } from './core/params.js';
import { readWebpMetadata } from './meta/webp.js';
import { readOrientation } from './meta/exif.js';

export { detectFormat, convert, convertAsync, OUTPUT_FORMATS };
// Decoder plugins; neither imports anything platform-specific at load time.
export { sharpDecoder } from './plugins/sharp.js';
export { browserDecoder } from './plugins/browser.js';
export { PixmixError, WrongKeyError } from './core/params.js';

const SCRAMBLERS = {
  png: { scramble: scramblePng, rekey: rekeyPng, inspect: inspectPng },
  jpeg: { scramble: scrambleJpeg, rekey: rekeyJpeg, inspect: inspectJpeg },
};

/**
 * @typedef {object} EncodeOptions
 * @property {string|Uint8Array} key
 * @property {'png'|'jpeg'} [format]   output format; default: the input's own format when
 *           pixmix can write it (PNG, JPEG), otherwise PNG
 * @property {'pixel'|'block'} [mode='pixel']  PNG only; JPEG is always scrambled per MCU
 * @property {number} [block=8]        PNG block mode tile size
 * @property {boolean} [transforms=true]  JPEG: also flip/rotate each MCU (lossless)
 * @property {number} [level]          zlib level for PNG output
 * @property {number} [quality=90]     JPEG quality when the input is not already JPEG
 * @property {'4:2:0'|'4:2:2'|'4:4:4'} [subsampling]  likewise
 * @property {string} [background]     JPEG: colour transparency is flattened onto
 * @property {boolean} [keepThumbnails=false]  keep embedded previews (they are unscrambled!)
 * @property {object[]} [decoders]     extra input decoders (see plugins/)
 * @property {(r: import('./convert/index.js').ConvertResult) => void} [onConvert]
 *           called with what happened to the input (decoder, metadata transferred/dropped)
 */

/**
 * Scrambles an image. PNG, JPEG and GIF input work out of the box; synchronous, so
 * plugins must be sync too (see encodeAsync).
 * @param {Uint8Array|ArrayBuffer} input @param {EncodeOptions} opts @returns {Uint8Array}
 */
export function encode(input, opts) {
  const converted = convert(input, withTarget(input, opts));
  opts.onConvert?.(converted);
  return SCRAMBLERS[converted.format].scramble(converted.bytes, opts);
}

/** Like encode, but accepts async decoder plugins (sharp, browser-native). */
export async function encodeAsync(input, opts) {
  const converted = await convertAsync(input, withTarget(input, opts));
  opts.onConvert?.(converted);
  return SCRAMBLERS[converted.format].scramble(converted.bytes, opts);
}

// Validates the output format and mode combination up front, before any decoding work.
function withTarget(input, opts) {
  const from = detectFormat(toBytes(input));
  if (!from) throw new PixmixError('Unrecognised image format', 'UNSUPPORTED');
  const format = targetFormat(from, opts?.format);
  if (format === 'jpeg' && opts.mode && opts.mode !== 'mcu') {
    throw new PixmixError(`JPEG output is scrambled per MCU; mode "${opts.mode}" only applies to PNG`, 'BAD_OPTION');
  }
  return { ...opts, format };
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
  const meta = format === 'webp' ? readWebpMetadata(bytes) : null;
  if (meta) {
    if (meta.width) Object.assign(out, { width: meta.width, height: meta.height });
    out.metadata = ['exif', 'icc', 'xmp', 'density'].filter((k) => meta[k]);
    if (meta.exif) out.orientation = readOrientation(meta.exif);
  }
  return out;
}
