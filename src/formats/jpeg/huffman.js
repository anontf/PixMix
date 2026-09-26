// Huffman tables for JPEG: decoding lookup, optimal table generation (ITU T.81 Annex K.2,
// the same procedure as libjpeg's jpeg_gen_optimal_table) and encoding codes.

import { PixmixError } from '../../core/params.js';

const LOOKAHEAD = 9;

/**
 * @typedef {{counts: Uint8Array, symbols: Uint8Array}} HuffSpec  counts[l] for l = 1..16
 * @typedef {{lookup: Uint16Array, maxcode: Int32Array, valptr: Int32Array, mincode: Int32Array, symbols: Uint8Array}} DecodeTable
 */

/** Parses a DHT payload into {class, id, spec} entries. */
export function parseDht(data) {
  const out = [];
  let pos = 0;
  while (pos < data.length) {
    const tc = data[pos] >> 4, th = data[pos] & 15;
    const counts = new Uint8Array(17);
    let total = 0;
    for (let l = 1; l <= 16; l++) { counts[l] = data[pos + l]; total += counts[l]; }
    if (pos + 17 + total > data.length || tc > 1 || th > 3) throw new PixmixError('Corrupt JPEG Huffman table', 'BAD_JPEG');
    out.push({ tableClass: tc, id: th, spec: { counts, symbols: data.slice(pos + 17, pos + 17 + total) } });
    pos += 17 + total;
  }
  return out;
}

/** @param {HuffSpec} spec @returns {DecodeTable} */
export function buildDecodeTable({ counts, symbols }) {
  const lookup = new Uint16Array(1 << LOOKAHEAD);
  const maxcode = new Int32Array(18).fill(-1);
  const valptr = new Int32Array(17);
  const mincode = new Int32Array(17);
  let code = 0, k = 0;
  for (let l = 1; l <= 16; l++) {
    valptr[l] = k;
    mincode[l] = code;
    for (let i = 0; i < counts[l]; i++, k++, code++) {
      if (l <= LOOKAHEAD) {
        const shift = LOOKAHEAD - l;
        const base = code << shift;
        for (let j = 0; j < 1 << shift; j++) lookup[base + j] = (l << 8) | symbols[k];
      }
    }
    maxcode[l] = counts[l] ? code - 1 : -1;
    code <<= 1;
  }
  maxcode[17] = 0x7fffffff;
  return { lookup, maxcode, valptr, mincode, symbols };
}

/**
 * Optimal code lengths for the given symbol frequencies, limited to 16 bits and never
 * using the all-ones code (Annex K.2).
 * @param {Uint32Array} freq 257 entries (index 256 is reserved internally)
 * @returns {HuffSpec}
 */
export function buildOptimalSpec(freq) {
  const f = Array.from(freq);
  f[256] = 1; // reserves one code point so no real code is all ones
  const codesize = new Array(257).fill(0);
  const others = new Array(257).fill(-1);
  for (;;) {
    let c1 = -1, c2 = -1, v = Infinity;
    for (let i = 0; i <= 256; i++) if (f[i] && f[i] <= v) { v = f[i]; c1 = i; }
    v = Infinity;
    for (let i = 0; i <= 256; i++) if (f[i] && f[i] <= v && i !== c1) { v = f[i]; c2 = i; }
    if (c2 < 0) break;
    f[c1] += f[c2];
    f[c2] = 0;
    codesize[c1]++;
    while (others[c1] >= 0) { c1 = others[c1]; codesize[c1]++; }
    others[c1] = c2;
    codesize[c2]++;
    while (others[c2] >= 0) { c2 = others[c2]; codesize[c2]++; }
  }
  const bits = new Array(33).fill(0);
  for (let i = 0; i <= 256; i++) if (codesize[i]) bits[codesize[i]]++;
  for (let i = 32; i > 16; i--) {
    while (bits[i] > 0) {
      let j = i - 2;
      while (bits[j] === 0) j--;
      bits[i] -= 2;
      bits[i - 1]++;
      bits[j + 1] += 2;
      bits[j]--;
    }
  }
  let i = 16;
  while (bits[i] === 0) i--;
  bits[i]--; // drop the reserved symbol
  const counts = new Uint8Array(17);
  for (let l = 1; l <= 16; l++) counts[l] = bits[l];
  const symbols = [];
  for (let size = 1; size <= 32; size++) for (let s = 0; s < 256; s++) if (codesize[s] === size) symbols.push(s);
  return { counts, symbols: Uint8Array.from(symbols) };
}

/** @param {HuffSpec} spec @returns {{code: Uint16Array, size: Uint8Array}} indexed by symbol */
export function buildEncodeTable({ counts, symbols }) {
  const code = new Uint16Array(256);
  const size = new Uint8Array(256);
  let c = 0, k = 0;
  for (let l = 1; l <= 16; l++) {
    for (let i = 0; i < counts[l]; i++, k++, c++) { code[symbols[k]] = c; size[symbols[k]] = l; }
    c <<= 1;
  }
  return { code, size };
}

/** DHT payload for a list of {tableClass, id, spec}. */
export function writeDht(tables) {
  const parts = [];
  for (const { tableClass, id, spec } of tables) {
    parts.push((tableClass << 4) | id, ...spec.counts.subarray(1), ...spec.symbols);
  }
  return Uint8Array.from(parts);
}

/** Bit writer with 0xFF byte stuffing. */
export class BitWriter {
  constructor(capacity = 1 << 16) {
    this.buf = new Uint8Array(capacity);
    this.pos = 0;
    this.acc = 0;
    this.n = 0;
  }

  put(code, size) {
    if (!size) return;
    this.acc = (this.acc << size) | (code & ((1 << size) - 1));
    this.n += size;
    while (this.n >= 8) {
      const byte = (this.acc >>> (this.n - 8)) & 255;
      this.byte(byte);
      if (byte === 0xff) this.byte(0);
      this.n -= 8;
    }
    this.acc &= (1 << this.n) - 1;
  }

  byte(b) {
    if (this.pos === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.pos++] = b;
  }

  /** Pads with 1-bits to a byte boundary. */
  flush() {
    if (this.n) this.put((1 << (8 - this.n)) - 1, 8 - this.n);
  }

  /** Byte-aligns and writes an RSTn marker. */
  restart(n) {
    this.flush();
    this.byte(0xff);
    this.byte(0xd0 + (n & 7));
  }

  result() {
    this.flush();
    return this.buf.subarray(0, this.pos);
  }
}

// The example tables of Annex K.3 (luminance = table 0, chrominance = table 1), as DHT
// payloads without the class/id byte. libjpeg decodes a scan with an undefined table 0 or 1
// with these, which Motion-JPEG frames rely on: they carry no DHT at all.
const STANDARD = [
  [
    '00010501010101010100000000000000000102030405060708090a0b',
    '00030101010101010101010000000000000102030405060708090a0b',
  ],
  [
    '0002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9fa',
    '00020102040403040705040400010277000102031104052131061241510761711322328108144291a1b1c109233352f0156272d10a162434e125f11718191a262728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a82838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9fa',
  ],
];
const standardCache = [[], []];

/** The Annex K decoding table for class 0 (DC) / 1 (AC) and id 0 or 1, else undefined. */
export function standardTable(tableClass, id) {
  if (id > 1) return undefined;
  if (!standardCache[tableClass][id]) {
    const hex = STANDARD[tableClass][id];
    const data = Uint8Array.from({ length: hex.length / 2 + 1 }, (_, i) => (i ? parseInt(hex.substr(i * 2 - 2, 2), 16) : 0));
    standardCache[tableClass][id] = buildDecodeTable(parseDht(data)[0].spec);
  }
  return standardCache[tableClass][id];
}
