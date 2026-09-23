// Browser decoder: restores scrambled images on a page, with an optional animation.
//
//   <img data-pixmix src="/img/cat.scrambled.png">   (PNG, JPEG or JPEG XL)
//   PixMix.revealAll({ key: 'site-key', effect: 'dissolve' })
//
// The animation runs on a canvas that temporarily replaces the <img>. At the end the
// <img> gets the exactly restored file (as a blob: URL), so colour management, ICC
// profiles, alt text, CSS and right-click "save image" all behave as usual.

import { decode, decodeAsync as decodeAnyAsync, inspect, detectFormat, configureJxl, PixmixError, WrongKeyError } from '../decoder.js';
import { unscramblePngDetailedAsync } from '../formats/png/index.js';
import { unscrambleJpegDetailed } from '../formats/jpeg/index.js';
import { unscrambleJxlDetailed, reconstructJpeg } from '../formats/jxl/index.js';
import { writeChunks } from '../formats/png/chunks.js';
import { encodeRasterAsync } from '../formats/png/raster.js';
import { toRGBA8 } from '../formats/png/rgba.js';
import { readOrientation } from '../meta/exif.js';
import { orientationTransform, swapsAxes, browserHonoursPngOrientation } from './orient.js';

export { decode, inspect, detectFormat, configureJxl, PixmixError, WrongKeyError };

export const EFFECTS = ['dissolve', 'scan', 'blocks', 'none'];
const MAX_ANIMATED_TILES = 12000;
const TYPES = { png: 'image/png', jpeg: 'image/jpeg' };

/**
 * Restores the original file, in its own format. Uses the browser's native zlib streams
 * for PNG. JPEG XL comes back as lossless JPEG XL, which needs the JPEG XL encoder too;
 * for display, decodeToURL (a PNG for JPEG XL) is cheaper.
 */
export async function decodeAsync(input, { key } = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const format = detectFormat(bytes);
  if (format === 'png') return (await unscramblePngDetailedAsync(bytes, { key })).toPng();
  return decodeAnyAsync(bytes, { key });
}

/**
 * Fetches and decodes to a blob: URL an <img> can show: the original PNG/JPEG, or for
 * JPEG XL (which most browsers cannot display) a lossless PNG of its pixels.
 */
export async function decodeToURL(url, { key, fetchOptions } = {}) {
  const bytes = await fetchBytes(url, fetchOptions);
  const job = await prepare(bytes, key, 'ignore', false);
  return URL.createObjectURL(new Blob([await job.restored()], { type: job.type }));
}

/**
 * Restores one <img>, animating the transition.
 * @param {HTMLImageElement} img
 * @param {object} opts
 * @param {string|Uint8Array} opts.key
 * @param {'dissolve'|'scan'|'blocks'|'none'} [opts.effect='dissolve']
 * @param {number} [opts.duration=1200] ms
 * @param {'image'|'canvas'} [opts.final='image'] keep the <img> (exact file) or the canvas
 * @param {string} [opts.src] defaults to data-pixmix-src, then the image's own src
 * @param {(p: number) => void} [opts.onProgress]
 * @param {RequestInit} [opts.fetchOptions]
 * @param {'auto'|'apply'|'ignore'} [opts.orientation='auto'] EXIF orientation during the
 *        animation; 'auto' matches whatever this browser does for the final <img>
 */
export async function reveal(img, opts = {}) {
  const {
    key: optKey,
    duration = 1200,
    final = 'image',
    onProgress,
    fetchOptions,
    orientation = 'auto',
  } = opts;
  const key = img.dataset.pixmixKey ?? optKey;
  let effect = img.dataset.pixmixEffect ?? opts.effect ?? 'dissolve';
  if (!EFFECTS.includes(effect)) throw new PixmixError(`Unknown effect "${effect}"`);
  if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) effect = 'none';

  const url = opts.src ?? img.dataset.pixmixSrc ?? (img.currentSrc || img.src);
  img.dataset.pixmixState = 'decoding';
  try {
    const bytes = await fetchBytes(url, fetchOptions);
    const job = await prepare(bytes, key, orientation, effect !== 'none');

    if (effect !== 'none') {
      const { width, height, o } = job;
      const canvas = document.createElement('canvas');
      canvas.width = swapsAxes(o) ? height : width;
      canvas.height = swapsAxes(o) ? width : height;
      // Frames are drawn unrotated; with an orientation they go to an off-screen canvas
      // and are copied through the EXIF transform after each frame.
      let work = canvas, present;
      if (o !== 1) {
        work = document.createElement('canvas');
        work.width = width;
        work.height = height;
        const vctx = canvas.getContext('2d');
        const m = orientationTransform(o, width, height);
        present = () => {
          vctx.setTransform(1, 0, 0, 1, 0, 0);
          vctx.clearRect(0, 0, canvas.width, canvas.height);
          vctx.setTransform(...m);
          vctx.drawImage(work, 0, 0);
        };
      }
      for (const attr of ['class', 'style', 'width', 'height']) {
        const v = img.getAttribute(attr);
        if (v !== null) canvas.setAttribute(attr, v);
      }
      if (img.alt) { canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', img.alt); }
      const prevDisplay = img.style.display;
      img.before(canvas);
      img.style.display = 'none';
      await job.animate(work, { effect, duration, onProgress, present });
      if (final === 'canvas') {
        img.remove();
        canvas.dataset.pixmixState = 'done';
        return canvas;
      }
      await setImageSource(img, await job.restored(), job.type);
      img.style.display = prevDisplay;
      canvas.remove();
    } else {
      await setImageSource(img, await job.restored(), job.type);
      onProgress?.(1);
    }
    img.dataset.pixmixState = 'done';
    return img;
  } catch (err) {
    img.dataset.pixmixState = 'error';
    throw err;
  }
}

/**
 * Decodes and sets up the format-specific animation.
 * @returns {Promise<{width: number, height: number, o: number, type: string,
 *   restored: () => Promise<Uint8Array>|Uint8Array, animate: Function}>}
 */
async function prepare(bytes, key, orientation, animated) {
  const format = detectFormat(bytes);
  if (format === 'png') {
    const d = await unscramblePngDetailedAsync(bytes, { key });
    const exif = d.img.chunks.find((c) => c.type === 'eXIf');
    const o = await effectiveOrientation(exif?.data, orientation, browserHonoursPngOrientation);
    return {
      width: d.layout.width,
      height: d.layout.height,
      o,
      type: TYPES.png,
      restored: d.toPng,
      animate: (work, opts) => animate(work, d, toRGBA8(d.img, d.img.pixels), opts),
    };
  }
  if (format === 'jpeg') {
    const d = unscrambleJpegDetailed(bytes, { key });
    const restored = d.toJpeg();
    const { width, height } = d.layout;
    const app1 = d.segments.find((s) => s.marker === 0xe1 && s.data[0] === 0x45 && s.data[4] === 0 && s.data[5] === 0);
    let o = await effectiveOrientation(app1?.data.subarray(6), orientation, async () => true);
    if (!animated) return { width, height, o, type: TYPES.jpeg, restored: () => restored };
    // Browsers decode JPEGs already oriented; undo that to get the stored pixel grid.
    const [orig, scr] = await Promise.all([loadImage(restored, TYPES.jpeg), loadImage(bytes, TYPES.jpeg)]);
    if (swapsAxes(o) && orig.naturalWidth === width) o = 1; // this browser did not apply it
    return {
      width, height, o, type: TYPES.jpeg,
      restored: () => restored,
      animate: (work, opts) => animateJpeg(work, d.layout, toRaw(scr, width, height, o), toRaw(orig, width, height, o), opts),
    };
  }
  if (format === 'jxl') {
    // JPEG route: rebuild the scrambled JPEG (WASM) and reveal that; visitors get the JPEG.
    if (inspect(bytes).mode === 'mcu') {
      return prepare(await reconstructJpeg(bytes), key, orientation, animated);
    }
    // Pixel route: decoded in WASM, exact, so this animates like PNG. The <img> gets a PNG
    // of the restored pixels, since most browsers cannot display JPEG XL.
    const d = await unscrambleJxlDetailed(bytes, { key });
    const { width, height } = d.layout;
    return {
      width, height, o: 1, type: TYPES.png,
      restored: () => rgbaPng(width, height, d.pixels),
      animate: (work, opts) => animate(work, d, new Uint8ClampedArray(d.scrambled.buffer, d.scrambled.byteOffset, d.scrambled.length), opts),
    };
  }
  throw new PixmixError(`${format ? format.toUpperCase() : 'This format'} cannot be revealed`, 'UNSUPPORTED');
}

async function rgbaPng(width, height, rgba) {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = await encodeRasterAsync({ width, height, depth: 8, colorType: 6, interlace: 0 }, rgba);
  return writeChunks([{ type: 'IHDR', data: ihdr }, { type: 'IDAT', data: idat }, { type: 'IEND', data: new Uint8Array(0) }]);
}

/**
 * Reveals every matching image. With `lazy` (default), each one starts when it scrolls
 * into view, so visitors actually see the animation.
 * @returns {Promise<PromiseSettledResult<Element>[]>}
 */
export function revealAll({ selector = 'img[data-pixmix]', root = document, lazy = true, ...opts } = {}) {
  const imgs = [...root.querySelectorAll(selector)].filter((el) => !el.dataset.pixmixState);
  const run = (img) => reveal(img, opts).catch((err) => {
    console.warn('[pixmix]', img.dataset.pixmixSrc || img.src, err.message);
    throw err;
  });
  if (!lazy || typeof IntersectionObserver === 'undefined') {
    return Promise.allSettled(imgs.map(run));
  }
  return Promise.allSettled(imgs.map((img) => new Promise((resolve, reject) => {
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      run(img).then(resolve, reject);
    }, { rootMargin: '100px' });
    // A hidden <img> has no box; observe its parent until it is decoded.
    io.observe(img.getClientRects().length ? img : img.parentElement ?? img);
  })));
}

async function effectiveOrientation(exif, mode, browserHonours) {
  if (mode === 'ignore') return 1;
  const o = exif ? readOrientation(exif) : 1;
  if (o === 1 || mode === 'apply') return o;
  return (await browserHonours()) ? o : 1;
}

async function fetchBytes(url, fetchOptions) {
  const res = await fetch(url, fetchOptions);
  if (!res.ok) throw new PixmixError(`Failed to load ${url} (${res.status})`, 'FETCH');
  return new Uint8Array(await res.arrayBuffer());
}

function setImageSource(img, bytes, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  return new Promise((resolve, reject) => {
    img.addEventListener('load', () => resolve(), { once: true });
    img.addEventListener('error', () => reject(new PixmixError('Browser failed to display restored image')), { once: true });
    img.removeAttribute('srcset');
    img.src = url;
  });
}

async function loadImage(bytes, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const im = new Image();
  im.src = url;
  try {
    await im.decode();
  } finally {
    URL.revokeObjectURL(url);
  }
  return im;
}

/** Draws a (browser-oriented) image back onto the stored w x h pixel grid. */
function toRaw(im, w, h, o) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (o !== 1) ctx.setTransform(...invertAffine(orientationTransform(o, w, h)));
  ctx.drawImage(im, 0, 0);
  return c;
}

function invertAffine([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

// ---------------------------------------------------------------------------
// Animation

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

function animate(canvas, d, scrambledRGBA, { effect, duration, onProgress, present }) {
  const { width, height, map, tiles } = d.layout;
  const ctx = canvas.getContext('2d');
  const src32 = new Uint32Array(scrambledRGBA.buffer);

  if (effect === 'blocks' && tiles && tiles.perm.length && tiles.perm.length <= MAX_ANIMATED_TILES) {
    return animateBlocks(ctx, d.layout, scrambledRGBA, duration, onProgress, present);
  }

  const frame = new ImageData(scrambledRGBA.slice(), width, height);
  const frame32 = new Uint32Array(frame.data.buffer);
  const n = map.length;
  let step;
  if (effect === 'scan') {
    const inv = new Uint32Array(n);
    for (let i = 0; i < n; i++) inv[map[i]] = i;
    step = (from, to) => { for (let p = from; p < to; p++) frame32[p] = src32[inv[p]]; };
  } else {
    // Scrambled order is already random with respect to the destination.
    step = (from, to) => { for (let i = from; i < to; i++) frame32[map[i]] = src32[i]; };
  }
  ctx.putImageData(frame, 0, 0);

  let done = 0;
  return frames(duration, (t) => {
    const target = t >= 1 ? n : Math.floor(easeInOut(t) * n);
    step(done, target);
    done = target;
    ctx.putImageData(frame, 0, 0);
    present?.();
    onProgress?.(t);
  });
}

function animateBlocks(ctx, layout, scrambledRGBA, duration, onProgress, present) {
  const { width, height, map, tiles } = layout;
  const { size, cols, rows, perm } = tiles;
  const count = perm.length;

  const sheet = document.createElement('canvas');
  sheet.width = width;
  sheet.height = height;
  sheet.getContext('2d').putImageData(new ImageData(scrambledRGBA, width, height), 0, 0);

  // Leftover strips (not covered by whole tiles) dissolve underneath the moving tiles.
  const tiledW = cols * size, tiledH = rows * size;
  const src32 = new Uint32Array(scrambledRGBA.buffer);
  const back = new ImageData(width, height);
  const back32 = new Uint32Array(back.data.buffer);
  const rest = [];
  for (let y = 0; y < height; y++) {
    for (let x = y < tiledH ? tiledW : 0; x < width; x++) {
      const i = y * width + x;
      rest.push(i);
      back32[i] = src32[i];
    }
  }

  // Tiles arrive in reading order of their destination, overlapping heavily.
  const travel = 0.45;
  const moves = new Float32Array(count * 5);
  for (let slot = 0; slot < count; slot++) {
    const t = perm[slot];
    const o = slot * 5;
    moves[o] = (slot % cols) * size;
    moves[o + 1] = Math.floor(slot / cols) * size;
    moves[o + 2] = (t % cols) * size;
    moves[o + 3] = Math.floor(t / cols) * size;
    moves[o + 4] = (t / count) * (1 - travel);
  }

  let restDone = 0;
  return frames(duration, (t) => {
    const target = t >= 1 ? rest.length : Math.floor(easeInOut(t) * rest.length);
    for (let k = restDone; k < target; k++) back32[map[rest[k]]] = src32[rest[k]];
    restDone = target;
    ctx.putImageData(back, 0, 0);

    // Layering: waiting tiles, then settled ones on top, then the ones in flight.
    for (let pass = 0; pass < 3; pass++) {
      for (let slot = 0; slot < count; slot++) {
        const o = slot * 5;
        const local = t >= 1 ? 1 : Math.min(1, Math.max(0, (t - moves[o + 4]) / travel));
        const layer = local <= 0 ? 0 : local >= 1 ? 1 : 2;
        if (layer !== pass) continue;
        const e = easeInOut(local);
        const x = moves[o] + (moves[o + 2] - moves[o]) * e;
        const y = moves[o + 1] + (moves[o + 3] - moves[o + 1]) * e;
        ctx.drawImage(sheet, moves[o], moves[o + 1], size, size, x, y, size, size);
      }
    }
    present?.();
    onProgress?.(t);
  });
}

function frames(duration, draw) {
  return new Promise((resolve) => {
    const start = performance.now();
    const tick = (now) => {
      const t = duration > 0 ? Math.min(1, (now - start) / duration) : 1;
      draw(t);
      if (t < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
}

// ---------------------------------------------------------------------------
// JPEG animation. Pixels come from the browser's own decodes of the scrambled and restored
// files (JPEG can't be re-derived exactly in JS without an IDCT), in the stored grid.

function animateJpeg(work, layout, scrambled, original, { effect, duration, onProgress, present }) {
  const { width, height, perm } = layout;
  const ctx = work.getContext('2d');
  if (effect === 'blocks' && perm.length <= MAX_ANIMATED_TILES) {
    return animateMcus(ctx, layout, original, duration, onProgress, present);
  }
  const from = scrambled.getContext('2d').getImageData(0, 0, width, height);
  const to = new Uint32Array(original.getContext('2d').getImageData(0, 0, width, height).data.buffer);
  const frame32 = new Uint32Array(from.data.buffer);
  const n = width * height;
  let order = null;
  if (effect !== 'scan') {
    order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }
  }
  ctx.putImageData(from, 0, 0);
  let done = 0;
  return frames(duration, (t) => {
    const target = t >= 1 ? n : Math.floor(easeInOut(t) * n);
    if (order) for (let k = done; k < target; k++) frame32[order[k]] = to[order[k]];
    else for (let k = done; k < target; k++) frame32[k] = to[k];
    done = target;
    ctx.putImageData(from, 0, 0);
    present?.();
    onProgress?.(t);
  });
}

// Transform code (bit 0 flip X, bit 1 flip Y, bit 2 transpose first) as rotation * scaleX,
// so a tile can spin and card-flip back to upright.
function decompose(t) {
  let m = [1, 0, 0, 1]; // [m00, m01, m10, m11]
  const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3]];
  if (t & 4) m = mul([0, 1, 1, 0], m);
  if (t & 1) m = mul([-1, 0, 0, 1], m);
  if (t & 2) m = mul([1, 0, 0, -1], m);
  for (const deg of [0, 90, 180, -90]) {
    const c = Math.round(Math.cos((deg * Math.PI) / 180)), s = Math.round(Math.sin((deg * Math.PI) / 180));
    for (const sx of [1, -1]) {
      if (sx * c === m[0] && -s === m[1] && sx * s === m[2] && c === m[3]) return { angle: (deg * Math.PI) / 180, flip: sx };
    }
  }
  return { angle: 0, flip: 1 };
}

function animateMcus(ctx, layout, original, duration, onProgress, present) {
  const { width, height, perm, transforms, cols, tileW, tileH } = layout;
  const count = perm.length;
  const travel = 0.45;
  const tiles = Array.from({ length: count }, (_, slot) => {
    const t = perm[slot];
    const hx = (t % cols) * tileW, hy = Math.floor(t / cols) * tileH;
    return {
      sx: (slot % cols) * tileW + tileW / 2, sy: Math.floor(slot / cols) * tileH + tileH / 2,
      hx, hy,
      w: Math.min(tileW, width - hx), h: Math.min(tileH, height - hy),
      start: (t / count) * (1 - travel),
      ...decompose(transforms ? transforms[slot] : 0),
    };
  });
  return frames(duration, (t) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    // Layering: waiting tiles, then settled ones on top, then the ones in flight.
    for (let pass = 0; pass < 3; pass++) {
      for (const k of tiles) {
        const local = t >= 1 ? 1 : Math.min(1, Math.max(0, (t - k.start) / travel));
        const layer = local <= 0 ? 0 : local >= 1 ? 1 : 2;
        if (layer !== pass) continue;
        if (layer === 1) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawImage(original, k.hx, k.hy, k.w, k.h, k.hx, k.hy, k.w, k.h);
          continue;
        }
        const e = easeInOut(local);
        const cx = k.sx + (k.hx + tileW / 2 - k.sx) * e;
        const cy = k.sy + (k.hy + tileH / 2 - k.sy) * e;
        // M = rotate(angle) * scaleX(flip), easing to identity; flip passes through 0,
        // which reads as the tile turning over like a card.
        const angle = k.angle * (1 - e);
        const flip = k.flip + (1 - k.flip) * e;
        const cos = Math.cos(angle), sin = Math.sin(angle);
        ctx.setTransform(cos * flip, sin * flip, -sin, cos, cx, cy);
        ctx.drawImage(original, k.hx, k.hy, k.w, k.h, -tileW / 2, -tileH / 2, k.w, k.h);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    present?.();
    onProgress?.(t);
  });
}
