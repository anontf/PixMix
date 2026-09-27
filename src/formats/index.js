// Format detection and dispatch. New formats (JPEG, JXL) register in the ENCODERS /
// DECODERS tables of encoder.js and decoder.js.

import { PixmixError } from '../core/params.js';

const SIGNATURES = [
  ['png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['jpeg', [0xff, 0xd8, 0xff]],
  ['jxl', [0xff, 0x0a]],
  ['jxl', [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]],
  ['gif', [0x47, 0x49, 0x46, 0x38]],
  ['webp', [0x52, 0x49, 0x46, 0x46, -1, -1, -1, -1, 0x57, 0x45, 0x42, 0x50]],
  ['bmp', [0x42, 0x4d]],
  ['tiff', [0x49, 0x49, 0x2a, 0x00]],
  ['tiff', [0x4d, 0x4d, 0x00, 0x2a]],
];

// ISO-BMFF images: 'ftyp' box at offset 4, then the major brand. The generic HEIF brands
// (mif1, msf1) say nothing about the codec, so the compatible brands decide: AVIF when they
// name it, else HEIC.
const FTYP_BRANDS = { avif: 'avif', avis: 'avif', heic: 'heic', heix: 'heic', mif1: 'heif', msf1: 'heif' };

/** @param {Uint8Array|ArrayBuffer|ArrayBufferView} bytes @returns {string|null} */
export function detectFormat(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = toBytes(bytes);
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp') {
    const brand = FTYP_BRANDS[String.fromCharCode(...bytes.subarray(8, 12))] ?? null;
    return brand === 'heif' ? (compatibleBrands(bytes).some((b) => FTYP_BRANDS[b] === 'avif') ? 'avif' : 'heic') : brand;
  }
  for (const [name, sig] of SIGNATURES) {
    if (bytes.length >= sig.length && sig.every((b, i) => b < 0 || bytes[i] === b)) return name;
  }
  return null;
}

/** The compatible brands of an 'ftyp' box (after its major brand and minor version). */
function compatibleBrands(bytes) {
  const size = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  const end = Math.min(size, bytes.length, 4096);
  const out = [];
  for (let o = 16; o + 4 <= end; o += 4) out.push(String.fromCharCode(...bytes.subarray(o, o + 4)));
  return out;
}

/**
 * Accepts Uint8Array (incl. Node Buffer), ArrayBuffer or any ArrayBufferView. Always
 * returns a plain Uint8Array: Buffer.prototype.slice returns a shared view instead of a
 * copy, and code downstream relies on slice() copying (it must never touch the input).
 */
export function toBytes(input) {
  if (input instanceof Uint8Array && Object.getPrototypeOf(input) === Uint8Array.prototype) return input;
  if (input instanceof Uint8Array) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new PixmixError('Expected image bytes (Uint8Array, Buffer or ArrayBuffer)', 'BAD_OPTION');
}

/** Picks the handler for `bytes` from a {format: handler} table. */
export function pick(table, bytes, targetFormat) {
  const format = detectFormat(bytes);
  if (!format) throw new PixmixError('Unrecognised image format', 'UNSUPPORTED');
  const target = targetFormat ?? format;
  if (target !== format) {
    throw new PixmixError(`Converting ${format} to ${target} is not supported yet`, 'UNSUPPORTED');
  }
  const handler = table[format];
  if (!handler) throw new PixmixError(`${format.toUpperCase()} is not supported yet`, 'UNSUPPORTED');
  return handler;
}
