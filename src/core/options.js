// The options callers pass in, checked at the entry points: a bad value throws a PixmixError
// with code BAD_OPTION before any work is done, instead of a RangeError or TypeError from
// deep inside a codec, or no error at all (a quality of NaN used to write a blank JPEG).
// undefined always means "the default"; any other value must be valid, null included.

import { PixmixError, MODES } from './params.js';

export const SUBSAMPLINGS = ['4:2:0', '4:2:2', '4:4:4'];
const MAX_SALT = 255; // the marker stores its length in one byte

const bad = (message) => new PixmixError(message, 'BAD_OPTION');
const show = (v) => (typeof v === 'string' ? `"${v}"` : typeof v === 'number' || v === null || typeof v === 'boolean' ? String(v) : typeof v);

function integer(opts, name, min, max) {
  const v = opts[name];
  if (v !== undefined && !(Number.isInteger(v) && v >= min && v <= max)) {
    throw bad(`${name} must be an integer from ${min} to ${max}, got ${show(v)}`);
  }
}

function boolean(opts, name, also) {
  const v = opts[name];
  if (v !== undefined && typeof v !== 'boolean' && v !== also) {
    throw bad(`${name} must be true or false${also ? ` (or "${also}")` : ''}, got ${show(v)}`);
  }
}

/** A #rgb or #rrggbb colour (the # is optional) as #rrggbb, or undefined. */
export function normalizeColor(c) {
  const m = typeof c === 'string' ? /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c) : null;
  if (!m) throw bad(`background must be a #rgb or #rrggbb colour, got ${show(c)}`);
  const hex = m[1].length === 3 ? [...m[1]].map((d) => d + d).join('') : m[1];
  return `#${hex.toLowerCase()}`;
}

/**
 * Checks the scramble and conversion options that are present, and returns the options with
 * `background` normalised to #rrggbb. Keys, watermarks, metadata policies and limits are
 * checked where they are used.
 * @template {object} T @param {T} opts @returns {T}
 */
export function checkOptions(opts) {
  if (!opts) return opts;
  if (opts.mode !== undefined && !MODES.includes(opts.mode)) throw bad(`Unknown mode ${show(opts.mode)} (expected pixel, block or mcu)`);
  integer(opts, 'block', 2, 4096);
  integer(opts, 'level', 0, 9);
  integer(opts, 'effort', 1, 9);
  const q = opts.quality;
  if (q !== undefined && !(typeof q === 'number' && q >= 1 && q <= 100)) throw bad(`quality must be a number from 1 to 100, got ${show(q)}`);
  if (opts.subsampling !== undefined && !SUBSAMPLINGS.includes(opts.subsampling)) {
    throw bad(`subsampling must be ${SUBSAMPLINGS.join(', ')}, got ${show(opts.subsampling)}`);
  }
  boolean(opts, 'transforms');
  boolean(opts, 'progressive', 'auto');
  boolean(opts, 'keepThumbnails');
  for (const name of ['onConvert', 'onMetadata']) {
    if (opts[name] !== undefined && typeof opts[name] !== 'function') throw bad(`${name} must be a function`);
  }
  const { salt, decoders } = opts;
  if (salt !== undefined && !(salt instanceof Uint8Array && salt.length <= MAX_SALT)) {
    throw bad(`salt must be a Uint8Array of at most ${MAX_SALT} bytes`);
  }
  if (decoders !== undefined) {
    if (!Array.isArray(decoders)) throw bad('decoders must be an array of decoder plugins');
    for (const d of decoders) {
      if (!d || !Array.isArray(d.formats) || typeof d.decode !== 'function') {
        throw bad('Each decoder needs `formats` (an array) and a `decode` function (see sharpDecoder)');
      }
    }
  }
  return opts.background === undefined ? opts : { ...opts, background: normalizeColor(opts.background) };
}
