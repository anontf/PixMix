// JPEG XL in, JPEG XL out, two ways:
//
// - pixel route (mode pixel/block): pixels are decoded (8- or 16-bit RGBA in the image's own
//   colour space, every frame of an animation), moved exactly like PNG pixels, and encoded
//   again LOSSLESSLY with the same ICC profile, so the key gives back exactly the pixels the
//   input decoded to. Like APNG, every animation frame gets its own permutation (the frame
//   index is part of the seed). Metadata boxes (Exif, xml, jumb, brob, unknown) are copied.
// - JPEG route (mode mcu): for JPEG sources. The JPEG is scrambled in the DCT domain (see
//   formats/jpeg) and then losslessly recompressed into JPEG XL, which stays lossy-small;
//   decoding reconstructs that JPEG bit for bit and unscrambles it.
//
// The scramble parameters go in a `pmIx` box (for the JPEG route, also in the JPEG's APP15
// segment, inside the reconstruction data). Everything here is async: the codec is WASM
// loaded on first use.

import { readJxl, writeJxl, wrapCodestream, readJxlHeader, isJxl } from './container.js';
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

const highPrecision = (header) => header.bits > 8 || header.float;

/** What re-encoding a JXL input losslessly from its decoded pixels changes, for the report. */
export function reencodeNotes(header) {
  const notes = [];
  if (header.lossy) notes.push('lossy compression (re-encoded losslessly from the decoded pixels; the file grows)');
  if (highPrecision(header) && header.animated) notes.push(`${header.float ? 'floating-point' : `${header.bits}-bit`} precision (reduced to 8-bit; animations are 8-bit)`);
  else if (header.float || header.bits > 16) notes.push(`${header.float ? 'floating-point' : `${header.bits}-bit`} precision (reduced to 16-bit)`);
  return notes;
}

function readMarkerBox(boxes) {
  const box = boxes.find((b) => b.type === MARKER_BOX);
  return box ? readMarker(box.data) : null;
}

/**
 * @typedef {object} JxlImage  what the pixel route scrambles and encodes
 * @property {number} width @property {number} height
 * @property {8|16} depth
 * @property {Uint8Array|Uint16Array} data   RGBA (frame 0 of an animation)
 * @property {Uint8Array|null} [icc]  colour profile of the samples (none = sRGB)
 * @property {{data: Uint8Array, delay: [number, number]}[]} [frames]  animation: every
 *           frame, full canvas, 8-bit
 * @property {number} [plays]  0 = forever
 */

/**
 * Decodes for re-encoding: frames of an animation, 16 bits when there are more than 8, and
 * the samples as stored, in the image's own colour space (with its ICC profile unless that
 * is sRGB). `display` asks for what a browser canvas wants instead: 8-bit sRGB.
 * @returns {Promise<JxlImage>}
 */
export async function decodeJxlImage(bytes, { display = false } = {}) {
  const header = readJxlHeader(readJxl(bytes).codestream);
  const codec = await loadJxlCodec();
  // Never convert an sRGB image: asking for sRGB would still turn grey into RGB.
  const srgb = display && header.srgb !== true;
  const icc = (profile) => (srgb || header.srgb === true ? null : profile);
  if (header.animated) {
    const a = await codec.decodeAnimation(bytes, { srgb, icc: header.srgb !== true });
    if (a.frames.length > 1) {
      return { width: a.width, height: a.height, depth: 8, data: a.frames[0].data, icc: icc(a.icc), frames: a.frames, plays: a.plays };
    }
  }
  const image = await codec.decode(bytes, { srgb, high: !display && highPrecision(header) });
  return { ...image, icc: icc(image.icc) };
}

// Frame i's permutation has index i in its seed; frame 0's key check goes in the marker.
// Layouts are computed one frame at a time, since each holds a map as large as the image.
function mapFrames(key, params, image, direction, expectedCheck) {
  const { width, height } = image;
  const move = (data, i) => {
    const layout = computeLayout(key, params, width, height, i);
    if (i === 0 && expectedCheck && !checksEqual(layout.check, expectedCheck)) throw new WrongKeyError();
    return { layout, data: mapPixels(data, layout.map, direction) };
  };
  if (!image.frames) {
    const { layout, data } = move(image.data, 0);
    return { layout, image: { ...image, data } };
  }
  let first;
  const frames = image.frames.map((f, i) => {
    const moved = move(f.data, i);
    first ??= moved.layout;
    return { ...f, data: moved.data };
  });
  return { layout: first, image: { ...image, data: frames[0].data, frames } };
}

/** applyMap for 8-bit (4 bytes a pixel) or 16-bit (8 bytes) RGBA. */
function mapPixels(data, map, direction) {
  if (!(data instanceof Uint16Array)) return applyMap(data, map, 4, direction);
  const moved = applyMap(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), map, 8, direction);
  return new Uint16Array(moved.buffer, moved.byteOffset, moved.length / 2);
}

// Noise from pixel mode gains nothing from a slow effort; tiles still compress well.
const effortFor = (params, effort) => effort ?? (params.mode === 'pixel' ? 2 : 7);

/**
 * Scrambles already-decoded pixels and writes a JXL around them.
 * @param {JxlImage} image
 * @param {import('./container.js').Box[]} boxes metadata boxes to include
 */
export async function scrambleJxlPixels(image, boxes, { key, mode, block, salt, effort } = {}) {
  if (mode === 'mcu') throw new PixmixError('Mode "mcu" needs a JPEG source', 'BAD_OPTION');
  const params = makeParams({ mode, block, salt });
  const scrambled = mapFrames(key, params, image, 'scramble');
  const codec = await loadJxlCodec();
  const codestream = await codec.encode(scrambled.image, { effort: effortFor(params, effort) });
  return wrapCodestream([...boxes, { type: MARKER_BOX, data: writeMarker(params, scrambled.layout.check) }], codestream);
}

export async function scrambleJxl(bytes, opts = {}) {
  const { boxes } = readJxl(bytes);
  if (readMarkerBox(boxes)) throw new PixmixError('Image is already scrambled (decode it first, or use rekey)', 'ALREADY_SCRAMBLED');
  return scrambleJxlPixels(await decodeJxlImage(bytes), sanitizeBoxes(boxes, opts).boxes, opts);
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
  const kept = boxes.filter((b) => !STRUCTURE.has(b.type)); // jbrd, Exif, xml from libjxl
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
 * Decodes and checks the key. Pixel route: `pixels` / `scrambled` are frame 0's restored
 * and scrambled RGBA, `image` the whole restored image (every frame), and `toJxl`
 * re-encodes it losslessly. With `display`, pixels are 8-bit sRGB for a canvas (and `toJxl`
 * is not offered). JPEG route: `jpeg` is the unscrambled JPEG's detail (see formats/jpeg)
 * and `toJxl` recompresses it.
 */
export async function unscrambleJxlDetailed(bytes, { key, effort, display = false } = {}) {
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
  const scrambled = await decodeJxlImage(bytes, { display });
  const { layout, image } = mapFrames(key, marker.params, scrambled, 'unscramble', marker.check);
  const kept = boxes.filter((b) => !STRUCTURE.has(b.type));
  return {
    route: 'pixels',
    layout,
    params: marker.params,
    scrambled: scrambled.data,
    pixels: image.data,
    image,
    toJxl: display ? null : async () => wrapCodestream(kept, await codec.encode(image, { effort: effort ?? 7 })),
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
  const { image } = mapFrames(from, marker.params, await decodeJxlImage(bytes), 'unscramble', marker.check);
  const kept = boxes.filter((b) => !STRUCTURE.has(b.type));
  return scrambleJxlPixels(image, kept, {
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
    ...(header.animated && header.loops !== undefined ? { plays: header.loops } : {}),
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
