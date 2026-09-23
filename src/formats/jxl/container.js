// JPEG XL files: a bare codestream (FF 0A …) or an ISO-BMFF container of boxes. Only the
// headers are parsed here; pixels go through the libjxl WASM codec (codec.js).

import { PixmixError } from '../../core/params.js';

const SIGNATURE_BOX = Uint8Array.from([0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]);
const FTYP = Uint8Array.from([0x6a, 0x78, 0x6c, 0x20, 0, 0, 0, 0, 0x6a, 0x78, 0x6c, 0x20]); // 'jxl ' 0 'jxl '

const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

export function isJxl(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0x0a) return true;
  return bytes.length >= 12 && SIGNATURE_BOX.every((v, i) => bytes[i] === v);
}

/**
 * @typedef {{type: string, data: Uint8Array}} Box
 * @returns {{container: boolean, boxes: Box[], codestream: Uint8Array}}
 */
export function readJxl(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0x0a) return { container: false, boxes: [], codestream: bytes };
  if (!isJxl(bytes)) throw new PixmixError('Not a JPEG XL file', 'BAD_JXL');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = [];
  for (let pos = 12; pos < bytes.length;) {
    if (pos + 8 > bytes.length) throw new PixmixError('Truncated JPEG XL box', 'BAD_JXL');
    let size = dv.getUint32(pos);
    const type = fourcc(bytes, pos + 4);
    let head = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(pos + 8));
      head = 16;
    } else if (size === 0) size = bytes.length - pos;
    if (size < head || pos + size > bytes.length) throw new PixmixError('Truncated JPEG XL box', 'BAD_JXL');
    boxes.push({ type, data: bytes.subarray(pos + head, pos + size) });
    pos += size;
  }
  const jxlc = boxes.find((b) => b.type === 'jxlc');
  let codestream = jxlc?.data;
  if (!codestream) {
    // Partial codestream boxes: 4-byte index (top bit marks the last one), then data.
    const parts = boxes.filter((b) => b.type === 'jxlp').map((b) => b.data.subarray(4));
    if (!parts.length) throw new PixmixError('JPEG XL container has no codestream', 'BAD_JXL');
    codestream = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { codestream.set(p, o); o += p.length; }
  }
  return { container: true, boxes, codestream };
}

/** Container with the given metadata boxes followed by the codestream. */
export function writeJxl(boxes, codestream) {
  const all = [{ type: 'ftyp', data: FTYP }, ...boxes, { type: 'jxlc', data: codestream }];
  let size = SIGNATURE_BOX.length;
  for (const b of all) size += 8 + b.data.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out.set(SIGNATURE_BOX);
  let pos = SIGNATURE_BOX.length;
  for (const b of all) {
    dv.setUint32(pos, 8 + b.data.length);
    for (let i = 0; i < 4; i++) out[pos + 4 + i] = b.type.charCodeAt(i);
    out.set(b.data, pos + 8);
    pos += 8 + b.data.length;
  }
  return out;
}

// --- codestream headers (ISO/IEC 18181-1 SizeHeader and the start of ImageMetadata) ---

class Bits {
  constructor(bytes) { this.b = bytes; this.pos = 0; }
  u(n) { // bits are read least-significant first
    let v = 0;
    for (let i = 0; i < n; i++, this.pos++) {
      const byte = this.b[this.pos >> 3];
      if (byte === undefined) throw new PixmixError('Truncated JPEG XL header', 'BAD_JXL');
      v += ((byte >> (this.pos & 7)) & 1) * 2 ** i;
    }
    return v;
  }
  bool() { return this.u(1) === 1; }
  /** U32 with four distributions, each [offset, bits]. */
  u32(d) { const [off, n] = d[this.u(2)]; return off + this.u(n); }
  enum() { return this.u32([[0, 0], [1, 0], [2, 4], [18, 6]]); }
}

const RATIOS = [null, [1, 1], [12, 10], [4, 3], [3, 2], [16, 9], [5, 4], [2, 1]];
const SIZE_U32 = [[1, 9], [1, 13], [1, 18], [1, 30]];

function sizeHeader(r) {
  const small = r.bool();
  const height = small ? (r.u(5) + 1) * 8 : r.u32(SIZE_U32);
  const ratio = r.u(3);
  const width = ratio ? Math.floor((height * RATIOS[ratio][0]) / RATIOS[ratio][1]) : small ? (r.u(5) + 1) * 8 : r.u32(SIZE_U32);
  return { width, height };
}

function bitDepth(r) {
  const float = r.bool();
  if (!float) return { float, bits: r.u32([[8, 0], [10, 0], [12, 0], [1, 6]]) };
  const bits = r.u32([[32, 0], [16, 0], [24, 0], [1, 6]]);
  r.u(4); // exponent bits - 1
  return { float, bits };
}

/**
 * Size and the headline properties of a codestream: orientation, animation, bit depth,
 * alpha, whether it is XYB (lossy) and whether its colour encoding is sRGB. Fields past
 * anything unexpected are left null rather than guessed.
 */
export function readJxlHeader(codestream) {
  const r = new Bits(codestream);
  if (r.u(16) !== 0x0aff) throw new PixmixError('Not a JPEG XL codestream', 'BAD_JXL');
  const info = { ...sizeHeader(r), orientation: 1, animated: false, bits: 8, float: false, alpha: false, lossy: null, srgb: null };
  try {
    if (r.bool()) { info.lossy = true; info.srgb = true; return info; } // all_default: 8-bit sRGB, XYB
    if (r.bool()) { // extra_fields
      info.orientation = r.u(3) + 1;
      if (r.bool()) sizeHeader(r); // intrinsic size
      if (r.bool()) { // preview
        const div8 = r.bool();
        const pd = div8 ? [[16, 0], [32, 0], [1, 5], [33, 9]] : [[1, 6], [65, 8], [321, 10], [1345, 12]];
        r.u32(pd);
        if (!r.u(3)) r.u32(pd);
      }
      if (r.bool()) { // animation
        info.animated = true;
        r.u32([[100, 0], [1000, 0], [1, 10], [1, 30]]);
        r.u32([[1, 0], [1001, 0], [1, 8], [1, 10]]);
        r.u32([[0, 0], [0, 3], [0, 16], [0, 32]]);
        r.bool();
      }
    }
    Object.assign(info, bitDepth(r));
    r.bool(); // modular_16_bit_buffer_sufficient
    const extra = r.u32([[0, 0], [1, 0], [2, 4], [1, 12]]);
    for (let i = 0; i < extra; i++) {
      if (r.bool()) { info.alpha = true; continue; } // d_alpha: default alpha channel
      const type = r.enum();
      bitDepth(r);
      r.u32([[0, 0], [3, 0], [4, 0], [1, 3]]); // dim_shift
      const nameLen = r.u32([[0, 0], [0, 4], [16, 5], [48, 10]]);
      r.u(nameLen * 8);
      if (type === 0) { info.alpha = true; r.bool(); }
      else if (type === 2) r.u(64); // spot colour: 4 x f16
      else if (type === 5) r.u32([[1, 0], [0, 2], [3, 4], [19, 8]]);
    }
    info.lossy = r.bool(); // xyb_encoded
    info.srgb = colourIsSrgb(r);
  } catch {
    // leave the remaining fields unknown
  }
  return info;
}

const CUSTOM_XY = [[0, 19], [524288, 19], [1048576, 20], [2097152, 21]];

/** ColourEncoding: true when it is (grey or RGB) with D65, sRGB primaries and sRGB transfer. */
function colourIsSrgb(r) {
  if (r.bool()) return true; // all_default = sRGB
  if (r.bool()) return false; // want_icc: an ICC profile follows, treat as not sRGB
  const space = r.enum(); // 0 RGB, 1 grey, 2 XYB, 3 unknown
  let ok = space === 0 || space === 1;
  if (space !== 2) {
    const wp = r.enum();
    if (wp === 2) { r.u32(CUSTOM_XY); r.u32(CUSTOM_XY); }
    ok &&= wp === 1;
  }
  if (space !== 1 && space !== 2) {
    const primaries = r.enum();
    if (primaries === 2) for (let i = 0; i < 6; i++) r.u32(CUSTOM_XY);
    ok &&= primaries === 1;
  }
  if (r.bool()) { r.u(24); return false; } // explicit gamma
  return ok && r.enum() === 13; // transfer function sRGB
}
