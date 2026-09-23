// Browser decoder: restores scrambled images on a page, with an optional animation.
//
//   <img data-pixmix src="/img/cat.scrambled.png">
//   PixMix.revealAll({ key: 'site-key', effect: 'dissolve' })
//
// The animation runs on a canvas that temporarily replaces the <img>. At the end the
// <img> gets the exactly restored PNG (as a blob: URL), so colour management, ICC
// profiles, alt text, CSS and right-click "save image" all behave as usual.

import { decode, inspect, detectFormat, PixmixError, WrongKeyError } from '../decoder.js';
import { unscramblePngDetailedAsync } from '../formats/png/index.js';
import { toRGBA8 } from './rgba.js';
import { readOrientation } from '../meta/exif.js';
import { orientationTransform, swapsAxes, browserHonoursPngOrientation } from './orient.js';

export { decode, inspect, detectFormat, PixmixError, WrongKeyError };

export const EFFECTS = ['dissolve', 'scan', 'blocks', 'none'];
const MAX_ANIMATED_TILES = 12000;

/** Like decode(), but uses the browser's native zlib streams; much faster on big images. */
export async function decodeAsync(input, { key } = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (detectFormat(bytes) !== 'png') throw new PixmixError('Only PNG is supported so far', 'UNSUPPORTED');
  return (await unscramblePngDetailedAsync(bytes, { key })).toPng();
}

/** Fetches and decodes to a blob: URL. */
export async function decodeToURL(url, { key, fetchOptions } = {}) {
  const bytes = await fetchBytes(url, fetchOptions);
  return URL.createObjectURL(new Blob([await decodeAsync(bytes, { key })], { type: 'image/png' }));
}

/**
 * Restores one <img>, animating the transition.
 * @param {HTMLImageElement} img
 * @param {object} opts
 * @param {string|Uint8Array} opts.key
 * @param {'dissolve'|'scan'|'blocks'|'none'} [opts.effect='dissolve']
 * @param {number} [opts.duration=1200] ms
 * @param {'image'|'canvas'} [opts.final='image'] keep the <img> (exact PNG) or the canvas
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
    if (detectFormat(bytes) !== 'png') throw new PixmixError('Only PNG is supported so far', 'UNSUPPORTED');
    const d = await unscramblePngDetailedAsync(bytes, { key });

    if (effect !== 'none') {
      const { width, height } = d.layout;
      const o = await effectiveOrientation(d.img, orientation);
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
      await animate(work, d, toRGBA8(d.img, d.img.pixels), { effect, duration, onProgress, present });
      if (final === 'canvas') {
        img.remove();
        canvas.dataset.pixmixState = 'done';
        return canvas;
      }
      await setImageSource(img, await d.toPng());
      img.style.display = prevDisplay;
      canvas.remove();
    } else {
      await setImageSource(img, await d.toPng());
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

async function effectiveOrientation(img, mode) {
  if (mode === 'ignore') return 1;
  const exif = img.chunks.find((c) => c.type === 'eXIf');
  const o = exif ? readOrientation(exif.data) : 1;
  if (o === 1 || mode === 'apply') return o;
  return (await browserHonoursPngOrientation()) ? o : 1;
}

async function fetchBytes(url, fetchOptions) {
  const res = await fetch(url, fetchOptions);
  if (!res.ok) throw new PixmixError(`Failed to load ${url} (${res.status})`, 'FETCH');
  return new Uint8Array(await res.arrayBuffer());
}

function setImageSource(img, pngBytes) {
  const url = URL.createObjectURL(new Blob([pngBytes], { type: 'image/png' }));
  return new Promise((resolve, reject) => {
    img.addEventListener('load', () => resolve(), { once: true });
    img.addEventListener('error', () => reject(new PixmixError('Browser failed to display restored image')), { once: true });
    img.removeAttribute('srcset');
    img.src = url;
  });
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
