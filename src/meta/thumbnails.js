// Embedded previews would show the unscrambled picture, so the encoder removes them
// (unless asked to keep them). Each function returns null when there was nothing to strip.

import { startsWith } from '../formats/jpeg/markers.js';

// A real copy even for Node Buffers, whose slice() shares memory with the input.
const copy = (bytes, end = bytes.length) => Uint8Array.prototype.slice.call(bytes, 0, end);

/**
 * EXIF (TIFF) thumbnail in IFD1: unlinks IFD1 and zeroes the IFD and the image bytes.
 * Offsets elsewhere stay valid because nothing moves.
 * @param {Uint8Array} tiff @returns {Uint8Array|null}
 */
export function stripExifThumbnail(tiff) {
  if (tiff.length < 8) return null;
  const le = tiff[0] === 0x49;
  if (!le && tiff[0] !== 0x4d) return null;
  const dv = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
  const ifd0 = u32(4);
  if (ifd0 + 2 > tiff.length) return null;
  const nextPtr = ifd0 + 2 + u16(ifd0) * 12;
  if (nextPtr + 4 > tiff.length) return null;
  const ifd1 = u32(nextPtr);
  if (!ifd1 || ifd1 + 2 > tiff.length) return null;

  const out = copy(tiff);
  const ov = new DataView(out.buffer);
  ov.setUint32(nextPtr, 0, le);
  const count = u16(ifd1);
  const ranges = [[ifd1, ifd1 + 2 + count * 12 + 4]];
  let offset = 0, length = 0, strips = null, stripLens = null;
  for (let i = 0; i < count; i++) {
    const e = ifd1 + 2 + i * 12;
    if (e + 12 > tiff.length) break;
    const tag = u16(e), type = u16(e + 2), n = u32(e + 4);
    const value = type === 3 && n === 1 ? u16(e + 8) : u32(e + 8);
    if (tag === 0x0201) offset = value;          // JPEGInterchangeFormat
    else if (tag === 0x0202) length = value;     // JPEGInterchangeFormatLength
    else if (tag === 0x0111 && n === 1) strips = value;     // single-strip uncompressed thumbnail
    else if (tag === 0x0117 && n === 1) stripLens = value;
  }
  if (offset && length) ranges.push([offset, offset + length]);
  if (strips !== null && stripLens) ranges.push([strips, strips + stripLens]);
  for (const [a, b] of ranges) out.fill(0, Math.min(a, out.length), Math.min(b, out.length));
  return out;
}

/** Photoshop APP13 image resources: drops thumbnail resources 0x0409 / 0x040C. */
export function stripIrbThumbnails(payload) {
  const SIG = 'Photoshop 3.0\0';
  if (!startsWith(payload, SIG)) return null;
  const keep = [payload.subarray(0, SIG.length)];
  let pos = SIG.length, dropped = false;
  while (pos + 12 <= payload.length && startsWith(payload.subarray(pos), '8BIM')) {
    const id = (payload[pos + 4] << 8) | payload[pos + 5];
    let p = pos + 6;
    const nameLen = payload[p];
    p += 1 + nameLen + ((nameLen + 1) & 1);
    if (p + 4 > payload.length) break;
    const size = ((payload[p] << 24) | (payload[p + 1] << 16) | (payload[p + 2] << 8) | payload[p + 3]) >>> 0;
    const end = Math.min(payload.length, p + 4 + size + (size & 1));
    if (id === 0x0409 || id === 0x040c) dropped = true;
    else keep.push(payload.subarray(pos, end));
    pos = end;
  }
  if (!dropped) return null;
  if (pos < payload.length) keep.push(payload.subarray(pos));
  const out = new Uint8Array(keep.reduce((n, k) => n + k.length, 0));
  let o = 0;
  for (const k of keep) { out.set(k, o); o += k.length; }
  return out;
}

/** JFIF APP0 with an embedded thumbnail: keeps the header, drops the pixels. */
export function stripJfifThumbnail(payload) {
  if (!startsWith(payload, 'JFIF\0') || payload.length < 14) return null;
  if (!payload[12] && !payload[13] && payload.length === 14) return null;
  const out = copy(payload, 14);
  out[12] = 0;
  out[13] = 0;
  return out;
}
