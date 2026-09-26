// Server-side / tooling entry: everything needed to scramble and re-key images.

import { pick, toBytes, detectFormat } from './formats/index.js';
import { scramblePng, rekeyPng, inspectPng } from './formats/png/index.js';
import { scrambleJpeg, rekeyJpeg, inspectJpeg } from './formats/jpeg/index.js';
import {
  scrambleJxl, scrambleJxlPixels, scrambleJpegToJxl, rekeyJxl, inspectJxl, reencodeNotes, hasJpegData, reconstructJpeg, rebuiltJpegMatches,
} from './formats/jxl/index.js';
import { readJxl, readJxlHeader } from './formats/jxl/container.js';
import { convert, convertAsync, decodeForJxl, targetFormat, OUTPUT_FORMATS } from './convert/index.js';
import { PixmixError } from './core/params.js';
import { withLimits } from './core/limits.js';
import { readWebpMetadata } from './meta/webp.js';
import { readOrientation } from './meta/exif.js';
import { validateCompiled, ID_PATTERN } from './watermark/schema.js';

export { detectFormat, convert, convertAsync, OUTPUT_FORMATS };
export { configureJxl, loadJxlCodec } from './formats/jxl/load.js';
export { configureWatermarks } from './watermark/load.js';
// Decoder plugins; neither imports anything platform-specific at load time.
export { sharpDecoder } from './plugins/sharp.js';
export { browserDecoder } from './plugins/browser.js';
export { PixmixError, WrongKeyError } from './core/params.js';
export { DEFAULT_LIMITS } from './core/limits.js';

// JPEG XL only has async operations (its codec is WASM, loaded on first use).
const SCRAMBLERS = {
  png: { scramble: scramblePng, rekey: rekeyPng, inspect: inspectPng },
  jpeg: { scramble: scrambleJpeg, rekey: rekeyJpeg, inspect: inspectJpeg },
  jxl: { scrambleAsync: scrambleJxl, rekeyAsync: rekeyJxl, inspect: inspectJxl },
};

const needsAsync = (what) => new PixmixError(`JPEG XL ${what} is async; use ${what}Async`, 'ASYNC_DECODER');

/**
 * @typedef {object} EncodeOptions
 * @property {string|Uint8Array} key
 * @property {'png'|'jpeg'|'jxl'} [format]  output format; default: the input's own format
 *           when pixmix can write it (PNG, JPEG, JPEG XL), otherwise PNG
 * @property {'pixel'|'block'|'mcu'} [mode]  PNG: block (default: 16 px tiles, flipped/rotated) or pixel. JPEG: always mcu.
 *           JPEG XL: pixel/block (lossless pixels), or mcu, the JPEG route, which is the
 *           default when the source is a JPEG (or a JPEG XL holding one)
 * @property {number} [block=8]        block mode tile size
 * @property {number} [effort]         JPEG XL encoder effort 1-9 (default 2 in pixel mode, else 7)
 * @property {boolean} [transforms=true]  JPEG: also flip/rotate each MCU (lossless)
 * @property {boolean|'auto'} [progressive='auto']  JPEG: write progressive scans; 'auto'
 *           keeps a JPEG source's structure (and means baseline for other sources)
 * @property {number} [level]          zlib level for PNG output
 * @property {number} [quality=90]     JPEG quality when the input is not already JPEG
 * @property {'4:2:0'|'4:2:2'|'4:4:4'} [subsampling]  likewise
 * @property {string} [background]     JPEG: colour transparency is flattened onto
 * @property {boolean} [keepThumbnails=false]  keep embedded previews (they are unscrambled!)
 * @property {object[]} [decoders]     extra input decoders (see plugins/)
 * @property {(r: import('./convert/index.js').ConvertResult) => void} [onConvert]
 *           called with what happened to the input (decoder, metadata transferred/dropped)
 * @property {object} [watermark]      a compiled watermark (or {id}) the file carries for the
 *           decoder, which draws it on the restored image
 * @property {object} [visibleWatermark]  a compiled watermark drawn on the scrambled image
 *           itself; the pixels under it are kept in the file (encrypted with the key), so
 *           restoring stays exact
 * @property {Partial<import('./core/limits.js').Limits>} [limits]  resource limits for untrusted
 *           input, over the defaults in core/limits.js; a violation throws code 'LIMIT'
 */

/**
 * Validates the watermark options (they end up inside the file) and returns the options
 * with them normalised. For rekey, undefined keeps what the file has and null removes it.
 */
function checkWatermarks(opts) {
  if (!opts) return opts;
  const out = { ...opts };
  if (opts.watermark) {
    const w = opts.watermark;
    if (typeof w === 'string' || (!w.format && typeof w.id === 'string' && Object.keys(w).length === 1)) {
      const id = typeof w === 'string' ? w : w.id;
      if (!ID_PATTERN.test(id)) throw new PixmixError(`Invalid watermark id "${id}"`, 'BAD_WATERMARK');
      out.watermark = { id };
    } else out.watermark = validateCompiled(w);
  }
  if (opts.visibleWatermark) out.visibleWatermark = validateCompiled(opts.visibleWatermark);
  return out;
}

/**
 * Scrambles an image. PNG, JPEG and GIF input work out of the box; synchronous, so
 * plugins must be sync too (see encodeAsync).
 * @param {Uint8Array|ArrayBuffer} input @param {EncodeOptions} opts @returns {Uint8Array}
 */
export function encode(input, opts) {
  const bytes = toBytes(input);
  opts = checkWatermarks(withLimits(bytes, opts));
  const withFormat = withTarget(bytes, opts);
  if (withFormat.format === 'jxl' || detectFormat(bytes) === 'jxl') throw needsAsync('encode');
  const converted = convert(bytes, withFormat);
  opts.onConvert?.(converted);
  return SCRAMBLERS[converted.format].scramble(converted.bytes, opts);
}

/** Like encode, but also accepts async decoder plugins (sharp, browser-native) and JPEG XL. */
export async function encodeAsync(input, opts) {
  opts = checkWatermarks(opts);
  const bytes = toBytes(input);
  opts = withLimits(bytes, opts);
  const withFormat = withTarget(bytes, opts);
  const from = detectFormat(bytes);
  // Why the default JPEG route was not taken for a JPEG source, for the report.
  let fallback = null;
  if (withFormat.format === 'jxl') {
    const viaJpeg = await jpegForJxl(bytes, from, opts);
    if (viaJpeg?.jpeg) {
      // JPEG route: sanitise the JPEG, scramble it in the DCT domain, recompress to JXL.
      const converted = convert(viaJpeg.jpeg, { ...opts, format: 'jpeg' });
      try {
        const out = await scrambleJpegToJxl(converted.bytes, opts);
        opts.onConvert?.({ ...converted, bytes: undefined, format: 'jxl', from, decoder: viaJpeg.decoder, dropped: [...viaJpeg.notes, ...converted.dropped] });
        return out;
      } catch (err) {
        if (!err?.jpegRoute || opts.mode === 'mcu') throw err;
        fallback = err.message;
      }
    } else if (viaJpeg?.fallback) fallback = viaJpeg.fallback;
  }
  const fallbackNote = (report) => {
    // The size note would point at the JPEG route; say it was tried instead.
    if (fallback) report.notes = [`JPEG route not possible, used the pixel route (lossless, typically 3-8 times larger): ${fallback}`];
    return report;
  };
  if (withFormat.format === 'jxl' && from !== 'jxl') {
    // Decode once, scramble the pixels, encode once (no intermediate unscrambled JXL).
    const { image, boxes, report } = await decodeForJxl(bytes, withFormat);
    opts.onConvert?.(fallbackNote(report));
    return scrambleJxlPixels(image, boxes, opts);
  }
  const converted = await convertAsync(bytes, withFormat);
  if (converted.format === 'jxl') {
    converted.dropped.push(...reencodeNotes(readJxlHeader(readJxl(converted.bytes, opts.limits).codestream, opts.limits)));
  }
  opts.onConvert?.(fallbackNote(converted));
  const s = SCRAMBLERS[converted.format];
  return s.scramble ? s.scramble(converted.bytes, opts) : s.scrambleAsync(converted.bytes, opts);
}

/**
 * For JPEG XL output: {jpeg} to take the JPEG route with, {fallback: reason} when a JPEG
 * source cannot take it, or null for the pixel route. The route is used when asked for
 * (mode mcu), or by default when the source is a JPEG or a recompressed-JPEG JXL.
 */
async function jpegForJxl(bytes, from, { mode, limits }) {
  if (mode && mode !== 'mcu') return null;
  const isJpegSource = from === 'jpeg' || (from === 'jxl' && hasJpegData(bytes, limits));
  if (!isJpegSource) {
    if (mode === 'mcu') throw new PixmixError('Mode "mcu" needs a JPEG source (a JPEG, or a JPEG XL made from one)', 'BAD_OPTION');
    return null;
  }
  if (from === 'jpeg') return { jpeg: bytes, decoder: 'none', notes: [] };
  let jpeg;
  try {
    jpeg = await reconstructJpeg(bytes, limits);
  } catch (err) {
    if (mode === 'mcu' || err?.code === 'LIMIT') throw err;
    return { fallback: `jxl-oxide cannot rebuild its JPEG: ${err?.message ?? err}` };
  }
  // jxl-oxide 0.12 rebuilds some progressive JPEGs wrongly without an error; scrambling that
  // JPEG would "restore" a different image.
  if (!(await rebuiltJpegMatches(bytes, jpeg, limits))) {
    const why = 'jxl-oxide does not rebuild its JPEG exactly';
    if (mode === 'mcu') throw new PixmixError(`This JPEG XL cannot take the JPEG route (${why}); use mode "block" or "pixel"`, 'UNSUPPORTED');
    return { fallback: why };
  }
  return { jpeg, decoder: 'jpeg reconstruction', notes: [] };
}

// Validates the output format and mode combination up front, before any decoding work.
function withTarget(input, opts) {
  const from = detectFormat(toBytes(input));
  if (!from) throw new PixmixError('Unrecognised image format', 'UNSUPPORTED');
  const format = targetFormat(from, opts?.format);
  if (format === 'jpeg' && opts.mode && opts.mode !== 'mcu') {
    throw new PixmixError(`JPEG output is scrambled per MCU; mode "${opts.mode}" only applies to PNG and JPEG XL`, 'BAD_OPTION');
  }
  if (format === 'png' && opts.mode === 'mcu') {
    throw new PixmixError('Mode "mcu" only applies to JPEG and JPEG XL output', 'BAD_OPTION');
  }
  return { ...opts, format };
}

/**
 * Swaps the key (and optionally the mode) of a scrambled image without an
 * intermediate unscrambled file.
 * @param {Uint8Array|ArrayBuffer} input
 * @param {{from: string|Uint8Array, to: string|Uint8Array, mode?: 'pixel'|'block', block?: number, level?: number,
 *   watermark?: object|null, visibleWatermark?: object|null,
 *   limits?: Partial<import('./core/limits.js').Limits>}} opts  watermarks are kept unless
 *   given (null removes them)
 */
export function rekey(input, opts) {
  opts = checkWatermarks(opts);
  const bytes = toBytes(input);
  const s = pick(SCRAMBLERS, bytes);
  if (!s.rekey) throw needsAsync('rekey');
  return s.rekey(bytes, withLimits(bytes, opts));
}

/** rekey for every format, including JPEG XL. */
export async function rekeyAsync(input, opts) {
  opts = checkWatermarks(opts);
  const bytes = toBytes(input);
  const s = pick(SCRAMBLERS, bytes);
  opts = withLimits(bytes, opts);
  return s.rekey ? s.rekey(bytes, opts) : s.rekeyAsync(bytes, opts);
}

/**
 * Describes an image and whether it carries a pixmix marker. Reads headers only, and checks
 * them against the same limits as decoding, so it doubles as a cheap check up front.
 * @param {Uint8Array|ArrayBuffer} input @param {{limits?: Partial<import('./core/limits.js').Limits>}} [opts]
 */
export function inspect(input, opts) {
  const bytes = toBytes(input);
  const { limits } = withLimits(bytes, opts);
  const format = detectFormat(bytes);
  if (SCRAMBLERS[format]) return SCRAMBLERS[format].inspect(bytes, limits);
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
