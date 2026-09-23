// zlib wrapper: native node:zlib when running under Node (several times faster),
// fflate everywhere else. process.getBuiltinModule keeps the bundle platform-neutral.

import { unzlibSync, zlibSync } from 'fflate';

const native = globalThis.process?.getBuiltinModule?.('node:zlib');

/** @type {(data: Uint8Array, level: number) => Uint8Array} */
export const deflate = native
  ? (data, level) => native.deflateSync(data, { level })
  : (data, level) => zlibSync(data, { level });

/** @type {(data: Uint8Array) => Uint8Array} */
export const inflate = native ? (data) => native.inflateSync(data) : (data) => unzlibSync(data);

// Async variants for browsers: (De)CompressionStream('deflate') is native zlib and far
// faster than any JS implementation. Falls back to the sync versions elsewhere.
const streams = !native && typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

async function pipe(data, stream) {
  const res = new Response(new Blob([data]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

/** @type {(data: Uint8Array) => Promise<Uint8Array>} */
export const inflateAsync = streams
  // Native streams reject trailing bytes after the zlib stream; the JS inflater tolerates them.
  ? (data) => pipe(data, new DecompressionStream('deflate')).catch(() => inflate(data))
  : async (data) => inflate(data);

/** Native streams have no level setting; they use the platform default. */
export const deflateAsync = streams ? (data) => pipe(data, new CompressionStream('deflate')) : async (data, level) => deflate(data, level);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32js(bytes, prev = 0) {
  let crc = ~prev;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

/** Standard CRC-32; `prev` continues a running checksum. */
export const crc32 = native?.crc32 ? (bytes, prev = 0) => native.crc32(bytes, prev) : crc32js;
