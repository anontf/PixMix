// MCU shuffling in the DCT domain. Moving whole MCUs keeps every component's blocks
// together, so colour stays attached to its luma. A transform code per slot additionally
// flips/transposes the MCU, done exactly on the coefficients:
//   flip X:    negate coefficients with odd horizontal frequency u
//   flip Y:    negate coefficients with odd vertical frequency v
//   transpose: swap (u, v)  (only when every component's MCU footprint is square)
// Nothing is requantized, so the operation is lossless and exactly reversible.

import { invertTransform } from '../../core/layout.js';

/** 8 transforms when all components have h == v (MCU is square), else the 4 flips. */
export function transformCount(frame) {
  return frame.components.every((c) => c.h === c.v) ? 8 : 4;
}

/**
 * @param {import('./decode.js').Frame} frame
 * @param {{perm: Uint32Array, transforms: Uint8Array|null}} layout perm[slot] = original MCU
 * @param {'scramble'|'unscramble'} direction
 * @returns {import('./decode.js').Frame} a new frame with moved coefficients
 */
export function applyMcuLayout(frame, { perm, transforms }, direction) {
  const fwd = direction === 'scramble';
  const { mcusX } = frame;
  const components = frame.components.map((c) => {
    const out = new Int16Array(c.coefs.length);
    const { h, v, blocksW, coefs } = c;
    for (let slot = 0; slot < perm.length; slot++) {
      const t = transforms ? (fwd ? transforms[slot] : invertTransform(transforms[slot])) : 0;
      // scramble: original MCU perm[slot] -> slot (transformed); unscramble: the reverse.
      const from = fwd ? perm[slot] : slot, to = fwd ? slot : perm[slot];
      const fx = (from % mcusX) * h, fy = Math.floor(from / mcusX) * v;
      const tx = (to % mcusX) * h, ty = Math.floor(to / mcusX) * v;
      for (let by = 0; by < v; by++) {
        for (let bx = 0; bx < h; bx++) {
          let x = bx, y = by;
          if (t & 4) { x = by; y = bx; }
          if (t & 1) x = h - 1 - x;
          if (t & 2) y = v - 1 - y;
          transformBlock(coefs, ((fy + by) * blocksW + fx + bx) * 64, out, ((ty + y) * blocksW + tx + x) * 64, t);
        }
      }
    }
    return { ...c, coefs: out };
  });
  return { ...frame, components };
}

function transformBlock(src, so, dst, d0, t) {
  if (!t) { dst.set(src.subarray(so, so + 64), d0); return; }
  const tr = t & 4, fx = t & 1, fy = t & 2;
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let val = tr ? src[so + u * 8 + v] : src[so + v * 8 + u];
      if ((fx && u & 1) ^ (fy && v & 1)) val = -val;
      dst[d0 + v * 8 + u] = val;
    }
  }
}
