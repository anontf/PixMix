// zlib wrapper: native node:zlib when running under Node (several times faster),
// fflate everywhere else. process.getBuiltinModule keeps the bundle platform-neutral.
//
// Inflating always has a ceiling: untrusted data can claim to be anything, and a few
// kilobytes of deflate can expand to gigabytes. inflateUpTo stops decompressing at the
// ceiling instead of allocating (or even computing) the rest.

import { Unzlib, zlibSync } from 'fflate';

const native = globalThis.process?.getBuiltinModule?.('node:zlib');

/** @type {(data: Uint8Array, level: number) => Uint8Array} */
export const deflate = native
  ? (data, level) => native.deflateSync(data, { level })
  : (data, level) => zlibSync(data, { level });

// Input is fed to the JS inflater in slices, so one step can produce at most about
// 1032 x STEP bytes (deflate's maximum ratio) before the ceiling is checked again.
const STEP = 1 << 14;

/**
 * Inflates a zlib stream, stopping once `limit` bytes are out: the result holds at most
 * `limit` bytes, plus `more` when the stream would have produced more than that.
 * @param {Uint8Array} data @param {number} limit
 * @returns {Uint8Array & {more?: boolean}}
 */
export function inflateUpTo(data, limit) {
  if (native) {
    try {
      const out = native.inflateSync(data, Number.isFinite(limit) ? { maxOutputLength: Math.max(1, limit) } : {});
      return new Uint8Array(out.buffer, out.byteOffset, out.length);
    } catch (err) {
      if (err?.code !== 'ERR_BUFFER_TOO_LARGE') throw err;
      // Over the limit: take the first `limit` bytes with the stepwise inflater below.
    }
  }
  const parts = [];
  let n = 0, ended = false;
  const z = new Unzlib((chunk, final) => { parts.push(chunk); n += chunk.length; ended ||= final; });
  for (let i = 0; !ended && n <= limit; i += STEP) {
    const last = i + STEP >= data.length;
    z.push(data.subarray(i, i + STEP), last);
    if (last) break;
  }
  // fflate does not check the Adler-32 that ends the stream; node:zlib (and the browsers'
  // streams) do, so a file must not be accepted here and refused there.
  if (ended && n <= limit && !hasChecksum(data, adler32(parts))) throw new Error('incorrect data check');
  const out = concat(parts, Math.min(n, limit));
  if (n > limit) out.more = true;
  return out;
}

function adler32(parts) {
  let a = 1, b = 0;
  for (const p of parts) {
    for (let i = 0; i < p.length;) {
      const end = Math.min(i + 3800, p.length);
      for (; i < end; i++) { a += p[i]; b += a; }
      a %= 65521;
      b %= 65521;
    }
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * The checksum follows the deflate data, normally at the very end; bytes after the stream
 * are tolerated (as by node:zlib), so it is looked for from the end backwards.
 */
function hasChecksum(data, sum) {
  const b0 = sum >>> 24, b1 = (sum >> 16) & 255, b2 = (sum >> 8) & 255, b3 = sum & 255;
  for (let i = data.length - 4; i >= 2; i--) {
    if (data[i] === b0 && data[i + 1] === b1 && data[i + 2] === b2 && data[i + 3] === b3) return true;
  }
  return false;
}

/** Async variants for browsers: (De)CompressionStream('deflate') is native zlib and far
 * faster than any JS implementation. Falls back to the sync versions elsewhere. */
const streams = !native && typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

async function pipe(data, stream) {
  const res = new Response(new Blob([data]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

/** inflateUpTo through a native stream, cancelled as soon as the limit is reached. */
async function inflateStream(data, limit) {
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    n += value.length;
    if (n > limit) { reader.cancel().catch(() => {}); break; }
  }
  const out = concat(parts, Math.min(n, limit));
  if (n > limit) out.more = true;
  return out;
}

/** @type {(data: Uint8Array, limit: number) => Promise<Uint8Array & {more?: boolean}>} */
export const inflateUpToAsync = streams
  // Native streams reject trailing bytes after the zlib stream; the JS inflater tolerates them.
  ? (data, limit) => inflateStream(data, limit).catch(() => inflateUpTo(data, limit))
  : async (data, limit) => inflateUpTo(data, limit);

/** Native streams have no level setting; they use the platform default. */
export const deflateAsync = streams ? (data) => pipe(data, new CompressionStream('deflate')) : async (data, level) => deflate(data, level);

function concat(parts, n) {
  if (parts.length === 1 && parts[0].length === n) return parts[0];
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    if (o >= n) break;
    const take = Math.min(p.length, n - o);
    out.set(take === p.length ? p : p.subarray(0, take), o);
    o += take;
  }
  return out;
}

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
