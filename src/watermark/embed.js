// What a scrambled file can carry about watermarks, in a private chunk / segment / box that
// other software ignores (PNG `pmWm` / `pmWs`, JPEG APP15 "pixmix-wm" / "pixmix-ws", JPEG XL
// `pmWm` / `pmWs` boxes):
//
// - the watermark for the RESTORED image (pmWm): an id to look up, or a whole compiled
//   watermark. The decoder draws it when it reveals the image.
//     u8 version (1) | u8 kind (0 = id, 1 = compiled JSON) | UTF-8 id or JSON
//
// - a VISIBLE watermark on the scrambled image itself (pmWs): the watermark drawn onto the
//   scrambled pixels (kept so rekey can draw it again), and the scrambled pixels it covers,
//   compressed and encrypted with the key (so they cannot be put back without it). The
//   decoder puts them back before unscrambling, so restoring stays exact. The pixmix
//   marker is v2 with FLAG_STASH when this is present (see core/params.js).
//     u8 version (1) | u32 JSON length | compiled watermark JSON
//     | u8 region count | regions (5 x u32 each: frame, x, y, width, height; for JPEG
//       x, y, width, height count MCUs) | u32 data length | encrypted zlib data
//
// Nothing here draws; that is paint.js, loaded on demand.

import { zlibSync, unzlibSync } from 'fflate';
import { PixmixError, keyBytes } from '../core/params.js';
import { hkdf } from '../core/sha256.js';
import { ChaChaRng } from '../core/prng.js';
import { resolveLimits, limitError } from '../core/limits.js';

export const WATERMARK_TAG = 'pmWm';
export const STASH_TAG = 'pmWs';
// What pixmix itself writes; on reading, carried JSON counts as metadata (maxMetadataBytes),
// and a stash can only hold pixels of the image, whose size the limits already bound.
const MAX_JSON = 512 * 1024;

const utf8 = new TextEncoder(), fromUtf8 = new TextDecoder('utf-8', { fatal: true });
const bad = (what) => new PixmixError(`Corrupt pixmix watermark data (${what})`, 'BAD_WATERMARK');

/**
 * @param {{id: string}|object} wm  an id reference, or a compiled watermark (both already
 *        validated: see checkWatermarkOptions in encoder.js)
 * @returns {Uint8Array}
 */
export function encodeWatermark(wm) {
  const idOnly = wm && Object.keys(wm).length === 1 && typeof wm.id === 'string';
  const body = utf8.encode(idOnly ? wm.id : JSON.stringify(wm));
  if (body.length > MAX_JSON) throw new PixmixError('Watermark too large to embed', 'BAD_WATERMARK');
  const out = new Uint8Array(2 + body.length);
  out[0] = 1;
  out[1] = idOnly ? 0 : 1;
  out.set(body, 2);
  return out;
}

/**
 * @returns {{id: string, name?: string, compiled: object|null}}  compiled is not validated
 *          here (drawing validates it)
 */
export function decodeWatermark(data, limits) {
  if (data.length < 3 || data[0] !== 1 || data[1] > 1) throw bad('header');
  checkJson(data.length - 2, limits);
  let text;
  try { text = fromUtf8.decode(data.subarray(2)); } catch { throw bad('text'); }
  if (data[1] === 0) return { id: text, compiled: null };
  let obj;
  try { obj = JSON.parse(text); } catch { throw bad('JSON'); }
  if (!obj || typeof obj !== 'object' || typeof obj.id !== 'string') throw bad('JSON');
  return { id: obj.id, name: typeof obj.name === 'string' ? obj.name : undefined, compiled: obj };
}

function checkJson(n, limits) {
  const { maxMetadataBytes } = resolveLimits(limits);
  if (n > maxMetadataBytes) throw limitError(`Carried watermark is ${n} bytes, over the limit of ${maxMetadataBytes} (limits.maxMetadataBytes)`);
}

/** The keystream that encrypts stashed pixels: HKDF of the key and the image's salt. */
function crypt(data, key, salt) {
  const okm = hkdf(keyBytes(key), salt, utf8.encode('pixmix/watermark-stash'), 44);
  const rng = new ChaChaRng(okm.subarray(0, 32), okm.subarray(32, 44));
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const w = rng.nextU32();
    for (let k = 0; k < 4 && i + k < data.length; k++) out[i + k] = data[i + k] ^ ((w >>> (8 * k)) & 255);
  }
  return out;
}

/**
 * @param {{watermark: object, regions: {frame: number, x: number, y: number, width: number,
 *   height: number}[], raw: Uint8Array, key: string|Uint8Array, salt: Uint8Array}} s
 */
export function encodeStash({ watermark, regions, raw, key, salt }) {
  const json = utf8.encode(JSON.stringify(watermark));
  const data = crypt(zlibSync(raw, { level: 6 }), key, salt);
  const out = new Uint8Array(1 + 4 + json.length + 1 + regions.length * 20 + 4 + data.length);
  const dv = new DataView(out.buffer);
  let o = 0;
  out[o++] = 1;
  dv.setUint32(o, json.length); o += 4;
  out.set(json, o); o += json.length;
  out[o++] = regions.length;
  for (const r of regions) for (const v of [r.frame, r.x, r.y, r.width, r.height]) { dv.setUint32(o, v); o += 4; }
  dv.setUint32(o, data.length); o += 4;
  out.set(data, o);
  return out;
}

/**
 * Parses and decrypts a stash. `bytesOf(region)` gives each region's raw size, so the data
 * is inflated into a buffer of exactly the expected length (a hostile file cannot make it
 * grow further).
 */
export function decodeStash(payload, key, salt, bytesOf, limits) {
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const need = (o, n) => { if (o + n > payload.length) throw bad('truncated'); };
  let o = 0;
  need(0, 5);
  if (payload[o++] !== 1) throw bad('version');
  const jl = dv.getUint32(o); o += 4;
  need(o, jl + 1);
  checkJson(jl, limits);
  let watermark;
  try { watermark = JSON.parse(fromUtf8.decode(payload.subarray(o, o + jl))); } catch { throw bad('JSON'); }
  o += jl;
  const count = payload[o++];
  need(o, count * 20 + 4);
  const regions = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const [frame, x, y, width, height] = [0, 1, 2, 3, 4].map((k) => dv.getUint32(o + k * 4));
    o += 20;
    const r = { frame, x, y, width, height };
    total += bytesOf(r); // throws for a region outside the image
    regions.push(r);
  }
  const dl = dv.getUint32(o); o += 4;
  need(o, dl);
  let raw;
  try {
    raw = unzlibSync(crypt(payload.subarray(o, o + dl), key, salt), { out: new Uint8Array(total) });
  } catch { throw bad('data'); }
  if (raw.length !== total) throw bad('data length');
  return { watermark, regions, raw };
}

/** Size of a JPEG stash region (in MCUs): every component's blocks, 64 int16 each. */
export function jpegRectBytes(frame, r) {
  if (r.frame || !r.width || !r.height || r.x + r.width > frame.mcusX || r.y + r.height > frame.mcusY) throw bad('region');
  return frame.components.reduce((n, c) => n + r.width * r.height * c.h * c.v * 128, 0);
}

/** Copies the coefficients of an MCU rectangle between a frame and a buffer (little-endian). */
export function jpegRect(frame, r, buf, toBuffer) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 0;
  for (const c of frame.components) {
    for (let my = r.y; my < r.y + r.height; my++) {
      for (let mx = r.x; mx < r.x + r.width; mx++) {
        for (let by = 0; by < c.v; by++) {
          for (let bx = 0; bx < c.h; bx++) {
            const at = ((my * c.v + by) * c.blocksW + mx * c.h + bx) * 64;
            for (let k = 0; k < 64; k++, o += 2) {
              if (toBuffer) dv.setInt16(o, c.coefs[at + k], true);
              else c.coefs[at + k] = dv.getInt16(o, true);
            }
          }
        }
      }
    }
  }
}

/** Puts a JPEG stash back into the (scrambled) frame. */
export function restoreJpegStash(frame, payload, key, salt, limits) {
  const { regions, raw, watermark } = decodeStash(payload, key, salt, (r) => jpegRectBytes(frame, r), limits);
  if (regions.length !== 1) throw bad('regions');
  jpegRect(frame, regions[0], raw, false);
  return watermark;
}

/**
 * Puts pixel stashes back: frames[i] is {pixels, width, height, bpp} (native PNG samples, or
 * JPEG XL RGBA bytes).
 */
export function restorePixelStash(frames, payload, key, salt, limits) {
  const size = (r) => {
    const f = frames[r.frame];
    if (!f || !r.width || !r.height || r.x + r.width > f.width || r.y + r.height > f.height) throw bad('region');
    return r.width * r.height * f.bpp;
  };
  const { regions, raw, watermark } = decodeStash(payload, key, salt, size, limits);
  let at = 0;
  for (const r of regions) {
    const f = frames[r.frame];
    at = copyRect(f.pixels, f.width, f.bpp, r, raw, at, false);
  }
  return watermark;
}

/** Copies a rectangle of pixels (bpp bytes each) between an image and a packed buffer. */
export function copyRect(pixels, stride, bpp, r, buf, offset, toBuffer) {
  const row = r.width * bpp;
  for (let y = 0; y < r.height; y++) {
    const at = ((r.y + y) * stride + r.x) * bpp;
    if (toBuffer) buf.set(pixels.subarray(at, at + row), offset + y * row);
    else pixels.set(buf.subarray(offset + y * row, offset + (y + 1) * row), at);
  }
  return offset + r.height * row;
}
