// Builds a JPEG from decoded 8-bit RGBA plus container-independent metadata.

import { encodePixels } from '../formats/jpeg/fdct.js';
import { assembleJpeg } from '../formats/jpeg/encode.js';
import { M } from '../formats/jpeg/markers.js';

const utf8 = new TextEncoder();
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
const MAX_PAYLOAD = 65533;
const ICC_CHUNK = MAX_PAYLOAD - 14; // "ICC_PROFILE\0" + sequence + count

/**
 * @param {{width: number, height: number, data: Uint8Array}} image RGBA8
 * @param {import('../meta/jpeg.js').Metadata} [meta]
 * @param {{quality?: number, subsampling?: '4:2:0'|'4:2:2'|'4:4:4', background?: string}} [opts]
 * @returns {{jpeg: Uint8Array, transferred: string[], dropped: string[]}}
 */
export function buildJpeg(image, meta = {}, { quality = 90, subsampling = '4:2:0', background = '#ffffff' } = {}) {
  const transferred = [];
  const dropped = [...(meta.dropped ?? [])];
  const { width, height } = image;
  let data = image.data;

  let alpha = false, grey = true;
  for (let o = 0; o < data.length; o += 4) {
    if (data[o + 3] !== 255) alpha = true;
    if (grey && (data[o] !== data[o + 1] || data[o] !== data[o + 2])) grey = false;
  }
  if (alpha) {
    const [br, bg, bb] = parseColor(background);
    data = data.slice();
    for (let o = 0; o < data.length; o += 4) {
      const a = data[o + 3] / 255;
      data[o] = Math.round(data[o] * a + br * (1 - a));
      data[o + 1] = Math.round(data[o + 1] * a + bg * (1 - a));
      data[o + 2] = Math.round(data[o + 2] * a + bb * (1 - a));
      data[o + 3] = 255;
    }
    grey &&= br === bg && bg === bb;
    dropped.push(`transparency (flattened onto ${background})`);
  }

  let icc = meta.icc;
  const iccSpace = icc?.length >= 20 ? String.fromCharCode(...icc.subarray(16, 20)) : null;
  if (icc && iccSpace !== 'RGB ' && iccSpace !== 'GRAY') {
    dropped.push(`ICC profile (${iccSpace?.trim() || 'invalid'} colour space)`);
    icc = undefined;
  }
  if (icc && iccSpace === 'GRAY' && !grey) {
    dropped.push('ICC profile (GRAY profile on a colour image)');
    icc = undefined;
  }
  if (icc && iccSpace === 'RGB ') grey = false;

  const header = [];
  const jfif = Uint8Array.from([...ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  if (meta.density) {
    // JPEG only has dots per cm/inch; pHYs is per metre.
    const d = meta.density;
    const perCm = d.unit === 'meter';
    const x = perCm ? Math.round(d.x / 100) : d.x, y = perCm ? Math.round(d.y / 100) : d.y;
    if (x > 0 && y > 0 && x < 65536 && y < 65536) {
      jfif[7] = perCm ? 2 : 0;
      jfif[8] = x >> 8; jfif[9] = x & 255; jfif[10] = y >> 8; jfif[11] = y & 255;
      transferred.push('density');
    }
  }
  header.push({ marker: M.APP0, data: jfif });
  if (meta.exif?.length) {
    if (meta.exif.length + 6 <= MAX_PAYLOAD) {
      header.push({ marker: M.APP1, data: concat(ascii('Exif\0\0'), meta.exif) });
      transferred.push('EXIF');
    } else dropped.push('EXIF (larger than one JPEG segment)');
  }
  if (meta.xmp) {
    const xmp = concat(ascii('http://ns.adobe.com/xap/1.0/\0'), utf8.encode(meta.xmp));
    if (xmp.length <= MAX_PAYLOAD) {
      header.push({ marker: M.APP1, data: xmp });
      transferred.push('XMP');
    } else dropped.push('XMP (needs extended XMP, not written yet)');
  }
  if (icc) {
    const count = Math.ceil(icc.length / ICC_CHUNK);
    for (let i = 0; i < count; i++) {
      header.push({
        marker: M.APP2,
        data: concat(ascii('ICC_PROFILE\0'), Uint8Array.of(i + 1, count), icc.subarray(i * ICC_CHUNK, (i + 1) * ICC_CHUNK)),
      });
    }
    transferred.push('ICC profile');
  }
  for (const c of meta.comments ?? []) {
    header.push({ marker: M.COM, data: ascii(c).subarray(0, MAX_PAYLOAD) });
    if (!transferred.includes('comments')) transferred.push('comments');
  }

  const { frame, dqt } = encodePixels({ width, height, data }, { quality, subsampling, grey });
  header.push(dqt);
  return { jpeg: assembleJpeg(header, frame), transferred, dropped };
}

function parseColor(c) {
  const m = /^#?([0-9a-f]{6})$/i.exec(c);
  if (!m) throw new RangeError(`background must be a #rrggbb colour, got "${c}"`);
  const n = parseInt(m[1], 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
