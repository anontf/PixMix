// TIFF-structured EXIF: parsed into IFDs of entries, and written back with every offset
// recomputed. Values stay raw bytes, so unknown tags survive untouched; only what a policy
// sets is encoded, and only what it removes is gone.
//
// Structure the writer rebuilds rather than copies: the Exif, GPS and Interop IFD pointers,
// IFD0's SubIFDs, and the data that offset tags point to (the IFD1 thumbnail, strips,
// tiles). The MakerNote is opaque vendor data, often holding offsets from the start of the
// TIFF header, so it is put back at its original offset whenever the new layout leaves room
// (it usually does, since policies only shrink EXIF); otherwise it moves and the writer says
// so. Anything unreadable in hostile input (out-of-range values, unknown types, loops) is
// skipped with a warning; only a missing header or IFD0 makes parsing fail.

import { PixmixError } from '../core/params.js';
import {
  TYPES, TYPE, POINTER_TAGS, SUBIFDS_TAG, OFFSET_PAIRS, MAKER_NOTE, VERSION_TAGS, XP_TAGS, tagInfo, tagName, tagByName,
} from './exif-tags.js';

const MAX_SUBIFDS = 16;
const utf8 = new TextDecoder();
const latin1 = new TextDecoder('latin1');
const bad = (message) => new PixmixError(`Unreadable EXIF: ${message}`, 'BAD_EXIF');

/**
 * @typedef {{tag: number, type: number, count: number, data: Uint8Array, blobs?: Uint8Array[]}} Entry
 *   data: the value in the Exif's byte order. blobs: for offset tags (thumbnail, strips,
 *   tiles), the data they point to; their offsets are written anew.
 * @typedef {object} Exif
 * @property {boolean} le            little-endian ("II")
 * @property {{IFD0: Entry[], Exif?: Entry[], GPS?: Entry[], Interop?: Entry[], IFD1?: Entry[]}} ifds
 * @property {Entry[][]} subIfds     IFD0's SubIFDs (DNG-style), without their own sub-IFDs
 * @property {number|null} makerNoteOffset  where the MakerNote's value was
 * @property {string[]} warnings     what was skipped
 */

/** @param {Uint8Array} tiff @returns {Exif} */
export function parseExif(tiff) {
  if (!(tiff?.length >= 8)) throw bad('too short');
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!le && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) throw bad('no TIFF byte order mark');
  const dv = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
  if (u16(2) !== 42) throw bad('not a TIFF header');
  const len = tiff.length;
  const warnings = [];
  const visited = new Set();
  const out = { le, ifds: {}, subIfds: [], makerNoteOffset: null, warnings };

  // Reads one IFD: its entries (value bytes located) and the next-IFD offset.
  const readIfd = (o, name) => {
    if (o < 8 || o + 2 > len || visited.has(o)) {
      warnings.push(`${name} ${visited.has(o) ? 'loops back' : 'lies outside the data'}`);
      return null;
    }
    visited.add(o);
    let n = u16(o);
    if (o + 2 + 12 * n > len) { n = Math.floor((len - o - 2) / 12); warnings.push(`${name} is truncated`); }
    const entries = [], seen = new Set();
    for (let i = 0; i < n; i++) {
      const e = o + 2 + 12 * i;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const t = TYPES[type];
      if (!t) { warnings.push(`${name} ${tagName(name, tag)}: unknown type ${type}`); continue; }
      const size = t[1] * count;
      let at = e + 8;
      if (size > 4) at = u32(e + 8);
      if (at + size > len) { warnings.push(`${name} ${tagName(name, tag)}: value outside the data`); continue; }
      if (seen.has(tag)) { warnings.push(`${name} ${tagName(name, tag)}: duplicate`); continue; }
      seen.add(tag);
      if (tag === MAKER_NOTE && name === 'Exif' && size > 4) out.makerNoteOffset = at;
      entries.push({ tag, type, count, data: tiff.subarray(at, at + size) });
    }
    const end = o + 2 + 12 * n;
    return { entries, next: end + 4 <= len ? u32(end) : 0 };
  };

  const num = (entry, i) => {
    const d = new DataView(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength);
    if (entry.type === TYPE.SHORT) return d.getUint16(i * 2, le);
    if (entry.type === TYPE.LONG || entry.type === TYPE.IFD) return d.getUint32(i * 4, le);
    return null;
  };
  // Takes a pointer tag out of an IFD's entries and reads the IFD it points to.
  const follow = (entries, tag, name) => {
    const i = entries.findIndex((e) => e.tag === tag);
    if (i < 0) return null;
    const [ptr] = entries.splice(i, 1);
    const at = ptr.count === 1 ? num(ptr, 0) : null;
    if (at === null) { warnings.push(`${name} pointer is not an offset`); return null; }
    const ifd = readIfd(at, name);
    return ifd && withBlobs(ifd.entries, name);
  };
  // Offset tags: the data they point to becomes the entry's blobs.
  const withBlobs = (entries, name) => {
    for (const [offTag, lenTag] of OFFSET_PAIRS) {
      const oi = entries.findIndex((e) => e.tag === offTag), li = entries.findIndex((e) => e.tag === lenTag);
      if (oi < 0 && li < 0) continue;
      const off = entries[oi], lens = entries[li];
      let blobs = null;
      if (off && lens && off.count === lens.count && off.count <= 4096 && num(off, 0) !== null && num(lens, 0) !== null) {
        blobs = [];
        for (let k = 0; k < off.count && blobs; k++) {
          const a = num(off, k), n = num(lens, k);
          if (a + n > len) blobs = null;
          else blobs.push(tiff.subarray(a, a + n));
        }
      }
      if (!blobs) {
        warnings.push(`${name} ${tagName(name, offTag)}: data outside the EXIF, dropped`);
        for (const t of [offTag, lenTag]) { const k = entries.findIndex((e) => e.tag === t); if (k >= 0) entries.splice(k, 1); }
      } else off.blobs = blobs;
    }
    return entries;
  };

  const ifd0 = readIfd(u32(4), 'IFD0');
  if (!ifd0) throw bad('IFD0 lies outside the data');
  out.ifds.IFD0 = ifd0.entries;
  const exif = follow(ifd0.entries, 0x8769, 'Exif');
  if (exif) {
    out.ifds.Exif = exif;
    const interop = follow(exif, 0xa005, 'Interop');
    if (interop) out.ifds.Interop = interop;
  }
  const gps = follow(ifd0.entries, 0x8825, 'GPS');
  if (gps) out.ifds.GPS = gps;
  const si = ifd0.entries.findIndex((e) => e.tag === SUBIFDS_TAG);
  if (si >= 0) {
    const [ptr] = ifd0.entries.splice(si, 1);
    for (let k = 0; k < Math.min(ptr.count, MAX_SUBIFDS); k++) {
      const at = num(ptr, k);
      const ifd = at === null ? null : readIfd(at, `SubIFD${k}`);
      if (ifd) out.subIfds.push(withBlobs(ifd.entries, `SubIFD${k}`));
    }
    if (ptr.count > MAX_SUBIFDS) warnings.push(`more than ${MAX_SUBIFDS} SubIFDs`);
  }
  withBlobs(ifd0.entries, 'IFD0');
  if (ifd0.next) {
    const ifd1 = readIfd(ifd0.next, 'IFD1');
    if (ifd1) {
      out.ifds.IFD1 = withBlobs(ifd1.entries, 'IFD1');
      if (ifd1.next) warnings.push('IFDs after IFD1 dropped');
    }
  }
  return out;
}

const elementSize = (type) => (type === TYPE.RATIONAL || type === TYPE.SRATIONAL ? 4 : TYPES[type][1]);

/** Value bytes in the other byte order. */
function swapped(type, data) {
  const es = elementSize(type);
  if (es === 1) return data;
  const out = new Uint8Array(data.length);
  for (let i = 0; i + es <= data.length; i += es) for (let k = 0; k < es; k++) out[i + k] = data[i + es - 1 - k];
  return out;
}

/**
 * TIFF bytes for an Exif model (see parseExif), in its own byte order unless `le` says
 * otherwise. Entries are sorted by tag, values word-aligned.
 * @param {Exif} exif @param {{le?: boolean}} [opts]
 * @returns {{tiff: Uint8Array, notes: string[]}}
 */
export function writeExif(exif, { le = exif.le } = {}) {
  const notes = [];
  const some = (list) => (list?.length ? list : null);
  const interop = some(exif.ifds.Interop);
  const exifIfd = some(exif.ifds.Exif) ?? (interop ? [] : null);
  const gps = some(exif.ifds.GPS);
  const subs = (exif.subIfds ?? []).filter((s) => s.length);
  const ifd1 = some(exif.ifds.IFD1);
  const conv = (e) => (le === exif.le || e.tag === MAKER_NOTE ? e.data : swapped(e.type, e.data));

  // Each IFD: its entries plus the pointers the layout fills in ({ptr: 'Exif'} etc.).
  const ptr = (tag, to, count = 1) => ({ tag, type: TYPE.LONG, count, ptr: to });
  const blocks = [];
  const block = (name, entries, extra) => {
    const all = [...entries.map((e) => ({ ...e, data: conv(e) })), ...extra].sort((a, b) => a.tag - b.tag);
    const b = { name, entries: all };
    blocks.push(b);
    return b;
  };
  const b0 = block('IFD0', exif.ifds.IFD0 ?? [], [
    ...(exifIfd ? [ptr(0x8769, 'Exif')] : []), ...(gps ? [ptr(0x8825, 'GPS')] : []),
    ...(subs.length ? [ptr(SUBIFDS_TAG, 'SubIFDs', subs.length)] : []),
  ]);
  if (exifIfd) block('Exif', exifIfd, interop ? [ptr(0xa005, 'Interop')] : []);
  if (interop) block('Interop', interop, []);
  if (gps) block('GPS', gps, []);
  subs.forEach((s, k) => block(`SubIFD${k}`, s, []));
  const b1 = ifd1 ? block('IFD1', ifd1, []) : null;

  // Layout: each IFD, then its out-of-line values, then the data its offset tags locate.
  // The MakerNote goes back to its old offset as soon as the layout reaches it (the gap is
  // zero-filled), and only moves when what comes before it no longer fits.
  const valueSize = (e) => (e.ptr ? 4 * e.count : e.blobs ? 4 * e.count : e.data.length);
  const even = (n) => n + (n & 1);
  const makerNote = blocks.find((b) => b.name === 'Exif')?.entries.find((e) => e.tag === MAKER_NOTE && e.data.length > 4) ?? null;
  const pinned = exif.makerNoteOffset;
  const canPin = () => pinned !== null && pinned >= pos && pinned - pos < 1 << 20;
  let pos = 8;
  const place = (e) => { e.at = pos; pos = even(pos + e.data.length); };
  const alloc = (size) => {
    if (makerNote && makerNote.at === undefined && canPin() && pos + size > pinned) { pos = pinned; place(makerNote); }
    const at = pos;
    pos = even(pos + size);
    return at;
  };
  for (const b of blocks) {
    b.offset = alloc(2 + 12 * b.entries.length + 4);
    for (const e of b.entries) if (e !== makerNote && valueSize(e) > 4) e.at = alloc(valueSize(e));
    for (const e of b.entries) if (e.blobs) e.blobAt = e.blobs.map((d) => alloc(d.length));
  }
  if (makerNote && makerNote.at === undefined) {
    if (canPin()) pos = pinned;
    else if (pinned !== null && pinned !== pos) notes.push('MakerNote moved (vendor offsets inside it may no longer match)');
    place(makerNote);
  }

  const out = new Uint8Array(pos);
  const dv = new DataView(out.buffer);
  out[0] = out[1] = le ? 0x49 : 0x4d;
  dv.setUint16(2, 42, le);
  dv.setUint32(4, b0.offset, le);
  const offsetOf = (name) => blocks.find((b) => b.name === name).offset;
  for (const b of blocks) {
    dv.setUint16(b.offset, b.entries.length, le);
    b.entries.forEach((e, i) => {
      const o = b.offset + 2 + 12 * i;
      dv.setUint16(o, e.tag, le);
      dv.setUint16(o + 2, e.ptr || e.blobs ? TYPE.LONG : e.type, le);
      dv.setUint32(o + 4, e.count, le);
      let values = null;
      if (e.ptr === 'SubIFDs') values = subs.map((_, k) => offsetOf(`SubIFD${k}`));
      else if (e.ptr) values = [offsetOf(e.ptr)];
      else if (e.blobs) values = e.blobAt;
      if (values) {
        const at = values.length > 1 ? e.at : o + 8;
        values.forEach((v, k) => dv.setUint32(at + 4 * k, v, le));
        if (values.length > 1) dv.setUint32(o + 8, e.at, le);
        if (e.blobs) e.blobs.forEach((d, k) => out.set(d, e.blobAt[k]));
      } else if (e.data.length > 4) {
        dv.setUint32(o + 8, e.at, le);
        out.set(e.data, e.at);
      } else out.set(e.data, o + 8);
    });
    dv.setUint32(b.offset + 2 + 12 * b.entries.length, b === b0 && b1 ? b1.offset : 0, le);
  }
  return { tiff: out, notes };
}

// --- values ---------------------------------------------------------------------------

const MAX_SHOWN = 32;

/** A tag's value for display: text, a number, or a list of numbers (long ones cut short). */
export function entryValue(ifd, entry, le) {
  const { type, count, data, tag } = entry;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (type === TYPE.ASCII || type === TYPE['UTF-8']) return text(data);
  if (XP_TAGS.has(tag) && (ifd === 'IFD0' || ifd === 'IFD1') && (type === TYPE.BYTE || type === TYPE.UNDEFINED)) {
    let s = '';
    for (let i = 0; i + 1 < data.length; i += 2) s += String.fromCharCode(data[i] | (data[i + 1] << 8));
    return s.replace(/\0+$/, '');
  }
  if (type === TYPE.UNDEFINED) {
    if (isVersion(ifd, tag) && count === 4) return latin1.decode(data);
    if ((ifd === 'Exif' && tag === 0x9286) || (ifd === 'GPS' && (tag === 0x1b || tag === 0x1c))) return userComment(data, le);
    return { bytes: data.length };
  }
  const n = Math.min(count, MAX_SHOWN);
  const values = [];
  for (let i = 0; i < n; i++) {
    switch (type) {
      case TYPE.BYTE: values.push(data[i]); break;
      case TYPE.SBYTE: values.push(dv.getInt8(i)); break;
      case TYPE.SHORT: values.push(dv.getUint16(2 * i, le)); break;
      case TYPE.SSHORT: values.push(dv.getInt16(2 * i, le)); break;
      case TYPE.LONG: case TYPE.IFD: values.push(dv.getUint32(4 * i, le)); break;
      case TYPE.SLONG: values.push(dv.getInt32(4 * i, le)); break;
      case TYPE.FLOAT: values.push(dv.getFloat32(4 * i, le)); break;
      case TYPE.DOUBLE: values.push(dv.getFloat64(8 * i, le)); break;
      case TYPE.RATIONAL: values.push(ratio(dv.getUint32(8 * i, le), dv.getUint32(8 * i + 4, le))); break;
      case TYPE.SRATIONAL: values.push(ratio(dv.getInt32(8 * i, le), dv.getInt32(8 * i + 4, le))); break;
      default: return { bytes: data.length };
    }
  }
  if (count > MAX_SHOWN) values.push('…');
  return values.length === 1 ? values[0] : values;
}

const isVersion = (ifd, tag) => (ifd === 'Exif' && VERSION_TAGS.has(tag) && tag !== 2) || (ifd === 'Interop' && tag === 2);
const ratio = (n, d) => (d ? +(n / d).toPrecision(8) : n ? Infinity : 0);

function text(data) {
  let end = data.length;
  while (end > 0 && data[end - 1] === 0) end--;
  // Copyright may hold "photographer\0editor".
  return utf8.decode(data.subarray(0, end)).replace(/\0+/g, ' / ');
}

function userComment(data, le) {
  const code = latin1.decode(data.subarray(0, 8)).replace(/\0+$/, '');
  const body = data.subarray(8);
  if (code === 'UNICODE') {
    let s = '';
    for (let i = 0; i + 1 < body.length; i += 2) s += String.fromCharCode(le ? body[i] | (body[i + 1] << 8) : (body[i] << 8) | body[i + 1]);
    return s.replace(/\0+$/, '');
  }
  return text(body).trim();
}

/** The Orientation tag of IFD0 (1 when absent or unusable). */
export function orientationOf(exif) {
  const e = exif.ifds.IFD0?.find((x) => x.tag === 0x0112);
  const v = e && e.type === TYPE.SHORT && e.count >= 1 ? entryValue('IFD0', e, exif.le) : 1;
  return Number.isInteger(v) && v >= 1 && v <= 8 ? v : 1;
}

// --- writing values ---------------------------------------------------------------------

const DATE_TAGS = new Set(['DateTime', 'DateTimeOriginal', 'DateTimeDigitized']);
const SETTABLE_TYPES = new Set(['ASCII', 'SHORT', 'LONG', 'RATIONAL', 'SRATIONAL', 'BYTE', 'UNDEFINED']);

/**
 * Which tag a policy names (by EXIF name, case-insensitive) and whether it can be set.
 * Structure (pointers, offsets) and the MakerNote cannot.
 * @returns {{ifd: string, tag: number, name: string, type: string, count?: number}}
 */
export function settableTag(name) {
  const info = tagByName(name);
  if (!info) throw new PixmixError(`Unknown EXIF tag "${name}"`, 'BAD_METADATA');
  if (POINTER_TAGS[info.tag] || [SUBIFDS_TAG, MAKER_NOTE, 0x8773, 0x83bb, 0x02bc, 0xc634, 0xea1c].includes(info.tag)
    || OFFSET_PAIRS.flat().includes(info.tag) || !SETTABLE_TYPES.has(info.type) || info.ifd === 'Interop') {
    throw new PixmixError(`EXIF tag ${info.name} cannot be set`, 'BAD_METADATA');
  }
  return info;
}

/**
 * Encodes a value for a settable tag (see settableTag): text for ASCII tags (DateTime as
 * "YYYY:MM:DD HH:MM:SS"), integers for SHORT/LONG, numbers or "n/d" for rationals, text
 * for XP* and UserComment, and 4-character versions. Arrays for multi-value tags.
 * @returns {Entry}
 */
export function encodeEntry(info, value, le) {
  const fail = (why) => new PixmixError(`EXIF ${info.name}: ${why}`, 'BAD_METADATA');
  const list = Array.isArray(value) ? value : [value];
  if (info.count && info.type !== 'ASCII' && list.length !== info.count && !(XP_TAGS.has(info.tag) || info.type === 'UNDEFINED')) {
    throw fail(`needs ${info.count} value${info.count > 1 ? 's' : ''}`);
  }
  const put = (type, count, size, write) => {
    const data = new Uint8Array(size);
    write(new DataView(data.buffer));
    return { tag: info.tag, type: TYPE[type], count, data };
  };
  if (XP_TAGS.has(info.tag)) {
    if (typeof value !== 'string') throw fail('must be text');
    return put('BYTE', value.length * 2 + 2, value.length * 2 + 2, (d) => { for (let i = 0; i < value.length; i++) d.setUint16(2 * i, value.charCodeAt(i), true); });
  }
  switch (info.type) {
    case 'ASCII': {
      if (typeof value !== 'string') throw fail('must be text');
      if (DATE_TAGS.has(info.name) && !/^\d{4}:\d\d:\d\d \d\d:\d\d:\d\d$/.test(value)) throw fail('must look like "2024:01:31 12:00:00"');
      const bytes = new TextEncoder().encode(value);
      if (bytes.includes(0)) throw fail('must not contain NUL characters');
      const data = new Uint8Array(bytes.length + 1);
      data.set(bytes);
      return { tag: info.tag, type: TYPE.ASCII, count: data.length, data };
    }
    case 'SHORT': case 'LONG': case 'BYTE': {
      const max = info.type === 'SHORT' ? 0xffff : info.type === 'BYTE' ? 0xff : 0xffffffff;
      if (!list.length || !list.every((v) => Number.isInteger(v) && v >= 0 && v <= max)) throw fail(`must be integer${list.length > 1 ? 's' : ''} from 0 to ${max}`);
      if (info.tag === 0x0112 && !(list[0] >= 1 && list[0] <= 8)) throw fail('must be 1-8');
      const size = { SHORT: 2, LONG: 4, BYTE: 1 }[info.type];
      return put(info.type, list.length, list.length * size, (d) => list.forEach((v, i) => (size === 2 ? d.setUint16(2 * i, v, le) : size === 4 ? d.setUint32(4 * i, v, le) : d.setUint8(i, v))));
    }
    case 'RATIONAL': case 'SRATIONAL': {
      const signed = info.type === 'SRATIONAL';
      const pairs = list.map((v) => rational(v, signed));
      if (!pairs.length || pairs.some((p) => !p)) throw fail(`must be ${signed ? '' : 'non-negative '}numbers or "n/d"`);
      return put(info.type, pairs.length, 8 * pairs.length, (d) => pairs.forEach(([n, den], i) => {
        if (signed) { d.setInt32(8 * i, n, le); d.setInt32(8 * i + 4, den, le); } else { d.setUint32(8 * i, n, le); d.setUint32(8 * i + 4, den, le); }
      }));
    }
    case 'UNDEFINED': {
      if (typeof value !== 'string') throw fail('must be text');
      if (isVersion(info.ifd, info.tag)) {
        if (!/^\d{4}$/.test(value)) throw fail('must be 4 digits, like "0232"');
        return { tag: info.tag, type: TYPE.UNDEFINED, count: 4, data: Uint8Array.from(value, (c) => c.charCodeAt(0)) };
      }
      // UserComment and the like: an 8-byte character code, then the text.
      const ascii = /^[\x20-\x7e\n\t]*$/.test(value);
      const body = new Uint8Array(ascii ? value.length : value.length * 2);
      const dv = new DataView(body.buffer);
      for (let i = 0; i < value.length; i++) (ascii ? body[i] = value.charCodeAt(i) : dv.setUint16(2 * i, value.charCodeAt(i), le));
      const data = new Uint8Array(8 + body.length);
      data.set(Uint8Array.from(ascii ? 'ASCII\0\0\0' : 'UNICODE\0', (c) => c.charCodeAt(0)));
      data.set(body, 8);
      return { tag: info.tag, type: TYPE.UNDEFINED, count: data.length, data };
    }
    default: throw fail('cannot be set');
  }
}

/** [numerator, denominator] for a number or an "n/d" string, or null. */
function rational(v, signed) {
  if (typeof v === 'string') {
    const m = /^(-?\d+)\/(\d+)$/.exec(v.trim());
    if (!m) return null;
    const n = Number(m[1]), d = Number(m[2]);
    const lim = signed ? 2 ** 31 : 2 ** 32;
    if (!d || (!signed && n < 0) || Math.abs(n) >= lim || d >= lim) return null;
    return [n, d];
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || (!signed && v < 0)) return null;
  const lim = signed ? 2 ** 31 - 1 : 2 ** 32 - 1;
  if (Math.abs(v) > lim) return null;
  if (Number.isInteger(v)) return [v, 1];
  // Best fraction with a denominator up to 10^6 (continued fractions).
  let [h0, h1, k0, k1] = [0, 1, 1, 0];
  let x = Math.abs(v);
  for (let i = 0; i < 32; i++) {
    const a = Math.floor(x);
    const h2 = a * h1 + h0, k2 = a * k1 + k0;
    if (k2 > 1e6 || h2 > lim) break;
    [h0, h1, k0, k1] = [h1, h2, k1, k2];
    if (x - a < 1e-12) break;
    x = 1 / (x - a);
  }
  return [Math.sign(v) * h1, k1 || 1];
}

export { tagInfo, tagName };
