// Pixels -> quantized DCT coefficients (a Frame the entropy encoder can write).
// JFIF YCbCr, optional 4:2:0 / 4:2:2 chroma subsampling, IJG quality scaling of the Annex K
// tables, and the AAN float forward DCT (as in libjpeg's jfdctflt.c).

import { ZIGZAG } from './decode.js';
import { M } from './markers.js';

const STD_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const STD_CHROMA = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];
const AAN = [1, 1.387039845, 1.306562965, 1.175875602, 1, 0.785694958, 0.5411961, 0.275899379];

function scaleTable(base, quality) {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - q * 2;
  return base.map((b) => Math.min(255, Math.max(1, Math.floor((b * scale + 50) / 100))));
}

/**
 * @param {{width: number, height: number, data: Uint8Array}} image  RGBA8, alpha ignored
 * @param {{quality?: number, subsampling?: '4:2:0'|'4:2:2'|'4:4:4', grey?: boolean}} [opts]
 * @returns {{frame: import('./decode.js').Frame, dqt: {marker: number, data: Uint8Array}}}
 */
export function encodePixels({ width, height, data }, { quality = 90, subsampling = '4:2:0', grey = false } = {}) {
  const tables = grey ? [scaleTable(STD_LUMA, quality)] : [scaleTable(STD_LUMA, quality), scaleTable(STD_CHROMA, quality)];
  const [hmax, vmax] = grey ? [1, 1] : ({ '4:2:0': [2, 2], '4:2:2': [2, 1], '4:4:4': [1, 1] })[subsampling] ?? badSubsampling(subsampling);
  const sub = hmax > 1 || vmax > 1;
  const mcusX = Math.ceil(width / (8 * hmax)), mcusY = Math.ceil(height / (8 * vmax));

  // Full-resolution planes, edge-replicated out to whole MCUs.
  const pw = mcusX * 8 * hmax, ph = mcusY * 8 * vmax;
  const Y = new Float32Array(pw * ph);
  const Cb = grey ? null : new Float32Array(pw * ph);
  const Cr = grey ? null : new Float32Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    const sy = Math.min(y, height - 1);
    for (let x = 0; x < pw; x++) {
      const o = (sy * width + Math.min(x, width - 1)) * 4;
      const r = data[o], g = data[o + 1], b = data[o + 2];
      const i = y * pw + x;
      Y[i] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
      if (!grey) {
        Cb[i] = -0.168735892 * r - 0.331264108 * g + 0.5 * b;
        Cr[i] = 0.5 * r - 0.418687589 * g - 0.081312411 * b;
      }
    }
  }

  const specs = grey
    ? [{ id: 1, h: 1, v: 1, tq: 0, plane: Y }]
    : [
      { id: 1, h: hmax, v: vmax, tq: 0, plane: Y },
      { id: 2, h: 1, v: 1, tq: 1, plane: sub ? downsample(Cb, pw, ph, hmax, vmax) : Cb },
      { id: 3, h: 1, v: 1, tq: 1, plane: sub ? downsample(Cr, pw, ph, hmax, vmax) : Cr },
    ];

  const components = specs.map(({ id, h, v, tq, plane }) => {
    const blocksW = mcusX * h, blocksH = mcusY * v;
    const planeW = blocksW * 8;
    const coefs = new Int16Array(blocksW * blocksH * 64);
    const div = divisors(tables[tq]);
    const block = new Float32Array(64);
    for (let by = 0; by < blocksH; by++) {
      for (let bx = 0; bx < blocksW; bx++) {
        for (let y = 0; y < 8; y++) {
          const row = (by * 8 + y) * planeW + bx * 8;
          for (let x = 0; x < 8; x++) block[y * 8 + x] = plane[row + x];
        }
        fdct(block);
        const o = (by * blocksW + bx) * 64;
        for (let i = 0; i < 64; i++) {
          const q = block[i] * div[i];
          coefs[o + i] = q < 0 ? -Math.round(-q) : Math.round(q);
        }
      }
    }
    return {
      id, h, v, tq, blocksW, blocksH, coefs,
      realW: Math.ceil(Math.ceil((width * h) / hmax) / 8),
      realH: Math.ceil(Math.ceil((height * v) / vmax) / 8),
    };
  });

  const sof = [8, height >> 8, height & 255, width >> 8, width & 255, components.length];
  for (const c of components) sof.push(c.id, (c.h << 4) | c.v, c.tq);
  const dqt = [];
  tables.forEach((t, i) => { dqt.push(i); for (let k = 0; k < 64; k++) dqt.push(t[ZIGZAG[k]]); });

  return {
    frame: {
      marker: M.SOF0, sof: Uint8Array.from(sof), width, height, precision: 8,
      hmax, vmax, mcusX, mcusY, components,
    },
    dqt: { marker: M.DQT, data: Uint8Array.from(dqt) },
  };
}

function badSubsampling(s) {
  throw new RangeError(`subsampling must be 4:2:0, 4:2:2 or 4:4:4, got "${s}"`);
}

/** Box-filters a plane by fx horizontally and fy vertically (each 1 or 2). */
function downsample(plane, w, h, fx, fy) {
  const ow = w / fx, oh = h / fy;
  const out = new Float32Array(ow * oh);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let sum = 0;
      for (let dy = 0; dy < fy; dy++) for (let dx = 0; dx < fx; dx++) sum += plane[(y * fy + dy) * w + x * fx + dx];
      out[y * ow + x] = sum / (fx * fy);
    }
  }
  return out;
}

// 1 / (quantizer * AAN row scale * AAN column scale * 8), in natural order.
function divisors(table) {
  const d = new Float32Array(64);
  for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) d[v * 8 + u] = 1 / (table[v * 8 + u] * AAN[v] * AAN[u] * 8);
  return d;
}

function fdct(d) {
  for (let pass = 0; pass < 2; pass++) {
    const step = pass ? 8 : 1, stride = pass ? 1 : 8;
    for (let i = 0; i < 8; i++) {
      const b = i * stride;
      const d0 = d[b], d1 = d[b + step], d2 = d[b + 2 * step], d3 = d[b + 3 * step];
      const d4 = d[b + 4 * step], d5 = d[b + 5 * step], d6 = d[b + 6 * step], d7 = d[b + 7 * step];
      const t0 = d0 + d7, t7 = d0 - d7, t1 = d1 + d6, t6 = d1 - d6;
      const t2 = d2 + d5, t5 = d2 - d5, t3 = d3 + d4, t4 = d3 - d4;
      // even part
      let t10 = t0 + t3, t13 = t0 - t3, t11 = t1 + t2, t12 = t1 - t2;
      d[b] = t10 + t11;
      d[b + 4 * step] = t10 - t11;
      const z1 = (t12 + t13) * 0.707106781;
      d[b + 2 * step] = t13 + z1;
      d[b + 6 * step] = t13 - z1;
      // odd part
      t10 = t4 + t5; t11 = t5 + t6; t12 = t6 + t7;
      const z5 = (t10 - t12) * 0.382683433;
      const z2 = 0.5411961 * t10 + z5;
      const z4 = 1.306562965 * t12 + z5;
      const z3 = t11 * 0.707106781;
      const z11 = t7 + z3, z13 = t7 - z3;
      d[b + 5 * step] = z13 + z2;
      d[b + 3 * step] = z13 - z2;
      d[b + step] = z11 + z4;
      d[b + 7 * step] = z11 - z4;
    }
  }
}
