// PNG container: signature + [length, type, data, crc]*. Chunks are kept as raw bytes
// so everything we do not touch is written back exactly as it came in.

import { PixmixError } from '../../core/params.js';
import { crc32 } from './zlib.js';

export const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export function isPng(bytes) {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) return false;
  return true;
}

/**
 * @typedef {{type: string, data: Uint8Array}} Chunk
 * @param {Uint8Array} bytes @returns {Chunk[]}
 */
export function readChunks(bytes) {
  if (!isPng(bytes)) throw new PixmixError('Not a PNG file', 'BAD_PNG');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let pos = 8;
  while (pos < bytes.length) {
    if (pos + 12 > bytes.length) throw new PixmixError('Truncated PNG chunk', 'BAD_PNG');
    const len = dv.getUint32(pos);
    if (len > 0x7fffffff || pos + 12 + len > bytes.length) {
      throw new PixmixError('Truncated PNG chunk', 'BAD_PNG');
    }
    const typeBytes = bytes.subarray(pos + 4, pos + 8);
    for (const c of typeBytes) {
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) {
        throw new PixmixError('Invalid PNG chunk type', 'BAD_PNG');
      }
    }
    const type = String.fromCharCode(...typeBytes);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    const crc = crc32(data, crc32(typeBytes));
    if (crc !== dv.getUint32(pos + 8 + len)) {
      throw new PixmixError(`CRC mismatch in ${type} chunk`, 'BAD_PNG');
    }
    chunks.push({ type, data });
    pos += 12 + len;
    if (type === 'IEND') break;
  }
  if (chunks[0]?.type !== 'IHDR') throw new PixmixError('PNG does not start with IHDR', 'BAD_PNG');
  if (chunks.at(-1).type !== 'IEND') throw new PixmixError('PNG is missing IEND', 'BAD_PNG');
  return chunks;
}

/** @param {Chunk[]} chunks @returns {Uint8Array} */
export function writeChunks(chunks) {
  let size = 8;
  for (const c of chunks) size += 12 + c.data.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out.set(SIGNATURE);
  let pos = 8;
  for (const c of chunks) {
    dv.setUint32(pos, c.data.length);
    for (let i = 0; i < 4; i++) out[pos + 4 + i] = c.type.charCodeAt(i);
    out.set(c.data, pos + 8);
    dv.setUint32(pos + 8 + c.data.length, crc32(c.data, crc32(out.subarray(pos + 4, pos + 8))));
    pos += 12 + c.data.length;
  }
  return out;
}
