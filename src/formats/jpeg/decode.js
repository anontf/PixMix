// Huffman-coded JPEG -> quantized DCT coefficients (no IDCT). Handles baseline, extended
// and progressive scans, restart intervals and truncated data (zero-filled, like libjpeg).
//
// Coefficients are stored per component in natural (row-major) order, 64 per block, on a
// grid padded to whole MCUs so that every interleaved MCU exists.

import { M, isSof } from './markers.js';
import { parseDht, buildDecodeTable, standardTable } from './huffman.js';
import { PixmixError } from '../../core/params.js';
import { resolveLimits, checkPixels, limitError } from '../../core/limits.js';

export const ZIGZAG = Uint8Array.from([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21,
  28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61,
  54, 47, 55, 62, 63,
]);

/**
 * @typedef {object} Component
 * @property {number} id @property {number} h @property {number} v @property {number} tq
 * @property {QuantTable|null} [qt]  the table tq named when the component's first scan
 *           started (tables may be redefined between scans; decoders latch them then)
 * @property {number} blocksW @property {number} blocksH   padded to whole MCUs
 * @property {number} realW @property {number} realH       blocks a non-interleaved scan covers
 * @property {Int16Array} coefs
 *
 * @typedef {{pq: number, values: Uint16Array}} QuantTable  values in zigzag order, as in DQT
 *
 * @typedef {object} Frame
 * @property {number} marker  SOF marker of the source
 * @property {Uint8Array} sof SOF payload (copied verbatim on output)
 * @property {number} width @property {number} height @property {number} precision
 * @property {number} hmax @property {number} vmax @property {number} mcusX @property {number} mcusY
 * @property {Component[]} components
 */

/**
 * @param {import('./markers.js').Segment[]} segments
 * @param {Partial<import('../../core/limits.js').Limits>} [limits]
 * @returns {Frame}
 */
export function decodeFrame(segments, limits) {
  const { maxScans } = resolveLimits(limits);
  // Every scan is a pass over the whole image, even with no data left (it is zero-filled).
  const scans = segments.reduce((n, s) => n + (s.marker === M.SOS), 0);
  if (scans > maxScans) throw limitError(`JPEG has ${scans} scans, over the limit of ${maxScans} (limits.maxScans)`);
  const dc = [], ac = [], qt = [];
  let frame = null;
  let restartInterval = 0;
  for (const seg of segments) {
    const { marker, data } = seg;
    if (marker === M.DHT) {
      for (const t of parseDht(data)) (t.tableClass ? ac : dc)[t.id] = buildDecodeTable(t.spec);
    } else if (marker === M.DQT) {
      for (const t of parseDqt(data)) qt[t.id] = t.table;
    } else if (marker === M.DRI) {
      restartInterval = (data[0] << 8) | data[1];
    } else if (isSof(marker)) {
      if (frame) throw new PixmixError('JPEG has more than one frame', 'UNSUPPORTED');
      frame = parseSof(marker, data, limits);
    } else if (marker === M.SOS) {
      if (!frame) throw new PixmixError('JPEG scan before frame header', 'BAD_JPEG');
      for (let i = 0; i < data[0]; i++) {
        const c = frame.components.find((x) => x.id === data[1 + i * 2]);
        if (c && c.qt === undefined) c.qt = qt[c.tq] ?? null;
      }
      decodeScan(frame, data, seg.ecs, dc, ac, restartInterval);
    } else if (marker === M.DNL) {
      throw new PixmixError('JPEG with DNL marker is not supported', 'UNSUPPORTED');
    }
  }
  if (!frame) throw new PixmixError('JPEG has no frame header', 'BAD_JPEG');
  return frame;
}

/** DQT payload -> [{id, table}]; a truncated table ends the list (the segment is kept as is). */
export function parseDqt(data) {
  const out = [];
  for (let pos = 0; pos < data.length;) {
    const pq = data[pos] >> 4, id = data[pos] & 15;
    const size = pq ? 2 : 1;
    if (pq > 1 || id > 3 || pos + 1 + 64 * size > data.length) break;
    const values = new Uint16Array(64);
    for (let k = 0; k < 64; k++) values[k] = pq ? (data[pos + 1 + 2 * k] << 8) | data[pos + 2 + 2 * k] : data[pos + 1 + k];
    out.push({ id, table: { pq, values } });
    pos += 1 + 64 * size;
  }
  return out;
}

const sameTable = (a, b) => !!a && !!b && a.values.every((v, k) => v === b.values[k]);

/**
 * pixmix writes every DQT in front of the frame, where the last definition of a table id
 * wins. A file that redefines a table between scans (legal: each component uses the table
 * as it was when its first scan started) would then decode differently. Such files get
 * one DQT with the tables the components really used, redefined ones moved to free ids,
 * and a frame header pointing at them: the same image.
 * @param {import('./markers.js').Segment[]} segments @param {Frame} frame
 * @returns {{segments: import('./markers.js').Segment[], frame: Frame}}
 */
export function normalizeQuantTables(segments, frame) {
  const final = [];
  for (const seg of segments) if (seg.marker === M.DQT) for (const t of parseDqt(seg.data)) final[t.id] = t.table;
  const moved = frame.components.filter((c) => c.qt && !sameTable(c.qt, final[c.tq]));
  if (!moved.length) return { segments, frame };
  const slots = [];
  for (const c of frame.components) if (!moved.includes(c) && final[c.tq]) slots[c.tq] = final[c.tq];
  const tq = new Map();
  for (const c of moved) {
    let id = slots.findIndex((t) => sameTable(t, c.qt));
    if (id < 0) {
      id = [0, 1, 2, 3].find((i) => !slots[i]); // each component holds at most one id: one is free
      slots[id] = c.qt;
    }
    tq.set(c, id);
  }
  const dqt = [];
  slots.forEach((t, id) => {
    if (!t) return;
    const pq = t.pq || t.values.some((v) => v > 255) ? 1 : 0;
    dqt.push((pq << 4) | id);
    for (const v of t.values) pq ? dqt.push(v >> 8, v & 255) : dqt.push(v);
  });
  const sof = frame.sof.slice();
  const components = frame.components.map((c, i) => {
    if (!tq.has(c)) return c;
    sof[8 + i * 3] = tq.get(c);
    return { ...c, tq: tq.get(c) };
  });
  const first = segments.findIndex((s) => s.marker === M.DQT);
  const out = segments.filter((s, i) => s.marker !== M.DQT || i === first);
  out[out.indexOf(segments[first])] = { marker: M.DQT, data: Uint8Array.from(dqt) };
  return { segments: out, frame: { ...frame, sof, components } };
}

function parseSof(marker, data, limits) {
  if (marker !== M.SOF0 && marker !== M.SOF1 && marker !== M.SOF2) {
    const kind = marker === 0xc3 || marker === 0xc7 || marker === 0xcb || marker === 0xcf ? 'lossless'
      : marker >= 0xc9 ? 'arithmetic-coded' : 'hierarchical';
    throw new PixmixError(`${kind} JPEG is not supported`, 'UNSUPPORTED');
  }
  const precision = data[0];
  if (precision !== 8) throw new PixmixError(`${precision}-bit JPEG is not supported`, 'UNSUPPORTED');
  const height = (data[1] << 8) | data[2];
  const width = (data[3] << 8) | data[4];
  if (!height) throw new PixmixError('JPEG with height defined by DNL is not supported', 'UNSUPPORTED');
  checkPixels(width, height, limits);
  const n = data[5];
  if (!n || n > 4) throw new PixmixError(`JPEG with ${n} components is not supported`, 'UNSUPPORTED');
  if (data.length < 6 + 3 * n) throw new PixmixError('Truncated JPEG frame header', 'BAD_JPEG');
  const raw = [];
  for (let i = 0; i < n; i++) {
    const o = 6 + i * 3;
    raw.push({ id: data[o], h: data[o + 1] >> 4, v: data[o + 1] & 15, tq: data[o + 2] });
  }
  // Sampling factors are 1-4 (B.2.2); a 0 made the MCU grid infinite.
  if (raw.some((c) => c.h < 1 || c.h > 4 || c.v < 1 || c.v > 4)) throw new PixmixError('Invalid JPEG sampling factors', 'BAD_JPEG');
  // A single-component frame is never interleaved: its MCU is one block, whatever the
  // sampling factors say.
  if (n === 1) { raw[0].h = 1; raw[0].v = 1; }
  const hmax = Math.max(...raw.map((c) => c.h));
  const vmax = Math.max(...raw.map((c) => c.v));
  const mcusX = Math.ceil(width / (8 * hmax));
  const mcusY = Math.ceil(height / (8 * vmax));
  const components = raw.map((c) => {
    const blocksW = mcusX * c.h, blocksH = mcusY * c.v;
    return {
      ...c,
      blocksW,
      blocksH,
      realW: Math.ceil(Math.ceil((width * c.h) / hmax) / 8),
      realH: Math.ceil(Math.ceil((height * c.v) / vmax) / 8),
      coefs: new Int16Array(blocksW * blocksH * 64),
    };
  });
  return { marker, sof: data, width, height, precision, hmax, vmax, mcusX, mcusY, components };
}

class BitReader {
  constructor(data) {
    this.data = data;
    this.pos = 0;
    this.buf = 0;
    this.cnt = 0;
    this.eof = false; // hit a marker or the end: feeding zeros from here
  }

  fill() {
    while (this.cnt <= 23) {
      let b = 0;
      if (this.pos < this.data.length) {
        b = this.data[this.pos];
        if (b === 0xff) {
          const next = this.data[this.pos + 1];
          if (next === 0) this.pos += 2;
          else { b = 0; this.eof = true; } // marker: do not consume
        } else this.pos++;
      } else this.eof = true;
      this.buf = ((this.buf << 8) | b) >>> 0;
      this.cnt += 8;
    }
  }

  bits(n) {
    if (!n) return 0;
    if (this.cnt < n) this.fill();
    this.cnt -= n;
    const v = (this.buf >>> this.cnt) & ((1 << n) - 1);
    this.buf &= (1 << this.cnt) - 1;
    return v;
  }

  bit() { return this.bits(1); }

  /** Signed value of the given magnitude category (F.2.2.1 EXTEND). */
  extend(s) {
    if (!s) return 0;
    const v = this.bits(s);
    return v < 1 << (s - 1) ? v - (1 << s) + 1 : v;
  }

  /** @param {import('./huffman.js').DecodeTable} t */
  huff(t) {
    if (this.cnt < 16) this.fill();
    const peek = (this.buf >>> (this.cnt - 9)) & 511;
    const e = t.lookup[peek];
    if (e) {
      this.cnt -= e >> 8;
      this.buf &= (1 << this.cnt) - 1;
      return e & 255;
    }
    const code16 = (this.buf >>> (this.cnt - 16)) & 0xffff;
    for (let l = 10; l <= 16; l++) {
      const code = code16 >>> (16 - l);
      if (code <= t.maxcode[l]) {
        this.cnt -= l;
        this.buf &= (1 << this.cnt) - 1;
        return t.symbols[t.valptr[l] + code - t.mincode[l]];
      }
    }
    if (this.eof) return 0; // zero-filled tail
    throw new PixmixError('Corrupt JPEG data (bad Huffman code)', 'BAD_JPEG');
  }

  /** Discards buffered bits and skips past the next RSTn marker. */
  restart() {
    this.buf = 0;
    this.cnt = 0;
    this.eof = false;
    const d = this.data;
    while (this.pos + 1 < d.length && !(d[this.pos] === 0xff && d[this.pos + 1] >= 0xd0 && d[this.pos + 1] <= 0xd7)) this.pos++;
    this.pos += 2;
  }
}

function decodeScan(frame, header, ecs, dcTables, acTables, restartInterval) {
  const ns = header[0];
  const comps = [];
  for (let i = 0; i < ns; i++) {
    const id = header[1 + i * 2], tables = header[2 + i * 2];
    const c = frame.components.find((x) => x.id === id);
    if (!c) throw new PixmixError('JPEG scan references an unknown component', 'BAD_JPEG');
    // Like libjpeg, an undefined table 0 or 1 is the Annex K one (Motion-JPEG has no DHT).
    const dc = dcTables[tables >> 4] ?? standardTable(0, tables >> 4);
    const ac = acTables[tables & 15] ?? standardTable(1, tables & 15);
    comps.push({ c, dc, ac, pred: 0 });
  }
  const o = 1 + ns * 2;
  const ss = header[o], se = header[o + 1], ah = header[o + 2] >> 4, al = header[o + 2] & 15;
  const progressive = frame.marker === M.SOF2;
  const needDc = !progressive || (ss === 0 && ah === 0);
  const needAc = !progressive || ss > 0;
  for (const sc of comps) {
    if ((needDc && !sc.dc) || (needAc && !sc.ac)) throw new PixmixError('JPEG scan uses an undefined Huffman table', 'BAD_JPEG');
  }
  const r = new BitReader(ecs);
  // Progressive state carried across blocks: EOB run length, and the AC refinement
  // state machine (0 = read symbol, 1 = skip ZRL zeros, 2 = skip zeros then set,
  // 3 = set next zero, 4 = inside an EOB run).
  let eobrun = 0, state = 0, nextValue = 0, zeros = 0;

  let decodeBlock;
  if (!progressive) {
    decodeBlock = (sc, blk) => {
      const coefs = sc.c.coefs;
      const t = r.huff(sc.dc);
      sc.pred += r.extend(t);
      coefs[blk] = sc.pred;
      for (let k = 1; k < 64;) {
        const rs = r.huff(sc.ac);
        const s = rs & 15, run = rs >> 4;
        if (!s) {
          if (run < 15) break;
          k += 16;
          continue;
        }
        k += run;
        if (k > 63) break;
        coefs[blk + ZIGZAG[k]] = r.extend(s);
        k++;
      }
    };
  } else if (ss === 0) {
    if (ah === 0) {
      decodeBlock = (sc, blk) => {
        sc.pred += r.extend(r.huff(sc.dc));
        sc.c.coefs[blk] = sc.pred * (1 << al);
      };
    } else {
      decodeBlock = (sc, blk) => { if (r.bit()) sc.c.coefs[blk] |= 1 << al; };
    }
  } else if (ah === 0) {
    decodeBlock = (sc, blk) => {
      if (eobrun > 0) { eobrun--; return; }
      const coefs = sc.c.coefs;
      for (let k = ss; k <= se;) {
        const rs = r.huff(sc.ac);
        const s = rs & 15, run = rs >> 4;
        if (!s) {
          if (run < 15) { eobrun = (1 << run) - 1 + r.bits(run); break; }
          k += 16;
          continue;
        }
        k += run;
        if (k > 63) break;
        coefs[blk + ZIGZAG[k]] = r.extend(s) * (1 << al);
        k++;
      }
    };
  } else {
    // AC successive approximation refinement (G.1.2.3); same result as libjpeg's
    // decode_mcu_AC_refine, written as a state machine over coefficient positions.
    decodeBlock = (sc, blk) => {
      const coefs = sc.c.coefs;
      const p1 = 1 << al, m1 = -1 << al;
      for (let k = ss; k <= se; k++) {
        const z = blk + ZIGZAG[k];
        const cur = coefs[z];
        switch (state) {
          case 0: {
            const rs = r.huff(sc.ac);
            const s = rs & 15;
            zeros = rs >> 4;
            if (!s) {
              if (zeros < 15) { eobrun = r.bits(zeros) + (1 << zeros); state = 4; }
              else { zeros = 16; state = 1; }
            } else {
              nextValue = r.bit() ? p1 : m1;
              state = zeros ? 2 : 3;
            }
            k--; // re-examine this coefficient in the new state
            continue;
          }
          case 1:
          case 2:
            if (cur) { if (r.bit() && (cur & p1) === 0) coefs[z] = cur >= 0 ? cur + p1 : cur + m1; }
            else if (--zeros === 0) state = state === 2 ? 3 : 0;
            break;
          case 3:
            if (cur) { if (r.bit() && (cur & p1) === 0) coefs[z] = cur >= 0 ? cur + p1 : cur + m1; }
            else { coefs[z] = nextValue; state = 0; }
            break;
          default: // 4: inside an EOB run, only refine existing coefficients
            if (cur && r.bit() && (cur & p1) === 0) coefs[z] = cur >= 0 ? cur + p1 : cur + m1;
        }
      }
      if (state === 4 && --eobrun === 0) state = 0;
    };
  }

  const reset = () => { for (const sc of comps) sc.pred = 0; eobrun = 0; state = 0; };
  let mcu = 0;
  const maybeRestart = () => {
    mcu++;
    if (restartInterval && mcu % restartInterval === 0) { r.restart(); reset(); }
  };

  if (comps.length === 1) {
    const sc = comps[0];
    const { realW, realH, blocksW } = sc.c;
    for (let by = 0; by < realH; by++) {
      for (let bx = 0; bx < realW; bx++) {
        decodeBlock(sc, (by * blocksW + bx) * 64);
        maybeRestart();
      }
    }
  } else {
    for (let my = 0; my < frame.mcusY; my++) {
      for (let mx = 0; mx < frame.mcusX; mx++) {
        for (const sc of comps) {
          const { h, v, blocksW } = sc.c;
          for (let y = 0; y < v; y++) {
            for (let x = 0; x < h; x++) decodeBlock(sc, ((my * v + y) * blocksW + mx * h + x) * 64);
          }
        }
        maybeRestart();
      }
    }
  }
}
