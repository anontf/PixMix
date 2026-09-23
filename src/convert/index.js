// Any supported input -> the requested output format, carrying metadata across.
//
// Same format in and out (PNG->PNG, JPEG->JPEG) takes the lossless path: the file is only
// sanitised (embedded previews removed) and the scrambler then rewrites the image data.
// Anything else is decoded to RGBA and re-encoded, mapping metadata between containers.

import { detectFormat, toBytes } from '../formats/index.js';
import { PixmixError } from '../core/params.js';
import { readJpegMetadata } from '../meta/jpeg.js';
import { readWebpMetadata } from '../meta/webp.js';
import { stripExifThumbnail } from '../meta/thumbnails.js';
import { readChunks, writeChunks } from '../formats/png/chunks.js';
import { sanitizeJpeg } from '../formats/jpeg/index.js';
import { buildPng } from './png-build.js';
import { buildJpeg } from './jpeg-build.js';
import { BUILTIN_DECODERS } from './decoders.js';

const EXTRACTORS = { jpeg: readJpegMetadata, webp: readWebpMetadata };
export const OUTPUT_FORMATS = ['png', 'jpeg'];

/**
 * @typedef {object} ConvertOptions
 * @property {'png'|'jpeg'} [format]    default: the input format when it can be written, else png
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
  const decoded = job.decoder.decode(bytes, job.from);
  if (decoded && typeof decoded.then === 'function') {
    throw new PixmixError(`Decoder "${job.decoder.name}" is async; use encodeAsync/convertAsync`, 'ASYNC_DECODER');
  }
  return finish(bytes, job, decoded, opts);
}

/** Accepts async decoder plugins (sharp, browser-native). @returns {Promise<ConvertResult>} */
export async function convertAsync(input, opts = {}) {
  const bytes = toBytes(input);
  const job = prepare(bytes, opts);
  if (job.done) return job.done;
  return finish(bytes, job, await job.decoder.decode(bytes, job.from), opts);
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

function finish(bytes, { from, target, decoder }, decoded, { keepThumbnails = false, quality, subsampling, background }) {
  decoded = { ...decoded, data: toBytes(decoded.data) }; // plugins may hand back Node Buffers
  const extracted = EXTRACTORS[from]?.(bytes);
  const meta = { ...(extracted ?? decoded.metadata ?? {}) };
  meta.dropped = [...(meta.dropped ?? []), ...(extracted ? decoded.metadata?.dropped ?? [] : [])];
  if (meta.exif && !keepThumbnails) {
    const stripped = stripExifThumbnail(meta.exif);
    if (stripped) { meta.exif = stripped; meta.dropped.push('EXIF thumbnail'); }
  }
  const built = target === 'jpeg'
    ? (({ jpeg, ...r }) => ({ bytes: jpeg, ...r }))(buildJpeg(decoded, meta, { quality, subsampling, background }))
    : (({ png, ...r }) => ({ bytes: png, ...r }))(buildPng(decoded, meta));
  return { bytes: built.bytes, format: target, from, decoder: decoder.name, transferred: built.transferred, dropped: [...new Set(built.dropped)] };
}

function sanitize(format, bytes) {
  if (format === 'jpeg') return sanitizeJpeg(bytes);
  // PNG: only an EXIF thumbnail can leak; everything else stays byte for byte.
  const chunks = readChunks(bytes);
  const i = chunks.findIndex((c) => c.type === 'eXIf');
  const stripped = i >= 0 ? stripExifThumbnail(chunks[i].data) : null;
  if (!stripped) return { bytes, dropped: [] };
  chunks[i] = { type: 'eXIf', data: stripped };
  return { bytes: writeChunks(chunks), dropped: ['EXIF thumbnail'] };
}
