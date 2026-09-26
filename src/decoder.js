// Decode-only entry: restores scrambled images. Contains no encoding options.

import { pick, toBytes, detectFormat } from './formats/index.js';
import { unscramblePng, unscramblePngDetailed, inspectPng } from './formats/png/index.js';
import { unscrambleJpeg, unscrambleJpegDetailed, inspectJpeg } from './formats/jpeg/index.js';
import { unscrambleJxl, unscrambleJxlDetailed, inspectJxl } from './formats/jxl/index.js';
import { PixmixError } from './core/params.js';
import { loadPainter } from './watermark/load.js';
import { withLimits } from './core/limits.js';
import { inspectOther } from './formats/other.js';
import { checkOptions } from './core/options.js';
import { loadMetadataTools, metadataToolsIfLoaded } from './meta/load.js';

export { configureJxl } from './formats/jxl/load.js';
export { configureWatermarks } from './watermark/load.js';
export { configureMetadata } from './meta/load.js';

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
 * @param {{key: string|Uint8Array, level?: number, limits?: Partial<import('./core/limits.js').Limits>,
 *   metadata?: object|string, onMetadata?: (report: object) => void}} opts
 *        limits: resource limits for untrusted input (see core/limits.js). metadata: a
 *        metadata policy for the restored file (see meta/policy.js); the pixels stay exact
 * @returns {Uint8Array}
 */
export function decode(input, opts) {
  const bytes = toBytes(input);
  const d = pick(DECODERS, bytes);
  if (opts?.watermark) throw new PixmixError('Drawing a watermark is async; use decodeAsync', 'ASYNC_DECODER');
  if (!d.unscramble) throw new PixmixError('JPEG XL decoding is async; use decodeAsync', 'ASYNC_DECODER');
  opts = withLimits(bytes, checkOptions(opts));
  if (!opts.metadata) return d.unscramble(bytes, opts);
  const tools = metadataToolsIfLoaded();
  if (!tools) throw new PixmixError('A metadata policy needs pixmix\'s metadata module: use decodeAsync, or import pixmix (or pixmix/encoder)', 'ASYNC_DECODER');
  return d.unscramble(policyApplied(tools, bytes, opts), opts);
}

/**
 * PNG and JPEG: the policy is applied to the scrambled file, whose metadata the restored
 * file copies (pixmix's own chunks are never touched), so the orientation a watermark is
 * drawn with is the one the restored file ends up with.
 */
function policyApplied(tools, bytes, opts) {
  const { bytes: out, report } = tools.applyMetadata(bytes, opts.metadata, { limits: opts.limits });
  opts.onMetadata?.(report);
  return out;
}

/**
 * decode for every format, including JPEG XL (which comes back as lossless JPEG XL).
 * Restoring is exact unless `watermark` asks for one to be drawn on the result:
 * - a compiled watermark (see watermark/compile.js), or {id} / an id string, looked up with
 *   `resolveWatermark(id)`;
 * - true or 'embedded': the one the file carries (nothing is drawn if it carries none; one
 *   that cannot be read is a BAD_WATERMARK or LIMIT error). Otherwise a carried watermark that
 *   cannot be read (damaged, or over maxMetadataBytes) is ignored: it never stops restoring.
 * @param {{key: string|Uint8Array, level?: number, watermark?: object|string|boolean,
 *   resolveWatermark?: (id: string) => object|Promise<object>, metadata?: object|string,
 *   onMetadata?: (report: object) => void}} opts  metadata: a policy for the restored file
 */
export async function decodeAsync(input, opts) {
  let bytes = toBytes(input);
  const d = pick(DECODERS, bytes);
  opts = withLimits(bytes, checkOptions(opts));
  const format = detectFormat(bytes);
  if (opts.metadata) {
    const tools = await loadMetadataTools();
    opts = { ...opts, metadata: tools.normalizePolicy(opts.metadata) };
    if (format === 'jxl') opts.meta = { tools, policy: opts.metadata, limits: opts.limits, onReport: opts.onMetadata };
    else bytes = policyApplied(tools, bytes, opts);
  }
  if (!opts.watermark) return d.unscramble ? d.unscramble(bytes, opts) : d.unscrambleAsync(bytes, opts);
  const detail = format === 'png' ? unscramblePngDetailed(bytes, opts)
    : format === 'jpeg' ? unscrambleJpegDetailed(bytes, opts) : await unscrambleJxlDetailed(bytes, opts);
  // The file's own watermark was asked for and cannot be read: say so (restoring alone, or
  // drawing another watermark, ignores it).
  if ((opts.watermark === true || opts.watermark === 'embedded') && detail.watermarkError) throw detail.watermarkError;
  const watermark = await chooseWatermark(opts.watermark, detail.watermark, opts.resolveWatermark);
  const paint = watermark ? { painter: await loadPainter(), watermark, limits: opts.limits } : null;
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

/** Describes an image and whether it carries a pixmix marker (checking the limits too). */
export function inspect(input, opts) {
  const bytes = toBytes(input);
  const { limits } = withLimits(bytes, opts);
  const format = detectFormat(bytes);
  if (!format) throw new PixmixError('Unrecognised image format', 'UNSUPPORTED');
  // The formats pixmix only reads are described the same way as by pixmix/encoder.
  return DECODERS[format] ? DECODERS[format].inspect(bytes, limits) : inspectOther(bytes, format, limits);
}
