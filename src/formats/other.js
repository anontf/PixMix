// inspect() for the formats pixmix reads but never writes: GIF and WebP get their size and
// frames from the headers, checked against the limits like everything else (so inspect
// stays a cheap check up front); the others (BMP, TIFF, AVIF, HEIC) only their format.

import { PixmixError } from '../core/params.js';
import { checkPixels, checkFrames } from '../core/limits.js';
import { readWebpMetadata } from '../meta/webp.js';
import { readOrientation } from '../meta/exif.js';

const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u24 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);

/** @param {Uint8Array} bytes @param {string} format @param {import('../core/limits.js').Limits} limits */
export function inspectOther(bytes, format, limits) {
  const out = format === 'gif' ? gifInfo(bytes) : format === 'webp' ? webpInfo(bytes) : {};
  if (out.width) checkPixels(out.width, out.height, limits);
  if (out.frameSizes) {
    out.frameSizes.forEach((f, i) => checkPixels(f.width, f.height, limits, `Frame ${i}`));
    if (out.frameSizes.length > 1) checkFrames(out.frameSizes.length, out.frameSizes.length * out.width * out.height, limits);
  }
  const { frameSizes, ...info } = out;
  return {
    format, scrambled: false, ...info,
    ...(frameSizes ? { animated: frameSizes.length > 1, frames: frameSizes.length } : {}),
  };
}

/** The logical screen and every image descriptor, walking the blocks (no LZW decoding). */
function gifInfo(b) {
  if (b.length < 13) throw new PixmixError('Bad GIF: truncated header', 'BAD_GIF');
  const info = { width: u16(b, 6), height: u16(b, 8), frameSizes: [] };
  let pos = 13 + (b[10] & 0x80 ? 3 << ((b[10] & 7) + 1) : 0);
  const skipSubBlocks = () => {
    while (pos < b.length && b[pos]) pos += b[pos] + 1;
    pos++;
  };
  while (pos < b.length) {
    const block = b[pos];
    if (block === 0x3b) break;
    if (block === 0x21) { pos += 2; skipSubBlocks(); continue; }
    // Anything else is damage the decoder reports; inspect describes what it could read.
    if (block !== 0x2c || pos + 10 > b.length) break;
    info.frameSizes.push({ width: u16(b, pos + 5), height: u16(b, pos + 7) });
    const flags = b[pos + 9];
    pos += 10 + (flags & 0x80 ? 3 << ((flags & 7) + 1) : 0) + 1; // local colour table, LZW code size
    skipSubBlocks();
  }
  if (!info.frameSizes.length) delete info.frameSizes;
  return info;
}

/** Canvas size (VP8X, or the VP8 / VP8L bitstream of a simple file), frames, metadata. */
function webpInfo(b) {
  const info = {};
  const frames = [];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let pos = 12; pos + 8 <= b.length;) {
    const id = fourcc(b, pos), len = dv.getUint32(pos + 4, true), d = pos + 8;
    if (id === 'VP8X' && len >= 10) Object.assign(info, { width: u24(b, d + 4) + 1, height: u24(b, d + 7) + 1 });
    else if (id === 'ANMF' && len >= 16) frames.push({ width: u24(b, d + 6) + 1, height: u24(b, d + 9) + 1 });
    else if (id === 'VP8 ' && !info.width && len >= 10) Object.assign(info, { width: u16(b, d + 6) & 0x3fff, height: u16(b, d + 8) & 0x3fff });
    else if (id === 'VP8L' && !info.width && len >= 5) {
      const bits = dv.getUint32(d + 1, true);
      Object.assign(info, { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 });
    }
    pos = d + len + (len & 1);
  }
  const meta = readWebpMetadata(b);
  info.metadata = ['exif', 'icc', 'xmp', 'density'].filter((k) => meta[k]);
  if (meta.exif) info.orientation = readOrientation(meta.exif);
  if (frames.length) info.frameSizes = frames;
  return info;
}
