// Scramble parameters, key derivation and the marker that travels inside the image.
//
// Marker layout (v1), stored in a format-specific container (PNG: `pmIx` chunk,
// JPEG: APP15 segment "pixmix\0"):
//   u8  version        (1)
//   u8  mode           (0 = pixel, 1 = block, 2 = mcu)
//   u16 block          (big-endian; block: tile size in bits 0-14 and bit 15 = tile
//                       transforms (flips/rotations); pixel: 0; mcu: flags, bit 0 = transforms,
//                       bit 1 = restore as progressive JPEG)
//   u8  salt length    (0..255)
//   ..  salt
//   u8[4] key check    (lets the decoder reject a wrong key instead of producing noise)
//
// Marker v2 is v1 followed by one byte of flags (bit 0: a visible watermark covers part of
// the scrambled image and the pixels under it are stored in the file; bit 1, JPEG only: the
// scrambled frame is enlarged to whole MCUs, and APP15 "pixmix-sz\0" holds the original
// size). It is only written when a flag is set, so that pixmix versions which cannot undo
// what a flag says refuse the file instead of restoring it wrongly. The permutation is the
// same as v1's.

import { hkdf } from './sha256.js';

export const VERSION = 1;
export const MODES = /** @type {const} */ (['pixel', 'block', 'mcu']);
export const MCU_TRANSFORMS = 1;
/** Block mode: tiles are also flipped/rotated (a bit above any valid tile size). */
export const BLOCK_TRANSFORMS = 0x8000;
/** Tile edge of block-mode params. */
export const tileSize = (params) => params.block & 0x7fff;
/** Whether block-mode tiles are flipped/rotated too. */
export const tileTransforms = (params) => params.mode === 'block' && !!(params.block & BLOCK_TRANSFORMS);
export const MCU_PROGRESSIVE = 2;
export const FLAG_STASH = 1;
export const FLAG_ENLARGED = 2;
const SALT_BYTES = 16;
const CHECK_BYTES = 4;

const utf8 = new TextEncoder();

/**
 * @typedef {object} ScrambleParams
 * @property {number} version
 * @property {'pixel'|'block'|'mcu'} mode   mcu: JPEG DCT-domain shuffle of whole MCUs
 * @property {number} block   block mode: tile edge in pixels; mcu mode: flags
 * @property {Uint8Array} salt
 * @property {number} [flags]  marker v2 flags (FLAG_STASH, FLAG_ENLARGED)
 */

/** @returns {ScrambleParams} */
// Default: 16 px tiles, flipped/rotated. Tiles keep neighbouring pixels together, so lossless
// output compresses almost like the unscrambled image; pixel mode turns it into incompressible
// noise (about twice the size of a lossless original).
export function makeParams({ mode = 'block', block = 16, transforms = true, progressive = false, salt } = {}) {
  if (!MODES.includes(mode)) throw new PixmixError(`Unknown mode "${mode}" (expected pixel, block or mcu)`, 'BAD_OPTION');
  if (mode === 'block' && !(Number.isInteger(block) && block >= 2 && block <= 4096)) {
    throw new PixmixError('Block size must be an integer between 2 and 4096', 'BAD_OPTION');
  }
  // The marker stores the salt's length in one byte: a longer salt made unrestorable files.
  if (salt !== undefined && !(salt instanceof Uint8Array && salt.length <= 255)) {
    throw new PixmixError('salt must be a Uint8Array of at most 255 bytes', 'BAD_OPTION');
  }
  if (!salt) {
    salt = new Uint8Array(SALT_BYTES);
    globalThis.crypto.getRandomValues(salt);
  }
  const field = mode === 'block' ? block | (transforms ? BLOCK_TRANSFORMS : 0)
    : mode === 'mcu' ? (transforms ? MCU_TRANSFORMS : 0) | (progressive ? MCU_PROGRESSIVE : 0) : 0;
  return { version: VERSION, mode, block: field, salt };
}

/** @param {string|Uint8Array} key */
export function keyBytes(key) {
  // UTF-8 turns every lone surrogate into U+FFFD, so keys differing only in them would be
  // the same key: refuse them rather than let them collide.
  if (typeof key === 'string' && hasLoneSurrogate(key)) {
    throw new PixmixError('The key is not valid Unicode (it has a lone surrogate); use a Uint8Array for binary keys', 'BAD_OPTION');
  }
  const bytes = typeof key === 'string' ? utf8.encode(key) : key;
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new PixmixError('A non-empty key (string or Uint8Array) is required', 'BAD_OPTION');
  }
  return bytes;
}

function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xd800 || c > 0xdfff) continue;
    const next = s.charCodeAt(i + 1);
    if (c > 0xdbff || !(next >= 0xdc00 && next <= 0xdfff)) return true;
    i++;
  }
  return false;
}

/**
 * Derives the PRNG seed and key check for one image (or animation frame). Dimensions,
 * parameters and the frame index are mixed in so the same key yields unrelated
 * permutations on different images and frames.
 */
export function deriveSeed(key, params, width, height, index = 0) {
  const info = new Uint8Array(32);
  const dv = new DataView(info.buffer);
  info.set(utf8.encode('pixmix/perm'));
  dv.setUint8(12, params.version);
  dv.setUint8(13, MODES.indexOf(params.mode));
  dv.setUint16(14, params.block);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  dv.setUint32(24, index); // animation frame; 0 (the only value before APNG) keeps v1 intact
  const okm = hkdf(keyBytes(key), params.salt, info, 32 + 12 + CHECK_BYTES);
  return {
    rngKey: okm.subarray(0, 32),
    nonce: okm.subarray(32, 44),
    check: okm.subarray(44, 44 + CHECK_BYTES),
  };
}

/** @param {ScrambleParams} params @param {Uint8Array} check */
export function writeMarker(params, check) {
  const flags = params.flags ?? 0;
  const out = new Uint8Array(5 + params.salt.length + CHECK_BYTES + (flags ? 1 : 0));
  const dv = new DataView(out.buffer);
  dv.setUint8(0, flags ? 2 : params.version);
  dv.setUint8(1, MODES.indexOf(params.mode));
  dv.setUint16(2, params.block);
  dv.setUint8(4, params.salt.length);
  out.set(params.salt, 5);
  out.set(check, 5 + params.salt.length);
  if (flags) out[out.length - 1] = flags;
  return out;
}

/** @param {Uint8Array} data @returns {{params: ScrambleParams, check: Uint8Array}} */
export function readMarker(data) {
  if (data.length < 5) throw new PixmixError('Corrupt pixmix marker', 'BAD_MARKER');
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = dv.getUint8(0);
  if (version !== VERSION && version !== 2) throw new PixmixError(`Unsupported pixmix marker version ${version}`, 'UNSUPPORTED');
  const mode = MODES[dv.getUint8(1)];
  if (!mode) throw new PixmixError('Corrupt pixmix marker (mode)', 'BAD_MARKER');
  const saltLen = dv.getUint8(4);
  const extra = version === 2 ? 1 : 0;
  if (data.length !== 5 + saltLen + CHECK_BYTES + extra) throw new PixmixError('Corrupt pixmix marker (length)', 'BAD_MARKER');
  const block = dv.getUint16(2);
  // The same range makeParams allows: a tile size of 0 made the tile grid infinite. (Before
  // tile transforms existed the flag bit made this check fail, so old readers refuse such files.)
  if (mode === 'block' && !((block & 0x7fff) >= 2 && (block & 0x7fff) <= 4096)) throw new PixmixError('Corrupt pixmix marker (block size)', 'BAD_MARKER');
  const flags = extra ? data[data.length - 1] : 0;
  if (flags & ~(FLAG_STASH | FLAG_ENLARGED)) throw new PixmixError(`Unsupported pixmix marker flags ${flags}`, 'UNSUPPORTED');
  return {
    params: { version: VERSION, mode, block, salt: data.slice(5, 5 + saltLen), flags },
    check: data.slice(5 + saltLen, 5 + saltLen + CHECK_BYTES),
  };
}

export function checksEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export class PixmixError extends Error {
  constructor(message, code = 'PIXMIX') {
    super(message);
    this.name = 'PixmixError';
    this.code = code;
  }
}

export class WrongKeyError extends PixmixError {
  constructor() {
    super('The key does not match this image', 'WRONG_KEY');
    this.name = 'WrongKeyError';
  }
}
