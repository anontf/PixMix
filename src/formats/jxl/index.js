// JPEG XL in, JPEG XL out, two ways:
//
// - pixel route (mode pixel/block): pixels are decoded (8-bit sRGB RGBA), moved exactly
//   like PNG pixels, and encoded again LOSSLESSLY, so the key gives back exactly the pixels
//   the input decoded to. Metadata boxes (Exif, xml, jumb, brob, unknown) are copied through.
// - JPEG route (mode mcu): for JPEG sources. The JPEG is scrambled in the DCT domain (see
//   formats/jpeg) and then losslessly recompressed into JPEG XL, which stays lossy-small;
//   decoding reconstructs that JPEG bit for bit and unscrambles it. Recompressing needs
//   libjxl's cjxl, so creating these files (and restoring them to JPEG XL) is Node-only;
//   browsers can still reveal them, as the original JPEG.
//
// The scramble parameters go in a `pmIx` box (for the JPEG route, also in the JPEG's APP15
// segment, inside the reconstruction data). Everything here is async: the codec is WASM
// loaded on first use.

import { readJxl, writeJxl, readJxlHeader, isJxl } from './container.js';
import { loadJxlCodec } from './load.js';
import { computeLayout, applyMap } from '../../core/layout.js';
import { makeParams, writeMarker, readMarker, checksEqual, PixmixError, WrongKeyError } from '../../core/params.js';
import { stripExifThumbnail } from '../../meta/thumbnails.js';
import { exifTiff, unwrapBrob } from '../../meta/jxl.js';
import { scrambleJpeg, unscrambleJpegDetailed, rekeyJpeg, jpegMarkerBytes } from '../jpeg/index.js';

export { isJxl };
export const MARKER_BOX = 'pmIx';

// Container structure (rewritten), or data tied to the old codestream / showing the image.
const STRUCTURE = new Set(['JXL ', 'ftyp', 'jxlc', 'jxlp', 'jxli', 'jxll', MARKER_BOX]);
const STALE = {
  jbrd: 'JPEG reconstruction data (no longer matches the image)',
  jhgm: 'HDR gain map (a second image)',
};

/**
 * Metadata boxes to carry over, with EXIF thumbnails removed unless kept.
 * @returns {{boxes: import('./container.js').Box[], dropped: string[]}}
 */
export function sanitizeBoxes(boxes, { keepThumbnails = false } = {}) {
  const out = [], dropped = [];
  for (const box of boxes) {
    if (STRUCTURE.has(box.type)) continue;
    if (STALE[box.type]) { dropped.push(STALE[box.type]); continue; }
    if (keepThumbnails) { out.push(box); continue; }
    if (box.type === 'Exif' && box.data.length > 4) {
      const stripped = stripExifThumbnail(exifTiff(box.data));
      if (stripped) {
        out.push({ type: 'Exif', data: withOffset(stripped) });
        dropped.push('EXIF thumbnail');
        continue;
      }
    } else if (box.type === 'brob' && String.fromCharCode(...box.data.subarray(0, 4)) === 'Exif') {
      const inner = unwrapBrob(box.data);
      if (!inner.data) { dropped.push('compressed EXIF (cannot be checked for a thumbnail here)'); continue; }
      const stripped = stripExifThumbnail(exifTiff(inner.data));
      out.push(stripped ? { type: 'Exif', data: withOffset(stripped) } : box);
      if (stripped) dropped.push('EXIF thumbnail');
      continue;
    }
    out.push(box);
  }
  return { boxes: out, dropped };
}

function withOffset(tiff) {
  const d = new Uint8Array(4 + tiff.length);
  d.set(tiff, 4);
  return d;
}

/** What re-encoding a JXL input from its decoded pixels changes, for the report. */
export function reencodeNotes(header) {
  const notes = [];
  if (header.lossy) notes.push('lossy compression (re-encoded losslessly from the decoded pixels; the file grows)');
  if (header.animated) notes.push('animation (first frame kept)');
  if (header.bits > 8 || header.float) notes.push(`${header.float ? 'floating-point' : `${header.bits}-bit`} precision (reduced to 8-bit)`);
  if (header.srgb === false) notes.push('colour space (converted to sRGB)');
  return notes;
}

function readMarkerBox(boxes) {
  const box = boxes.find((b) => b.type === MARKER_BOX);
  return box ? readMarker(box.data) : null;
}

function layoutFor(key, params, width, height, expectedCheck) {
  const layout = computeLayout(key, params, width, height);
  if (expectedCheck && !checksEqual(layout.check, expectedCheck)) throw new WrongKeyError();
  return layout;
}

// Noise from pixel mode gains nothing from a slow effort; tiles still compress well.
const effortFor = (params, effort) => effort ?? (params.mode === 'pixel' ? 2 : 7);

/**
 * Scrambles already-decoded RGBA and writes a JXL around it.
 * @param {{width: number, height: number, data: Uint8Array}} image
 * @param {import('./container.js').Box[]} boxes metadata boxes to include
 */
export async function scrambleJxlPixels(image, boxes, { key, mode, block, salt, effort } = {}) {
  if (mode === 'mcu') throw new PixmixError('Mode "mcu" needs a JPEG source', 'BAD_OPTION');
  const params = makeParams({ mode, block, salt });
  const layout = layoutFor(key, params, image.width, image.height);
  const pixels = applyMap(image.data, layout.map, 4, 'scramble');
  const codec = await loadJxlCodec();
  const codestream = await codec.encode({ width: image.width, height: image.height, data: pixels }, { effort: effortFor(params, effort) });
  return writeJxl([...boxes, { type: MARKER_BOX, data: writeMarker(params, layout.check) }], codestream);
}

export async function scrambleJxl(bytes, opts = {}) {
  const { boxes } = readJxl(bytes);
  if (readMarkerBox(boxes)) throw new PixmixError('Image is already scrambled (decode it first, or use rekey)', 'ALREADY_SCRAMBLED');
  const image = await (await loadJxlCodec()).decode(bytes);
  return scrambleJxlPixels(image, sanitizeBoxes(boxes, opts).boxes, opts);
}

// --- JPEG route -------------------------------------------------------------------

/** True when the file is a losslessly recompressed JPEG (it has reconstruction data). */
export const hasJpegData = (bytes) => readJxl(bytes).boxes.some((b) => b.type === 'jbrd');

/** The JPEG inside a recompressed JPEG XL, bit for bit (null if it is not one). */
export async function reconstructJpeg(bytes) {
  return (await loadJxlCodec()).reconstructJpeg(bytes);
}

async function toJxlWithMarker(scrambledJpeg) {
  const codec = await loadJxlCodec();
  const { boxes, codestream } = readJxl(await codec.transcodeJpeg(scrambledJpeg));
  const kept = boxes.filter((b) => !STRUCTURE.has(b.type)); // jbrd, Exif, xml from cjxl
  return writeJxl([...kept, { type: MARKER_BOX, data: jpegMarkerBytes(scrambledJpeg) }], codestream);
}

/**
 * JPEG (already sanitised) -> DCT-domain scramble -> recompressed JPEG XL. The JPEG inside
 * is always baseline: jxl-oxide 0.12 cannot reconstruct some progressive JPEGs.
 */
export async function scrambleJpegToJxl(jpeg, { key, transforms, salt } = {}) {
  return toJxlWithMarker(scrambleJpeg(jpeg, { key, transforms, salt, progressive: false }));
}

// --- both routes -------------------------------------------------------------------

/**
 * Decodes and checks the key. Pixel route: `pixels` / `scrambled` are the restored and
 * scrambled RGBA and `toJxl` re-encodes losslessly. JPEG route: `jpeg` is the unscrambled
 * JPEG's detail (see formats/jpeg) and `toJxl` recompresses it (Node only).
 */
export async function unscrambleJxlDetailed(bytes, { key, effort } = {}) {
  const { boxes } = readJxl(bytes);
  const marker = readMarkerBox(boxes);
  if (!marker) throw new PixmixError('Image carries no pixmix marker', 'NOT_SCRAMBLED');
  const codec = await loadJxlCodec();
  if (marker.params.mode === 'mcu') {
    const scrambledJpeg = await codec.reconstructJpeg(bytes);
    if (!scrambledJpeg) throw new PixmixError('JPEG XL file lost its JPEG reconstruction data', 'BAD_JXL');
    const jpeg = unscrambleJpegDetailed(scrambledJpeg, { key });
    return { route: 'jpeg', params: marker.params, jpeg, toJxl: () => codec.transcodeJpeg(jpeg.toJpeg()) };
  }
  const image = await codec.decode(bytes);
  const layout = layoutFor(key, marker.params, image.width, image.height, marker.check);
  const pixels = applyMap(image.data, layout.map, 4, 'unscramble');
  const kept = boxes.filter((b) => !STRUCTURE.has(b.type));
  return {
    route: 'pixels',
    layout,
    params: marker.params,
    scrambled: image.data,
    pixels,
    toJxl: async () => writeJxl(kept, await codec.encode({ width: image.width, height: image.height, data: pixels }, { effort: effort ?? 7 })),
  };
}

export async function unscrambleJxl(bytes, opts) {
  return (await unscrambleJxlDetailed(bytes, opts)).toJxl();
}

export async function rekeyJxl(bytes, { from, to, mode, block, salt, effort, transforms } = {}) {
  const { boxes } = readJxl(bytes);
  const marker = readMarkerBox(boxes);
  if (!marker) throw new PixmixError('Image carries no pixmix marker', 'NOT_SCRAMBLED');
  if (marker.params.mode === 'mcu') {
    if (mode && mode !== 'mcu') throw new PixmixError('This JPEG XL holds a scrambled JPEG; it can only be re-keyed in mode "mcu"', 'BAD_OPTION');
    const jpeg = await reconstructJpeg(bytes);
    return toJxlWithMarker(rekeyJpeg(jpeg, { from, to, transforms, salt, progressive: false }));
  }
  if (mode === 'mcu') throw new PixmixError('Mode "mcu" needs a JPEG XL that holds a JPEG', 'BAD_OPTION');
  const image = await (await loadJxlCodec()).decode(bytes);
  const old = layoutFor(from, marker.params, image.width, image.height, marker.check);
  const plain = { ...image, data: applyMap(image.data, old.map, 4, 'unscramble') };
  const kept = boxes.filter((b) => !STRUCTURE.has(b.type));
  return scrambleJxlPixels(plain, kept, {
    key: to, salt, effort,
    mode: mode ?? marker.params.mode,
    block: block ?? (marker.params.block || undefined),
  });
}

/** Cheap: container and codestream headers only. */
export function inspectJxl(bytes) {
  const { container, boxes, codestream } = readJxl(bytes);
  const header = readJxlHeader(codestream);
  const marker = readMarkerBox(boxes);
  return {
    format: 'jxl',
    width: header.width,
    height: header.height,
    container,
    lossy: header.lossy,
    bitDepth: header.bits,
    alpha: header.alpha,
    animated: header.animated,
    orientation: header.orientation,
    srgb: header.srgb,
    scrambled: !!marker,
    mode: marker?.params.mode ?? null,
    block: marker?.params.mode === 'block' ? marker.params.block : null,
    transforms: marker?.params.mode === 'mcu' ? !!(marker.params.block & 1) : null,
    boxes: boxes.map((b) => ({ type: b.type.trim(), length: b.data.length })),
    metadata: ['Exif', 'xml ', 'jumb'].filter((t) => boxes.some((b) => b.type === t || (b.type === 'brob' && String.fromCharCode(...b.data.subarray(0, 4)) === t))).map((t) => ({ Exif: 'exif', 'xml ': 'xmp', jumb: 'jumbf' })[t]),
  };
}
