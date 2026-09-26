// Any supported input -> the requested output format, carrying metadata across.
//
// Same format in and out (PNG->PNG, JPEG->JPEG) takes the lossless path: the file is only
// sanitised (embedded previews removed) and the scrambler then rewrites the image data.
// Anything else is decoded to RGBA and re-encoded, mapping metadata between containers.

import { detectFormat, toBytes } from '../formats/index.js';
import { PixmixError } from '../core/params.js';
import { checkOptions } from '../core/options.js';
import { withLimits, checkPixels, checkFrames, resolveLimits } from '../core/limits.js';
import { readJpegMetadata } from '../meta/jpeg.js';
import { readWebpMetadata } from '../meta/webp.js';
import { readJxlMetadata } from '../meta/jxl.js';
import { readJxl, writeJxl, wrapCodestream, readJxlHeader } from '../formats/jxl/container.js';
import { sanitizeBoxes } from '../formats/jxl/index.js';
import { iccSpace, iccFits } from '../formats/jxl/icc.js';
import { loadJxlCodec } from '../formats/jxl/load.js';
import { stripExifPreviews, stripXmpPreviews } from '../meta/thumbnails.js';
import { readPngText } from '../meta/read.js';
import { readChunks, writeChunks } from '../formats/png/chunks.js';
import { sanitizeJpeg, jpegMarkerBytes } from '../formats/jpeg/index.js';
import { buildPng } from './png-build.js';
import { buildJpeg } from './jpeg-build.js';
import { BUILTIN_DECODERS } from './decoders.js';
import { applyMetadata, applyMetadataAsync, applyJxlParts, normalizePolicy } from '../meta/apply.js';

const EXTRACTORS = { jpeg: readJpegMetadata, webp: readWebpMetadata, jxl: readJxlMetadata };
export const OUTPUT_FORMATS = ['png', 'jpeg', 'jxl'];

/**
 * @typedef {object} ConvertOptions
 * @property {'png'|'jpeg'|'jxl'} [format]  default: the input format when it can be written, else png
 * @property {object[]} [decoders]      extra input decoders (plugins)
 * @property {boolean} [keepThumbnails] keep embedded previews (they show the unscrambled image)
 * @property {number} [quality=90]      JPEG output from non-JPEG input
 * @property {'4:2:0'|'4:2:2'|'4:4:4'} [subsampling='4:2:0']
 * @property {string} [background='#ffffff']  what transparency is flattened onto for JPEG
 * @property {Partial<import('../core/limits.js').Limits>} [limits]  resource limits for the input
 * @property {object|string} [metadata]  a metadata policy for the output (see meta/policy.js);
 *           without one, metadata is carried over as described above
 *
 * @typedef {object} ConvertResult
 * @property {Uint8Array} bytes
 * @property {string} format         output format
 * @property {string} from           detected input format
 * @property {string} decoder        which decoder produced the pixels ('none' = lossless path)
 * @property {string[]} transferred  metadata carried into the output
 * @property {string[]} dropped      what could not be (or was deliberately not) carried, and why
 * @property {import('../meta/apply.js').MetadataReport} [metadata]  what the metadata policy
 *           removed and set (only with a policy)
 */

export function targetFormat(from, format) {
  const target = format ?? (OUTPUT_FORMATS.includes(from) ? from : 'png');
  if (!OUTPUT_FORMATS.includes(target)) {
    throw new PixmixError(`Output format "${target}" is not supported yet (available: ${OUTPUT_FORMATS.join(', ')})`, 'UNSUPPORTED');
  }
  return target;
}

/** Synchronous; built-in decoders or sync plugins only. @returns {ConvertResult} */
export function convert(input, opts = {}) {
  const bytes = toBytes(input);
  opts = withPolicy(withLimits(bytes, checkOptions(opts)));
  const job = prepare(bytes, opts);
  if (job.done) return applied(job.done, opts);
  if (job.target === 'jxl') throw new PixmixError('JPEG XL output needs encodeAsync/convertAsync', 'ASYNC_DECODER');
  const decoded = callDecoder(job, bytes, opts.limits);
  if (decoded && typeof decoded.then === 'function') {
    decoded.catch(() => {}); // nobody will await it
    throw new PixmixError(`Decoder "${job.decoder.name}" is async; use encodeAsync/convertAsync`, 'ASYNC_DECODER');
  }
  return applied(finish(bytes, job, checkDecoded(job, decoded, opts.limits), opts), opts);
}

/** Accepts async decoder plugins (sharp, browser-native) and JPEG XL. @returns {Promise<ConvertResult>} */
export async function convertAsync(input, opts = {}) {
  const bytes = toBytes(input);
  opts = withPolicy(withLimits(bytes, checkOptions(opts)));
  const job = prepare(bytes, opts);
  if (job.done) {
    if (!opts.metadata) return job.done;
    const { bytes: out, report } = await applyMetadataAsync(job.done.bytes, opts.metadata, { limits: opts.limits, stripThumbnails: !opts.keepThumbnails });
    return { ...job.done, bytes: out, metadata: report };
  }
  if (job.target === 'jxl') {
    const { image, boxes, report } = await decodeJob(bytes, job, opts);
    const codestream = await (await loadJxlCodec()).encode(image);
    return { bytes: wrapCodestream(boxes, codestream), ...report };
  }
  return applied(finish(bytes, job, await decodeAsync(job, bytes, opts.limits), opts), opts);
}

/** Options with the metadata policy validated up front (before any decoding work). */
const withPolicy = (opts) => (opts.metadata === undefined ? opts : { ...opts, metadata: normalizePolicy(opts.metadata) });

/** A PNG or JPEG result with the metadata policy applied (and reported). */
function applied(result, { metadata, limits, keepThumbnails }) {
  if (!metadata) return result;
  const { bytes, report } = applyMetadata(result.bytes, metadata, { limits, stripThumbnails: !keepThumbnails });
  return { ...result, bytes, metadata: report };
}

// Decoders (plugins above all) throw whatever their library throws; callers get a
// PixmixError either way, with the original as its cause.
function decodeFailure(job, err) {
  if (err instanceof PixmixError) return err;
  const failure = new PixmixError(`${job.decoder.name} could not decode this ${job.from.toUpperCase()}: ${err?.message ?? err}`, `BAD_${job.from.toUpperCase()}`);
  failure.cause = err;
  return failure;
}

function callDecoder(job, bytes, limits) {
  try {
    return job.decoder.decode(bytes, job.from, { limits });
  } catch (err) {
    throw decodeFailure(job, err);
  }
}

async function decodeAsync(job, bytes, limits) {
  let decoded;
  try {
    decoded = await callDecoder(job, bytes, limits);
  } catch (err) {
    throw decodeFailure(job, err);
  }
  return checkDecoded(job, decoded, limits);
}

/** What a decoder returned: its size against the limits, and the data against its size. */
function checkDecoded(job, decoded, limits) {
  const { width, height, data, animation } = decoded ?? {};
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0) || !data) {
    throw new PixmixError(`Decoder "${job.decoder.name}" returned no image`, `BAD_${job.from.toUpperCase()}`);
  }
  checkPixels(width, height, limits);
  const frames = animation?.frames ?? [];
  if (frames.length > 1) checkFrames(frames.length, frames.length * width * height, limits);
  for (const d of [data, ...frames.map((f) => f.data)]) {
    if (d?.length !== width * height * 4) throw new PixmixError(`Decoder "${job.decoder.name}" must return width*height RGBA samples`, 'DECODER');
  }
  return decoded;
}

/**
 * For JPEG XL output from another format: the decoded pixels (see formats/jxl JxlImage) and
 * the metadata as JXL boxes, so the encoder can scramble the pixels before the one and only
 * (lossless) encode.
 */
export async function decodeForJxl(input, opts = {}) {
  const bytes = toBytes(input);
  opts = withLimits(bytes, checkOptions(opts));
  const job = prepare(bytes, { ...opts, format: 'jxl' });
  if (job.done) throw new Error('decodeForJxl is for non-JXL input');
  return decodeJob(bytes, job, opts);
}

async function decodeJob(bytes, job, { keepThumbnails = false, limits, metadata }) {
  const decoded = normalise(await decodeAsync(job, bytes, limits));
  const meta = mergedMeta(bytes, job.from, decoded, keepThumbnails, limits);
  let { image, boxes, transferred, dropped } = jxlImage(decoded, meta);
  const report = { format: 'jxl', from: job.from, decoder: job.decoder.name, transferred, dropped, notes: sizeNotes(bytes, job.from, 'jxl') };
  if (metadata) {
    // The pixel route encodes the codestream, so the ICC profile can change here too.
    const parts = applyJxlParts({ boxes, icc: image.icc ?? null }, normalizePolicy(metadata), { limits, stripThumbnails: !keepThumbnails });
    ({ boxes } = parts);
    image = { ...image, icc: parts.icc };
    report.metadata = parts.report;
  }
  return { image, boxes, report };
}

/**
 * Lossless output (PNG, or JPEG XL on the pixel route) of a lossy source is several times
 * larger than the source even before scrambling; say so, and what stays small.
 */
export function sizeNotes(bytes, from, target) {
  const recompressed = from === 'jxl' && isRecompressedJpeg(bytes);
  const lossy = from === 'jpeg' || from === 'heic' || recompressed
    || (from === 'avif' && !isLosslessAvif(bytes))
    || (from === 'webp' && webpChunks(bytes).includes('VP8 '))
    || (from === 'jxl' && isLossyJxl(bytes));
  if (!lossy || target === 'jpeg') return [];
  const smaller = from === 'jpeg' ? 'format "jpeg" (or "jxl" without a pixel/block mode, the JPEG route)'
    : !recompressed ? 'format "jpeg" with a quality setting'
      : target === 'jxl' ? 'the JPEG route (no pixel/block mode) or format "jpeg"'
        : 'format "jxl" without a pixel/block mode (the JPEG route) or "jpeg"';
  const what = recompressed ? 'jxl (a recompressed JPEG) is lossy' : `${from} is lossy`;
  return [`${what}: lossless ${target} output is typically 3-8 times its size even unscrambled; ${smaller} stays small`];
}

/** The chunk ids of a WebP (RIFF) file, in order. */
function webpChunks(bytes) {
  const ids = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let pos = 12; pos + 8 <= bytes.length && ids.length < 1024;) {
    ids.push(String.fromCharCode(...bytes.subarray(pos, pos + 4)));
    const len = dv.getUint32(pos + 4, true);
    pos += 8 + len + (len & 1);
  }
  return ids;
}

/**
 * AVIF is lossless only when coded as RGB (the identity matrix in its nclx colour box):
 * every other lossless coding still loses to the YUV conversion.
 */
function isLosslessAvif(bytes) {
  const end = Math.min(bytes.length, 1 << 16);
  for (let i = 4; i + 15 <= end; i++) {
    if (bytes[i] === 0x63 && bytes[i + 1] === 0x6f && bytes[i + 2] === 0x6c && bytes[i + 3] === 0x72 // colr
      && bytes[i + 4] === 0x6e && bytes[i + 5] === 0x63 && bytes[i + 6] === 0x6c && bytes[i + 7] === 0x78) { // nclx
      return ((bytes[i + 12] << 8) | bytes[i + 13]) === 0; // matrix_coefficients
    }
  }
  return false;
}

function isRecompressedJpeg(bytes) {
  try {
    return readJxl(bytes).boxes.some((b) => b.type === 'jbrd');
  } catch {
    return false;
  }
}

function isLossyJxl(bytes) {
  try {
    return !!readJxlHeader(readJxl(bytes).codestream).lossy;
  } catch {
    return false;
  }
}

/**
 * Decoded pixels and metadata as JPEG XL has them: EXIF and XMP in boxes; the ICC profile,
 * animation frames and 16-bit samples in the codestream.
 */
function jxlImage(decoded, meta) {
  const boxes = [], transferred = [];
  let dropped = [...meta.dropped];
  let image = { width: decoded.width, height: decoded.height, depth: decoded.depth === 16 ? 16 : 8, data: decoded.data };
  const frames = decoded.animation?.frames.length > 1 ? decoded.animation.frames : null;
  if (frames) {
    // Animations are 8-bit (so are the frames decoders hand over).
    if (image.depth === 16) image = to8bit(image, { dropped });
    image = { ...image, data: frames[0].data, frames, plays: decoded.animation.plays };
    dropped = dropped.filter((d) => !d.startsWith('animation'));
    transferred.push('animation');
  } else if (image.depth === 16 && image.data.every((v) => v % 257 === 0)) {
    image = { ...image, depth: 8, data: Uint8Array.from(image.data, (v) => v / 257) }; // 8 bits lose nothing
  }
  if (meta.icc) {
    const space = iccSpace(meta.icc);
    if (iccFits(meta.icc, frames ? frames.map((f) => f.data) : [image.data])) {
      image.icc = meta.icc;
      transferred.push('ICC profile');
    } else {
      dropped.push(space === 'GRAY' ? 'ICC profile (GRAY profile on a colour image)' : `ICC profile (${space?.trim() || 'invalid'} colour space)`);
    }
  }
  if (meta.exif?.length) {
    const d = new Uint8Array(4 + meta.exif.length);
    d.set(meta.exif, 4);
    boxes.push({ type: 'Exif', data: d });
    transferred.push('EXIF');
  }
  if (meta.xmp) { boxes.push({ type: 'xml ', data: new TextEncoder().encode(meta.xmp) }); transferred.push('XMP'); }
  if (meta.density) dropped.push('density (JPEG XL has no field for it)');
  if (meta.comments?.length) dropped.push('comments (JPEG XL has no field for them)');
  return { image, boxes, transferred, dropped: [...new Set(dropped)] };
}

function prepare(bytes, { format, decoders = [], keepThumbnails = false, limits }) {
  const from = detectFormat(bytes);
  if (!from) throw new PixmixError('Unrecognised image format', 'UNSUPPORTED');
  const target = targetFormat(from, format);
  if (from === target) {
    const { bytes: out, dropped } = sanitize(from, bytes, limits, keepThumbnails);
    return { done: { bytes: out, format: target, from, decoder: 'none', transferred: ['all metadata'], dropped, notes: [] } };
  }
  // Decoding a scrambled image to another format would lose its marker (and with it the
  // original): refuse, as encode does. The same format keeps the marker (see sanitize).
  if (isScrambled(bytes, from, limits)) {
    throw new PixmixError('Image is scrambled; converting it to another format would lose the original (decode it first)', 'ALREADY_SCRAMBLED');
  }
  // Plugins first, so a caller can override a built-in (e.g. sharp for faster JPEG).
  const decoder = [...decoders, ...BUILTIN_DECODERS].find((d) => d.formats.includes(from));
  if (!decoder) {
    throw new PixmixError(`No decoder for ${from.toUpperCase()} input; pass a decoder plugin (e.g. sharp)`, 'UNSUPPORTED');
  }
  return { from, target, decoder };
}

/** Plugins may hand back Node Buffers; 16-bit data stays a Uint16Array. */
function normalise(decoded) {
  return decoded.depth === 16 ? { ...decoded, data: Uint16Array.from(decoded.data) } : { ...decoded, data: toBytes(decoded.data) };
}

/** 16-bit RGBA to 8-bit (rounded), noting the loss. */
function to8bit(image, meta) {
  if (image.depth !== 16) return image;
  meta.dropped.push('16-bit precision (reduced to 8-bit)');
  const d = new Uint8Array(image.data.length);
  for (let i = 0; i < d.length; i++) d[i] = (image.data[i] + 128) / 257;
  return { ...image, depth: 8, data: d };
}

// pixmix's own container reader wins; the decoder fills in what it cannot see (e.g. the
// colour profile of a JPEG XL, which lives in the codestream).
function mergedMeta(bytes, from, decoded, keepThumbnails, limits) {
  const extracted = EXTRACTORS[from]?.(bytes, limits) ?? {};
  const fromDecoder = decoded.metadata ?? {};
  const meta = { ...fromDecoder, ...extracted };
  for (const k of Object.keys(extracted)) if (extracted[k] === undefined) meta[k] = fromDecoder[k];
  meta.dropped = [...(extracted.dropped ?? []), ...(fromDecoder.dropped ?? [])];
  if (meta.exif && !keepThumbnails) {
    const stripped = stripExifPreviews(meta.exif);
    if (stripped) { meta.exif = stripped.tiff; meta.dropped.push(...stripped.dropped); }
  }
  if (meta.xmp && !keepThumbnails) {
    const stripped = stripXmpPreviews(meta.xmp);
    if (stripped) { meta.xmp = stripped.text ?? undefined; meta.dropped.push(...stripped.dropped); }
  }
  return meta;
}

function finish(bytes, { from, target, decoder }, decoded, { keepThumbnails = false, quality, subsampling, background, progressive, limits }) {
  decoded = normalise(decoded);
  const meta = mergedMeta(bytes, from, decoded, keepThumbnails, limits);
  if (target !== 'png') decoded = to8bit(decoded, meta); // PNG keeps 16 bits; JPEG cannot
  const built = target === 'jpeg'
    ? (({ jpeg, ...r }) => ({ bytes: jpeg, ...r }))(buildJpeg(decoded, meta, { quality, subsampling, background, progressive }))
    : (({ png, ...r }) => ({ bytes: png, ...r }))(buildPng(decoded, meta));
  return { bytes: built.bytes, format: target, from, decoder: decoder.name, transferred: built.transferred, dropped: [...new Set(built.dropped)], notes: sizeNotes(bytes, from, target) };
}

function sanitize(format, bytes, limits, keepThumbnails) {
  if (format === 'jpeg') return sanitizeJpeg(bytes, limits, { keepThumbnails });
  if (keepThumbnails) return { bytes, dropped: [] };
  if (format === 'jxl') {
    // The codestream is copied as it is, so the boxes that belong to it stay.
    const { boxes, codestream } = readJxl(bytes, limits);
    const clean = sanitizeBoxes(boxes, { limits, sameCodestream: true });
    return { bytes: writeJxl(clean.boxes, codestream), dropped: clean.dropped };
  }
  // PNG: only EXIF and XMP previews can leak; everything else stays byte for byte.
  const chunks = readChunks(bytes, limits);
  const dropped = [];
  let changed = false;
  const i = chunks.findIndex((c) => c.type === 'eXIf');
  const exif = i >= 0 ? stripExifPreviews(chunks[i].data) : null;
  if (exif) { chunks[i] = { type: 'eXIf', data: exif.tiff }; dropped.push(...exif.dropped); changed = true; }
  const { maxMetadataBytes } = resolveLimits(limits);
  for (let k = 0; k < chunks.length; k++) {
    const c = chunks[k];
    if (!['iTXt', 'tEXt', 'zTXt'].includes(c.type) || !startsWithKeyword(c.data, 'XML:com.adobe.xmp')) continue;
    const text = readPngText(c.type, c.data, maxMetadataBytes)?.text;
    const xmp = text ? stripXmpPreviews(text) : null;
    if (!xmp) continue;
    chunks[k] = xmp.text === null ? null : { type: 'iTXt', data: xmpChunk(xmp.text) };
    for (const d of xmp.dropped) if (!dropped.includes(d)) dropped.push(d);
    changed = true;
  }
  if (!changed) return { bytes, dropped: [] };
  return { bytes: writeChunks(chunks.filter(Boolean)), dropped };
}

const startsWithKeyword = (data, k) => data.length > k.length && data[k.length] === 0 && [...k].every((ch, i) => data[i] === ch.charCodeAt(0));
const xmpChunk = (text) => {
  const k = Uint8Array.from('XML:com.adobe.xmp', (c) => c.charCodeAt(0)), t = new TextEncoder().encode(text);
  const out = new Uint8Array(k.length + 5 + t.length);
  out.set(k);
  out.set(t, k.length + 5);
  return out;
};

/** Whether the file carries a pixmix marker (only its presence: nothing is parsed). */
export function isScrambled(bytes, format, limits) {
  if (format === 'png') return readChunks(bytes, limits).some((c) => c.type === 'pmIx');
  if (format === 'jpeg') return !!jpegMarkerBytes(bytes);
  if (format === 'jxl') return readJxl(bytes, limits).boxes.some((b) => b.type === 'pmIx');
  return false;
}
