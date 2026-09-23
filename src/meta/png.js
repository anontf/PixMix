// Metadata from PNG chunks, for converting PNG to other formats.

import { inflateUpTo } from '../formats/png/zlib.js';
import { resolveLimits, decompressedLimitError } from '../core/limits.js';

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder();

/**
 * @param {import('../formats/png/chunks.js').Chunk[]} chunks
 * @param {Partial<import('../core/limits.js').Limits>} [limits]
 * @returns {import('./jpeg.js').Metadata}
 */
export function readPngMetadata(chunks, limits) {
  const meta = { dropped: [], comments: [] };
  const { maxMetadataBytes } = resolveLimits(limits);
  // Over the limit is an error rather than a quiet drop: the caller asked for a ceiling.
  const inflate = (data) => {
    const out = inflateUpTo(data, maxMetadataBytes);
    if (out.more) throw decompressedLimitError(maxMetadataBytes, 'maxMetadataBytes', 'A metadata chunk');
    return out;
  };
  const hasIcc = chunks.some((c) => c.type === 'iCCP');
  const otherText = new Set();
  for (const { type, data } of chunks) {
    if (type === 'eXIf') meta.exif = data.slice();
    else if (type === 'iCCP') {
      const nul = data.indexOf(0);
      try { meta.icc = inflate(data.subarray(nul + 2)); } catch (err) { rethrowLimit(err); meta.dropped.push('ICC profile (corrupt)'); }
    } else if (type === 'pHYs' && data.length === 9) {
      const dv = new DataView(data.buffer, data.byteOffset, 9);
      meta.density = { x: dv.getUint32(0), y: dv.getUint32(4), unit: data[8] === 1 ? 'meter' : 'none' };
    } else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const t = readText(type, data, inflate);
      if (!t) continue;
      if (t.keyword === 'XML:com.adobe.xmp') meta.xmp = t.text;
      else if (t.keyword === 'Comment') meta.comments.push(t.text);
      else otherText.add(t.keyword);
    } else if ((type === 'gAMA' || type === 'cHRM') && !hasIcc) {
      if (!meta.dropped.includes('gamma/chromaticity')) meta.dropped.push('gamma/chromaticity');
    }
  }
  if (otherText.size) meta.dropped.push(`text chunks (${[...otherText].join(', ')})`);
  return meta;
}

const rethrowLimit = (err) => { if (err?.code === 'LIMIT') throw err; };

function readText(type, data, inflate) {
  const nul = data.indexOf(0);
  if (nul < 1) return null;
  const keyword = latin1.decode(data.subarray(0, nul));
  try {
    if (type === 'tEXt') return { keyword, text: latin1.decode(data.subarray(nul + 1)) };
    if (type === 'zTXt') return { keyword, text: latin1.decode(inflate(data.subarray(nul + 2))) };
    const compressed = data[nul + 1] === 1;
    const lang = data.indexOf(0, nul + 3);
    const trans = data.indexOf(0, lang + 1);
    const body = data.subarray(trans + 1);
    return { keyword, text: utf8.decode(compressed ? inflate(body) : body) };
  } catch (err) {
    rethrowLimit(err);
    return null;
  }
}
