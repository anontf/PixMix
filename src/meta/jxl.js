// Metadata boxes of a JPEG XL container. The colour encoding lives in the codestream
// header (see formats/jxl/container.js), not in a box.

import { readJxl } from '../formats/jxl/container.js';
import { resolveLimits, decompressedLimitError } from '../core/limits.js';

const utf8 = new TextDecoder();
const brotli = globalThis.process?.getBuiltinModule?.('node:zlib');

/** EXIF box payload: 4-byte big-endian offset to the TIFF header, then TIFF. */
export const exifTiff = (data) => data.subarray(4 + ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]));

/**
 * Unwraps a Brotli-compressed 'brob' box when this runtime can (Node). `data` is null when
 * it cannot, and `corrupt` is set when the Brotli stream is broken.
 * @returns {{type: string, data: Uint8Array|null, corrupt?: boolean}}
 */
export function unwrapBrob(data, limits) {
  const type = String.fromCharCode(...data.subarray(0, 4));
  if (!brotli) return { type, data: null };
  const { maxMetadataBytes } = resolveLimits(limits);
  try {
    const out = brotli.brotliDecompressSync(data.subarray(4), Number.isFinite(maxMetadataBytes) ? { maxOutputLength: maxMetadataBytes } : {});
    return { type, data: new Uint8Array(out.buffer, out.byteOffset, out.length) };
  } catch (err) {
    if (err?.code === 'ERR_BUFFER_TOO_LARGE') throw decompressedLimitError(maxMetadataBytes, 'maxMetadataBytes', `A compressed ${type.trim()} box`);
    return { type, data: null, corrupt: true };
  }
}

/** @returns {import('./jpeg.js').Metadata} */
export function readJxlMetadata(bytes, limits) {
  const meta = { dropped: [] };
  for (let { type, data } of readJxl(bytes, limits).boxes) {
    if (type === 'brob') {
      const inner = unwrapBrob(data, limits);
      if (!inner.data) { meta.dropped.push(`compressed ${inner.type.trim()} box (${inner.corrupt ? 'corrupt' : 'no Brotli here'})`); continue; }
      ({ type, data } = inner);
    }
    if (type === 'Exif' && data.length > 4) meta.exif = exifTiff(data).slice();
    else if (type === 'xml ') meta.xmp = utf8.decode(data);
  }
  return meta;
}
