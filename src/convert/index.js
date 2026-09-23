// Any supported input -> PNG, carrying metadata across. PNG input is passed through
// untouched (the lossless path keeps it byte-exact apart from the image data).

import { detectFormat, toBytes } from '../formats/index.js';
import { PixmixError } from '../core/params.js';
import { readJpegMetadata } from '../meta/jpeg.js';
import { readWebpMetadata } from '../meta/webp.js';
import { buildPng } from './png-build.js';
import { BUILTIN_DECODERS } from './decoders.js';

const EXTRACTORS = { jpeg: readJpegMetadata, webp: readWebpMetadata };

/**
 * @typedef {object} ConvertResult
 * @property {Uint8Array} png
 * @property {string} from            detected input format
 * @property {string} decoder         which decoder produced the pixels ('none' for PNG)
 * @property {string[]} transferred   metadata carried into the PNG
 * @property {string[]} dropped       metadata that could not be carried, with reasons
 */

/** Synchronous; built-in decoders or sync plugins only. @returns {ConvertResult} */
export function convert(input, { decoders = [] } = {}) {
  const bytes = toBytes(input);
  const job = prepare(bytes, decoders);
  if (job.done) return job.done;
  const decoded = job.decoder.decode(bytes, job.format);
  if (decoded && typeof decoded.then === 'function') {
    throw new PixmixError(`Decoder "${job.decoder.name}" is async; use encodeAsync/convertAsync`, 'ASYNC_DECODER');
  }
  return finish(bytes, job, decoded);
}

/** Accepts async decoder plugins (sharp, browser-native). @returns {Promise<ConvertResult>} */
export async function convertAsync(input, { decoders = [] } = {}) {
  const bytes = toBytes(input);
  const job = prepare(bytes, decoders);
  if (job.done) return job.done;
  return finish(bytes, job, await job.decoder.decode(bytes, job.format));
}

function prepare(bytes, decoders) {
  const format = detectFormat(bytes);
  if (!format) throw new PixmixError('Unrecognised image format', 'UNSUPPORTED');
  if (format === 'png') return { done: { png: bytes, from: 'png', decoder: 'none', transferred: ['all chunks'], dropped: [] } };
  // Plugins first, so a caller can override a built-in (e.g. sharp for faster JPEG).
  const decoder = [...decoders, ...BUILTIN_DECODERS].find((d) => d.formats.includes(format));
  if (!decoder) {
    throw new PixmixError(`No decoder for ${format.toUpperCase()} input; pass a decoder plugin (e.g. sharp)`, 'UNSUPPORTED');
  }
  return { format, decoder };
}

function finish(bytes, { format, decoder }, decoded) {
  const extracted = EXTRACTORS[format]?.(bytes);
  const meta = extracted ?? decoded.metadata ?? {};
  if (extracted && decoded.metadata?.dropped) meta.dropped = [...(meta.dropped ?? []), ...decoded.metadata.dropped];
  const { png, transferred, dropped } = buildPng(decoded, meta);
  return { png, from: format, decoder: decoder.name, transferred, dropped: [...new Set(dropped)] };
}
