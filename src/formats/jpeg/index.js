// JPEG in, JPEG out, losslessly: coefficients are shuffled per MCU in the DCT domain and
// re-entropy-coded; nothing is requantized. APPn/COM/DQT segments and the SOF payload are
// copied through unchanged. The scramble parameters go in an APP15 "pixmix\0" segment.
//
// What does change: Huffman tables are re-optimised, restart markers are dropped, DQT
// segments that redefine a table between scans are merged into one (normalizeQuantTables:
// same image, other table ids), and the scans are rewritten: baseline files as one
// baseline scan, progressive files as progressive scans with pixmix's own scan script
// (option `progressive` overrides either way).
//
// One catch: progressive AC scans only cover an image's real blocks, not the padding blocks
// of partial edge MCUs. Scrambling can move real content into those, so a scrambled file is
// only progressive when there is no such padding; the marker remembers that the original was
// progressive, and restoring writes progressive again (exactly: the original could not hold
// AC data in padding blocks either).
//
// The same goes for frames whose MCU has more than 10 blocks (e.g. every component sampled
// 2x2): they can only be coded one scan per component, and such scans never hold padding
// blocks either. With partial edge MCUs there is nowhere to put the content scrambling
// moves into the padding, so those files are refused (UNSUPPORTED).
//
// Watermarks (see watermark/embed.js) travel in more APP15 segments: "pixmix-wm\0" names the
// watermark for the restored image, "pixmix-ws\0" (split over as many segments as it needs)
// holds the coefficients under a watermark drawn on the scrambled image.

import { readSegments, writeSegments, isJpeg, isSof, isApp, startsWith, M } from './markers.js';
import { decodeFrame, normalizeQuantTables } from './decode.js';
import { assembleJpeg, interleavable } from './encode.js';
import { applyMcuLayout, transformCount } from './transform.js';
import { computeGridLayout } from '../../core/layout.js';
import {
  makeParams, writeMarker, readMarker, checksEqual, PixmixError, WrongKeyError, MCU_TRANSFORMS, MCU_PROGRESSIVE,
} from '../../core/params.js';
import { checkPixels } from '../../core/limits.js';
import { readJpegMetadata } from '../../meta/jpeg.js';
import { readOrientation } from '../../meta/exif.js';
import { stripExifThumbnail, stripIrbThumbnails, stripJfifThumbnail } from '../../meta/thumbnails.js';
import { FLAG_STASH } from '../../core/params.js';
import { encodeWatermark, readCarried, keptWatermark, restoreJpegStash } from '../../watermark/embed.js';
import { stashJpeg } from '../../watermark/paint.js';
import { watermarkInfo, carriedFields } from '../png/index.js';

export { isJpeg };

const SIG = 'pixmix\0';
const WM_SIG = 'pixmix-wm\0';
const WS_SIG = 'pixmix-ws\0';
const WS_CHUNK = 65533 - WS_SIG.length - 2;
const ascii = (str) => Uint8Array.from(str, (c) => c.charCodeAt(0));
const NAMES = { 0xc0: 'SOF0', 0xc1: 'SOF1', 0xc2: 'SOF2', 0xc4: 'DHT', 0xda: 'SOS', 0xdb: 'DQT', 0xdd: 'DRI', 0xfe: 'COM' };
const segmentName = (m) => NAMES[m] ?? (isApp(m) ? `APP${m - 0xe0}` : `0x${m.toString(16)}`);
const CODING = new Set([M.DHT, M.DRI, M.SOS, M.DNL]);

function markerSegment(segments) {
  return segments.find((s) => s.marker === M.APP15 && startsWith(s.data, SIG)) ?? null;
}

/** The raw pixmix marker (without the APP15 signature) of a scrambled JPEG, or null. */
export function jpegMarkerBytes(bytes) {
  const seg = markerSegment(readSegments(bytes).segments);
  return seg ? seg.data.subarray(SIG.length) : null;
}

function readMarkerFrom(segments) {
  const seg = markerSegment(segments);
  return seg ? readMarker(seg.data.subarray(SIG.length)) : null;
}

const isOurs = (s) => s.marker === M.APP15 && (startsWith(s.data, SIG) || startsWith(s.data, WM_SIG) || startsWith(s.data, WS_SIG));

/** Everything that is kept verbatim, in order (drops coding segments and our segments). */
function headerSegments(segments) {
  return segments.filter((s) => !CODING.has(s.marker) && !isSof(s.marker) && !isOurs(s));
}

/**
 * The watermark a JPEG carries for its restored image, read tolerantly (see readCarried in
 * watermark/embed.js): {watermark: {id, name, compiled}|null, error, data}.
 */
export function jpegWatermark(segments, limits) {
  const seg = segments.find((s) => s.marker === M.APP15 && startsWith(s.data, WM_SIG));
  return readCarried(seg?.data.subarray(WM_SIG.length), limits);
}

function jpegOrientation(segments) {
  const app1 = segments.find((s) => s.marker === M.APP1 && startsWith(s.data, 'Exif\0\0'));
  return app1 ? readOrientation(app1.data.subarray(6)) : 1;
}

/** Our APP15 payloads for the watermark and the stash (numbered, 1-based, like ICC). */
function watermarkSegments(watermark, stash) {
  const out = [];
  if (watermark) out.push(concat(ascii(WM_SIG), encodeWatermark(watermark)));
  if (stash) {
    const count = Math.ceil(stash.length / WS_CHUNK);
    if (count > 255) throw new PixmixError('Visible watermark too large for a JPEG', 'BAD_WATERMARK');
    for (let i = 0; i < count; i++) out.push(concat(ascii(WS_SIG), Uint8Array.of(i + 1, count), stash.subarray(i * WS_CHUNK, (i + 1) * WS_CHUNK)));
  }
  return out;
}

function stashOf(segments) {
  const parts = segments.filter((s) => s.marker === M.APP15 && startsWith(s.data, WS_SIG)).map((s) => s.data.subarray(WS_SIG.length));
  if (!parts.length || parts.some((p, i) => p[0] !== i + 1 || p[1] !== parts.length)) {
    throw new PixmixError('Image lost the coefficients under its visible watermark (APP15 pixmix-ws)', 'BAD_JPEG');
  }
  return concat(...parts.map((p) => p.subarray(2)));
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Scrambled frame -> file: the marker, the watermark segments and, with a visible
 * watermark, the frame painted and its covered coefficients stashed.
 */
function finishScramble(segments, frame, params, check, { key, watermark, visibleWatermark, progressive }) {
  if (!interleavable(frame) && hasPadding(frame)) {
    throw new PixmixError(
      'JPEG with more than 10 blocks per MCU and partial edge MCUs cannot be scrambled losslessly (its scans cannot hold the padding blocks scrambling fills)',
      'UNSUPPORTED',
    );
  }
  let stash = null;
  if (visibleWatermark) {
    stash = stashJpeg(frame, segments, visibleWatermark, jpegOrientation(segments), key, params.salt);
    if (stash) params = { ...params, flags: FLAG_STASH };
  }
  return assembleJpeg(headerSegments(segments), frame, {
    marker: markerPayload(params, check),
    extra: watermarkSegments(watermark, stash),
    progressive,
  });
}

/** Checks the key, puts a visible watermark's stash back into the scrambled frame, unscrambles. */
function restoreFrame(segments, frame, marker, key, limits) {
  const layout = layoutFor(key, marker.params, frame, marker.check);
  let visible = null;
  if (marker.params.flags & FLAG_STASH) visible = restoreJpegStash(frame, stashOf(segments), key, marker.params.salt, limits);
  return { layout, visible, restored: applyMcuLayout(frame, layout, 'unscramble') };
}

function parse(bytes, limits) {
  const { segments, trailing } = readSegments(bytes, limits);
  return { ...normalizeQuantTables(segments, decodeFrame(segments, limits)), trailing };
}

function layoutFor(key, params, frame, expectedCheck) {
  const count = params.block & MCU_TRANSFORMS ? transformCount(frame) : 1;
  const layout = computeGridLayout(key, params, frame.mcusX, frame.mcusY, count);
  if (expectedCheck && !checksEqual(layout.check, expectedCheck)) throw new WrongKeyError();
  return {
    ...layout,
    cols: frame.mcusX,
    rows: frame.mcusY,
    tileW: 8 * frame.hmax,
    tileH: 8 * frame.vmax,
    width: frame.width,
    height: frame.height,
  };
}

const markerPayload = (params, check) => {
  const m = writeMarker(params, check);
  const out = new Uint8Array(SIG.length + m.length);
  for (let i = 0; i < SIG.length; i++) out[i] = SIG.charCodeAt(i);
  out.set(m, SIG.length);
  return out;
};

/**
 * Removes embedded previews and extra images that would show the unscrambled picture:
 * EXIF/JFIF/JFXX/Photoshop thumbnails, and MPF data or anything else after EOI (secondary
 * images, motion-photo video). The entropy-coded data is untouched.
 * @returns {{bytes: Uint8Array, dropped: string[]}}
 */
export function sanitizeJpeg(bytes, limits) {
  const { segments, trailing } = readSegments(bytes, limits);
  const dropped = [];
  const out = [];
  for (const seg of segments) {
    let data = seg.data;
    if (seg.marker === M.APP0 && startsWith(data, 'JFXX\0')) { dropped.push('JFXX thumbnail'); continue; }
    if (seg.marker === M.APP2 && startsWith(data, 'MPF\0')) { dropped.push('MPF index (secondary images)'); continue; }
    if (seg.marker === M.APP0) {
      const s = stripJfifThumbnail(data);
      if (s) { data = s; dropped.push('JFIF thumbnail'); }
    } else if (seg.marker === M.APP1 && startsWith(data, 'Exif\0\0')) {
      const s = stripExifThumbnail(data.subarray(6));
      if (s) {
        data = new Uint8Array(6 + s.length);
        data.set(seg.data.subarray(0, 6));
        data.set(s, 6);
        dropped.push('EXIF thumbnail');
      }
    } else if (seg.marker === M.APP13) {
      const s = stripIrbThumbnails(data);
      if (s) { data = s; dropped.push('Photoshop thumbnail'); }
    }
    out.push(data === seg.data ? seg : { ...seg, data });
  }
  if (trailing.length) dropped.push(`${trailing.length} bytes after the image (e.g. secondary images, motion-photo video)`);
  if (!dropped.length) return { bytes, dropped };
  return { bytes: writeSegments(out), dropped };
}

// 'auto' keeps the source's structure: progressive stays progressive, baseline baseline.
const isProgressive = (frame, progressive) => (progressive === 'auto' || progressive === undefined ? frame.marker === M.SOF2 : !!progressive);
const hasPadding = (frame) => frame.components.some((c) => c.realW < c.blocksW || c.realH < c.blocksH);

/**
 * @param {Uint8Array} bytes JPEG
 * @param {{key: string|Uint8Array, transforms?: boolean, salt?: Uint8Array, mode?: string, progressive?: boolean|'auto'}} opts
 */
export function scrambleJpeg(bytes, { key, transforms = true, salt, mode, progressive, limits, watermark, visibleWatermark } = {}) {
  if (mode && mode !== 'mcu') {
    throw new PixmixError(`JPEG output is scrambled per MCU; mode "${mode}" does not apply (use mode "mcu" or omit it)`, 'BAD_OPTION');
  }
  const { segments, frame } = parse(bytes, limits);
  if (markerSegment(segments)) {
    throw new PixmixError('Image is already scrambled (decode it first, or use rekey)', 'ALREADY_SCRAMBLED');
  }
  const restoreProgressive = isProgressive(frame, progressive);
  const params = makeParams({ mode: 'mcu', transforms, progressive: restoreProgressive, salt });
  const layout = layoutFor(key, params, frame);
  const scrambled = applyMcuLayout(frame, layout, 'scramble');
  return finishScramble(segments, scrambled, params, layout.check, {
    key, watermark, visibleWatermark, progressive: restoreProgressive && !hasPadding(frame),
  });
}

/** Full decode with the layout, for the browser reveal. */
export function unscrambleJpegDetailed(bytes, { key, progressive, limits } = {}) {
  const { segments, frame } = parse(bytes, limits);
  const marker = readMarkerFrom(segments);
  if (!marker) throw new PixmixError('Image carries no pixmix marker', 'NOT_SCRAMBLED');
  const { layout, restored } = restoreFrame(segments, frame, marker, key, limits);
  const header = headerSegments(segments);
  return {
    layout,
    params: marker.params,
    segments: header,
    ...carriedFields(jpegWatermark(segments, limits)),
    /** `paint` ({painter, watermark}): draw a watermark on the restored image. */
    toJpeg: (paint) => {
      let out = restored;
      if (paint?.watermark) {
        out = { ...restored, components: restored.components.map((c) => ({ ...c, coefs: c.coefs.slice() })) };
        paint.painter.paintJpegImage(out, header, paint.watermark, jpegOrientation(header), paint.limits ?? limits);
      }
      return assembleJpeg(header, out, {
        progressive: progressive === undefined || progressive === 'auto' ? !!(marker.params.block & MCU_PROGRESSIVE) : !!progressive,
      });
    },
  };
}

export function unscrambleJpeg(bytes, opts) {
  return unscrambleJpegDetailed(bytes, opts).toJpeg();
}

export function rekeyJpeg(bytes, { from, to, transforms, salt, mode, progressive, limits, watermark, visibleWatermark } = {}) {
  if (mode && mode !== 'mcu') throw new PixmixError(`JPEG only supports mode "mcu"`, 'BAD_OPTION');
  const { segments, frame } = parse(bytes, limits);
  const marker = readMarkerFrom(segments);
  if (!marker) throw new PixmixError('Image carries no pixmix marker', 'NOT_SCRAMBLED');
  const { restored: plain, visible } = restoreFrame(segments, frame, marker, from, limits);
  const restoreProgressive = progressive === undefined || progressive === 'auto' ? !!(marker.params.block & MCU_PROGRESSIVE) : !!progressive;
  const params = makeParams({
    mode: 'mcu', transforms: transforms ?? !!(marker.params.block & MCU_TRANSFORMS), progressive: restoreProgressive, salt,
  });
  const layout = layoutFor(to, params, frame);
  return finishScramble(segments, applyMcuLayout(plain, layout, 'scramble'), params, layout.check, {
    key: to,
    watermark: watermark === undefined ? keptWatermark(jpegWatermark(segments, limits)) : watermark,
    visibleWatermark: visibleWatermark === undefined ? visible?.() ?? null : visibleWatermark,
    progressive: restoreProgressive && !hasPadding(frame),
  });
}

/**
 * The same image as a clean JPEG (like jpegtran): explicit Huffman tables, no stray bytes,
 * truncated data zero-filled, redefined quantisation tables merged, baseline scans. For
 * pixel decoders that cannot read the original.
 */
export function rebuildJpeg(bytes, limits) {
  const { segments, frame } = parse(bytes, limits);
  return assembleJpeg(headerSegments(segments), frame);
}

/** Cheap: parses segments only, no entropy decoding. */
export function inspectJpeg(bytes, limits) {
  const { segments, trailing } = readSegments(bytes, limits);
  const sof = segments.find((s) => isSof(s.marker));
  const marker = readMarkerFrom(segments);
  const meta = readJpegMetadata(bytes);
  if (meta.width && meta.height) checkPixels(meta.width, meta.height, limits);
  const n = sof?.data[5] ?? 0;
  const comps = [];
  for (let i = 0; i < n; i++) comps.push(sof.data[7 + i * 3]);
  const hmax = n > 1 ? Math.max(...comps.map((b) => b >> 4)) : 1;
  const vmax = n > 1 ? Math.max(...comps.map((b) => b & 15)) : 1;
  return {
    format: 'jpeg',
    width: meta.width,
    height: meta.height,
    components: n,
    progressive: sof?.marker === M.SOF2,
    mcu: `${8 * hmax}x${8 * vmax}`,
    scrambled: !!marker,
    mode: marker ? 'mcu' : null,
    transforms: marker ? !!(marker.params.block & MCU_TRANSFORMS) : null,
    ...watermarkInfo(jpegWatermark(segments, limits), marker),
    metadata: ['exif', 'icc', 'xmp', 'density'].filter((k) => meta[k]),
    ...(meta.exif ? { orientation: readOrientation(meta.exif) } : {}),
    segments: segments.map((s) => ({ type: segmentName(s.marker), length: s.data.length + (s.ecs?.length ?? 0) })),
    trailingBytes: trailing.length,
  };
}
