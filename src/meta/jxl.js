// Metadata boxes of a JPEG XL container. The colour encoding lives in the codestream
// header (see formats/jxl/container.js), not in a box.

import { readJxl } from '../formats/jxl/container.js';

const utf8 = new TextDecoder();
const brotli = globalThis.process?.getBuiltinModule?.('node:zlib');

/** EXIF box payload: 4-byte big-endian offset to the TIFF header, then TIFF. */
export const exifTiff = (data) => data.subarray(4 + ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]));

/** Unwraps a Brotli-compressed 'brob' box when this runtime can (Node). */
export function unwrapBrob(data) {
  const type = String.fromCharCode(...data.subarray(0, 4));
  if (!brotli) return { type, data: null };
  return { type, data: new Uint8Array(brotli.brotliDecompressSync(data.subarray(4))) };
}

/** @returns {import('./jpeg.js').Metadata} */
export function readJxlMetadata(bytes) {
  const meta = { dropped: [] };
  for (let { type, data } of readJxl(bytes).boxes) {
    if (type === 'brob') {
      const inner = unwrapBrob(data);
      if (!inner.data) { meta.dropped.push(`compressed ${inner.type.trim()} box (no Brotli here)`); continue; }
      ({ type, data } = inner);
    }
    if (type === 'Exif' && data.length > 4) meta.exif = exifTiff(data).slice();
    else if (type === 'xml ') meta.xmp = utf8.decode(data);
  }
  return meta;
}
