// Applies a metadata policy (policy.js) to a file: PNG chunks, JPEG segments, JPEG XL boxes.
// Only metadata changes; image data, structure and pixmix's own chunks (marker, watermark,
// stash, JPEG XL jbrd) are copied as they are, so restoring stays exact. Nothing is
// rewritten unless the policy changes it: a block the policy leaves alone keeps its bytes.
//
// Unreadable metadata is never kept when the policy asks to change it: an EXIF, XMP or IPTC
// block pixmix cannot parse is removed instead (and the report says so), so that "remove the
// location" can not quietly leave it in.
//
// This module is also the lazily loaded browser chunk (dist/pixmix-metadata.mjs), so it
// imports nothing heavy. Everything is synchronous except JPEG XL files carrying JPEG
// reconstruction data, whose metadata lives partly inside the JPEG they rebuild (see
// applyMetadataAsync).

import { PixmixError } from '../core/params.js';
import { resolveLimits } from '../core/limits.js';
import { detectFormat } from '../formats/index.js';
import { readChunks, writeChunks } from '../formats/png/chunks.js';
import { inflateUpTo } from '../formats/png/zlib.js';
import { readSegments, writeSegments, startsWith, M } from '../formats/jpeg/markers.js';
import { readJxl, writeJxl, readJxlHeader } from '../formats/jxl/container.js';
import { loadJxlCodec } from '../formats/jxl/load.js';
import { exifTiff, unwrapBrob } from './jxl.js';
import { stripIrbThumbnails } from './thumbnails.js';
import { parseExif, writeExif, encodeEntry, settableTag, orientationOf } from './tiff.js';
import { tagName } from './exif-tags.js';
import { XmpPacket, emptyPacket } from './xmp.js';
import { describeIcc, isSrgbIcc, srgbProfile } from './icc.js';
import { editIptc, dropResources, COPY_RESOURCES } from './iptc.js';
import { normalizePolicy, removal, exifRemoval, touches } from './policy.js';
import { readPngText } from './read.js';

export { normalizePolicy, normalizeProfile, formatProfile, PRESETS, PRESET_NAMES, KINDS, GROUPS } from './policy.js';
export { readMetadata } from './read.js';

const utf8 = new TextEncoder(), fromUtf8 = new TextDecoder(), latin1 = new TextDecoder('latin1');
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
const EXIF_SIG = 'Exif\0\0';
const XMP_SIG = 'http://ns.adobe.com/xap/1.0/\0';
const XMP_EXT_SIG = 'http://ns.adobe.com/xmp/extension/\0';
const ICC_SIG = 'ICC_PROFILE\0';
const MAX_SEGMENT = 65533;

/**
 * What a policy did: `removed` and `set` list what changed (per kind, in file order),
 * `notes` what could not be done and why. Deterministic, so it can go in logs and headers.
 * @typedef {{policy: string, removed: string[], set: string[], notes: string[]}} MetadataReport
 */
function newReport(p) {
  return { policy: p.name, removed: [], set: [], notes: [] };
}
const note = (r, s) => { if (!r.notes.includes(s)) r.notes.push(s); };
const list = (names) => (names.length > 8 ? `${names.slice(0, 8).join(', ')}, … (${names.length})` : names.join(', '));

// Where the convenience fields go, per kind.
const CONVENIENCE = {
  artist: { exif: 'Artist', xmp: 'dc:creator', text: 'Author', iptc: 'By-line' },
  copyright: { exif: 'Copyright', xmp: 'dc:rights', text: 'Copyright', iptc: 'CopyrightNotice' },
  title: { exif: 'ImageTitle', xmp: 'dc:title', text: 'Title', iptc: 'ObjectName' },
  description: { exif: 'ImageDescription', xmp: 'dc:description', text: 'Description', iptc: 'Caption-Abstract' },
  software: { exif: 'Software', xmp: 'xmp:CreatorTool', text: 'Software' },
};
const convenience = (p, kind) => Object.entries(p.set.convenience).filter(([k]) => CONVENIENCE[k][kind]).map(([k, v]) => [CONVENIENCE[k][kind], v]);

// --- EXIF ----------------------------------------------------------------------------

/** EXIF tags to set: explicit ones win over the convenience fields. */
function exifSets(p, ctx) {
  const out = new Map();
  for (const [name, value] of convenience(p, 'exif')) { const info = settableTag(name); out.set(info.tag, { info, value }); }
  for (const e of p.set.exif) if (e.value !== null) out.set(e.info.tag, e);
  if (p.set.orientation) {
    if (ctx.format === 'jxl') note(ctx.report, 'orientation: JPEG XL keeps it in the codestream (EXIF Orientation is ignored there), so set.orientation does nothing');
    else out.set(0x0112, { info: settableTag('Orientation'), value: p.set.orientation });
  }
  return [...out.values()];
}

/**
 * @param {Uint8Array|null} tiff
 * @returns {{tiff: Uint8Array|null, changed: boolean}} tiff null: no EXIF (any more)
 */
function transformExif(tiff, p, ctx) {
  const r = ctx.report;
  const sets = exifSets(p, ctx);
  const strip = p.kinds.exif === 'strip';
  if (!tiff && !sets.length) return { tiff, changed: false };
  if (tiff && !strip && !sets.length && !touches(p, 'exif') && !ctx.stripThumbnails) return { tiff, changed: false };
  let exif = null;
  let changed = false;
  if (tiff) {
    try {
      exif = parseExif(tiff);
    } catch (err) {
      if (err?.code !== 'BAD_EXIF') throw err;
      r.removed.push(`EXIF (${err.message.replace(/^Unreadable EXIF: /, 'unreadable: ')})`);
      changed = true;
    }
  }
  exif ??= { le: true, ifds: { IFD0: [] }, subIfds: [], makerNoteOffset: null, warnings: [] };
  const ifdEntries = () => [...Object.entries(exif.ifds), ...exif.subIfds.map((s, k) => [`SubIFD${k}`, s])];

  if (strip && tiff && !changed) {
    const count = ifdEntries().reduce((n, [, l]) => n + l.length, 0);
    const o = orientationOf(exif);
    const keepO = p.kinds.orientation === 'keep' && ctx.format !== 'jxl' && o !== 1;
    exif = { le: exif.le, ifds: { IFD0: keepO ? exif.ifds.IFD0.filter((e) => e.tag === 0x0112) : [] }, subIfds: [], makerNoteOffset: null, warnings: [] };
    r.removed.push(keepO ? `EXIF (${count - 1} of ${count} tags; Orientation kept)` : `EXIF (${count} tags)`);
    changed = true;
  } else if (!strip) {
    // Tag by tag. IFD1 is the thumbnail: it goes when previews are stripped.
    const why = new Map();
    const dropped = (reason, name) => { if (!why.has(reason)) why.set(reason, []); why.get(reason).push(name); };
    if (exif.ifds.IFD1 && (ctx.stripThumbnails || p.groups.has('thumbnail'))) {
      delete exif.ifds.IFD1;
      dropped(p.groups.has('thumbnail') ? 'thumbnail' : 'embedded preview', 'IFD1 thumbnail');
    }
    for (const [ifd, entries] of ifdEntries()) {
      const keep = entries.filter((e) => {
        const reason = exifRemoval(p, ifd, e.tag, tagName(ifd, e.tag));
        if (reason) dropped(reason, ifd === 'IFD0' || ifd === 'Exif' ? tagName(ifd, e.tag) : `${ifd}:${tagName(ifd, e.tag)}`);
        return !reason;
      });
      if (keep.length === entries.length) continue;
      if (ifd.startsWith('SubIFD')) exif.subIfds[Number(ifd.slice(6))] = keep;
      else exif.ifds[ifd] = keep;
    }
    if (exif.ifds.GPS && !exif.ifds.GPS.length) delete exif.ifds.GPS;
    for (const [reason, names] of why) r.removed.push(`EXIF ${list(names)} (${reason})`);
    if (why.size) changed = true;
  }
  for (const { info, value } of sets) {
    const entry = encodeEntry(info, value, exif.le);
    const target = (exif.ifds[info.ifd] ??= []);
    const i = target.findIndex((e) => e.tag === info.tag);
    if (i >= 0 && sameEntry(target[i], entry)) continue;
    if (i >= 0) target[i] = entry; else target.push(entry);
    r.set.push(`EXIF ${info.name}`);
    changed = true;
  }
  if (!changed) return { tiff, changed: false };
  if (exif.warnings.length) note(r, `EXIF: dropped what could not be read (${list(exif.warnings)})`);
  if (!ifdEntries().some(([, l]) => l.length)) return { tiff: null, changed: true };
  const written = writeExif(exif);
  for (const n of written.notes) note(r, `EXIF: ${n}`);
  return { tiff: written.tiff, changed: true };
}

const sameEntry = (a, b) => a.type === b.type && a.count === b.count && a.data.length === b.data.length && a.data.every((v, i) => v === b.data[i]);

// --- XMP -----------------------------------------------------------------------------

/** @returns {{text: string|null, changed: boolean}} */
function transformXmp(text, p, ctx) {
  const r = ctx.report;
  const strip = p.kinds.xmp === 'strip';
  const explicit = p.set.xmp.filter((e) => e.value !== null);
  const conv = convenience(p, 'xmp');
  if (!text && !explicit.length && !p.set.xmpPacket) return { text, changed: false };
  if (text && !strip && !touches(p, 'xmp') && !conv.length && !explicit.length && !p.set.xmpPacket) return { text, changed: false };
  let doc = null, changed = false;
  if (text && strip) { r.removed.push('XMP'); changed = true; }
  else if (text) {
    try {
      doc = new XmpPacket(text);
    } catch (err) {
      if (err?.code !== 'BAD_XMP') throw err;
      r.removed.push(`XMP (${err.message.replace(/^Unreadable XMP: /, 'unreadable: ')})`);
      changed = true;
    }
  }
  if (doc) {
    const why = new Map();
    for (const name of doc.remove((n) => !!removal(p, 'xmp', n))) {
      const reason = removal(p, 'xmp', name);
      if (!why.has(reason)) why.set(reason, []);
      why.get(reason).push(name);
    }
    for (const [reason, names] of why) r.removed.push(`XMP ${list(names)} (${reason})`);
    if (why.size) changed = true;
  }
  if (p.set.xmpPacket) { doc = new XmpPacket(p.set.xmpPacket); r.set.push('XMP packet (replaced)'); changed = true; }
  // Convenience fields only go into a packet the file keeps; explicit ones create one.
  const sets = [...(doc ? conv : []), ...explicit.map((e) => [e.name, e.value])];
  const byName = new Map(sets);
  for (const [name, value] of byName) {
    doc ??= new XmpPacket(emptyPacket());
    const before = doc.properties().find((x) => x.name === name)?.value;
    if (JSON.stringify(before) === JSON.stringify(Array.isArray(value) ? value : wrap(name, value))) continue;
    doc.set(name, value);
    r.set.push(`XMP ${name}`);
    changed = true;
  }
  if (!changed) return { text, changed: false };
  if (!doc || (doc.empty && !p.set.xmpPacket)) return { text: null, changed: true };
  return { text: doc.toString(), changed: true };
}

// Array properties read back as lists; compare like with like.
const wrap = (name, value) => (['dc:creator', 'dc:rights', 'dc:title', 'dc:description', 'dc:subject', 'dc:contributor', 'dc:publisher', 'dc:date', 'xmpRights:UsageTerms'].includes(name) ? [value] : value);

// --- ICC -------------------------------------------------------------------------------

/**
 * @returns {{icc: Uint8Array|null|'srgb', changed: boolean}}  'srgb': tag as sRGB, the way
 *   the format does that best (PNG sRGB chunk, JPEG a compact profile, JPEG XL its enum)
 */
function transformIcc(icc, p, ctx) {
  const r = ctx.report;
  const desc = (x) => { const d = describeIcc(x); return d?.description ? `"${d.description}"` : 'unnamed'; };
  if (p.set.icc === 'srgb') {
    if ((icc && isSrgbIcc(icc) && ctx.format !== 'png') || (!icc && ctx.srgbTagged)) return { icc, changed: false };
    if (icc && !isSrgbIcc(icc)) note(r, `ICC profile ${desc(icc)} replaced by sRGB: pixels are not converted, so colours display differently`);
    r.set.push('ICC profile: sRGB');
    return { icc: 'srgb', changed: true };
  }
  if (!icc) return { icc, changed: false };
  if (p.kinds.icc === 'strip') {
    r.removed.push(`ICC profile (${desc(icc)})`);
    if (!isSrgbIcc(icc)) note(r, 'ICC profile removed: viewers now assume sRGB, so colours display differently (pixels are not converted)');
    return { icc: null, changed: true };
  }
  if (p.dropSrgbIcc && isSrgbIcc(icc)) {
    r.removed.push(`ICC profile (${desc(icc)}, plain sRGB: viewers assume it anyway)`);
    return { icc: null, changed: true };
  }
  return { icc, changed: false };
}

// --- PNG -----------------------------------------------------------------------------

const PNG_PROTECTED = new Set(['pmIx', 'pmWm', 'pmWs']);
const PNG_STRUCTURE = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'acTL', 'fcTL', 'fdAT']);
const PNG_COLOUR = new Set(['sRGB', 'gAMA', 'cHRM', 'cICP', 'mDCV', 'cLLI']);
const PNG_TEXT = new Set(['tEXt', 'zTXt', 'iTXt']);
// Chunks new ones go before: colour chunks must precede PLTE, everything precedes IDAT.
const PNG_BEFORE = new Set(['PLTE', 'tRNS', 'bKGD', 'hIST', 'sPLT', 'acTL', 'fcTL', 'IDAT', 'pmIx', 'pmWm']);
// ImageMagick keeps profiles it cannot map as hex dumps in text chunks.
const RAW_PROFILE = /^Raw profile type (exif|app1|xmp|icc|icm|iptc|8bim)$/i;
const RAW_KIND = { exif: 'exif', app1: 'exif', xmp: 'xmp', icc: 'icc', icm: 'icc', iptc: 'other', '8bim': 'other' };

/** tEXt when the text is Latin-1, else iTXt (UTF-8). */
function pngTextChunk(keyword, text) {
  const k = ascii(keyword);
  if (/^[\x00-\xff]*$/.test(text) && !text.includes('\0')) return { type: 'tEXt', data: concat(k, Uint8Array.of(0), ascii(text)) };
  return { type: 'iTXt', data: concat(k, Uint8Array.of(0, 0, 0, 0, 0), utf8.encode(text)) };
}
const xmpChunk = (text) => ({ type: 'iTXt', data: concat(ascii('XML:com.adobe.xmp'), Uint8Array.of(0, 0, 0, 0, 0), utf8.encode(text)) });

function classifyPng(c, maxBytes) {
  if (PNG_PROTECTED.has(c.type)) return { kind: 'protected' };
  if (PNG_STRUCTURE.has(c.type)) return { kind: 'structure' };
  if (c.type === 'eXIf') return { kind: 'exif' };
  if (c.type === 'iCCP') return { kind: 'icc' };
  if (c.type === 'pHYs') return { kind: 'density' };
  if (PNG_COLOUR.has(c.type)) return { kind: 'colour' };
  if (PNG_TEXT.has(c.type)) {
    const nul = c.data.indexOf(0);
    const keyword = nul > 0 ? latin1.decode(c.data.subarray(0, nul)) : '';
    if (keyword === 'XML:com.adobe.xmp') return { kind: 'xmp' };
    const raw = RAW_PROFILE.exec(keyword);
    if (raw) return { kind: RAW_KIND[raw[1].toLowerCase()], raw: keyword };
    return { kind: 'text', keyword, lazy: () => readPngText(c.type, c.data, maxBytes) };
  }
  if (c.type.charCodeAt(0) < 97) return { kind: 'structure' }; // unknown critical chunk: needed to decode
  return { kind: 'other' };
}

function applyPng(bytes, p, ctx) {
  const r = ctx.report;
  const { maxMetadataBytes } = resolveLimits(ctx.limits);
  const chunks = readChunks(bytes, ctx.limits);
  const info = chunks.map((c) => classifyPng(c, maxMetadataBytes));
  const out = chunks.map((c) => c); // null: removed
  const extra = []; // new chunks, inserted before the image data
  let changed = false;
  const drop = (i) => { out[i] = null; changed = true; };
  const first = (kind) => info.findIndex((x, i) => x.kind === kind && !x.raw && out[i]);

  // Raw profiles in text chunks cannot be edited: they go with their kind, or when it changes.
  info.forEach((x, i) => {
    if (!x.raw) return;
    const kindChanges = p.kinds[x.kind] === 'strip' || (x.kind === 'other' ? touches(p, 'iptc') || touches(p, 'other') : touches(p, x.kind));
    if (kindChanges) { drop(i); r.removed.push(`text chunk "${x.raw}" (${x.kind === 'other' ? 'IPTC/Photoshop' : x.kind.toUpperCase()} profile pixmix cannot edit)`); }
  });

  // EXIF: the first eXIf chunk (the spec allows one).
  const ei = first('exif');
  const exif = transformExif(ei >= 0 ? chunks[ei].data : null, p, ctx);
  if (exif.changed) {
    info.forEach((x, i) => { if (x.kind === 'exif' && !x.raw && i !== ei) drop(i); });
    if (exif.tiff && ei >= 0) out[ei] = { type: 'eXIf', data: exif.tiff };
    else if (exif.tiff) extra.push({ type: 'eXIf', data: exif.tiff });
    else if (ei >= 0) drop(ei);
    changed = true;
  }

  // XMP: the iTXt XML:com.adobe.xmp chunk.
  const xi = first('xmp');
  const xmpText = xi >= 0 ? readPngText(chunks[xi].type, chunks[xi].data, maxMetadataBytes)?.text ?? '' : null;
  const xmp = transformXmp(xmpText, p, ctx);
  if (xmp.changed) {
    info.forEach((x, i) => { if (x.kind === 'xmp' && !x.raw && i !== xi) drop(i); });
    if (xmp.text !== null && xi >= 0) out[xi] = xmpChunk(xmp.text);
    else if (xmp.text !== null) extra.push(xmpChunk(xmp.text));
    else if (xi >= 0) drop(xi);
    changed = true;
  }

  // ICC. sRGB is the sRGB chunk (plus gAMA for old decoders), replacing any colour chunks.
  const ci = first('icc');
  let icc = null;
  if (ci >= 0) {
    const d = chunks[ci].data, nul = d.indexOf(0);
    try {
      const inflated = nul > 0 ? inflateUpTo(d.subarray(nul + 2), maxMetadataBytes) : null;
      if (inflated?.length && !inflated.more) icc = inflated;
    } catch { /* corrupt: a profile pixmix cannot read */ }
  }
  ctx.srgbTagged = ci < 0 && chunks.some((c) => c.type === 'sRGB') && !chunks.some((c) => c.type === 'cICP');
  const iccOut = transformIcc(icc, p, ctx);
  if (ci >= 0 && !icc && p.kinds.icc === 'strip') { drop(ci); r.removed.push('ICC profile (unreadable)'); }
  if (iccOut.changed) {
    if (ci >= 0) drop(ci);
    if (iccOut.icc === 'srgb') {
      const replaced = [];
      info.forEach((x, i) => { if (x.kind === 'colour' && out[i]) { replaced.push(chunks[i].type); drop(i); } });
      if (replaced.length) r.removed.push(`colour chunks ${replaced.join(', ')} (replaced by sRGB)`);
      extra.push({ type: 'sRGB', data: Uint8Array.of(0) }, { type: 'gAMA', data: Uint8Array.of(0, 0, 0xb1, 0x8f) });
    }
  }

  // Colour chunks, density, text, other.
  const colourRemoved = [];
  info.forEach((x, i) => {
    if (!out[i]) return;
    const type = chunks[i].type;
    if (x.kind === 'colour' && p.kinds.colour === 'strip') { colourRemoved.push(type); drop(i); }
    else if (x.kind === 'density' && p.kinds.density === 'strip') { r.removed.push('density (pHYs)'); drop(i); }
    else if (x.kind === 'other') {
      const reason = p.kinds.other === 'strip' ? 'other' : removal(p, 'other', type);
      if (reason) { r.removed.push(`chunk ${type} (${reason})`); drop(i); }
    }
  });
  if (colourRemoved.length) r.removed.push(`colour chunks ${colourRemoved.join(', ')}`);
  if (applyPngText(chunks, info, out, extra, p, ctx)) changed = true;

  if (!changed && !extra.length) return bytes;
  const at = chunks.findIndex((c) => PNG_BEFORE.has(c.type));
  const result = [];
  out.forEach((c, i) => {
    if (i === at) result.push(...extra);
    if (c) result.push(c);
  });
  return writeChunks(result);
}

/**
 * Text chunks: strip, removals, set.text and the convenience fields (the first chunk with a
 * keyword is replaced in place, later ones dropped), set.comment (replaces every comment).
 */
function applyPngText(chunks, info, out, extra, p, ctx) {
  const r = ctx.report;
  let changed = false;
  const sets = new Map(); // keyword -> text
  if (p.kinds.text === 'keep') for (const [kw, v] of convenience(p, 'text')) sets.set(kw, v);
  for (const e of p.set.text) if (e.text !== null) sets.set(e.keyword, e.text);
  const comments = p.set.comments;
  const removed = new Map(), placed = new Set(), oldComments = [];
  info.forEach((x, i) => {
    if (x.kind !== 'text' || !out[i]) return;
    const kw = x.keyword;
    if (kw === 'Comment' && comments) { oldComments.push(i); return; }
    if (sets.has(kw)) {
      if (placed.has(kw)) { out[i] = null; changed = true; return; }
      placed.add(kw);
      if (x.lazy()?.text === sets.get(kw)) return;
      out[i] = pngTextChunk(kw, sets.get(kw));
      r.set.push(`text ${kw}`);
      changed = true;
      return;
    }
    const reason = p.kinds.text === 'strip' ? 'text' : removal(p, 'text', kw);
    if (!reason) return;
    if (!removed.has(reason)) removed.set(reason, []);
    if (!removed.get(reason).includes(kw)) removed.get(reason).push(kw);
    out[i] = null;
    changed = true;
  });
  for (const [kw, text] of sets) {
    if (placed.has(kw)) continue;
    extra.push(pngTextChunk(kw, text));
    r.set.push(`text ${kw}`);
    changed = true;
  }
  if (comments) {
    const same = oldComments.length === comments.length && oldComments.every((i, k) => info[i].lazy()?.text === comments[k]);
    if (!same) {
      for (const i of oldComments) out[i] = null;
      extra.push(...comments.map((c) => pngTextChunk('Comment', c)));
      r.set.push(`text Comment${comments.length > 1 ? ` (${comments.length})` : ''}`);
      changed = true;
    }
  }
  for (const [reason, kws] of removed) r.removed.push(`text ${list(kws)} (${reason})`);
  return changed;
}

// --- JPEG ------------------------------------------------------------------------------

const APP_NAMES = [['JFXX\0', 'JFXX thumbnail'], ['MPF\0', 'MPF'], ['FPXR\0', 'FlashPix'], ['JP', 'JUMBF'], ['Ducky', 'Ducky'], ['Photoshop 3.0\0', 'Photoshop']];

function classifyJpeg(s) {
  const d = s.data, m = s.marker;
  if (m === M.APP15 && (startsWith(d, 'pixmix\0') || startsWith(d, 'pixmix-wm\0') || startsWith(d, 'pixmix-ws\0'))) return { kind: 'protected' };
  if (m === M.APP0 && startsWith(d, 'JFIF\0')) return { kind: 'jfif' };
  if (m === M.APP1 && startsWith(d, 'Exif\0')) return { kind: 'exif' };
  if (m === M.APP1 && startsWith(d, XMP_SIG)) return { kind: 'xmp' };
  if (m === M.APP1 && startsWith(d, XMP_EXT_SIG)) return { kind: 'xmp-ext' };
  if (m === M.APP2 && startsWith(d, ICC_SIG)) return { kind: 'icc' };
  if (m === 0xee && startsWith(d, 'Adobe')) return { kind: 'structure' }; // colour transform: needed to decode
  if (m === M.COM) return { kind: 'text' };
  if (m >= 0xe0 && m <= 0xef) {
    const type = `APP${m - 0xe0}`;
    const known = APP_NAMES.find(([sig]) => startsWith(d, sig));
    return { kind: 'other', type, label: known ? `${type} ${known[1]}` : type };
  }
  return { kind: 'structure' };
}

function applyJpeg(bytes, p, ctx) {
  const r = ctx.report;
  const { segments, trailing } = readSegments(bytes, ctx.limits);
  const info = segments.map(classifyJpeg);
  const out = segments.map((s) => s);
  let changed = false;
  const drop = (i) => { out[i] = null; changed = true; };
  const first = (kind) => info.findIndex((x) => x.kind === kind);
  // New APPn segments: EXIF right after SOI (or JFIF), the others after the last APPn.
  const afterJfif = info[0]?.kind === 'jfif' ? 1 : 0;
  let lastApp = -1;
  segments.forEach((s, i) => { if (s.marker >= 0xe0 && s.marker <= 0xef) lastApp = i; });
  const inserts = []; // [beforeIndex, segment]

  // EXIF
  const ei = first('exif');
  const exif = transformExif(ei >= 0 ? segments[ei].data.subarray(6) : null, p, ctx);
  if (exif.changed) {
    info.forEach((x, i) => { if (x.kind === 'exif' && i !== ei) drop(i); });
    let seg = exif.tiff && { marker: M.APP1, data: concat(ascii(EXIF_SIG), exif.tiff) };
    if (seg && seg.data.length > MAX_SEGMENT) { note(r, 'EXIF larger than a JPEG segment: removed'); seg = null; }
    if (seg && ei >= 0) out[ei] = seg;
    else if (seg) inserts.push([afterJfif, seg]);
    else if (ei >= 0) drop(ei);
    changed = true;
  }

  // XMP (extended XMP is not rewritten: it goes when the main packet changes)
  const xi = first('xmp');
  const xmp = transformXmp(xi >= 0 ? fromUtf8.decode(segments[xi].data.subarray(XMP_SIG.length)) : null, p, ctx);
  if (xmp.changed) {
    let ext = 0;
    info.forEach((x, i) => { if ((x.kind === 'xmp' && i !== xi) || x.kind === 'xmp-ext') { if (x.kind === 'xmp-ext') ext++; drop(i); } });
    if (ext) r.removed.push(`extended XMP (${ext} segment${ext > 1 ? 's' : ''}: not rewritten, so it goes with the packet it extends)`);
    let seg = xmp.text !== null && { marker: M.APP1, data: concat(ascii(XMP_SIG), utf8.encode(xmp.text)) };
    if (seg && seg.data.length > MAX_SEGMENT) { note(r, 'XMP larger than a JPEG segment: removed'); seg = null; }
    if (seg && xi >= 0) out[xi] = seg;
    else if (seg) inserts.push([Math.max(afterJfif, ei + 1), seg]);
    else if (xi >= 0) drop(xi);
    changed = true;
  } else if (xi < 0 && info.some((x) => x.kind === 'xmp-ext') && (p.kinds.xmp === 'strip' || touches(p, 'xmp'))) {
    info.forEach((x, i) => { if (x.kind === 'xmp-ext') drop(i); });
    r.removed.push('extended XMP (without its main packet)');
  }

  // ICC, possibly split over several APP2 segments.
  const parts = info.map((x, i) => (x.kind === 'icc' ? i : -1)).filter((i) => i >= 0);
  let icc = null;
  if (parts.length) {
    const ordered = parts.map((i) => segments[i].data).filter((d) => d.length > ICC_SIG.length + 2).sort((a, b) => a[ICC_SIG.length] - b[ICC_SIG.length]);
    icc = concat(...ordered.map((d) => d.subarray(ICC_SIG.length + 2)));
  }
  const iccOut = transformIcc(icc, p, ctx);
  if (iccOut.changed) {
    for (const i of parts) drop(i);
    if (iccOut.icc === 'srgb') {
      const prof = srgbProfile();
      inserts.push([parts.length ? parts[0] : lastApp + 1, { marker: M.APP2, data: concat(ascii(ICC_SIG), Uint8Array.of(1, 1), prof) }]);
    }
  }

  // Density: JFIF back to "no units, 1:1".
  const ji = first('jfif');
  if (ji >= 0 && p.kinds.density === 'strip') {
    const d = segments[ji].data;
    if (d.length >= 12 && !(d[7] === 0 && d[8] === 0 && d[9] === 1 && d[10] === 0 && d[11] === 1)) {
      const nd = d.slice();
      nd.set([0, 0, 1, 0, 1], 7);
      out[ji] = { ...segments[ji], data: nd };
      r.removed.push('density (JFIF)');
      changed = true;
    }
  }

  // Comments.
  const coms = info.map((x, i) => (x.kind === 'text' ? i : -1)).filter((i) => i >= 0);
  const comReason = p.kinds.text === 'strip' ? 'text' : removal(p, 'text', 'Comment');
  if (p.set.comments) {
    const want = p.set.comments.map((c) => ({ marker: M.COM, data: utf8.encode(c).subarray(0, MAX_SEGMENT) }));
    const same = coms.length === want.length && coms.every((i, k) => segments[i].data.length === want[k].data.length && segments[i].data.every((v, j) => v === want[k].data[j]));
    if (!same) {
      for (const i of coms) drop(i);
      inserts.push([coms.length ? coms[0] : lastApp + 1, ...want]);
      r.set.push(`comment${want.length > 1 ? `s (${want.length})` : ''}`);
    }
  } else if (coms.length && comReason) {
    for (const i of coms) drop(i);
    r.removed.push(`comment${coms.length > 1 ? `s (${coms.length})` : ''} (${comReason})`);
  }
  const textSets = p.set.text.filter((e) => e.text !== null);
  if (textSets.length) note(r, `text ${textSets.map((e) => e.keyword).join(', ')}: JPEG has no keyword text (only comments, see set.comment)`);

  // Other APPn segments, Photoshop/IPTC among them.
  const iptcReplace = Object.fromEntries(convenience(p, 'iptc'));
  const dropCopies = touches(p, 'exif') || touches(p, 'xmp');
  info.forEach((x, i) => {
    if (x.kind !== 'other' || !out[i]) return;
    const reason = p.kinds.other === 'strip' ? 'other'
      : removal(p, 'other', x.type) ?? (x.label === `${x.type} JFXX thumbnail` && p.groups.has('thumbnail') ? 'thumbnail' : null)
        ?? (x.label === 'APP2 MPF' && p.groups.has('thumbnail') ? 'thumbnail' : null);
    if (reason) { r.removed.push(`${x.label} (${reason})`); drop(i); return; }
    if (x.label !== 'APP13 Photoshop') return;
    let data = segments[i].data;
    if (p.groups.has('thumbnail')) {
      const s = stripIrbThumbnails(data);
      if (s) { data = s; r.removed.push('Photoshop thumbnail (thumbnail)'); }
    }
    if (touches(p, 'iptc') || Object.keys(iptcReplace).length) {
      const edited = editIptc(data, (name) => !!removal(p, 'iptc', name), iptcReplace);
      if (!edited) { r.removed.push('APP13 Photoshop (unreadable IPTC)'); drop(i); return; }
      const why = new Map();
      for (const name of edited.removed) { const w = removal(p, 'iptc', name); if (!why.has(w)) why.set(w, []); why.get(w).push(name); }
      for (const [w, names] of why) r.removed.push(`IPTC ${list(names)} (${w})`);
      for (const name of edited.replaced) r.set.push(`IPTC ${name}`);
      data = edited.payload;
    }
    if (dropCopies) {
      const d = dropResources(data, Object.keys(COPY_RESOURCES).map(Number));
      if (d?.removed.length) { data = d.payload; r.removed.push(`Photoshop ${[...new Set(d.removed.map((id) => COPY_RESOURCES[id]))].join(', ')} (cannot be cleaned)`); }
    }
    if (data !== segments[i].data) {
      if (data.length > MAX_SEGMENT) { r.removed.push('APP13 Photoshop (too large once edited)'); drop(i); return; }
      out[i] = { ...segments[i], data };
      changed = true;
    }
  });
  let tail = trailing;
  if (trailing.length && p.groups.has('thumbnail')) { tail = new Uint8Array(0); r.removed.push(`${trailing.length} bytes after the image (thumbnail)`); changed = true; }

  if (!changed && !inserts.length) return bytes;
  const result = [];
  const at = new Map();
  for (const [i, ...segs] of inserts) at.set(i, [...(at.get(i) ?? []), ...segs]);
  out.forEach((s, i) => {
    if (at.has(i)) result.push(...at.get(i));
    if (s) result.push(s);
  });
  if (at.has(out.length)) result.push(...at.get(out.length));
  return writeSegments(result, tail);
}

// --- JPEG XL -------------------------------------------------------------------------

const JXL_STRUCTURE = new Set(['ftyp', 'jxlc', 'jxlp', 'jxli', 'jxll', 'jbrd', 'jhgm', 'JXL ']);
const JXL_PROTECTED = new Set(['pmIx', 'pmWm', 'pmWs']);
const exifBox = (tiff) => ({ type: 'Exif', data: concat(new Uint8Array(4), tiff) });

/**
 * Metadata boxes of a JPEG XL: EXIF, XMP, JUMBF and unknown ones (Brotli-compressed ones
 * are unwrapped where the runtime can, and written back uncompressed when they change).
 * `icc` is the codestream's profile when the caller re-encodes (pixel route), else
 * undefined: then an ICC change can only be reported as impossible.
 * @returns {{boxes: import('../formats/jxl/container.js').Box[], icc?: Uint8Array|null, changed: boolean}}
 */
function applyJxlBoxes(boxes, icc, p, ctx) {
  const r = ctx.report;
  const out = boxes.map((b) => b);
  let changed = false;
  const inner = boxes.map((b) => {
    if (b.type !== 'brob') return { type: b.type, data: b.data };
    const u = unwrapBrob(b.data, ctx.limits);
    return { type: u.type, data: u.data, compressed: true, corrupt: u.corrupt };
  });
  const kindOf = (t) => (JXL_PROTECTED.has(t) ? 'protected' : JXL_STRUCTURE.has(t) ? 'structure' : t === 'Exif' ? 'exif' : t === 'xml ' ? 'xmp' : 'other');
  const pending = [];

  for (const [kind, transform, box, read] of [
    ['exif', transformExif, exifBox, (d) => (d.length > 4 ? exifTiff(d) : null)],
    ['xmp', transformXmp, (t) => ({ type: 'xml ', data: utf8.encode(t) }), (d) => fromUtf8.decode(d)],
  ]) {
    const idx = inner.map((b, i) => (kindOf(b.type) === kind ? i : -1)).filter((i) => i >= 0);
    const i0 = idx[0] ?? -1;
    // A compressed box this runtime cannot open: kept as it is unless the policy needs it.
    if (i0 >= 0 && !inner[i0].data) {
      if (p.kinds[kind] === 'strip' || touches(p, kind)) {
        for (const i of idx) out[i] = null;
        r.removed.push(`${kind === 'exif' ? 'EXIF' : 'XMP'} (Brotli-compressed, ${inner[i0].corrupt ? 'corrupt' : 'cannot be read here'})`);
        changed = true;
      }
      continue;
    }
    let value = null;
    try { value = i0 >= 0 ? read(inner[i0].data) : null; } catch { value = null; }
    const res = transform(value, p, ctx);
    if (!res.changed) continue;
    for (const i of idx) out[i] = null;
    const next = kind === 'exif' ? res.tiff : res.text;
    if (next !== null) (i0 >= 0 ? (out[i0] = box(next)) : pending.push(box(next)));
    changed = true;
  }

  inner.forEach((b, i) => {
    if (!out[i] || kindOf(b.type) !== 'other') return;
    const t = b.type.trim();
    const reason = p.kinds.other === 'strip' ? 'other' : removal(p, 'other', t);
    if (reason) { r.removed.push(`box ${t}${b.compressed ? ' (compressed)' : ''} (${reason})`); out[i] = null; changed = true; }
  });
  if (p.set.comments || p.set.text.some((e) => e.text !== null)) note(r, 'text and comments: JPEG XL has no place for them');

  let iccOut = icc;
  if (icc !== undefined) {
    ctx.srgbTagged = icc === null;
    const t = transformIcc(icc, p, ctx);
    if (t.changed) { iccOut = t.icc === 'srgb' ? null : t.icc; changed = true; }
  } else if (p.kinds.icc === 'strip' || p.set.icc || p.dropSrgbIcc) {
    if (ctx.codestreamIcc) note(r, 'ICC profile: it lives in the JPEG XL codestream and cannot change without re-encoding (encode, decode and rekey re-encode; convert does not)');
  }
  return { boxes: [...out.filter(Boolean), ...pending], icc: iccOut, changed };
}

function applyJxlFile(bytes, p, ctx) {
  const { container, boxes, codestream } = readJxl(bytes, ctx.limits);
  let header = null;
  try { header = readJxlHeader(codestream, ctx.limits); } catch (err) { if (err?.code === 'LIMIT') throw err; }
  ctx.codestreamIcc = header?.srgb !== true;
  const meta = boxes.filter((b) => b.type !== 'ftyp' && b.type !== 'jxlc' && b.type !== 'jxlp');
  const res = applyJxlBoxes(meta, undefined, p, ctx);
  if (!res.changed) return bytes;
  let kept = res.boxes;
  const jbrd = kept.some((b) => b.type === 'jbrd');
  if (jbrd) {
    kept = kept.filter((b) => b.type !== 'jbrd');
    ctx.report.removed.push('JPEG reconstruction data (it no longer matches the metadata)');
  }
  if (!container && !kept.length) return bytes;
  return writeJxl(kept, codestream);
}

// --- entry points ------------------------------------------------------------------------

/**
 * @typedef {object} ApplyOptions
 * @property {Partial<import('../core/limits.js').Limits>} [limits]
 * @property {boolean} [stripThumbnails=false]  drop an EXIF IFD1 thumbnail whenever EXIF is
 *           rewritten (the encoder's default; decoding keeps what the file has)
 */

/**
 * Applies a policy to a PNG, JPEG or JPEG XL file (JPEG XL at the box level: see
 * applyMetadataAsync for files holding JPEG reconstruction data).
 * @param {Uint8Array} bytes @param {object|string} policy @param {ApplyOptions} [opts]
 * @returns {{bytes: Uint8Array, report: MetadataReport}}  `bytes` is the input itself when
 *   nothing changed
 */
export function applyMetadata(bytes, policy, { limits, stripThumbnails = false } = {}) {
  const p = normalizePolicy(policy);
  const report = newReport(p);
  if (p.noop) return { bytes, report };
  const format = detectFormat(bytes);
  const ctx = { report, limits, stripThumbnails, format };
  if (format === 'png') return { bytes: applyPng(bytes, p, ctx), report };
  if (format === 'jpeg') return { bytes: applyJpeg(bytes, p, ctx), report };
  if (format === 'jxl') return { bytes: applyJxlFile(bytes, p, ctx), report };
  throw new PixmixError(`Metadata policies apply to PNG, JPEG and JPEG XL, not ${format ? format.toUpperCase() : 'this format'}`, 'UNSUPPORTED');
}

/**
 * applyMetadata, except that a JPEG XL made from a JPEG (with reconstruction data) is
 * handled through that JPEG: rebuilt, edited, and recompressed losslessly, so it stays a
 * recompressed JPEG and everything (ICC and comments included) can change. When the JPEG
 * cannot be rebuilt, the boxes are edited and the reconstruction data dropped.
 */
export async function applyMetadataAsync(bytes, policy, opts = {}) {
  const p = normalizePolicy(policy);
  if (p.noop || detectFormat(bytes) !== 'jxl') return applyMetadata(bytes, p, opts);
  const { boxes } = readJxl(bytes, opts.limits);
  if (!boxes.some((b) => b.type === 'jbrd')) return applyMetadata(bytes, p, opts);
  const codec = await loadJxlCodec();
  let jpeg = null;
  try { jpeg = await codec.reconstructJpeg(bytes, { limits: opts.limits }); } catch (err) { if (err?.code === 'LIMIT') throw err; }
  if (!jpeg) return applyMetadata(bytes, p, opts);
  const report = newReport(p);
  const edited = applyJpeg(jpeg, p, { report, limits: opts.limits, stripThumbnails: !!opts.stripThumbnails, format: 'jpeg' });
  if (edited === jpeg) return { bytes, report };
  // Boxes that did not come from the JPEG (pixmix's own, unknown ones) are carried over.
  const rebuilt = readJxl(await codec.transcodeJpeg(edited));
  const own = boxes.filter((b) => JXL_PROTECTED.has(b.type) || !['ftyp', 'jxlc', 'jxlp', 'jbrd', 'Exif', 'xml ', 'jumb', 'brob', 'jxll', 'jxli'].includes(b.type));
  const kept = applyJxlBoxes(own, undefined, p, { report, limits: opts.limits, format: 'jxl' }).boxes;
  return { bytes: writeJxl([...rebuilt.boxes.filter((b) => b.type !== 'ftyp' && b.type !== 'jxlc' && b.type !== 'jxlp'), ...kept], rebuilt.codestream), report };
}

/**
 * For the pixel route, which encodes the codestream itself: applies a policy to the metadata
 * boxes and to the ICC profile the pixels will be tagged with (null = sRGB).
 * @param {{boxes: import('../formats/jxl/container.js').Box[], icc: Uint8Array|null}} parts
 * @returns {{boxes: import('../formats/jxl/container.js').Box[], icc: Uint8Array|null, report: MetadataReport}}
 */
export function applyJxlParts({ boxes, icc }, policy, { limits, stripThumbnails = false } = {}) {
  const p = normalizePolicy(policy);
  const report = newReport(p);
  if (p.noop) return { boxes, icc, report };
  const res = applyJxlBoxes(boxes, icc ?? null, p, { report, limits, stripThumbnails, format: 'jxl' });
  return { boxes: res.boxes, icc: res.icc, report };
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}
