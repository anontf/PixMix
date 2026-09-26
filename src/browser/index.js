// Browser decoder: restores scrambled images on a page, with an optional animation.
//
//   <img data-pixmix src="/img/cat.scrambled.png">   (PNG, JPEG or JPEG XL)
//   PixMix.revealAll({ key: 'site-key', effect: 'dissolve' })
//
// The animation runs on a canvas that temporarily replaces the <img>. At the end the
// <img> gets the exactly restored file (as a blob: URL), so colour management, ICC
// profiles, alt text, CSS and right-click "save image" all behave as usual.
//
// Watermarks: when the file carries one (or `watermark` names one), it is drawn onto the
// restored image; the animation ends by fading it in, and the <img> gets the watermarked
// file. The painter (dist/pixmix-watermark.mjs) is only fetched when that happens.

import {
  decode, decodeAsync as decodeAnyAsync, inspect, detectFormat, configureJxl, configureWatermarks, configureMetadata, PixmixError, WrongKeyError, DEFAULT_LIMITS,
} from '../decoder.js';
import { loadMetadataTools } from '../meta/load.js';
import { unscramblePngDetailedAsync } from '../formats/png/index.js';
import { computeAnywhere } from './worker-client.js';
import { readOrientation } from '../meta/exif.js';
import { resolveLimits, checkInputSize } from '../core/limits.js';
import { orientationTransform, swapsAxes, browserHonoursPngOrientation } from './orient.js';

export { decode, inspect, detectFormat, configureJxl, configureWatermarks, configureMetadata, PixmixError, WrongKeyError, DEFAULT_LIMITS };

export const EFFECTS = ['dissolve', 'scan', 'blocks', 'none'];
const MAX_ANIMATED_TILES = 12000;
const TYPES = { png: 'image/png', jpeg: 'image/jpeg' };

/**
 * Restores the original file, in its own format. Uses the browser's native zlib streams
 * for PNG. JPEG XL comes back as lossless JPEG XL, which needs the JPEG XL encoder too;
 * for display, decodeToURL (a PNG for JPEG XL) is cheaper.
 */
export async function decodeAsync(input, { key, limits, watermark, watermarkBase, fetchOptions, metadata, onMetadata } = {}) {
  let bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const format = detectFormat(bytes);
  if (!watermark) {
    if (format === 'png') {
      checkInputSize(bytes, limits);
      if (metadata) {
        const r = (await loadMetadataTools()).applyMetadata(bytes, metadata, { limits });
        onMetadata?.(r.report);
        bytes = r.bytes;
      }
      return (await unscramblePngDetailedAsync(bytes, { key, limits })).toPng();
    }
    return decodeAnyAsync(bytes, { key, limits, metadata, onMetadata });
  }
  // Exact restoring stays the default; a watermark is only drawn when asked for.
  return decodeAnyAsync(bytes, { key, limits, watermark, metadata, onMetadata, resolveWatermark: (id) => fetchWatermark(id, watermarkBase, fetchOptions) });
}

/**
 * The restored image in a form every browser displays: PNG and JPEG as they are; JPEG XL
 * (which most browsers cannot show) as a lossless PNG of its pixels (an APNG when it is
 * animated), or, on the JPEG route, as the original JPEG. Needs only the JPEG XL decoder.
 * @returns {Promise<{bytes: Uint8Array, type: string}>}
 */
export async function restoreForDisplay(input, { key, worker, limits, watermark = false, watermarkBase, fetchOptions, metadata } = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const wm = await watermarkFor(watermark, bytes, watermarkBase, fetchOptions, limits);
  const job = await prepare(bytes, key, 'ignore', false, worker, limits, wm, metadata);
  return { bytes: job.restored(), type: job.type };
}

/** Fetches, restores for display (see restoreForDisplay) and returns a blob: URL. */
export async function decodeToURL(url, { key, fetchOptions, worker, limits, watermark, watermarkBase, metadata } = {}) {
  const { bytes, type } = await restoreForDisplay(await fetchBytes(url, fetchOptions, limits), { key, worker, limits, watermark, watermarkBase, fetchOptions, metadata });
  return URL.createObjectURL(new Blob([bytes], { type }));
}

// --- watermarks ---------------------------------------------------------------------

const fetched = new Map();

/**
 * A compiled watermark from an id (fetched from `${base}${id}.json`, base defaulting to
 * "watermarks/" next to the page) or a URL. Cached per URL.
 */
export function fetchWatermark(ref, base = 'watermarks/', fetchOptions) {
  const page = typeof document !== 'undefined' ? document.baseURI : globalThis.location?.href;
  const url = /[/:]|\.json$/.test(ref) ? new URL(ref, page) : new URL(`${encodeURIComponent(ref)}.json`, new URL(base, page));
  if (!fetched.has(url.href)) {
    fetched.set(url.href, fetch(url, fetchOptions).then(async (res) => {
      if (!res.ok) throw new PixmixError(`Failed to load watermark ${url.href} (${res.status})`, 'FETCH');
      return res.json();
    }).catch((err) => { fetched.delete(url.href); throw err; }));
  }
  return fetched.get(url.href);
}

/**
 * What to draw: false / 'none' nothing; undefined / 'auto' / true / 'embedded' the file's own
 * watermark if it carries one (its id is looked up when it carries no more than that); an
 * id or URL string; or a compiled watermark object.
 * @returns {Promise<object|'embedded'|null>}
 */
async function watermarkFor(spec, bytes, base, fetchOptions, limits) {
  if (spec === false || spec === null || spec === '' || spec === 'none') return null;
  if (spec === undefined || spec === true || spec === 'auto' || spec === 'embedded') {
    const info = inspect(bytes, { limits }).watermark;
    if (!info) return null;
    return info.embedded ? 'embedded' : fetchWatermark(info.id, base, fetchOptions);
  }
  if (typeof spec === 'string') return fetchWatermark(spec, base, fetchOptions);
  if (!spec.format && typeof spec.id === 'string') return fetchWatermark(spec.id, base, fetchOptions);
  return spec;
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
 * @param {boolean|string} [opts.worker=true] decode in a Web Worker (falls back to the main
 *        thread when one cannot start); a string is the worker script's URL
 * @param {object|string|boolean} [opts.watermark='auto'] drawn on the revealed image: 'auto'
 *        the file's own if it carries one, false none, an id / URL, or a compiled watermark;
 *        data-pixmix-watermark overrides it per image
 * @param {string} [opts.watermarkBase='watermarks/'] where ids are looked up (id.json)
 * @param {Partial<import('../core/limits.js').Limits>} [opts.limits] resource limits for the
 *        fetched file (see core/limits.js); the download stops at maxInputBytes
 * @param {object|string} [opts.metadata] a metadata policy for the file the <img> gets (a
 *        preset name or a policy object, see meta/policy.js); the pixels stay exact
 */
export async function reveal(img, opts = {}) {
  const {
    key: optKey,
    duration = 1200,
    final = 'image',
    onProgress,
    fetchOptions,
    orientation = 'auto',
    worker = true,
    limits,
    metadata,
  } = opts;
  const key = img.dataset.pixmixKey ?? optKey;
  let effect = img.dataset.pixmixEffect ?? opts.effect ?? 'dissolve';
  if (!EFFECTS.includes(effect)) throw new PixmixError(`Unknown effect "${effect}"`);
  if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) effect = 'none';

  const url = opts.src ?? img.dataset.pixmixSrc ?? (img.currentSrc || img.src);
  img.dataset.pixmixState = 'decoding';
  try {
    const bytes = await fetchBytes(url, fetchOptions, limits);
    // A watermark that cannot be had never stops the image itself from showing.
    const wm = await watermarkFor(img.dataset.pixmixWatermark ?? opts.watermark, bytes, opts.watermarkBase, fetchOptions, limits)
      .catch((err) => { console.warn('[pixmix] watermark:', err.message); return null; });
    const job = await prepare(bytes, key, orientation, effect !== 'none', worker, limits, wm, metadata);
    if (job.watermarkError) console.warn('[pixmix] watermark:', job.watermarkError);

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
      if (job.overlay) await fadeIn(work, job.overlay, Math.min(400, Math.max(150, duration / 4)), present);
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
 * Decodes (in a worker when possible) and sets up the format-specific animation.
 * @returns {Promise<{width: number, height: number, o: number, type: string,
 *   restored: () => Uint8Array, animate?: Function}>}
 */
async function prepare(bytes, key, orientation, animated, worker = true, limits, watermark = null, metadata) {
  const r = await computeAnywhere(bytes, key, { animated, worker, limits, watermark, metadata });
  const { width, height } = r.layout;
  const restored = () => r.restored;
  const wm = { overlay: r.overlay ?? null, watermarkError: r.watermarkError };
  if (r.kind === 'pixels') {
    const o = await effectiveOrientation(r.exif, orientation, browserHonoursPngOrientation);
    return { width, height, o, type: r.type, restored, ...wm, animate: (work, opts) => animate(work, r, r.scrambled, opts) };
  }
  let o = await effectiveOrientation(r.exif, orientation, async () => true);
  if (!animated) return { width, height, o, type: r.type, restored, ...wm };
  // Browsers decode JPEGs already oriented; undo that to get the stored pixel grid.
  const [orig, scr] = await Promise.all([loadImage(r.restored, r.type), loadImage(r.scrambled, r.type)]);
  if (swapsAxes(o) && orig.naturalWidth === width) o = 1; // this browser did not apply it
  return {
    width, height, o, type: r.type, restored, ...wm,
    animate: (work, opts) => animateJpeg(work, r.layout, toRaw(scr, width, height, o), toRaw(orig, width, height, o), opts),
  };
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

/** The response body, read no further than limits.maxInputBytes. */
async function fetchBytes(url, fetchOptions, limits) {
  const { maxInputBytes } = resolveLimits(limits);
  const res = await fetch(url, fetchOptions);
  if (!res.ok) throw new PixmixError(`Failed to load ${url} (${res.status})`, 'FETCH');
  const tooLarge = (n) => checkInputSize({ length: n }, limits);
  const declared = Number(res.headers?.get?.('Content-Length'));
  if (declared > maxInputBytes) { res.body?.cancel?.().catch(() => {}); tooLarge(declared); }
  if (!res.body?.getReader) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    checkInputSize(bytes, limits);
    return bytes;
  }
  const reader = res.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > maxInputBytes) { reader.cancel().catch(() => {}); tooLarge(n); }
    parts.push(value);
  }
  const bytes = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { bytes.set(p, o); o += p.length; }
  return bytes;
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

/** @param {{layout: object}} d  PNG / JPEG XL pixel-route result */
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
  const { size, cols, rows, perm, transforms } = tiles;
  const count = perm.length;

  // Tiles are drawn from the restored image, each starting at its scrambled slot in its
  // scrambled orientation and turning back as it flies home (like JPEG MCUs).
  const src32 = new Uint32Array(scrambledRGBA.buffer);
  const restored = new Uint8ClampedArray(scrambledRGBA.length);
  const restored32 = new Uint32Array(restored.buffer);
  for (let i = 0; i < src32.length; i++) restored32[map[i]] = src32[i];
  const sheet = document.createElement('canvas');
  sheet.width = width;
  sheet.height = height;
  sheet.getContext('2d').putImageData(new ImageData(restored, width, height), 0, 0);

  // Leftover strips (not covered by whole tiles) dissolve underneath the moving tiles.
  const tiledW = cols * size, tiledH = rows * size;
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
  const half = size / 2;
  const moves = Array.from({ length: count }, (_, slot) => {
    const t = perm[slot];
    return {
      sx: (slot % cols) * size + half, sy: Math.floor(slot / cols) * size + half,
      hx: (t % cols) * size, hy: Math.floor(t / cols) * size,
      start: (t / count) * (1 - travel),
      ...decompose(transforms ? transforms[slot] : 0),
    };
  });

  let restDone = 0;
  return frames(duration, (t) => {
    const target = t >= 1 ? rest.length : Math.floor(easeInOut(t) * rest.length);
    for (let k = restDone; k < target; k++) back32[map[rest[k]]] = src32[rest[k]];
    restDone = target;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.putImageData(back, 0, 0);

    // Layering: waiting tiles, then settled ones on top, then the ones in flight.
    for (let pass = 0; pass < 3; pass++) {
      for (const k of moves) {
        const local = t >= 1 ? 1 : Math.min(1, Math.max(0, (t - k.start) / travel));
        const layer = local <= 0 ? 0 : local >= 1 ? 1 : 2;
        if (layer !== pass) continue;
        if (layer === 1) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawImage(sheet, k.hx, k.hy, size, size, k.hx, k.hy, size, size);
          continue;
        }
        const e = easeInOut(local);
        const cx = k.sx + (k.hx + half - k.sx) * e;
        const cy = k.sy + (k.hy + half - k.sy) * e;
        const angle = k.angle * (1 - e);
        const flip = k.flip + (1 - k.flip) * e;
        const cos = Math.cos(angle), sin = Math.sin(angle);
        ctx.setTransform(cos * flip, sin * flip, -sin, cos, cx, cy);
        ctx.drawImage(sheet, k.hx, k.hy, size, size, -half, -half, size, size);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    present?.();
    onProgress?.(t);
  });
}

/** Fades the watermark (drawn into the final file already) in over the finished animation. */
function fadeIn(work, { x, y, width, height, rgba }, duration, present) {
  const sheet = document.createElement('canvas');
  sheet.width = width;
  sheet.height = height;
  sheet.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  const ctx = work.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const under = ctx.getImageData(x, y, width, height);
  return frames(duration, (t) => {
    ctx.putImageData(under, x, y);
    ctx.globalAlpha = t;
    ctx.drawImage(sheet, x, y);
    ctx.globalAlpha = 1;
    present?.();
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
