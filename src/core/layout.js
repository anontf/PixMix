// The permutation, expressed as a pixel map shared by every format:
//   scrambled pixel i  <-  original pixel map[i]
//
// pixel mode: one Fisher–Yates shuffle over all pixels.
// block mode: full BxB tiles are shuffled among themselves; the leftover right/bottom
//             strips (when the size is not a multiple of B) are shuffled pixel by pixel.
// The RNG is consumed in exactly that order (tiles, then leftovers); changing it breaks
// compatibility with existing images, so bump the marker version if you ever do.

import { ChaChaRng } from './prng.js';
import { deriveSeed } from './params.js';

/**
 * @typedef {object} Layout
 * @property {number} width
 * @property {number} height
 * @property {Uint32Array} map   scrambled index -> original index
 * @property {{size: number, cols: number, rows: number, perm: Uint32Array} | null} tiles
 *           block mode: perm[slot] = original tile index shown in that slot
 * @property {Uint8Array} check
 */

/** @returns {Layout} */
export function computeLayout(key, params, width, height) {
  const { rngKey, nonce, check } = deriveSeed(key, params, width, height);
  const rng = new ChaChaRng(rngKey, nonce);
  const total = width * height;
  if (total > 0xffffffff) throw new RangeError('Image too large');
  const map = new Uint32Array(total);

  if (params.mode === 'pixel') {
    for (let i = 0; i < total; i++) map[i] = i;
    shuffle(map, rng);
    return { width, height, map, tiles: null, check };
  }

  const size = params.block;
  const cols = Math.floor(width / size);
  const rows = Math.floor(height / size);
  const perm = new Uint32Array(cols * rows);
  for (let i = 0; i < perm.length; i++) perm[i] = i;
  shuffle(perm, rng);

  for (let slot = 0; slot < perm.length; slot++) {
    const src = perm[slot];
    const sx = (slot % cols) * size, sy = Math.floor(slot / cols) * size;
    const ox = (src % cols) * size, oy = Math.floor(src / cols) * size;
    for (let dy = 0; dy < size; dy++) {
      const s = (sy + dy) * width + sx;
      const o = (oy + dy) * width + ox;
      for (let dx = 0; dx < size; dx++) map[s + dx] = o + dx;
    }
  }

  // Leftover strips: collect their indices, shuffle, and map them onto each other.
  const tiledW = cols * size, tiledH = rows * size;
  const rest = new Uint32Array(total - tiledW * tiledH);
  let n = 0;
  for (let y = 0; y < height; y++) {
    const x0 = y < tiledH ? tiledW : 0;
    for (let x = x0; x < width; x++) rest[n++] = y * width + x;
  }
  const shuffled = rest.slice();
  shuffle(shuffled, rng);
  for (let i = 0; i < n; i++) map[rest[i]] = shuffled[i];

  return { width, height, map, tiles: { size, cols, rows, perm }, check };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.below(i + 1);
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
}

/**
 * Moves whole pixels of `bpp` bytes. direction 'scramble': dst[i] = src[map[i]];
 * 'unscramble': dst[map[i]] = src[i].
 * @param {Uint8Array} src @param {Uint32Array} map @param {number} bpp
 * @param {'scramble'|'unscramble'} direction
 */
export function applyMap(src, map, bpp, direction) {
  const dst = new Uint8Array(src.length);
  const fwd = direction === 'scramble';
  const n = map.length;
  if (bpp === 1) {
    if (fwd) for (let i = 0; i < n; i++) dst[i] = src[map[i]];
    else for (let i = 0; i < n; i++) dst[map[i]] = src[i];
  } else if (bpp === 4 && src.byteOffset % 4 === 0) {
    const s = new Uint32Array(src.buffer, src.byteOffset, n);
    const d = new Uint32Array(dst.buffer, 0, n);
    if (fwd) for (let i = 0; i < n; i++) d[i] = s[map[i]];
    else for (let i = 0; i < n; i++) d[map[i]] = s[i];
  } else if (bpp === 2 && src.byteOffset % 2 === 0) {
    const s = new Uint16Array(src.buffer, src.byteOffset, n);
    const d = new Uint16Array(dst.buffer, 0, n);
    if (fwd) for (let i = 0; i < n; i++) d[i] = s[map[i]];
    else for (let i = 0; i < n; i++) d[map[i]] = s[i];
  } else if (bpp === 3) {
    for (let i = 0; i < n; i++) {
      const a = (fwd ? map[i] : i) * 3;
      const b = (fwd ? i : map[i]) * 3;
      dst[b] = src[a]; dst[b + 1] = src[a + 1]; dst[b + 2] = src[a + 2];
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = (fwd ? map[i] : i) * bpp;
      const b = (fwd ? i : map[i]) * bpp;
      for (let k = 0; k < bpp; k++) dst[b + k] = src[a + k];
    }
  }
  return dst;
}

/**
 * Permutation of a grid of units (JPEG MCUs), plus an optional per-slot transform code
 * drawn after the permutation: bit 0 = flip X, bit 1 = flip Y, bit 2 = transpose
 * (applied first). `transformCount` is 1 (none), 4 (flips) or 8 (flips + transposes).
 * @returns {{perm: Uint32Array, transforms: Uint8Array|null, check: Uint8Array}}
 *          perm[slot] = original unit index shown in that slot
 */
export function computeGridLayout(key, params, cols, rows, transformCount = 1) {
  const { rngKey, nonce, check } = deriveSeed(key, params, cols, rows);
  const rng = new ChaChaRng(rngKey, nonce);
  const perm = new Uint32Array(cols * rows);
  for (let i = 0; i < perm.length; i++) perm[i] = i;
  shuffle(perm, rng);
  let transforms = null;
  if (transformCount > 1) {
    transforms = new Uint8Array(perm.length);
    for (let i = 0; i < perm.length; i++) transforms[i] = rng.below(transformCount);
  }
  return { perm, transforms, check };
}

/** Inverse of a transform code (flip X/Y swap roles when a transpose is involved). */
export function invertTransform(t) {
  const fx = t & 1, fy = (t >> 1) & 1;
  return t & 4 && fx !== fy ? 4 | (fy) | (fx << 1) : t;
}
