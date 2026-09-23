// JPEG in, JPEG out, losslessly: coefficients are shuffled per MCU in the DCT domain and
// re-entropy-coded; nothing is requantized. APPn/COM/DQT segments and the SOF payload are
// copied through unchanged. The scramble parameters go in an APP15 "pixmix\0" segment.
//
// What does change: Huffman tables are re-optimised, restart markers are dropped, and the
// scans are rewritten: baseline files as one baseline scan, progressive files as progressive
// scans with pixmix's own scan script (option `progressive` overrides either way).
//
// One catch: progressive AC scans only cover an image's real blocks, not the padding blocks
// of partial edge MCUs. Scrambling can move real content into those, so a scrambled file is
// only progressive when there is no such padding; the marker remembers that the original was
// progressive, and restoring writes progressive again (exactly: the original could not hold
// AC data in padding blocks either).

import { readSegments, writeSegments, isJpeg, isSof, isApp, startsWith, M } from './markers.js';
import { decodeFrame } from './decode.js';
import { assembleJpeg } from './encode.js';
import { applyMcuLayout, transformCount } from './transform.js';
import { computeGridLayout } from '../../core/layout.js';
import {
  makeParams, writeMarker, readMarker, checksEqual, PixmixError, WrongKeyError, MCU_TRANSFORMS, MCU_PROGRESSIVE,
} from '../../core/params.js';
import { readJpegMetadata } from '../../meta/jpeg.js';
import { readOrientation } from '../../meta/exif.js';
import { stripExifThumbnail, stripIrbThumbnails, stripJfifThumbnail } from '../../meta/thumbnails.js';

export { isJpeg };

const SIG = 'pixmix\0';
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

/** Everything that is kept verbatim, in order (drops coding segments and our marker). */
function headerSegments(segments) {
  return segments.filter((s) => !CODING.has(s.marker) && !isSof(s.marker) && !(s.marker === M.APP15 && startsWith(s.data, SIG)));
}

function parse(bytes) {
  const { segments, trailing } = readSegments(bytes);
  const frame = decodeFrame(segments);
  return { segments, trailing, frame };
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
export function sanitizeJpeg(bytes) {
  const { segments, trailing } = readSegments(bytes);
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
export function scrambleJpeg(bytes, { key, transforms = true, salt, mode, progressive } = {}) {
  if (mode && mode !== 'mcu') {
    throw new PixmixError(`JPEG output is scrambled per MCU; mode "${mode}" does not apply (use mode "mcu" or omit it)`, 'BAD_OPTION');
  }
  const { segments, frame } = parse(bytes);
  if (markerSegment(segments)) {
    throw new PixmixError('Image is already scrambled (decode it first, or use rekey)', 'ALREADY_SCRAMBLED');
  }
  const restoreProgressive = isProgressive(frame, progressive);
  const params = makeParams({ mode: 'mcu', transforms, progressive: restoreProgressive, salt });
  const layout = layoutFor(key, params, frame);
  const scrambled = applyMcuLayout(frame, layout, 'scramble');
  return assembleJpeg(headerSegments(segments), scrambled, {
    marker: markerPayload(params, layout.check),
    progressive: restoreProgressive && !hasPadding(frame),
  });
}

/** Full decode with the layout, for the browser reveal. */
export function unscrambleJpegDetailed(bytes, { key, progressive } = {}) {
  const { segments, frame } = parse(bytes);
  const marker = readMarkerFrom(segments);
  if (!marker) throw new PixmixError('Image carries no pixmix marker', 'NOT_SCRAMBLED');
  const layout = layoutFor(key, marker.params, frame, marker.check);
  const restored = applyMcuLayout(frame, layout, 'unscramble');
  const header = headerSegments(segments);
  return {
    layout,
    params: marker.params,
    segments: header,
    toJpeg: () => assembleJpeg(header, restored, {
      progressive: progressive === undefined || progressive === 'auto' ? !!(marker.params.block & MCU_PROGRESSIVE) : !!progressive,
    }),
  };
}

export function unscrambleJpeg(bytes, opts) {
  return unscrambleJpegDetailed(bytes, opts).toJpeg();
}

export function rekeyJpeg(bytes, { from, to, transforms, salt, mode, progressive } = {}) {
  if (mode && mode !== 'mcu') throw new PixmixError(`JPEG only supports mode "mcu"`, 'BAD_OPTION');
  const { segments, frame } = parse(bytes);
  const marker = readMarkerFrom(segments);
  if (!marker) throw new PixmixError('Image carries no pixmix marker', 'NOT_SCRAMBLED');
  const plain = applyMcuLayout(frame, layoutFor(from, marker.params, frame, marker.check), 'unscramble');
  const restoreProgressive = progressive === undefined || progressive === 'auto' ? !!(marker.params.block & MCU_PROGRESSIVE) : !!progressive;
  const params = makeParams({
    mode: 'mcu', transforms: transforms ?? !!(marker.params.block & MCU_TRANSFORMS), progressive: restoreProgressive, salt,
  });
  const layout = layoutFor(to, params, frame);
  return assembleJpeg(headerSegments(segments), applyMcuLayout(plain, layout, 'scramble'), {
    marker: markerPayload(params, layout.check), progressive: restoreProgressive && !hasPadding(frame),
  });
}

/** Cheap: parses segments only, no entropy decoding. */
export function inspectJpeg(bytes) {
  const { segments, trailing } = readSegments(bytes);
  const sof = segments.find((s) => isSof(s.marker));
  const marker = readMarkerFrom(segments);
  const meta = readJpegMetadata(bytes);
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
    metadata: ['exif', 'icc', 'xmp', 'density'].filter((k) => meta[k]),
    ...(meta.exif ? { orientation: readOrientation(meta.exif) } : {}),
    segments: segments.map((s) => ({ type: segmentName(s.marker), length: s.data.length + (s.ecs?.length ?? 0) })),
    trailingBytes: trailing.length,
  };
}
