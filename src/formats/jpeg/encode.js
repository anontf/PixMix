// Quantized DCT coefficients -> Huffman JPEG, baseline (one interleaved scan, or one per
// component when the MCU is too large to interleave) or progressive
// (spectral selection), with Huffman tables optimised for the data (two passes, like
// jpegtran -optimize). Everything that is not entropy coding (APPn, COM, DQT, the SOF
// payload) is supplied by the caller and written back unchanged.

import { M, writeSegments } from './markers.js';
import { ZIGZAG } from './decode.js';
import { buildOptimalSpec, buildEncodeTable, writeDht, BitWriter } from './huffman.js';
import { PixmixError } from '../../core/params.js';

const category = (v) => (v ? 32 - Math.clz32(v < 0 ? -v : v) : 0);

// An AC symbol holds the category in 4 bits. A coefficient of -32768 (category 16) only
// comes from corrupt data that overflowed on decoding; coding it would garble the stream.
const acCategory = (v) => {
  const c = category(v);
  if (c > 15) throw new PixmixError('JPEG coefficient out of range (corrupt data)', 'BAD_JPEG');
  return c;
};

// Decoders keep the DC predictor as an int and store it as a 16-bit coefficient, so only
// a difference mod 2^16 matters. Corrupt data whose predictor overflowed decodes to
// coefficients whose differences can need 16 bits, which no DC table codes: write the
// difference wrapped into 15 bits instead, which decodes to the same coefficients. Only
// a difference of exactly 2^15 has no such form.
const dcDiff = (dc, pred) => {
  const d = ((dc - pred + 0x8000) & 0xffff) - 0x8000;
  if (d === -0x8000) throw new PixmixError('JPEG DC coefficient out of range (corrupt data)', 'BAD_JPEG');
  return d;
};

/**
 * Whether the frame can be coded in one interleaved scan: T.81 B.2.3 (and libjpeg) limit
 * an interleaved MCU to 10 blocks. Larger layouts (e.g. every component sampled 2x2) are
 * only legal as one scan per component.
 */
export const interleavable = (frame) => frame.components.length === 1
  || frame.components.reduce((n, c) => n + c.h * c.v, 0) <= 10;

/**
 * One baseline scan: every component interleaved, or with `only` just that component
 * (non-interleaved: its real blocks, in raster order).
 * @param {import('./decode.js').Frame} frame
 * @param {{restartInterval?: number, only?: number}} [opts]  restart markers are only for tests
 * @returns {{dht: Uint8Array, sos: Uint8Array, ecs: Uint8Array, dri: Uint8Array|null}}
 */
export function encodeScan(frame, { restartInterval = 0, only } = {}) {
  const comps = only === undefined ? frame.components : [frame.components[only]];
  // Luma table 0, chroma table 1 (baseline allows 2).
  const tableOf = (i) => ((only ?? i) === 0 ? 0 : 1);
  const tables = [...new Set(comps.map((_, i) => tableOf(i)))];

  const walk = (visit) => {
    const pred = new Int32Array(comps.length);
    let mcu = 0;
    const tick = () => {
      if (restartInterval && ++mcu % restartInterval === 0 && mcu < totalMcus) { pred.fill(0); visit(-1, 0, mcu / restartInterval - 1, pred); }
    };
    let totalMcus;
    if (comps.length === 1) {
      const { realW, realH, blocksW } = comps[0];
      totalMcus = realW * realH;
      for (let by = 0; by < realH; by++) {
        for (let bx = 0; bx < realW; bx++) { visit(0, (by * blocksW + bx) * 64, 0, pred); tick(); }
      }
    } else {
      totalMcus = frame.mcusX * frame.mcusY;
      for (let my = 0; my < frame.mcusY; my++) {
        for (let mx = 0; mx < frame.mcusX; mx++) {
          for (let ci = 0; ci < comps.length; ci++) {
            const { h, v, blocksW } = comps[ci];
            for (let y = 0; y < v; y++) {
              for (let x = 0; x < h; x++) visit(ci, ((my * v + y) * blocksW + mx * h + x) * 64, 0, pred);
            }
          }
          tick();
        }
      }
    }
  };

  // Pass 1: symbol statistics.
  const dcFreq = [0, 1].map(() => new Uint32Array(257));
  const acFreq = [0, 1].map(() => new Uint32Array(257));
  walk((ci, blk, _r, pred) => {
    if (ci < 0) return;
    const coefs = comps[ci].coefs, t = tableOf(ci);
    const dc = coefs[blk];
    dcFreq[t][category(dcDiff(dc, pred[ci]))]++;
    pred[ci] = dc;
    let run = 0;
    for (let k = 1; k < 64; k++) {
      const v = coefs[blk + ZIGZAG[k]];
      if (!v) { run++; continue; }
      while (run > 15) { acFreq[t][0xf0]++; run -= 16; }
      acFreq[t][(run << 4) | acCategory(v)]++;
      run = 0;
    }
    if (run) acFreq[t][0]++;
  });

  const specs = [];
  const dcEnc = [], acEnc = [];
  for (const t of tables) {
    const dcSpec = buildOptimalSpec(dcFreq[t]);
    const acSpec = buildOptimalSpec(acFreq[t]);
    specs.push({ tableClass: 0, id: t, spec: dcSpec }, { tableClass: 1, id: t, spec: acSpec });
    dcEnc[t] = buildEncodeTable(dcSpec);
    acEnc[t] = buildEncodeTable(acSpec);
  }

  // Pass 2: emit.
  const w = new BitWriter(Math.max(1 << 16, frame.width * frame.height));
  walk((ci, blk, rst, pred) => {
    if (ci < 0) { w.restart(rst); return; }
    const coefs = comps[ci].coefs, t = tableOf(ci);
    const dcT = dcEnc[t], acT = acEnc[t];
    const dc = coefs[blk];
    const diff = dcDiff(dc, pred[ci]);
    pred[ci] = dc;
    const s = category(diff);
    w.put(dcT.code[s], dcT.size[s]);
    if (s) w.put(diff < 0 ? diff - 1 : diff, s);
    let run = 0;
    for (let k = 1; k < 64; k++) {
      const v = coefs[blk + ZIGZAG[k]];
      if (!v) { run++; continue; }
      while (run > 15) { w.put(acT.code[0xf0], acT.size[0xf0]); run -= 16; }
      const cat = acCategory(v);
      const sym = (run << 4) | cat;
      w.put(acT.code[sym], acT.size[sym]);
      w.put(v < 0 ? v - 1 : v, cat);
      run = 0;
    }
    if (run) w.put(acT.code[0], acT.size[0]);
  });

  const sos = [comps.length];
  comps.forEach((c, i) => sos.push(c.id, (tableOf(i) << 4) | tableOf(i)));
  sos.push(0, 63, 0);
  return {
    dht: writeDht(specs),
    sos: Uint8Array.from(sos),
    ecs: w.result(),
    dri: restartInterval ? Uint8Array.from([restartInterval >> 8, restartInterval & 255]) : null,
  };
}

/**
 * SOF payload for the output: the original bytes, which only change marker (baseline
 * SOF0 unless a 16-bit quantisation table requires extended SOF1).
 */
export function sofMarkerFor(dqtSegments) {
  for (const seg of dqtSegments) {
    for (let pos = 0; pos < seg.data.length;) {
      const pq = seg.data[pos] >> 4;
      if (pq) return M.SOF1;
      pos += 1 + 64 * (pq + 1);
    }
  }
  return M.SOF0;
}

// --- progressive -------------------------------------------------------------------

/**
 * Scan script: DC of all components first (one interleaved scan, or one per component when
 * the MCU is too large to interleave), then AC bands per component, luma's low frequencies
 * early. Spectral selection only (Ah = Al = 0), which every progressive decoder handles
 * and keeps coefficients exact.
 */
function progressiveScript(n, interleaved) {
  if (n === 1) return [{ comps: [0], ss: 0, se: 0 }, { comps: [0], ss: 1, se: 5 }, { comps: [0], ss: 6, se: 63 }];
  const all = [...Array(n).keys()];
  const dc = interleaved ? [{ comps: all, ss: 0, se: 0 }] : all.map((c) => ({ comps: [c], ss: 0, se: 0 }));
  const script = [...dc, { comps: [0], ss: 1, se: 5 }];
  for (let c = 1; c < n; c++) script.push({ comps: [c], ss: 1, se: 63 });
  script.push({ comps: [0], ss: 6, se: 63 });
  return script;
}

/** Visits one scan's blocks in the order a decoder expects them. */
function walkScan(frame, comps, visit) {
  const cs = comps.map((i) => frame.components[i]);
  if (cs.length === 1) {
    const c = cs[0];
    for (let by = 0; by < c.realH; by++) for (let bx = 0; bx < c.realW; bx++) visit(0, (by * c.blocksW + bx) * 64);
    return;
  }
  for (let my = 0; my < frame.mcusY; my++) {
    for (let mx = 0; mx < frame.mcusX; mx++) {
      cs.forEach((c, ci) => {
        for (let y = 0; y < c.v; y++) for (let x = 0; x < c.h; x++) visit(ci, ((my * c.v + y) * c.blocksW + mx * c.h + x) * 64);
      });
    }
  }
}

/**
 * Runs one scan through `put(tableSlot, symbol, extraBits, extraCount)`; slot = the index
 * of the component within the scan. Called once to count symbols and once to write.
 */
function codeScan(frame, { comps, ss, se }, put) {
  const cs = comps.map((i) => frame.components[i]);
  if (ss === 0) {
    const pred = new Int32Array(cs.length);
    walkScan(frame, comps, (ci, blk) => {
      const dc = cs[ci].coefs[blk];
      const diff = dcDiff(dc, pred[ci]);
      pred[ci] = dc;
      const s = category(diff);
      put(ci, s, diff < 0 ? diff - 1 : diff, s);
    });
    return;
  }
  let eobrun = 0;
  const flush = () => {
    if (!eobrun) return;
    const nbits = 31 - Math.clz32(eobrun);
    put(0, nbits << 4, eobrun - (1 << nbits), nbits);
    eobrun = 0;
  };
  const coefs = cs[0].coefs;
  walkScan(frame, comps, (_ci, blk) => {
    let run = 0;
    for (let k = ss; k <= se; k++) {
      const v = coefs[blk + ZIGZAG[k]];
      if (!v) { run++; continue; }
      flush();
      while (run > 15) { put(0, 0xf0, 0, 0); run -= 16; }
      const cat = acCategory(v);
      put(0, (run << 4) | cat, v < 0 ? v - 1 : v, cat);
      run = 0;
    }
    if (run && ++eobrun === 0x7fff) flush();
  });
  flush();
}

/** Progressive scans: [{dht, sos, ecs}] with tables optimised per scan. */
export function encodeProgressive(frame) {
  const out = [];
  for (const scan of progressiveScript(frame.components.length, interleavable(frame))) {
    const dc = scan.ss === 0;
    // DC scans: luma table 0, chroma table 1; an AC scan has one component, table 0.
    const tableOf = (slot) => (dc && scan.comps[slot] !== 0 ? 1 : 0);
    const freq = [0, 1].map(() => new Uint32Array(257));
    codeScan(frame, scan, (slot, sym) => { freq[tableOf(slot)][sym]++; });
    const used = [...new Set(scan.comps.map((_, slot) => tableOf(slot)))];
    const specs = used.map((t) => ({ tableClass: dc ? 0 : 1, id: t, spec: buildOptimalSpec(freq[t]) }));
    const enc = [];
    for (const s of specs) enc[s.id] = buildEncodeTable(s.spec);
    const w = new BitWriter();
    codeScan(frame, scan, (slot, sym, bits, n) => {
      const t = enc[tableOf(slot)];
      w.put(t.code[sym], t.size[sym]);
      if (n) w.put(bits, n);
    });
    const sos = [scan.comps.length];
    scan.comps.forEach((c, slot) => sos.push(frame.components[c].id, dc ? tableOf(slot) << 4 : tableOf(slot)));
    sos.push(scan.ss, scan.se, 0);
    out.push({ dht: writeDht(specs), sos: Uint8Array.from(sos), ecs: w.result() });
  }
  return out;
}

/**
 * Builds a complete JPEG from metadata/table segments (kept verbatim) and a frame.
 * @param {import('./markers.js').Segment[]} header  APPn, COM, DQT … in output order
 * @param {import('./decode.js').Frame} frame
 * @param {{marker?: Uint8Array, extra?: Uint8Array[], restartInterval?: number, progressive?: boolean}} [opts]
 *        marker: APP15 payload; extra: more APP15 payloads after it; progressive: write SOF2
 *        with progressive scans
 */
export function assembleJpeg(header, frame, { marker, extra = [], restartInterval, progressive = false } = {}) {
  const out = [...header];
  if (marker || extra.length) {
    let at = 0;
    while (at < out.length && out[at].marker >= 0xe0 && out[at].marker <= 0xef) at++;
    out.splice(at, 0, ...[...(marker ? [marker] : []), ...extra].map((data) => ({ marker: M.APP15, data })));
  }
  if (progressive) {
    out.push({ marker: M.SOF2, data: frame.sof });
    for (const { dht, sos, ecs } of encodeProgressive(frame)) {
      out.push({ marker: M.DHT, data: dht }, { marker: M.SOS, data: sos, ecs });
    }
    return writeSegments(out);
  }
  out.push({ marker: sofMarkerFor(header.filter((s) => s.marker === M.DQT)), data: frame.sof });
  const scans = interleavable(frame) ? [encodeScan(frame, { restartInterval })]
    : frame.components.map((_, only) => encodeScan(frame, { restartInterval, only }));
  if (scans[0].dri) out.push({ marker: M.DRI, data: scans[0].dri });
  for (const { dht, sos, ecs } of scans) out.push({ marker: M.DHT, data: dht }, { marker: M.SOS, data: sos, ecs });
  return writeSegments(out);
}
