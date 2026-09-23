// Any supported input -> the requested output format, carrying metadata across.
//
// Same format in and out (PNG->PNG, JPEG->JPEG) takes the lossless path: the file is only
// sanitised (embedded previews removed) and the scrambler then rewrites the image data.
// Anything else is decoded to RGBA and re-encoded, mapping metadata between containers.

import { detectFormat, toBytes } from '../formats/index.js';
import { PixmixError } from '../core/params.js';
import { readJpegMetadata } from '../meta/jpeg.js';
import { readWebpMetadata } from '../meta/webp.js';
import { readJxlMetadata } from '../meta/jxl.js';
import { readJxl, writeJxl } from '../formats/jxl/container.js';
import { sanitizeBoxes } from '../formats/jxl/index.js';
import { loadJxlCodec } from '../formats/jxl/load.js';
import { stripExifThumbnail } from '../meta/thumbnails.js';
import { readChunks, writeChunks } from '../formats/png/chunks.js';
import { sanitizeJpeg } from '../formats/jpeg/index.js';
import { buildPng } from './png-build.js';
import { buildJpeg } from './jpeg-build.js';
import { BUILTIN_DECODERS } from './decoders.js';

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
 *
 * @typedef {object} ConvertResult
 * @property {Uint8Array} bytes
 * @property {string} format         output format
 * @property {string} from           detected input format
 * @property {string} decoder        which decoder produced the pixels ('none' = lossless path)
 * @property {string[]} transferred  metadata carried into the output
 * @property {string[]} dropped      what could not be (or was deliberately not) carried, and why
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
  const job = prepare(bytes, opts);
  if (job.done) return job.done;
  if (job.target === 'jxl') throw new PixmixError('JPEG XL output needs encodeAsync/convertAsync', 'ASYNC_DECODER');
  const decoded = job.decoder.decode(bytes, job.from);
  if (decoded && typeof decoded.then === 'function') {
    throw new PixmixError(`Decoder "${job.decoder.name}" is async; use encodeAsync/convertAsync`, 'ASYNC_DECODER');
  }
  return finish(bytes, job, decoded, opts);
}

/** Accepts async decoder plugins (sharp, browser-native) and JPEG XL. @returns {Promise<ConvertResult>} */
export async function convertAsync(input, opts = {}) {
  const bytes = toBytes(input);
  const job = prepare(bytes, opts);
  if (job.done) return job.done;
  if (job.target === 'jxl') {
    const { image, meta, from, decoder } = await decodeJob(bytes, job, opts);
    const { boxes, transferred, dropped } = jxlBoxes(meta);
    const codestream = await (await loadJxlCodec()).encode(image);
    return { bytes: writeJxl(boxes, codestream), format: 'jxl', from, decoder, transferred, dropped };
  }
  return finish(bytes, job, await job.decoder.decode(bytes, job.from), opts);
}

/**
 * For JPEG XL output from another format: the decoded RGBA and the metadata as JXL boxes,
 * so the encoder can scramble the pixels before the one and only (lossless) encode.
 */
export async function decodeForJxl(input, opts = {}) {
  const bytes = toBytes(input);
  const job = prepare(bytes, { ...opts, format: 'jxl' });
  if (job.done) throw new Error('decodeForJxl is for non-JXL input');
  const { image, meta, from, decoder } = await decodeJob(bytes, job, opts);
  const { boxes, transferred, dropped } = jxlBoxes(meta);
  return { image, boxes, report: { format: 'jxl', from, decoder, transferred, dropped } };
}

async function decodeJob(bytes, job, { keepThumbnails = false }) {
  const decoded = await job.decoder.decode(bytes, job.from);
  const meta = mergedMeta(bytes, job.from, decoded, keepThumbnails);
  const image = to8bit(normalise(decoded), meta); // the JPEG XL encoder is 8-bit
  return { image, meta, from: job.from, decoder: job.decoder.name };
}

// JPEG XL keeps EXIF and XMP in boxes; the colour profile would go in the codestream,
// which the bundled encoder always writes as sRGB.
function jxlBoxes(meta) {
  const boxes = [], transferred = [], dropped = [...meta.dropped];
  if (meta.exif?.length) {
    const d = new Uint8Array(4 + meta.exif.length);
    d.set(meta.exif, 4);
    boxes.push({ type: 'Exif', data: d });
    transferred.push('EXIF');
  }
  if (meta.xmp) { boxes.push({ type: 'xml ', data: new TextEncoder().encode(meta.xmp) }); transferred.push('XMP'); }
  if (meta.icc) dropped.push('ICC profile (the bundled JPEG XL encoder writes sRGB only)');
  if (meta.density) dropped.push('density (JPEG XL has no field for it)');
  if (meta.comments?.length) dropped.push('comments (JPEG XL has no field for them)');
  return { boxes, transferred, dropped: [...new Set(dropped)] };
}

function prepare(bytes, { format, decoders = [], keepThumbnails = false }) {
  const from = detectFormat(bytes);
  if (!from) throw new PixmixError('Unrecognised image format', 'UNSUPPORTED');
  const target = targetFormat(from, format);
  if (from === target) {
    const { bytes: out, dropped } = keepThumbnails ? { bytes, dropped: [] } : sanitize(from, bytes);
    return { done: { bytes: out, format: target, from, decoder: 'none', transferred: ['all metadata'], dropped } };
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
function mergedMeta(bytes, from, decoded, keepThumbnails) {
  const extracted = EXTRACTORS[from]?.(bytes) ?? {};
  const fromDecoder = decoded.metadata ?? {};
  const meta = { ...fromDecoder, ...extracted };
  for (const k of Object.keys(extracted)) if (extracted[k] === undefined) meta[k] = fromDecoder[k];
  meta.dropped = [...(extracted.dropped ?? []), ...(fromDecoder.dropped ?? [])];
  if (meta.exif && !keepThumbnails) {
    const stripped = stripExifThumbnail(meta.exif);
    if (stripped) { meta.exif = stripped; meta.dropped.push('EXIF thumbnail'); }
  }
  return meta;
}

function finish(bytes, { from, target, decoder }, decoded, { keepThumbnails = false, quality, subsampling, background, progressive }) {
  decoded = normalise(decoded);
  const meta = mergedMeta(bytes, from, decoded, keepThumbnails);
  if (target !== 'png') decoded = to8bit(decoded, meta); // PNG keeps 16 bits; JPEG cannot
  const built = target === 'jpeg'
    ? (({ jpeg, ...r }) => ({ bytes: jpeg, ...r }))(buildJpeg(decoded, meta, { quality, subsampling, background, progressive }))
    : (({ png, ...r }) => ({ bytes: png, ...r }))(buildPng(decoded, meta));
  return { bytes: built.bytes, format: target, from, decoder: decoder.name, transferred: built.transferred, dropped: [...new Set(built.dropped)] };
}

function sanitize(format, bytes) {
  if (format === 'jpeg') return sanitizeJpeg(bytes);
  if (format === 'jxl') {
    const { boxes, codestream } = readJxl(bytes);
    const clean = sanitizeBoxes(boxes);
    return { bytes: writeJxl(clean.boxes, codestream), dropped: clean.dropped };
  }
  // PNG: only an EXIF thumbnail can leak; everything else stays byte for byte.
  const chunks = readChunks(bytes);
  const i = chunks.findIndex((c) => c.type === 'eXIf');
  const stripped = i >= 0 ? stripExifThumbnail(chunks[i].data) : null;
  if (!stripped) return { bytes, dropped: [] };
  chunks[i] = { type: 'eXIf', data: stripped };
  return { bytes: writeChunks(chunks), dropped: ['EXIF thumbnail'] };
}
