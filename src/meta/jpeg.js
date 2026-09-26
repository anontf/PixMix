// Metadata from a JPEG's marker segments. Nothing here decodes pixels.

import { PixmixError } from '../core/params.js';
import { decodeComment } from './text.js';

const startsWith = (bytes, s) => s.length <= bytes.length && [...s].every((c, i) => bytes[i] === c.charCodeAt(0));

const EXIF = 'Exif\0\0';
const XMP = 'http://ns.adobe.com/xap/1.0/\0';
const XMP_EXT = 'http://ns.adobe.com/xmp/extension/\0';
const ICC = 'ICC_PROFILE\0';

/**
 * @typedef {object} Metadata  container-independent metadata, all optional
 * @property {Uint8Array} [exif]     TIFF-structured EXIF (no "Exif\0\0" prefix)
 * @property {Uint8Array} [icc]      ICC profile
 * @property {string}     [xmp]      XMP packet
 * @property {{x: number, y: number, unit: 'meter'|'none'}} [density]  pixels per unit
 * @property {string[]}   [comments]
 * @property {string[]}   [dropped]  what could not be carried over, and why
 */

/** @returns {Metadata & {width: number, height: number}} */
export function readJpegMetadata(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new PixmixError('Not a JPEG file', 'BAD_JPEG');
  const meta = { dropped: [], comments: [] };
  const iccParts = [];
  let pos = 2;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) throw new PixmixError('Corrupt JPEG marker stream', 'BAD_JPEG');
    const marker = bytes[pos + 1];
    if (marker === 0xff) { pos++; continue; } // fill byte
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { pos += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / start of scan: no more metadata
    const len = (bytes[pos + 2] << 8) | bytes[pos + 3];
    if (len < 2 || pos + 2 + len > bytes.length) throw new PixmixError('Truncated JPEG segment', 'BAD_JPEG');
    const seg = bytes.subarray(pos + 4, pos + 2 + len);

    if (marker === 0xe0 && startsWith(seg, 'JFIF\0') && seg.length >= 12) {
      const unit = seg[7], x = (seg[8] << 8) | seg[9], y = (seg[10] << 8) | seg[11];
      if (x && y) {
        // PNG pHYs is per metre: 1 = dots per inch, 2 = dots per cm, 0 = aspect ratio only.
        const scale = unit === 1 ? 1 / 0.0254 : unit === 2 ? 100 : 1;
        meta.density = { x: Math.round(x * scale), y: Math.round(y * scale), unit: unit ? 'meter' : 'none' };
      }
    } else if (marker === 0xe1 && startsWith(seg, EXIF)) {
      meta.exif ??= seg.slice(EXIF.length);
    } else if (marker === 0xe1 && startsWith(seg, XMP)) {
      meta.xmp ??= new TextDecoder().decode(seg.subarray(XMP.length));
    } else if (marker === 0xe1 && startsWith(seg, XMP_EXT)) {
      if (!meta.dropped.includes('extended XMP')) meta.dropped.push('extended XMP');
    } else if (marker === 0xe2 && startsWith(seg, ICC) && seg.length > ICC.length + 2) {
      iccParts.push({ seq: seg[ICC.length], data: seg.subarray(ICC.length + 2) });
    } else if (marker === 0xfe) {
      meta.comments.push(decodeComment(seg));
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      meta.height = (seg[1] << 8) | seg[2];
      meta.width = (seg[3] << 8) | seg[4];
      meta.components = seg[5];
    }
    pos += 2 + len;
  }
  if (iccParts.length) {
    iccParts.sort((a, b) => a.seq - b.seq);
    const icc = new Uint8Array(iccParts.reduce((n, p) => n + p.data.length, 0));
    let o = 0;
    for (const p of iccParts) { icc.set(p.data, o); o += p.data.length; }
    meta.icc = icc;
  }
  return meta;
}
