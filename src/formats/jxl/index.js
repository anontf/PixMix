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
//
// Watermarks (see watermark/embed.js): a `pmWm` box names the watermark for the restored
// image, a `pmWs` box holds the pixels under a watermark drawn on the scrambled image (pixel
// route; the JPEG route keeps both in the JPEG's APP15 segments, and mirrors pmWm in a box).

import { readJxl, writeJxl, wrapCodestream, readJxlHeader, isJxl, extraChannelsNote } from './container.js';
import { loadJxlCodec } from './load.js';
import { computeLayout, applyMap, fitParams } from '../../core/layout.js';
import {
  makeParams, writeMarker, readMarker, checksEqual, PixmixError, WrongKeyError, FLAG_STASH, tileSize, tileTransforms,
} from '../../core/params.js';
import { stripExifPreviews, stripXmpPreviews } from '../../meta/thumbnails.js';
import { isSrgbIcc } from '../../meta/icc.js';
import { exifTiff, unwrapBrob } from '../../meta/jxl.js';
import { scrambleJpeg, unscrambleJpegDetailed, rekeyJpeg, jpegMarkerBytes, jpegWatermark } from '../jpeg/index.js';
import { readSegments } from '../jpeg/markers.js';
import { watermarkInfo, carriedFields } from '../png/index.js';
import {
  WATERMARK_TAG, STASH_TAG, encodeWatermark, readCarried, keptWatermark, restorePixelStash,
} from '../../watermark/embed.js';
import { stashRgba } from '../../watermark/paint.js';

export { isJxl };
export const MARKER_BOX = 'pmIx';

// Container structure (rewritten), or data tied to the old codestream / showing the image.
const STRUCTURE = new Set(['JXL ', 'ftyp', 'jxlc', 'jxlp', 'jxli', 'jxll', MARKER_BOX, WATERMARK_TAG, STASH_TAG]);
const STALE = {
  jbrd: 'JPEG reconstruction data (no longer matches the image)',
  jhgm: 'HDR gain map (a second image)',
};
const KEPT_WITH_CODESTREAM = new Set(['jxll', MARKER_BOX, WATERMARK_TAG, STASH_TAG]);

/**
 * Metadata boxes to carry over, with EXIF and XMP previews removed unless kept.
 * `sameCodestream`: the codestream is copied unchanged (not re-encoded), so what belongs to
 * it stays too: its level box (jxll), a pixmix marker with its watermark boxes, and the JPEG
 * reconstruction data (jbrd), unless removing a preview changed the EXIF or XMP it rebuilds.
 * @returns {{boxes: import('./container.js').Box[], dropped: string[]}}
 */
export function sanitizeBoxes(boxes, { keepThumbnails = false, limits, sameCodestream = false } = {}) {
  const out = [], dropped = [];
  const note = (s) => { if (!dropped.includes(s)) dropped.push(s); };
  let metaChanged = false;
  for (const box of boxes) {
    if (sameCodestream && (KEPT_WITH_CODESTREAM.has(box.type) || box.type === 'jbrd')) { out.push(box); continue; }
    if (STRUCTURE.has(box.type)) continue;
    if (STALE[box.type]) { dropped.push(STALE[box.type]); continue; }
    if (keepThumbnails) { out.push(box); continue; }
    const inner = box.type === 'brob' ? String.fromCharCode(...box.data.subarray(0, 4)) : box.type;
    if (inner !== 'Exif' && inner !== 'xml ') { out.push(box); continue; }
    let data = box.data;
    if (box.type === 'brob') {
      const u = unwrapBrob(box.data, limits);
      if (!u.data) { metaChanged = true; dropped.push(`compressed ${inner === 'Exif' ? 'EXIF' : 'XMP'} (cannot be checked for a ${inner === 'Exif' ? 'thumbnail' : 'preview'} here)`); continue; }
      data = u.data;
    }
    if (inner === 'Exif') {
      const stripped = data.length > 4 ? stripExifPreviews(exifTiff(data)) : null;
      out.push(stripped ? { type: 'Exif', data: withOffset(stripped.tiff) } : box);
      if (stripped) { stripped.dropped.forEach(note); metaChanged = true; }
    } else {
      const stripped = stripXmpPreviews(new TextDecoder().decode(data));
      if (stripped) { stripped.dropped.forEach(note); metaChanged = true; }
      if (!stripped) out.push(box);
      else if (stripped.text !== null) out.push({ type: 'xml ', data: new TextEncoder().encode(stripped.text) });
    }
  }
  if (!metaChanged || !out.some((b) => b.type === 'jbrd')) return { boxes: out, dropped };
  dropped.push('JPEG reconstruction data (it rebuilds the preview that was removed)');
  return { boxes: out.filter((b) => b.type !== 'jbrd'), dropped };
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
  const extra = extraChannelsNote(header);
  if (extra) notes.push(extra);
  return notes;
}

/** Container and codestream header, the size checked against the limits before decoding. */
function readChecked(bytes, limits) {
  const jxl = readJxl(bytes, limits);
  readJxlHeader(jxl.codestream, limits);
  return jxl;
}

function readMarkerBox(boxes) {
  const box = boxes.find((b) => b.type === MARKER_BOX);
  return box ? readMarker(box.data) : null;
}

/**
 * The watermark a JPEG XL carries for its restored image, read tolerantly (see readCarried
 * in watermark/embed.js): {watermark: {id, name, compiled}|null, error, data}.
 */
export function jxlWatermark(boxes, limits) {
  return readCarried(boxes.find((b) => b.type === WATERMARK_TAG)?.data, limits);
}

const frameList = (image) => (image.frames ? image.frames.map((f) => f.data) : [image.data]);

/**
 * @typedef {object} JxlImage  what the pixel route scrambles and encodes
 * @property {number} width @property {number} height
 * @property {8|16} depth
 * @property {Uint8Array|Uint16Array} data   RGBA (frame 0 of an animation)
 * @property {Uint8Array|null} [icc]  colour profile of the samples (none = sRGB)
 * @property {object|null} [colour]  the enum colour encoding they came with (see codec.js)
 * @property {number} [orientation]  1-8: the samples are on the stored grid, and the header
 *           says how to show them
 * @property {{data: Uint8Array, delay: [number, number]}[]} [frames]  animation: every
 *           frame, full canvas, 8-bit
 * @property {number} [plays]  0 = forever
 */

/**
 * Decodes for re-encoding: frames of an animation, 16 bits when there are more than 8, and
 * the samples as stored, on the stored grid (the orientation stays a header field) and in
 * the image's own colour space (with its ICC profile unless that is sRGB). `display` asks
 * for what a browser canvas wants instead: 8-bit sRGB (still on the stored grid).
 * @returns {Promise<JxlImage>}
 */
export async function decodeJxlImage(bytes, { display = false, limits } = {}) {
  const header = readJxlHeader(readJxl(bytes, limits).codestream, limits);
  const codec = await loadJxlCodec();
  // Never convert an sRGB image: asking for sRGB would still turn grey into RGB.
  const srgb = display && header.srgb !== true;
  const icc = (profile) => (srgb || header.srgb === true ? null : profile);
  const colour = (c) => (icc(c?.icc) ? c : null);
  if (header.animated) {
    const a = await codec.decodeAnimation(bytes, { srgb, icc: header.srgb !== true, oriented: false, limits });
    if (a.frames.length > 1) {
      return { width: a.width, height: a.height, depth: 8, data: a.frames[0].data, icc: icc(a.icc), colour: colour(a.colour), orientation: a.orientation, frames: a.frames, plays: a.plays };
    }
  }
  const image = await codec.decode(bytes, { srgb, high: !display && highPrecision(header), oriented: false, limits });
  return { ...image, icc: icc(image.icc), colour: colour(image.colour) };
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
export async function scrambleJxlPixels(image, boxes, { key, mode, block, transforms, salt, effort, watermark, visibleWatermark } = {}) {
  if (mode === 'mcu') throw new PixmixError('Mode "mcu" needs a JPEG source', 'BAD_OPTION');
  let params = fitParams(makeParams({ mode, block, transforms, salt }), [image]);
  const scrambled = mapFrames(key, params, image, 'scramble');
  const extra = [];
  if (watermark) extra.push({ type: WATERMARK_TAG, data: encodeWatermark(watermark) });
  if (visibleWatermark) {
    // Browsers get 8-bit sRGB pixels to reveal; only then are those the stored pixels too.
    // A plain sRGB ICC profile says no more than the sRGB colour encoding, which replaces it.
    if (image.icc && isSrgbIcc(image.icc)) image = { ...image, icc: null, colour: null };
    if (image.depth === 16 || image.icc) {
      throw new PixmixError('A visible watermark on JPEG XL needs an 8-bit sRGB image (or use PNG output)', 'UNSUPPORTED');
    }
    const stash = stashRgba({ width: image.width, height: image.height, orientation: image.orientation, frames: frameList(scrambled.image) }, visibleWatermark, key, params.salt);
    if (stash) {
      extra.push({ type: STASH_TAG, data: stash });
      params = { ...params, flags: FLAG_STASH };
    }
  }
  const codec = await loadJxlCodec();
  const codestream = await codec.encode({ ...scrambled.image, icc: image.icc, colour: image.colour }, { effort: effortFor(params, effort) });
  return wrapCodestream([...boxes, { type: MARKER_BOX, data: writeMarker(params, scrambled.layout.check) }, ...extra], codestream);
}

/** Puts the pixels under a visible watermark back into the (scrambled) decoded frames. */
function restoreStash(boxes, marker, image, key, limits) {
  if (!(marker.params.flags & FLAG_STASH)) return null;
  const box = boxes.find((b) => b.type === STASH_TAG);
  if (!box) throw new PixmixError('Image lost the pixels under its visible watermark (pmWs box)', 'BAD_JXL');
  if (image.depth === 16) throw new PixmixError('Corrupt pixmix watermark data (depth)', 'BAD_WATERMARK');
  const frames = frameList(image).map((d) => ({ pixels: new Uint8Array(d.buffer, d.byteOffset, d.byteLength), width: image.width, height: image.height, bpp: 4 }));
  try {
    return restorePixelStash(frames, box.data, key, marker.params.salt, limits);
  } catch (err) {
    // A wrong key cannot decrypt the stash: say so rather than "corrupt".
    if (!checksEqual(computeLayout(key, marker.params, image.width, image.height, 0).check, marker.check)) throw new WrongKeyError();
    throw err;
  }
}

/** What the pixel route scrambles: the decoded image, the metadata boxes to carry, and what was not carried. */
export async function jxlForScramble(bytes, opts = {}) {
  const { limits } = opts;
  const { boxes, codestream } = readChecked(bytes, limits);
  if (readMarkerBox(boxes)) throw new PixmixError('Image is already scrambled (decode it first, or use rekey)', 'ALREADY_SCRAMBLED');
  const clean = sanitizeBoxes(boxes, opts);
  // Only the pixels are needed: JPEG reconstruction data the decoder cannot use (the reason
  // the JPEG route was not taken) would fail the decode, so the bare codestream is decoded.
  const pixels = boxes.some((b) => b.type === 'jbrd') ? codestream : bytes;
  return { image: await decodeJxlImage(pixels, { limits }), boxes: clean.boxes, dropped: clean.dropped };
}

export async function scrambleJxl(bytes, opts = {}) {
  const { image, boxes } = await jxlForScramble(bytes, opts);
  return scrambleJxlPixels(image, boxes, opts);
}

/**
 * A metadata policy, where this module decodes and encodes (see encoder.js metaHook):
 * `meta` is {tools, policy, limits, onReport}, tools being meta/apply.js (passed in, so
 * the browser decoder only loads it when a policy is used).
 */
function policyOnJpeg(meta, jpeg) {
  if (!meta) return jpeg;
  const { bytes, report } = meta.tools.applyMetadata(jpeg, meta.policy, { limits: meta.limits });
  meta.onReport?.(report);
  return bytes;
}

function policyOnParts(meta, boxes, image) {
  if (!meta) return { boxes, image };
  const parts = meta.tools.applyJxlParts({ boxes, icc: image.icc ?? null }, meta.policy, { limits: meta.limits });
  meta.onReport?.(parts.report);
  return { boxes: parts.boxes, image: { ...image, icc: parts.icc } };
}

// --- JPEG route -------------------------------------------------------------------

/** True when the file is a losslessly recompressed JPEG (it has reconstruction data). */
export const hasJpegData = (bytes, limits) => readJxl(bytes, limits).boxes.some((b) => b.type === 'jbrd');

/** The JPEG inside a recompressed JPEG XL, bit for bit (null if it is not one). */
export async function reconstructJpeg(bytes, limits) {
  readChecked(bytes, limits);
  return (await loadJxlCodec()).reconstructJpeg(bytes, { limits });
}

/** The scrambled JPEG inside a JPEG-route file, which cannot do without it. */
export async function scrambledJpegOf(bytes, limits) {
  const jpeg = await reconstructJpeg(bytes, limits);
  if (!jpeg) throw new PixmixError('JPEG XL file lost its JPEG reconstruction data', 'BAD_JXL');
  return jpeg;
}

/**
 * The error for a JPEG the JPEG route cannot carry. `jpegRoute` lets the encoder fall back to
 * the pixel route when the route was only the default.
 */
function routeError(why) {
  const err = new PixmixError(`This JPEG cannot take the JPEG XL JPEG route (${why}); use mode "block" or "pixel"`, 'UNSUPPORTED');
  err.jpegRoute = true;
  return err;
}

async function toJxlWithMarker(scrambledJpeg, limits) {
  // The JPEG inside holds the watermark segments; a copy in a box lets inspect() see it.
  const wm = jpegWatermark(readSegments(scrambledJpeg).segments, limits).data;
  const mirror = wm ? [{ type: WATERMARK_TAG, data: wm }] : [];
  return recompressChecked(scrambledJpeg, [{ type: MARKER_BOX, data: jpegMarkerBytes(scrambledJpeg) }, ...mirror], limits);
}

/**
 * A (plain, unscrambled) JPEG recompressed into JPEG XL as the JPEG route carries it, which
 * is what convertAsync gives for JPEG XL output from a JPEG: the same coefficients, written
 * the way a JPEG-route file restores them (baseline, like the scrambled JPEG it holds).
 * Throws like the route does (with `jpegRoute` set) when the JPEG cannot take it.
 */
export async function jpegToJxl(jpeg, limits) {
  const key = 'pixmix';
  const plain = unscrambleJpegDetailed(scrambleJpeg(jpeg, { key, progressive: false, limits }), { key, limits }).toJpeg();
  return recompressChecked(plain, [], limits);
}

async function recompressChecked(jpeg, extra, limits) {
  const codec = await loadJxlCodec();
  let transcoded;
  try {
    transcoded = await codec.transcodeJpeg(jpeg);
  } catch (err) {
    if (err?.code === 'LIMIT') throw err;
    throw routeError(`libjxl cannot recompress it: ${err?.message ?? err}`); // e.g. CMYK, 4:1:1
  }
  const { boxes, codestream } = readJxl(transcoded);
  const kept = boxes.filter((b) => !STRUCTURE.has(b.type)); // jbrd, Exif, xml from libjxl
  const out = writeJxl([...kept, ...extra], codestream);
  // libjxl writes the file and jxl-oxide rebuilds the JPEG from it, and jxl-oxide 0.12 gets
  // some JPEGs wrong (e.g. 4:4:4 stored with 1x2 sampling factors). A file that cannot be
  // rebuilt bit for bit could never be restored, so never write one.
  let rebuilt;
  try {
    rebuilt = await codec.reconstructJpeg(out, { limits });
  } catch (err) {
    if (err?.code === 'LIMIT') throw err;
    throw routeError(`jxl-oxide cannot rebuild it: ${err?.message ?? err}`);
  }
  if (!rebuilt || !sameBytes(rebuilt, jpeg)) throw routeError('jxl-oxide does not rebuild it exactly');
  return out;
}

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Whether `jpeg` (rebuilt by jxl-oxide from a third-party recompressed JPEG XL) holds the
 * same image as the JPEG XL itself. jxl-oxide 0.12 rebuilds some progressive JPEGs wrongly
 * without an error. Recompressing the rebuilt JPEG and decoding both with the same decoder
 * gives identical pixels exactly when the DCT coefficients match; a false alarm only costs
 * the pixel route.
 */
export async function rebuiltJpegMatches(jxl, jpeg, limits) {
  const codec = await loadJxlCodec();
  let again;
  try {
    again = await codec.transcodeJpeg(jpeg);
  } catch (err) {
    if (err?.code === 'LIMIT') throw err;
    return false;
  }
  const a = await codec.decode(jxl, { srgb: false, limits });
  const b = await codec.decode(again, { srgb: false, limits });
  return a.width === b.width && a.height === b.height && sameBytes(a.data, b.data);
}

/**
 * JPEG (already sanitised) -> DCT-domain scramble -> recompressed JPEG XL. The JPEG inside
 * is always baseline: jxl-oxide 0.12 cannot reconstruct some progressive JPEGs.
 */
export async function scrambleJpegToJxl(jpeg, { key, transforms, salt, limits, watermark, visibleWatermark } = {}) {
  return toJxlWithMarker(scrambleJpeg(jpeg, { key, transforms, salt, progressive: false, limits, watermark, visibleWatermark }), limits);
}

// --- both routes -------------------------------------------------------------------

/**
 * Decodes and checks the key. Pixel route: `pixels` / `scrambled` are frame 0's restored
 * and scrambled RGBA, `image` the whole restored image (every frame), and `toJxl`
 * re-encodes it losslessly. With `display`, pixels are 8-bit sRGB for a canvas (and `toJxl`
 * is not offered). JPEG route: `jpeg` is the unscrambled JPEG's detail (see formats/jpeg)
 * and `toJxl` recompresses it.
 */
export async function unscrambleJxlDetailed(bytes, { key, effort, display = false, limits, meta } = {}) {
  const { boxes } = readChecked(bytes, limits);
  const marker = readMarkerBox(boxes);
  if (!marker) throw new PixmixError('Image carries no pixmix marker', 'NOT_SCRAMBLED');
  const codec = await loadJxlCodec();
  if (marker.params.mode === 'mcu') {
    const scrambledJpeg = policyOnJpeg(meta, await scrambledJpegOf(bytes, limits));
    const jpeg = unscrambleJpegDetailed(scrambledJpeg, { key, limits });
    return { route: 'jpeg', params: marker.params, jpeg, watermark: jpeg.watermark, watermarkError: jpeg.watermarkError, toJxl: (paint) => codec.transcodeJpeg(jpeg.toJpeg(paint)) };
  }
  const scrambled = await decodeJxlImage(bytes, { display, limits });
  restoreStash(boxes, marker, scrambled, key, limits);
  const { layout, image } = mapFrames(key, marker.params, scrambled, 'unscramble', marker.check);
  const kept = boxes.filter((b) => !STRUCTURE.has(b.type));
  const paintImage = (paint) => {
    if (!paint?.watermark) return image;
    const copy = image.frames ? { ...image, frames: image.frames.map((f) => ({ ...f, data: f.data.slice() })) } : { ...image, data: image.data.slice() };
    if (copy.frames) copy.data = copy.frames[0].data;
    paint.painter.paintRgba({ width: image.width, height: image.height, orientation: image.orientation, frames: frameList(copy) }, paint.watermark, paint.limits);
    return copy;
  };
  return {
    route: 'pixels',
    layout,
    params: marker.params,
    scrambled: scrambled.data,
    pixels: image.data,
    image,
    ...carriedFields(jxlWatermark(boxes, limits)),
    /** The restored image with a watermark drawn on a copy (`paint`: {painter, watermark}). */
    paint: paintImage,
    toJxl: display ? null : async (paint) => {
      const out = policyOnParts(meta, kept, paintImage(paint));
      return wrapCodestream(out.boxes, await codec.encode(out.image, { effort: effort ?? 7 }));
    },
  };
}



export async function unscrambleJxl(bytes, opts) {
  return (await unscrambleJxlDetailed(bytes, opts)).toJxl();
}

export async function rekeyJxl(bytes, { from, to, mode, block, salt, effort, transforms, limits, watermark, visibleWatermark, meta } = {}) {
  const { boxes } = readChecked(bytes, limits);
  const marker = readMarkerBox(boxes);
  if (!marker) throw new PixmixError('Image carries no pixmix marker', 'NOT_SCRAMBLED');
  if (marker.params.mode === 'mcu') {
    if (mode && mode !== 'mcu') throw new PixmixError('This JPEG XL holds a scrambled JPEG; it can only be re-keyed in mode "mcu"', 'BAD_OPTION');
    const jpeg = policyOnJpeg(meta, await scrambledJpegOf(bytes, limits));
    return toJxlWithMarker(rekeyJpeg(jpeg, { from, to, transforms, salt, progressive: false, limits, watermark, visibleWatermark }), limits);
  }
  if (mode === 'mcu') throw new PixmixError('Mode "mcu" needs a JPEG XL that holds a JPEG', 'BAD_OPTION');
  const scrambled = await decodeJxlImage(bytes, { limits });
  const visible = restoreStash(boxes, marker, scrambled, from, limits);
  const restored = mapFrames(from, marker.params, scrambled, 'unscramble', marker.check).image;
  const { boxes: kept, image } = policyOnParts(meta, boxes.filter((b) => !STRUCTURE.has(b.type)), restored);
  return scrambleJxlPixels(image, kept, {
    key: to, salt, effort,
    mode: mode ?? marker.params.mode,
    block: block ?? (marker.params.mode === 'block' ? tileSize(marker.params) : undefined),
    transforms: transforms ?? (marker.params.mode === 'block' ? tileTransforms(marker.params) : undefined),
    watermark: watermark === undefined ? keptWatermark(jxlWatermark(boxes, limits)) : watermark,
    visibleWatermark: visibleWatermark === undefined ? visible?.() ?? null : visibleWatermark,
  });
}

/** Cheap: container and codestream headers only. */
export function inspectJxl(bytes, limits) {
  const { container, boxes, codestream } = readJxl(bytes, limits);
  const header = readJxlHeader(codestream, limits);
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
    block: marker?.params.mode === 'block' ? tileSize(marker.params) : null,
    transforms: marker?.params.mode === 'mcu' ? !!(marker.params.block & 1) : marker?.params.mode === 'block' ? tileTransforms(marker.params) : null,
    ...watermarkInfo(jxlWatermark(boxes, limits), marker),
    boxes: boxes.map((b) => ({ type: b.type.trim(), length: b.data.length })),
    metadata: ['Exif', 'xml ', 'jumb'].filter((t) => boxes.some((b) => b.type === t || (b.type === 'brob' && String.fromCharCode(...b.data.subarray(0, 4)) === t))).map((t) => ({ Exif: 'exif', 'xml ': 'xmp', jumb: 'jumbf' })[t]),
  };
}
