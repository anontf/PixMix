// Embedded previews would show the unscrambled picture, so the encoder removes them
// (unless asked to keep them). Each function returns null when there was nothing to strip.

import { startsWith } from '../formats/jpeg/markers.js';
import { XmpPacket } from './xmp.js';

// A real copy even for Node Buffers, whose slice() shares memory with the input.
const copy = (bytes, end = bytes.length) => Uint8Array.prototype.slice.call(bytes, 0, end);

/**
 * XMP properties that hold an image: Adobe's thumbnails (base64 JPEGs), Google's original
 * image and depth map (portrait and lens-blur photos). Also the metadata policies'
 * `thumbnail` group.
 */
export const XMP_PREVIEWS = ['xmp:Thumbnails', 'GImage:*', 'GDepth:*'];
// Of those, the ones holding the image data: what the encoder removes by default.
const XMP_PREVIEW_DATA = new Set(['xmp:Thumbnails', 'GImage:Data', 'GDepth:Data', 'GDepth:Confidence']);
const isXmpPreview = (name) => XMP_PREVIEW_DATA.has(name);
// For packets pixmix cannot parse: the element names above, whatever the prefix.
const XMP_PREVIEW_TEXT = /<[\w.-]+:Thumbnails[\s>]|[\s<]GImage:Data\b|[\s<]GDepth:Data\b/;

function tiffReader(tiff) {
  if (tiff.length < 8) return null;
  const le = tiff[0] === 0x49;
  if (!le && tiff[0] !== 0x4d) return null;
  const dv = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  return { le, u16: (o) => dv.getUint16(o, le), u32: (o) => dv.getUint32(o, le) };
}

/** The values of a SHORT or LONG entry (offsets or byte counts), as far as they are in range. */
function entryValues(tiff, r, e) {
  const type = r.u16(e + 2), n = Math.min(r.u32(e + 4), 65536);
  const size = type === 3 ? 2 : type === 4 ? 4 : 0;
  if (!size) return [];
  const at = n * size <= 4 ? e + 8 : r.u32(e + 8);
  const out = [];
  for (let k = 0; k < n && at + (k + 1) * size <= tiff.length; k++) out.push(size === 2 ? r.u16(at + k * size) : r.u32(at + k * size));
  return out;
}

/**
 * EXIF (TIFF) thumbnail in IFD1: unlinks IFD1 and zeroes the IFD and the image bytes (a
 * JPEG, or uncompressed strips or tiles). Offsets elsewhere stay valid because nothing moves.
 * @param {Uint8Array} tiff @returns {Uint8Array|null}
 */
export function stripExifThumbnail(tiff) {
  const r = tiffReader(tiff);
  if (!r) return null;
  const ifd0 = r.u32(4);
  if (ifd0 + 2 > tiff.length) return null;
  const nextPtr = ifd0 + 2 + r.u16(ifd0) * 12;
  if (nextPtr + 4 > tiff.length) return null;
  const ifd1 = r.u32(nextPtr);
  if (!ifd1 || ifd1 + 2 > tiff.length) return null;

  const out = copy(tiff);
  new DataView(out.buffer).setUint32(nextPtr, 0, r.le);
  const count = r.u16(ifd1);
  const ranges = [[ifd1, ifd1 + 2 + count * 12 + 4]];
  let offset = 0, length = 0, starts = [], lengths = [];
  for (let i = 0; i < count; i++) {
    const e = ifd1 + 2 + i * 12;
    if (e + 12 > tiff.length) break;
    const tag = r.u16(e);
    if (tag === 0x0201) offset = entryValues(tiff, r, e)[0] ?? r.u32(e + 8);       // JPEGInterchangeFormat
    else if (tag === 0x0202) length = entryValues(tiff, r, e)[0] ?? r.u32(e + 8);  // JPEGInterchangeFormatLength
    else if (tag === 0x0111 || tag === 0x0144) starts = entryValues(tiff, r, e);   // StripOffsets / TileOffsets
    else if (tag === 0x0117 || tag === 0x0145) lengths = entryValues(tiff, r, e);  // their byte counts
  }
  if (offset && length) ranges.push([offset, offset + length]);
  starts.forEach((s, k) => { if (lengths[k]) ranges.push([s, s + lengths[k]]); });
  for (const [a, b] of ranges) out.fill(0, Math.min(a, out.length), Math.min(b, out.length));
  return out;
}

/** Where the MakerNote's value is ([start, end) in the TIFF), or null. */
function makerNote(tiff) {
  const r = tiffReader(tiff);
  if (!r) return null;
  const entry = (ifd, tag) => {
    if (ifd + 2 > tiff.length) return -1;
    const n = r.u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > tiff.length) return -1;
      if (r.u16(e) === tag) return e;
    }
    return -1;
  };
  const exifPtr = entry(r.u32(4), 0x8769);
  if (exifPtr < 0) return null;
  const e = entry(r.u32(exifPtr + 8), 0x927c);
  if (e < 0) return null;
  const n = r.u32(e + 4);
  if (n <= 4) return null;
  const start = r.u32(e + 8);
  return start < tiff.length ? [start, Math.min(tiff.length, start + n)] : null;
}

const isSof = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

/**
 * The end of a complete JPEG stream starting at `start` (SOI) and ending before `limit`,
 * or -1 when it is not one: every segment length must fit, a frame header must come
 * before a scan, and the stream must end with EOI. Nothing else looks like that.
 */
function jpegEnd(b, start, limit) {
  let p = start + 2, frame = false, scan = false;
  while (p + 2 <= limit) {
    if (b[p] !== 0xff) return -1;
    const m = b[p + 1];
    if (m === 0xff) { p++; continue; }
    if (m === 0xd9) return frame && scan ? p + 2 : -1;
    if (m === 0x00 || m === 0x01 || (m >= 0xd0 && m <= 0xd8) || p + 4 > limit) return -1;
    const len = (b[p + 2] << 8) | b[p + 3];
    if (len < 2 || p + 2 + len > limit) return -1;
    if (isSof(m)) frame = true;
    p += 2 + len;
    if (m === 0xda) {
      if (!frame) return -1;
      scan = true;
      // Entropy-coded data: up to a marker that is neither stuffing, RSTn nor fill.
      while (p + 1 < limit && !(b[p] === 0xff && b[p + 1] !== 0 && b[p + 1] !== 0xff && !(b[p + 1] >= 0xd0 && b[p + 1] <= 0xd7))) p++;
    }
  }
  return -1;
}

/**
 * JPEG previews inside the MakerNote (Olympus, Pentax, older Nikon and others keep one
 * there): zeroed in place, so the vendor's offsets inside the MakerNote stay valid. Only
 * complete, well-formed JPEG streams are touched.
 * @param {Uint8Array} tiff @returns {Uint8Array|null}
 */
export function stripMakerNotePreviews(tiff) {
  const range = makerNote(tiff);
  if (!range) return null;
  const [start, end] = range;
  let out = null;
  for (let i = start; i + 3 < end; i++) {
    if (tiff[i] !== 0xff || tiff[i + 1] !== 0xd8 || tiff[i + 2] !== 0xff) continue;
    const e = jpegEnd(tiff, i, end);
    if (e < 0) continue;
    out ??= copy(tiff);
    out.fill(0, i, e);
    i = e - 1;
  }
  return out;
}

/**
 * Every preview in an EXIF block: the IFD1 thumbnail and JPEG previews in the MakerNote.
 * @param {Uint8Array} tiff @returns {{tiff: Uint8Array, dropped: string[]}|null}
 */
export function stripExifPreviews(tiff) {
  let out = stripExifThumbnail(tiff);
  const dropped = out ? ['EXIF thumbnail'] : [];
  const mn = stripMakerNotePreviews(out ?? tiff);
  if (mn) { out = mn; dropped.push('MakerNote preview (zeroed)'); }
  return out ? { tiff: out, dropped } : null;
}

/**
 * XMP previews (the image data of XMP_PREVIEWS): the properties are removed and the rest of the packet
 * is written back as it was. A packet pixmix cannot parse goes entirely when it seems to
 * hold one. `text` null: remove the packet.
 * @param {string} text @returns {{text: string|null, dropped: string[]}|null}
 */
export function stripXmpPreviews(text) {
  let doc;
  try {
    doc = new XmpPacket(text);
  } catch (err) {
    if (err?.code !== 'BAD_XMP') throw err;
    return XMP_PREVIEW_TEXT.test(text) ? { text: null, dropped: ['XMP (unreadable, and it seems to hold a preview image)'] } : null;
  }
  const removed = doc.remove(isXmpPreview);
  if (!removed.length) return null;
  return { text: doc.toString(), dropped: [`XMP preview (${[...new Set(removed)].join(', ')})`] };
}

/**
 * Whether an extended XMP payload (reassembled, see extendedXmpPreviews) holds a
 * preview image. Extended XMP is where Google's GImage:Data and GDepth:Data usually are.
 */
function extendedHasPreview(text) {
  try {
    return new XmpPacket(text).properties().some((p) => isXmpPreview(p.name));
  } catch (err) {
    if (err?.code !== 'BAD_XMP') throw err;
    return XMP_PREVIEW_TEXT.test(text);
  }
}

const EXT_SIG = 'http://ns.adobe.com/xmp/extension/\0';

/**
 * JPEG extended XMP segments (payloads: the APP1 data, signature included) whose packet
 * holds a preview image. They cannot be rewritten without a new MD5 GUID, so such a packet
 * goes entirely. @returns {Set<number>} indices into `payloads` to drop
 */
export function extendedXmpPreviews(payloads) {
  const byGuid = new Map();
  payloads.forEach((d, i) => {
    if (d.length < EXT_SIG.length + 40) return;
    const guid = String.fromCharCode(...d.subarray(EXT_SIG.length, EXT_SIG.length + 32));
    if (!byGuid.has(guid)) byGuid.set(guid, []);
    byGuid.get(guid).push(i);
  });
  const drop = new Set();
  for (const idx of byGuid.values()) {
    const parts = idx.map((i) => {
      const d = payloads[i], h = EXT_SIG.length + 32;
      return { at: ((d[h + 4] << 24) | (d[h + 5] << 16) | (d[h + 6] << 8) | d[h + 7]) >>> 0, data: d.subarray(h + 8) };
    }).sort((a, b) => a.at - b.at);
    const text = new TextDecoder().decode(concat(parts.map((p) => p.data)));
    if (extendedHasPreview(text)) for (const i of idx) drop.add(i);
  }
  return drop;
}

const IRB_SIG = 'Photoshop 3.0\0';
const MAX_IRB = 65533 - IRB_SIG.length;

/**
 * The 8BIM resources of an IRB stream (after the signature). `cut`: the last one runs past
 * the end (its segment continues in the next APP13 segment).
 */
function irbResources(b, pos = 0) {
  const list = [];
  let cut = false;
  while (pos + 12 <= b.length && startsWith(b.subarray(pos), '8BIM')) {
    const id = (b[pos + 4] << 8) | b[pos + 5];
    let p = pos + 6;
    const nameLen = b[p];
    p += 1 + nameLen + ((nameLen + 1) & 1);
    if (p + 4 > b.length) { cut = true; break; }
    const size = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
    if (p + 4 + size > b.length) cut = true;
    const end = Math.min(b.length, p + 4 + size + (size & 1));
    list.push({ id, start: pos, end });
    pos = end;
  }
  return { list, end: pos, cut };
}

/** Photoshop APP13 image resources: drops thumbnail resources 0x0409 / 0x040C. */
export function stripIrbThumbnails(payload) {
  if (!startsWith(payload, IRB_SIG)) return null;
  const { list, end } = irbResources(payload, IRB_SIG.length);
  if (!list.some((r) => r.id === 0x0409 || r.id === 0x040c)) return null;
  const keep = [payload.subarray(0, IRB_SIG.length), ...list.filter((r) => r.id !== 0x0409 && r.id !== 0x040c).map((r) => payload.subarray(r.start, r.end))];
  if (end < payload.length) keep.push(payload.subarray(end));
  return concat(keep);
}

/**
 * Photoshop image resources over several APP13 segments: writers split large resource
 * blocks at any byte, and readers join the segments, so a thumbnail can sit in a
 * continuation segment. When every segment holds whole resources they are edited one by
 * one; otherwise the joined stream is, and cut into segments again (never more than before).
 * @param {Uint8Array[]} payloads  the "Photoshop 3.0" APP13 payloads, in file order
 * @returns {Uint8Array[]|null}  the new payloads, or null when there was no thumbnail
 */
export function stripIrbThumbnailSegments(payloads) {
  const whole = payloads.every((d) => { const r = irbResources(d, IRB_SIG.length); return !r.cut && r.end === d.length; });
  if (payloads.length < 2 || whole) {
    let changed = false;
    const out = payloads.map((d) => { const s = stripIrbThumbnails(d); if (s) changed = true; return s ?? d; });
    return changed ? out : null;
  }
  const joined = concat([payloads[0].subarray(0, IRB_SIG.length), ...payloads.map((d) => d.subarray(IRB_SIG.length))]);
  const s = stripIrbThumbnails(joined);
  if (!s) return null;
  const sig = s.subarray(0, IRB_SIG.length), body = s.subarray(IRB_SIG.length);
  const out = [];
  for (let o = 0; o < body.length; o += MAX_IRB) out.push(concat([sig, body.subarray(o, o + MAX_IRB)]));
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

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}
