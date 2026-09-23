// Scramble parameters, key derivation and the marker that travels inside the image.
//
// Marker layout (v1), stored in a format-specific container (PNG: `pmIx` chunk,
// JPEG: APP15 segment "pixmix\0"):
//   u8  version        (1)
//   u8  mode           (0 = pixel, 1 = block, 2 = mcu)
//   u16 block          (big-endian; block: tile size, pixel: 0, mcu: flags, bit 0 = transforms,
//                       bit 1 = restore as progressive JPEG)
//   u8  salt length    (0..255)
//   ..  salt
//   u8[4] key check    (lets the decoder reject a wrong key instead of producing noise)
//
// Marker v2 is v1 followed by one byte of flags (bit 0: a visible watermark covers part of
// the scrambled image and the pixels under it are stored in the file). It is only written
// when a flag is set, so that pixmix versions which cannot put those pixels back refuse the
// file instead of restoring it wrongly. The permutation is the same as v1's.

import { hkdf } from './sha256.js';

export const VERSION = 1;
export const MODES = /** @type {const} */ (['pixel', 'block', 'mcu']);
export const MCU_TRANSFORMS = 1;
export const MCU_PROGRESSIVE = 2;
export const FLAG_STASH = 1;
const SALT_BYTES = 16;
const CHECK_BYTES = 4;

const utf8 = new TextEncoder();

/**
 * @typedef {object} ScrambleParams
 * @property {number} version
 * @property {'pixel'|'block'|'mcu'} mode   mcu: JPEG DCT-domain shuffle of whole MCUs
 * @property {number} block   block mode: tile edge in pixels; mcu mode: flags
 * @property {Uint8Array} salt
 * @property {number} [flags]  marker v2 flags (FLAG_STASH)
 */

/** @returns {ScrambleParams} */
export function makeParams({ mode = 'pixel', block = 8, transforms = true, progressive = false, salt } = {}) {
  if (!MODES.includes(mode)) throw new PixmixError(`Unknown mode "${mode}" (expected pixel, block or mcu)`);
  if (mode === 'block' && !(Number.isInteger(block) && block >= 2 && block <= 4096)) {
    throw new PixmixError('Block size must be an integer between 2 and 4096');
  }
  if (!salt) {
    salt = new Uint8Array(SALT_BYTES);
    globalThis.crypto.getRandomValues(salt);
  }
  const field = mode === 'block' ? block : mode === 'mcu' ? (transforms ? MCU_TRANSFORMS : 0) | (progressive ? MCU_PROGRESSIVE : 0) : 0;
  return { version: VERSION, mode, block: field, salt };
}

/** @param {string|Uint8Array} key */
export function keyBytes(key) {
  const bytes = typeof key === 'string' ? utf8.encode(key) : key;
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new PixmixError('A non-empty key (string or Uint8Array) is required');
  }
  return bytes;
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
  if (data.length < 5) throw new PixmixError('Corrupt pixmix marker');
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = dv.getUint8(0);
  if (version !== VERSION && version !== 2) throw new PixmixError(`Unsupported pixmix marker version ${version}`);
  const mode = MODES[dv.getUint8(1)];
  if (!mode) throw new PixmixError('Corrupt pixmix marker (mode)');
  const saltLen = dv.getUint8(4);
  const extra = version === 2 ? 1 : 0;
  if (data.length !== 5 + saltLen + CHECK_BYTES + extra) throw new PixmixError('Corrupt pixmix marker (length)');
  const flags = extra ? data[data.length - 1] : 0;
  if (flags & ~FLAG_STASH) throw new PixmixError(`Unsupported pixmix marker flags ${flags}`);
  return {
    params: { version: VERSION, mode, block: dv.getUint16(2), salt: data.slice(5, 5 + saltLen), flags },
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
