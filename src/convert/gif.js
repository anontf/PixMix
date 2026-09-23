// GIF frames to RGBA. omggif parses the block structure (frames, palettes, delays), but its
// LZW decoder can loop forever on a corrupt code stream (a code table with a cycle in it)
// and blits frames that stick out of the canvas into the next row, so the image data is
// decoded here instead:
//   - codes beyond the table end the frame, as in browsers (the rest stays as it was);
//   - every table entry points at an older one, so expanding a code always terminates;
//   - the output never exceeds the frame, and the frame is clipped to the canvas.

import { PixmixError } from '../core/params.js';

const INTERLACE = [[0, 8], [4, 8], [2, 4], [1, 2]]; // first row, step, per pass

/**
 * LZW-decodes a frame's image data (starting at its code size byte) into `out`, one palette
 * index per pixel. Returns how many pixels were decoded (short data leaves the rest).
 * @param {Uint8Array} buf @param {number} p @param {Uint8Array} out
 */
export function decodeLzw(buf, p, out) {
  const minSize = buf[p++];
  if (!(minSize >= 1 && minSize <= 11)) throw new PixmixError(`Invalid GIF LZW code size ${minSize}`, 'BAD_GIF');
  const clear = 1 << minSize, eoi = clear + 1;
  const prefix = new Uint16Array(4096), suffix = new Uint8Array(4096), first = new Uint8Array(4096), length = new Uint16Array(4096);
  for (let c = 0; c < clear; c++) { suffix[c] = c; first[c] = c; length[c] = 1; }
  let size = minSize + 1, next = eoi + 1, prev = -1;
  let block = 0, bits = 0, acc = 0, op = 0;
  for (;;) {
    // Refill from the data sub-blocks; running out (or a terminator) ends the frame.
    while (bits < size) {
      if (!block) {
        block = buf[p++] ?? 0;
        if (!block) return op;
      }
      if (p >= buf.length) return op;
      acc |= buf[p++] << bits;
      bits += 8;
      block--;
    }
    const code = acc & ((1 << size) - 1);
    acc >>>= size;
    bits -= size;
    if (code === clear) { size = minSize + 1; next = eoi + 1; prev = -1; continue; }
    if (code === eoi) return op;
    let c = code;
    if (prev < 0) {
      if (code >= clear) return op; // only a literal can follow a clear code
    } else if (code > next || (code === next && next >= 4096)) {
      return op; // not in the table: corrupt data
    } else if (next < 4096) {
      // New entry: the previous string plus the first byte of this one (of itself, when
      // the code is the entry being defined, the KwKwK case).
      prefix[next] = prev;
      first[next] = first[prev];
      suffix[next] = code === next ? first[prev] : first[code];
      length[next] = length[prev] + 1;
      if (++next === 1 << size && size < 12) size++;
    }
    // Write the string backwards; prefix[] always points at an older entry.
    const n = length[c];
    const end = Math.min(op + n, out.length);
    for (let i = op + n - 1; i >= op; i--) {
      if (i < end) out[i] = suffix[c];
      c = prefix[c];
    }
    op = end;
    prev = code;
    if (op >= out.length) return op;
  }
}

/**
 * Decodes frame `index` of an omggif GifReader onto an RGBA canvas (width x height),
 * skipping transparent pixels and anything outside the canvas.
 */
export function blitFrame(reader, bytes, index, canvas, width, height) {
  const f = reader.frameInfo(index);
  const indices = new Uint8Array(f.width * f.height);
  const decoded = decodeLzw(bytes, f.data_offset, indices);
  const trans = f.transparent_index ?? -1;
  const pal = f.palette_offset, palSize = pal === null ? 0 : f.palette_size;
  const rows = [];
  if (f.interlaced) for (const [start, step] of INTERLACE) for (let r = start; r < f.height; r += step) rows.push(r);
  else for (let r = 0; r < f.height; r++) rows.push(r);
  for (let i = 0; i < decoded; i++) {
    const row = rows[(i / f.width) | 0], col = i % f.width;
    const x = f.x + col, y = f.y + row;
    if (x >= width || y >= height) continue;
    const k = indices[i];
    if (k === trans || k >= palSize) continue;
    const o = (y * width + x) * 4, s = pal + k * 3;
    canvas[o] = bytes[s] ?? 0; canvas[o + 1] = bytes[s + 1] ?? 0; canvas[o + 2] = bytes[s + 2] ?? 0; canvas[o + 3] = 255;
  }
  return f;
}

/** Clears a frame's rectangle (disposal 2), clipped to the canvas. */
export function clearRect(canvas, width, height, { x, y, width: w, height: h }) {
  const x1 = Math.min(width, x + w);
  if (x >= x1) return;
  for (let row = y; row < Math.min(height, y + h); row++) canvas.fill(0, (row * width + x) * 4, (row * width + x1) * 4);
}
