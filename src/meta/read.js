// A file's metadata, parsed for people (inspect({ metadata: true }), the lab, the CLI):
// EXIF tags by name, XMP properties, the ICC profile's description, text chunks and
// comments, IPTC datasets, and every other chunk, segment or box by type. It reads the
// same blocks apply.js edits, with the same kinds, so what it lists is what policies see.

import { resolveLimits } from '../core/limits.js';
import { detectFormat } from '../formats/index.js';
import { readChunks } from '../formats/png/chunks.js';
import { inflateUpTo } from '../formats/png/zlib.js';
import { readSegments, startsWith, M } from '../formats/jpeg/markers.js';
import { readJxl, readJxlHeader } from '../formats/jxl/container.js';
import { exifTiff, unwrapBrob } from './jxl.js';
import { parseExif, entryValue, orientationOf } from './tiff.js';
import { tagName, TYPES } from './exif-tags.js';
import { XmpPacket } from './xmp.js';
import { describeIcc } from './icc.js';
import { readIptc } from './iptc.js';
import { PixmixError } from '../core/params.js';

const utf8 = new TextDecoder(), latin1 = new TextDecoder('latin1');
const MAX_TEXT = 2000;
const cut = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);

/**
 * @typedef {object} MetadataInfo
 * @property {string} format
 * @property {{byteOrder: 'II'|'MM', bytes: number, tags: {ifd: string, tag: string, name: string, type: string, value: *}[],
 *   thumbnail: number|null, warnings: string[]}|{bytes: number, error: string}|null} exif
 * @property {{bytes: number, properties: {name: string, value: *}[], extended?: number}|{bytes: number, error: string}|null} xmp
 * @property {object|null} icc      describeIcc() plus `source`; JPEG XL: {source: 'codestream', srgb}
 * @property {{type: string, value: *}[]} colour   PNG sRGB, gAMA, cHRM, cICP, …
 * @property {{keyword: string, text: string, type: string}[]} text  PNG text chunks, JPEG comments
 * @property {{x: number, y: number, unit: string}|null} density
 * @property {number} orientation  EXIF (JPEG XL: the codestream's)
 * @property {{name: string, value: string}[]|null} iptc
 * @property {{type: string, label?: string, bytes: number, value?: string}[]} other
 * @property {string[]} pixmix     pixmix's own chunks (marker, watermark, stash)
 */

/** @param {Uint8Array} bytes @param {{limits?: object}} [opts] @returns {MetadataInfo} */
export function readMetadata(bytes, { limits } = {}) {
  const format = detectFormat(bytes);
  const out = { format, exif: null, xmp: null, icc: null, colour: [], text: [], density: null, orientation: 1, iptc: null, other: [], pixmix: [] };
  const { maxMetadataBytes } = resolveLimits(limits);
  const inflate = (d) => { try { const o = inflateUpTo(d, maxMetadataBytes); return o.more ? null : o; } catch { return null; } };
  if (format === 'png') readPng(bytes, out, limits, inflate, maxMetadataBytes);
  else if (format === 'jpeg') readJpeg(bytes, out, limits);
  else if (format === 'jxl') readJxlFile(bytes, out, limits);
  return out;
}

function exifInfo(tiff) {
  try {
    const e = parseExif(tiff);
    const tags = [];
    const add = (ifd, list) => {
      for (const en of list) {
        tags.push({ ifd, tag: `0x${en.tag.toString(16).padStart(4, '0')}`, name: tagName(ifd, en.tag), type: TYPES[en.type][0], value: en.blobs ? { bytes: en.blobs.reduce((n, b) => n + b.length, 0) } : entryValue(ifd, en, e.le) });
      }
    };
    for (const [ifd, list] of Object.entries(e.ifds)) add(ifd, list);
    e.subIfds.forEach((s, k) => add(`SubIFD${k}`, s));
    const thumb = e.ifds.IFD1?.find((x) => x.tag === 0x0201)?.blobs?.[0]?.length ?? null;
    return { info: { byteOrder: e.le ? 'II' : 'MM', bytes: tiff.length, tags, thumbnail: thumb, warnings: e.warnings }, orientation: orientationOf(e) };
  } catch (err) {
    if (err?.code !== 'BAD_EXIF') throw err;
    return { info: { bytes: tiff.length, error: err.message }, orientation: 1 };
  }
}

function xmpInfo(text) {
  try {
    const doc = new XmpPacket(text);
    return { bytes: text.length, properties: doc.properties().map(({ name, value }) => ({ name, value: typeof value === 'string' ? cut(value) : value })) };
  } catch (err) {
    if (err?.code !== 'BAD_XMP') throw err;
    return { bytes: text.length, error: err.message };
  }
}

const iccInfo = (icc, source) => (describeIcc(icc) ? { ...describeIcc(icc), source } : { bytes: icc.length, source, error: 'not an ICC profile' });

function readPng(bytes, out, limits, inflate, maxBytes) {
  for (const c of readChunks(bytes, limits)) {
    const { type, data } = c;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (type === 'pmIx' || type === 'pmWm' || type === 'pmWs') out.pixmix.push(type);
    else if (type === 'eXIf' && !out.exif) {
      const e = exifInfo(data);
      out.exif = e.info;
      out.orientation = e.orientation;
    } else if (type === 'iCCP' && !out.icc) {
      const nul = data.indexOf(0);
      const icc = nul > 0 ? inflate(data.subarray(nul + 2)) : null;
      out.icc = icc ? iccInfo(icc, 'iCCP') : { bytes: data.length, source: 'iCCP', error: 'corrupt' };
    } else if (type === 'pHYs' && data.length === 9) {
      out.density = { x: dv.getUint32(0), y: dv.getUint32(4), unit: data[8] === 1 ? 'meter' : 'none' };
    } else if (type === 'sRGB' && data.length === 1) out.colour.push({ type, value: ['perceptual', 'relative colorimetric', 'saturation', 'absolute colorimetric'][data[0]] ?? data[0] });
    else if (type === 'gAMA' && data.length === 4) out.colour.push({ type, value: dv.getUint32(0) / 100000 });
    else if (type === 'cHRM' && data.length === 32) out.colour.push({ type, value: Array.from({ length: 8 }, (_, i) => dv.getUint32(4 * i) / 100000) });
    else if (type === 'cICP' && data.length === 4) out.colour.push({ type, value: { primaries: data[0], transfer: data[1], matrix: data[2], fullRange: !!data[3] } });
    else if (type === 'mDCV' || type === 'cLLI') out.colour.push({ type, value: { bytes: data.length } });
    else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const t = readPngText(type, data, maxBytes);
      if (t?.keyword === 'XML:com.adobe.xmp') { if (!out.xmp) out.xmp = xmpInfo(t.text); }
      else if (t) out.text.push({ keyword: t.keyword, text: cut(t.text), type });
      else out.text.push({ keyword: latin1.decode(data.subarray(0, Math.max(0, data.indexOf(0)))), text: '', type, error: 'unreadable' });
    } else if (type === 'tIME' && data.length === 7) {
      const p2 = (n) => String(n).padStart(2, '0');
      out.other.push({ type, bytes: 7, value: `${dv.getUint16(0)}-${p2(data[2])}-${p2(data[3])} ${p2(data[4])}:${p2(data[5])}:${p2(data[6])} UTC` });
    } else if (!['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'acTL', 'fcTL', 'fdAT', 'eXIf', 'iCCP'].includes(type) && type.charCodeAt(0) >= 97) {
      out.other.push({ type, label: type === 'caBX' ? 'caBX C2PA manifest' : type, bytes: data.length });
    }
  }
}

function readJpeg(bytes, out, limits) {
  const { segments, trailing } = readSegments(bytes, limits);
  const iccParts = [];
  let ext = 0;
  for (const s of segments) {
    const d = s.data, m = s.marker;
    if (m === M.APP15 && (startsWith(d, 'pixmix\0') || startsWith(d, 'pixmix-wm\0') || startsWith(d, 'pixmix-ws\0'))) out.pixmix.push(`APP15 ${latin1.decode(d.subarray(0, d.indexOf(0)))}`);
    else if (m === M.APP0 && startsWith(d, 'JFIF\0') && d.length >= 12) {
      const x = (d[8] << 8) | d[9], y = (d[10] << 8) | d[11];
      if (x && y && !(d[7] === 0 && x === 1 && y === 1)) out.density = { x, y, unit: ['none', 'dpi', 'dpcm'][d[7]] ?? 'none' };
    } else if (m === M.APP1 && startsWith(d, 'Exif\0') && !out.exif) {
      const e = exifInfo(d.subarray(6));
      out.exif = e.info;
      out.orientation = e.orientation;
    } else if (m === M.APP1 && startsWith(d, 'http://ns.adobe.com/xap/1.0/\0') && !out.xmp) out.xmp = xmpInfo(utf8.decode(d.subarray(29)));
    else if (m === M.APP1 && startsWith(d, 'http://ns.adobe.com/xmp/extension/\0')) ext++;
    else if (m === M.APP2 && startsWith(d, 'ICC_PROFILE\0') && d.length > 14) iccParts.push(d);
    else if (m === M.COM) out.text.push({ keyword: 'Comment', text: cut(decodeComment(d)), type: 'COM' });
    else if (m >= 0xe0 && m <= 0xef && !(m === 0xee && startsWith(d, 'Adobe')) && !(m === M.APP0 && startsWith(d, 'JFIF\0'))) {
      const type = `APP${m - 0xe0}`;
      const label = [['JFXX\0', 'JFXX thumbnail'], ['MPF\0', 'MPF'], ['FPXR\0', 'FlashPix'], ['JP', 'JUMBF'], ['Ducky', 'Ducky'], ['Photoshop 3.0\0', 'Photoshop'], ['Exif\0', 'EXIF (another copy)'], ['http', 'XMP (another copy)']]
        .find(([sig]) => startsWith(d, sig))?.[1];
      out.other.push({ type, label: label ? `${type} ${label}` : type, bytes: d.length });
      if (label === 'Photoshop') out.iptc ??= readIptc(d);
    }
  }
  if (ext && out.xmp) out.xmp.extended = ext;
  if (iccParts.length) {
    iccParts.sort((a, b) => a[12] - b[12]);
    const n = iccParts.reduce((k, p) => k + p.length - 14, 0);
    const icc = new Uint8Array(n);
    let o = 0;
    for (const p of iccParts) { icc.set(p.subarray(14), o); o += p.length - 14; }
    out.icc = iccInfo(icc, 'APP2');
  }
  if (trailing.length) out.other.push({ type: 'trailing', label: 'data after the image', bytes: trailing.length });
}

/** A PNG text chunk's keyword and text (null when unreadable; over the limit throws). */
export function readPngText(type, data, maxBytes) {
  const nul = data.indexOf(0);
  if (nul < 1 || nul > 79) return null;
  const keyword = latin1.decode(data.subarray(0, nul));
  const inflate = (d) => {
    const out = inflateUpTo(d, maxBytes);
    if (out.more) throw new PixmixError(`A ${type} chunk inflates to more than the metadata limit`, 'LIMIT');
    return out;
  };
  try {
    if (type === 'tEXt') return { keyword, text: latin1.decode(data.subarray(nul + 1)) };
    if (type === 'zTXt') return { keyword, text: latin1.decode(inflate(data.subarray(nul + 2))), compressed: true };
    const compressed = data[nul + 1] === 1;
    const lang = data.indexOf(0, nul + 3);
    const trans = lang < 0 ? -1 : data.indexOf(0, lang + 1);
    if (trans < 0) return null;
    const body = data.subarray(trans + 1);
    return { keyword, text: utf8.decode(compressed ? inflate(body) : body), compressed, lang: latin1.decode(data.subarray(nul + 3, lang)) };
  } catch (err) {
    if (err?.code === 'LIMIT') throw err;
    return null;
  }
}

/** COM text: UTF-8 when it is valid UTF-8, else Latin-1. */
function decodeComment(d) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(d); } catch { return latin1.decode(d); }
}

function readJxlFile(bytes, out, limits) {
  const { boxes, codestream } = readJxl(bytes, limits);
  try {
    const h = readJxlHeader(codestream, limits);
    out.orientation = h.orientation;
    out.icc = { source: 'codestream', srgb: h.srgb };
  } catch (err) { if (err?.code === 'LIMIT') throw err; }
  for (const b of boxes) {
    let { type, data } = b;
    let compressed = false;
    if (type === 'brob') {
      const u = unwrapBrob(data, limits);
      compressed = true;
      if (!u.data) { out.other.push({ type: `brob ${u.type.trim()}`, label: `compressed ${u.type.trim()} box (${u.corrupt ? 'corrupt' : 'cannot be read here'})`, bytes: data.length }); continue; }
      ({ type, data } = u);
    }
    if (type === 'pmIx' || type === 'pmWm' || type === 'pmWs') out.pixmix.push(type);
    else if (type === 'Exif' && !out.exif && data.length > 4) out.exif = exifInfo(exifTiff(data)).info;
    else if (type === 'xml ' && !out.xmp) out.xmp = xmpInfo(utf8.decode(data));
    else if (!['ftyp', 'jxlc', 'jxlp', 'jxli', 'jxll', 'Exif', 'xml '].includes(type)) {
      const labels = { jumb: 'JUMBF (e.g. C2PA)', jbrd: 'JPEG reconstruction data', jhgm: 'HDR gain map' };
      out.other.push({ type: type.trim(), label: `${type.trim()}${labels[type] ? ` ${labels[type]}` : ''}${compressed ? ' (compressed)' : ''}`, bytes: data.length });
    }
  }
}
