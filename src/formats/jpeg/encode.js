// Quantized DCT coefficients -> baseline Huffman JPEG: one interleaved scan, Huffman
// tables optimised for the data (two passes, like jpegtran -optimize). Everything that
// is not entropy coding (APPn, COM, DQT, the SOF payload) is supplied by the caller and
// written back unchanged.

import { M, writeSegments } from './markers.js';
import { ZIGZAG } from './decode.js';
import { buildOptimalSpec, buildEncodeTable, writeDht, BitWriter } from './huffman.js';

const category = (v) => (v ? 32 - Math.clz32(v < 0 ? -v : v) : 0);

/**
 * @param {import('./decode.js').Frame} frame
 * @param {{restartInterval?: number}} [opts]  restart markers are only for tests
 * @returns {{dht: Uint8Array, sos: Uint8Array, ecs: Uint8Array, dri: Uint8Array|null}}
 */
export function encodeScan(frame, { restartInterval = 0 } = {}) {
  const comps = frame.components;
  const tableOf = (i) => (i === 0 ? 0 : 1); // luma table 0, chroma table 1 (baseline allows 2)
  const nTables = comps.length > 1 ? 2 : 1;

  const walk = (visit) => {
    const pred = new Int32Array(comps.length);
    let mcu = 0;
    const tick = () => {
      if (restartInterval && ++mcu % restartInterval === 0 && mcu < totalMcus) { pred.fill(0); visit(-1, 0, mcu / restartInterval - 1, pred); }
    };
    let totalMcus;
    if (comps.length === 1) {
      const c = comps[0];
      totalMcus = c.blocksW * c.blocksH;
      for (let b = 0; b < totalMcus; b++) { visit(0, b * 64, 0, pred); tick(); }
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
    dcFreq[t][category(dc - pred[ci])]++;
    pred[ci] = dc;
    let run = 0;
    for (let k = 1; k < 64; k++) {
      const v = coefs[blk + ZIGZAG[k]];
      if (!v) { run++; continue; }
      while (run > 15) { acFreq[t][0xf0]++; run -= 16; }
      acFreq[t][(run << 4) | category(v)]++;
      run = 0;
    }
    if (run) acFreq[t][0]++;
  });

  const specs = [];
  const dcEnc = [], acEnc = [];
  for (let t = 0; t < nTables; t++) {
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
    const diff = dc - pred[ci];
    pred[ci] = dc;
    const s = category(diff);
    w.put(dcT.code[s], dcT.size[s]);
    if (s) w.put(diff < 0 ? diff - 1 : diff, s);
    let run = 0;
    for (let k = 1; k < 64; k++) {
      const v = coefs[blk + ZIGZAG[k]];
      if (!v) { run++; continue; }
      while (run > 15) { w.put(acT.code[0xf0], acT.size[0xf0]); run -= 16; }
      const cat = category(v);
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

/**
 * Builds a complete JPEG from metadata/table segments (kept verbatim) and a frame.
 * @param {import('./markers.js').Segment[]} header  APPn, COM, DQT … in output order
 * @param {import('./decode.js').Frame} frame
 * @param {{marker?: Uint8Array, restartInterval?: number}} [opts] marker: APP15 payload
 */
export function assembleJpeg(header, frame, { marker, restartInterval } = {}) {
  const { dht, sos, ecs, dri } = encodeScan(frame, { restartInterval });
  const out = [...header];
  if (marker) {
    let at = 0;
    while (at < out.length && out[at].marker >= 0xe0 && out[at].marker <= 0xef) at++;
    out.splice(at, 0, { marker: M.APP15, data: marker });
  }
  out.push({ marker: sofMarkerFor(header.filter((s) => s.marker === M.DQT)), data: frame.sof });
  out.push({ marker: M.DHT, data: dht });
  if (dri) out.push({ marker: M.DRI, data: dri });
  out.push({ marker: M.SOS, data: sos, ecs });
  return writeSegments(out);
}
