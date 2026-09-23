// Resource limits for untrusted input. Every entry point takes `limits` (merged over these
// defaults) and checks it from the headers, before anything large is allocated, so a small
// file cannot make pixmix allocate gigabytes or spin for minutes. Violations throw a
// PixmixError with code 'LIMIT'. Any limit can be raised, or set to Infinity.

import { PixmixError } from './params.js';

/**
 * @typedef {object} Limits
 * @property {number} maxInputBytes         size of the input file
 * @property {number} maxPixels             width x height of the image, and of any one frame
 * @property {number} maxFrames             frames in an animation
 * @property {number} maxTotalPixels        pixels of all frames together
 * @property {number} maxDecompressedBytes  what one stream of image data (PNG IDAT/fdAT) may inflate to
 * @property {number} maxMetadataBytes      what one compressed metadata stream (iCCP, zTXt, iTXt,
 *                                          JPEG XL brob) may inflate to
 * @property {number} maxChunks             PNG chunks, JPEG segments or JPEG XL boxes in one file
 * @property {number} maxScans              scans in one JPEG (each one is a pass over the image)
 */

/** @type {Readonly<Limits>} */
export const DEFAULT_LIMITS = Object.freeze({
  maxInputBytes: 256 * 2 ** 20,
  maxPixels: 100_000_000,
  maxFrames: 1000,
  maxTotalPixels: 200_000_000,
  maxDecompressedBytes: 2 ** 30,
  maxMetadataBytes: 16 * 2 ** 20,
  maxChunks: 1_000_000,
  maxScans: 256,
});

const RESOLVED = Symbol('pixmix.limits');

/**
 * Defaults with the caller's overrides; resolving twice is free.
 * @param {Partial<Limits>} [limits] @returns {Limits}
 */
export function resolveLimits(limits) {
  if (limits?.[RESOLVED]) return limits;
  if (limits !== undefined && (limits === null || typeof limits !== 'object')) {
    throw new PixmixError('limits must be an object', 'BAD_OPTION');
  }
  const out = { ...DEFAULT_LIMITS };
  for (const [k, v] of Object.entries(limits ?? {})) {
    if (!(k in DEFAULT_LIMITS)) throw new PixmixError(`Unknown limit "${k}" (known: ${Object.keys(DEFAULT_LIMITS).join(', ')})`, 'BAD_OPTION');
    if (v === undefined) continue;
    if (typeof v !== 'number' || !(v > 0)) throw new PixmixError(`limits.${k} must be a positive number (or Infinity)`, 'BAD_OPTION');
    out[k] = v;
  }
  Object.defineProperty(out, RESOLVED, { value: true });
  return out;
}

export const limitError = (message) => new PixmixError(message, 'LIMIT');

const mp = (n) => `${+(n / 1e6).toPrecision(3)} megapixels`;
const mib = (n) => (n >= 2 ** 20 ? `${+(n / 2 ** 20).toPrecision(3)} MiB` : `${n} bytes`);

/** @param {Uint8Array} bytes @param {Partial<Limits>} [limits] */
export function checkInputSize(bytes, limits) {
  const { maxInputBytes } = resolveLimits(limits);
  if (bytes.length > maxInputBytes) {
    throw limitError(`Input is ${mib(bytes.length)}, over the limit of ${mib(maxInputBytes)} (limits.maxInputBytes)`);
  }
}

/** For entry points: `opts` with its limits resolved, once the input's size is checked. */
export function withLimits(bytes, opts) {
  const limits = resolveLimits(opts?.limits);
  checkInputSize(bytes, limits);
  return { ...opts, limits };
}

/** Width x height of an image or frame against maxPixels. */
export function checkPixels(width, height, limits, what = 'Image') {
  const { maxPixels } = resolveLimits(limits);
  if (width * height > maxPixels) {
    throw limitError(`${what} is ${width}x${height} (${mp(width * height)}), over the limit of ${mp(maxPixels)} (limits.maxPixels)`);
  }
}

/** Frame count and the pixels of all frames together (`totalPixels`, when known). */
export function checkFrames(count, totalPixels, limits) {
  const { maxFrames, maxTotalPixels } = resolveLimits(limits);
  if (count > maxFrames) throw limitError(`Animation has ${count} frames, over the limit of ${maxFrames} (limits.maxFrames)`);
  if (totalPixels > maxTotalPixels) {
    throw limitError(`Animation frames add up to ${mp(totalPixels)}, over the limit of ${mp(maxTotalPixels)} (limits.maxTotalPixels)`);
  }
}

/** Running count of chunks / segments / boxes while a container is parsed. */
export function checkChunks(count, limits, what = 'chunks') {
  const { maxChunks } = resolveLimits(limits);
  if (count > maxChunks) throw limitError(`File has more than ${maxChunks} ${what} (limits.maxChunks)`);
}

export function decompressedLimitError(limit, which = 'maxDecompressedBytes', what = 'Image data') {
  return limitError(`${what} inflates to more than ${mib(limit)} (limits.${which})`);
}
