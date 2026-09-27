// JPEG container: SOI, marker segments, scans (SOS header + entropy-coded data), EOI.
// Segments are kept as raw payloads so everything not rewritten is copied back verbatim.

import { PixmixError } from '../../core/params.js';
import { resolveLimits, checkChunks } from '../../core/limits.js';

export const M = {
  SOI: 0xd8, EOI: 0xd9, SOS: 0xda, DQT: 0xdb, DHT: 0xc4, DRI: 0xdd, DNL: 0xdc, COM: 0xfe,
  SOF0: 0xc0, SOF1: 0xc1, SOF2: 0xc2, APP0: 0xe0, APP1: 0xe1, APP2: 0xe2, APP13: 0xed, APP14: 0xee, APP15: 0xef,
};

export const isSof = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
export const isApp = (m) => m >= 0xe0 && m <= 0xef;

export function isJpeg(bytes) {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * @typedef {{marker: number, data: Uint8Array, ecs?: Uint8Array}} Segment
 *   data is the payload after the length field; SOS segments carry `ecs`, the
 *   entropy-coded bytes (including any RST markers) that follow the header.
 * @param {Uint8Array} bytes @param {Partial<import('../../core/limits.js').Limits>} [limits]
 * @returns {{segments: Segment[], trailing: Uint8Array, damaged: boolean}}  damaged: bytes
 *   before a marker were skipped, or the file ends inside a scan (no EOI)
 */
export function readSegments(bytes, limits) {
  if (!isJpeg(bytes)) throw new PixmixError('Not a JPEG file', 'BAD_JPEG');
  const { maxChunks } = resolveLimits(limits);
  const segments = [];
  let pos = 2, damaged = false;
  for (;;) {
    if (segments.length >= maxChunks) checkChunks(segments.length + 1, limits, 'segments');
    // Like libjpeg's next_marker: garbage before a marker is skipped (libjpeg warns about
    // "extraneous bytes"), and so are fill bytes (FF FF) and stuffed FF00 pairs.
    for (;;) {
      while (pos < bytes.length && bytes[pos] !== 0xff) { pos++; damaged = true; }
      while (pos + 1 < bytes.length && bytes[pos + 1] === 0xff) pos++;
      if (pos + 1 < bytes.length && bytes[pos + 1] === 0) { pos += 2; damaged = true; continue; }
      break;
    }
    if (pos + 2 > bytes.length) throw new PixmixError('JPEG ends before EOI', 'BAD_JPEG');
    const marker = bytes[pos + 1];
    pos += 2;
    if (marker === M.EOI) break;
    if (marker === M.SOI || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (pos + 2 > bytes.length) throw new PixmixError('Truncated JPEG segment', 'BAD_JPEG');
    const len = (bytes[pos] << 8) | bytes[pos + 1];
    if (len < 2 || pos + len > bytes.length) throw new PixmixError('Truncated JPEG segment', 'BAD_JPEG');
    const seg = { marker, data: bytes.subarray(pos + 2, pos + len) };
    pos += len;
    if (marker === M.SOS) {
      const start = pos;
      // Entropy data runs to the next marker that is neither stuffing (FF00) nor RSTn.
      while (pos < bytes.length) {
        if (bytes[pos] === 0xff) {
          const next = bytes[pos + 1];
          if (next === 0 || (next >= 0xd0 && next <= 0xd7)) { pos += 2; continue; }
          if (next === 0xff) { pos++; continue; }
          break;
        }
        pos++;
      }
      seg.ecs = bytes.subarray(start, Math.min(pos, bytes.length));
      segments.push(seg);
      if (pos >= bytes.length) { damaged = true; break; } // truncated file: tolerate a missing EOI
      continue;
    }
    segments.push(seg);
  }
  return { segments, trailing: bytes.subarray(Math.min(pos, bytes.length)), damaged };
}

/** @param {Segment[]} segments @param {Uint8Array} [trailing] */
export function writeSegments(segments, trailing) {
  let size = 4 + (trailing?.length ?? 0);
  for (const s of segments) size += 4 + s.data.length + (s.ecs?.length ?? 0);
  const out = new Uint8Array(size);
  out[0] = 0xff; out[1] = M.SOI;
  let pos = 2;
  for (const s of segments) {
    if (s.data.length + 2 > 0xffff) throw new PixmixError(`JPEG segment 0x${s.marker.toString(16)} too large`, 'BAD_JPEG');
    out[pos] = 0xff; out[pos + 1] = s.marker;
    out[pos + 2] = (s.data.length + 2) >> 8; out[pos + 3] = (s.data.length + 2) & 255;
    out.set(s.data, pos + 4);
    pos += 4 + s.data.length;
    if (s.ecs) { out.set(s.ecs, pos); pos += s.ecs.length; }
  }
  out[pos] = 0xff; out[pos + 1] = M.EOI;
  if (trailing?.length) out.set(trailing, pos + 2);
  return out;
}

export const startsWith = (bytes, s) => s.length <= bytes.length && [...s].every((c, i) => bytes[i] === c.charCodeAt(0));
