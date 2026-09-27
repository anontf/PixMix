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
import { toBytes } from '../formats/index.js';
import { orientationTransform, swapsAxes, browserHonoursPngOrientation } from './orient.js';

export { decode, inspect, detectFormat, configureJxl, configureWatermarks, configureMetadata, PixmixError, WrongKeyError, DEFAULT_LIMITS };

export const EFFECTS = ['dissolve', 'scan', 'blocks', 'none'];
const TYPES = { png: 'image/png', jpeg: 'image/jpeg' };

/**
 * Restores the original file, in its own format. Uses the browser's native zlib streams
 * for PNG. JPEG XL comes back as lossless JPEG XL, which needs the JPEG XL encoder too;
 * for display, decodeToURL (a PNG for JPEG XL) is cheaper.
 */
export async function decodeAsync(input, { key, limits, watermark, watermarkBase, fetchOptions, metadata, onMetadata } = {}) {
  let bytes = toBytes(input);
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
  const bytes = toBytes(input);
  const wm = await watermarkFor(watermark, bytes, watermarkBase, fetchOptions, limits);
  const job = await prepare(bytes, key, 'ignore', 'none', worker, limits, wm, metadata);
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
    if (info.unreadable) throw new PixmixError(`The watermark this file carries cannot be read: ${info.error}`, 'BAD_WATERMARK');
    return info.embedded ? 'embedded' : fetchWatermark(info.id, base, fetchOptions);
  }
  if (typeof spec === 'string') return fetchWatermark(spec, base, fetchOptions);
  if (!spec.format && typeof spec.id === 'string') return fetchWatermark(spec.id, base, fetchOptions);
  return spec;
}

const running = new WeakMap(); // <img> -> its reveal in flight
const waiting = new WeakMap(); // <img> -> revealAll's promise while it waits to scroll into view

/**
 * Restores one <img>, animating the transition. While a reveal of the image is in flight,
 * another call joins it; on an image already revealed (still showing the restored file) it
 * does nothing.
 * @param {HTMLImageElement} img
 * @param {object} opts
 * @param {string|Uint8Array} opts.key
 * @param {'dissolve'|'scan'|'blocks'|'none'} [opts.effect='dissolve'] an unknown one plays
 *        dissolve, with a warning
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
 * @returns {Promise<HTMLImageElement|HTMLCanvasElement>}
 */
export function reveal(img, opts = {}) {
  const current = running.get(img);
  if (current) return current;
  if (img.dataset.pixmixState === 'done' && opts.src === undefined && shownBlob.has(img) && img.src === shownBlob.get(img)) {
    return Promise.resolve(img);
  }
  const job = revealNow(img, opts).finally(() => running.delete(img));
  running.set(img, job);
  return job;
}

async function revealNow(img, opts) {
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
  if (!EFFECTS.includes(effect)) {
    console.warn(`[pixmix] unknown effect "${effect}", using dissolve`);
    effect = 'dissolve';
  }
  if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) effect = 'none';

  const url = opts.src ?? img.dataset.pixmixSrc ?? (img.currentSrc || img.src);
  const candidate = srcsetCandidate(img);
  const box = renderedBox(img);
  img.dataset.pixmixState = 'decoding';
  try {
    const bytes = await fetchBytes(url, fetchOptions, limits);
    // A watermark that cannot be had never stops the image itself from showing.
    const wm = await watermarkFor(img.dataset.pixmixWatermark ?? opts.watermark, bytes, opts.watermarkBase, fetchOptions, limits)
      .catch((err) => { console.warn('[pixmix] watermark:', err.message); return null; });
    const fitPixels = box ? box.width * box.height * (globalThis.devicePixelRatio || 1) ** 2 : undefined;
    const job = await prepare(bytes, key, orientation, effect, worker, limits, wm, metadata, fitPixels);
    if (job.watermarkError) console.warn('[pixmix] watermark:', job.watermarkError);

    if (job.anim) {
      const { canvas, work, present } = standIn(img, job, box);
      const prevDisplay = img.style.display;
      img.before(canvas);
      img.style.display = 'none';
      await animateFrames(work, job.anim, { duration, onProgress, present });
      if (job.anim.fade) await fadeIn(work, job, Math.min(400, Math.max(150, duration / 4)), present);
      if (final === 'canvas') {
        if (job.anim.scale < 1) await drawFull(canvas, job);
        img.remove();
        canvas.dataset.pixmixState = 'done';
        return canvas;
      }
      await setImageSource(img, job.restored(), job.type, candidate);
      img.style.display = prevDisplay;
      canvas.remove();
    } else {
      await setImageSource(img, job.restored(), job.type, candidate);
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
 * The canvas that stands in for the <img> while animating: the same classes, style and box,
 * a bitmap of the animation's frames (the image's size, or less for a big one) in the
 * displayed orientation. Frames are drawn unrotated on `work`; with an orientation that is
 * an off-screen canvas, copied through the EXIF transform by `present` after each frame.
 */
function standIn(img, { anim, o }, box) {
  const { width, height } = anim;
  const canvas = document.createElement('canvas');
  canvas.width = swapsAxes(o) ? height : width;
  canvas.height = swapsAxes(o) ? width : height;
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
  for (const attr of ['class', 'style']) {
    const v = img.getAttribute(attr);
    if (v !== null) canvas.setAttribute(attr, v);
  }
  if (img.hidden) canvas.hidden = true;
  // Whatever sized the <img> (its attributes, CSS rules for img, srcset densities) may not
  // apply to a canvas: give it the box the <img> has. Unrendered, the attributes stand in.
  if (box) {
    canvas.style.width = `${box.width}px`;
    canvas.style.height = `${box.height}px`;
    canvas.style.boxSizing = 'content-box';
  } else {
    for (const attr of ['width', 'height']) {
      const v = img.getAttribute(attr);
      if (v !== null && !canvas.style[attr]) canvas.style[attr] = /^\s*\d+(\.\d+)?\s*$/.test(v) ? `${parseFloat(v)}px` : v;
    }
  }
  if (img.alt) { canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', img.alt); }
  return { canvas, work, present };
}

/** The <img>'s content box in CSS pixels, when it is rendered with its image loaded. */
function renderedBox(img) {
  if (typeof getComputedStyle !== 'function' || !img.complete || !img.naturalWidth || !img.getClientRects().length) return null;
  const cs = getComputedStyle(img);
  let w = parseFloat(cs.width), h = parseFloat(cs.height);
  if (cs.boxSizing === 'border-box') {
    const px = (...names) => names.reduce((sum, n) => sum + (parseFloat(cs[n]) || 0), 0);
    w -= px('paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth');
    h -= px('paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth');
  }
  return w > 0 && h > 0 ? { width: w, height: h } : null;
}

/** final: 'canvas' after an animation at a reduced size: the canvas gets the whole image. */
async function drawFull(canvas, job) {
  const im = await loadImage(job.restored(), job.type);
  canvas.width = im.naturalWidth;
  canvas.height = im.naturalHeight;
  canvas.getContext('2d').drawImage(im, 0, 0);
}

/**
 * Decodes (in a worker when possible) and gets the animation's frames ready.
 * @returns {Promise<{width: number, height: number, o: number, type: string,
 *   restored: () => Uint8Array, overlay: object|null, watermarkError?: string,
 *   anim?: import('./compute.js').Animation}>}
 */
async function prepare(bytes, key, orientation, effect, worker = true, limits, watermark = null, metadata, fitPixels) {
  const animated = effect !== 'none';
  // The watermark goes where the <img> shows it: on the unrotated image where this browser
  // ignores a PNG's EXIF orientation.
  const pngOrientation = watermark && typeof Image !== 'undefined' && detectFormat(bytes) === 'png' ? await browserHonoursPngOrientation() : true;
  const r = await computeAnywhere(bytes, key, { animated, effect, fitPixels, worker, limits, watermark, metadata, pngOrientation });
  const { width, height } = r.layout;
  const fileO = r.exif ? readOrientation(r.exif) : 1;
  // A JPEG XL is unscrambled on its stored grid and carries its header's orientation.
  const o = r.orientation ?? await effectiveOrientation(fileO, orientation, r.kind === 'pixels' ? browserHonoursPngOrientation : async () => true);
  const job = { width, height, o, type: r.type, restored: () => r.restored, overlay: r.overlay ?? null, watermarkError: r.watermarkError };
  if (!animated) return job;
  if (r.kind === 'jpeg' && !r.anim.from) await jpegFramesHere(r, fileO);
  return { ...job, anim: r.anim };
}

/**
 * JPEG frames where the worker could not decode them: from the page's own decodes, which
 * browsers orient by the EXIF; that is undone to get the stored pixel grid.
 */
async function jpegFramesHere(r, fileO) {
  const { width, height } = r.layout;
  const a = r.anim;
  const out = [];
  for (const [i, file] of [r.scrambled, a.plain ?? r.restored, a.plain ? r.restored : null].entries()) {
    if (!file) { out.push(null); continue; }
    // A scrambled file enlarged to whole MCUs is stored larger; the image is its top left.
    const w = i === 0 ? r.layout.storedWidth ?? width : width, h = i === 0 ? r.layout.storedHeight ?? height : height;
    const im = await loadImage(file, r.type);
    const applied = swapsAxes(fileO) && w !== h && im.naturalWidth === w ? 1 : fileO; // this browser did not apply it
    const raw = toRaw(im, w, h, applied, Math.round((a.width * w) / width), Math.round((a.height * h) / height));
    out.push(raw.getContext('2d').getImageData(0, 0, a.width, a.height).data);
  }
  [a.from, a.to, a.final] = out;
}

/**
 * Reveals every matching image. With `lazy` (default), each one starts when it scrolls
 * into view, so visitors actually see the animation. Images already being revealed (or
 * waiting to scroll into view for an earlier call) are joined, not revealed again.
 * @returns {Promise<PromiseSettledResult<Element>[]>}
 */
export function revealAll({ selector = 'img[data-pixmix]', root = document, lazy = true, ...opts } = {}) {
  const imgs = [...root.querySelectorAll(selector)].filter((el) => !el.dataset.pixmixState || running.has(el) || waiting.has(el));
  const run = (img) => running.get(img) ?? reveal(img, opts).catch((err) => {
    console.warn('[pixmix]', img.dataset.pixmixSrc || img.src, err.message);
    throw err;
  });
  if (!lazy || typeof IntersectionObserver === 'undefined') {
    return Promise.allSettled(imgs.map(run));
  }
  return Promise.allSettled(imgs.map((img) => running.get(img) ?? waiting.get(img) ?? whenVisible(img, run)));
}

function whenVisible(img, run) {
  const p = new Promise((resolve, reject) => {
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      waiting.delete(img);
      run(img).then(resolve, reject);
    }, { rootMargin: '100px' });
    // A hidden <img> has no box; observe its parent until it is decoded.
    io.observe(img.getClientRects().length ? img : img.parentElement ?? img);
  });
  waiting.set(img, p);
  return p;
}

async function effectiveOrientation(o, mode, browserHonours) {
  if (mode === 'ignore') return 1;
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

// --- the restored file in the <img> -------------------------------------------------

/**
 * Shows the restored file, as a blob: URL. The srcset candidate the browser had picked keeps
 * its descriptor (640w with the sizes, or its density), so the image keeps its size; a <picture>'s
 * <source>s, which would pick the scrambled file again, lose their srcset (kept in
 * data-pixmix-srcset).
 */
function setImageSource(img, bytes, type, candidate) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const sources = pictureSources(img);
  const natural = img.naturalWidth; // at the candidate's density
  return new Promise((resolve, reject) => {
    img.addEventListener('load', () => resolve(), { once: true });
    img.addEventListener('error', () => {
      for (const s of sources) s.setAttribute('srcset', s.dataset.pixmixSrcset);
      forget(img);
      reject(new PixmixError('Browser failed to display restored image', 'DISPLAY'));
    }, { once: true });
    const d = candidate?.descriptor ?? '';
    const density = /^[\d.]+x$/i.test(d) ? parseFloat(d) : 1;
    if (/^\d+w$/i.test(d)) {
      img.setAttribute('srcset', `${url} ${d}`);
      if (candidate.sizes === null) img.removeAttribute('sizes');
      else img.setAttribute('sizes', candidate.sizes);
    } else if (density !== 1 && natural) {
      // As a width: with a density descriptor, src would count as a 1x candidate.
      img.setAttribute('srcset', `${url} ${Math.round(natural * density)}w`);
      img.setAttribute('sizes', `${natural}px`);
    } else img.removeAttribute('srcset');
    for (const s of sources) {
      s.dataset.pixmixSrcset = s.getAttribute('srcset');
      s.removeAttribute('srcset');
    }
    remember(img, url);
    img.src = url;
  }).then(() => decoded(img));
}

// Shown once decoded (or after a second at most), so that the swap from the canvas does not flash.
function decoded(img) {
  if (!img.decode) return undefined;
  let timer;
  return Promise.race([img.decode().catch(() => {}), new Promise((r) => { timer = setTimeout(r, 1000); })]).finally(() => clearTimeout(timer));
}

const pictureSources = (img) => (img.parentElement?.tagName === 'PICTURE'
  ? [...img.parentElement.children].filter((el) => el.tagName === 'SOURCE' && el.hasAttribute('srcset'))
  : []);

/** The srcset candidate the <img> shows ({descriptor, sizes}), or null. */
function srcsetCandidate(img) {
  const current = img.currentSrc;
  if (!current || typeof document === 'undefined') return null;
  for (const el of [...pictureSources(img), img]) {
    const set = el.getAttribute('srcset');
    if (!set) continue;
    for (const c of parseSrcset(set)) {
      let href;
      try { href = new URL(c.url, document.baseURI).href; } catch { continue; }
      if (href === current) return { descriptor: c.descriptor, sizes: el.getAttribute('sizes') };
    }
  }
  return null;
}

/** srcset as [{url, descriptor}] (the HTML parsing rules, minus error handling). */
function parseSrcset(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    let j = i;
    while (j < s.length && !/\s/.test(s[j])) j++;
    let url = s.slice(i, j), descriptor = '';
    i = j;
    if (url.endsWith(',')) url = url.replace(/,+$/, '');
    else {
      j = s.indexOf(',', i);
      if (j < 0) j = s.length;
      descriptor = s.slice(i, j).trim();
      i = j + 1;
    }
    if (url) out.push({ url, descriptor });
  }
  return out;
}

// The blob: URLs the <img>s show are revoked once nothing can show them any more: when the
// page gives the <img> another src (or srcset), or the element is garbage-collected.
const shownBlob = new WeakMap();
const collected = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry((url) => URL.revokeObjectURL(url)) : null;
let srcWatch = null;

function remember(img, url) {
  forget(img);
  shownBlob.set(img, url);
  collected?.register(img, url, img);
  srcWatch ??= typeof MutationObserver === 'function' ? new MutationObserver(forgetReplaced) : null;
  srcWatch?.observe(img, { attributes: true, attributeFilter: ['src', 'srcset'] });
}

function forgetReplaced(records) {
  for (const { target: img } of records) {
    const url = shownBlob.get(img);
    if (url && img.getAttribute('src') !== url && !(img.getAttribute('srcset') ?? '').includes(url)) forget(img);
  }
}

function forget(img) {
  const url = shownBlob.get(img);
  if (!url) return;
  shownBlob.delete(img);
  collected?.unregister(img);
  URL.revokeObjectURL(url);
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

/**
 * Draws a (browser-oriented) image back onto the stored w x h pixel grid, where `o` is the
 * orientation the browser applied; scaled to dw x dh.
 */
function toRaw(im, w, h, o, dw = w, dh = h) {
  const c = document.createElement('canvas');
  c.width = dw;
  c.height = dh;
  const ctx = c.getContext('2d');
  const [a, b, cc, d, e, f] = invertAffine(orientationTransform(o, w, h));
  const sx = dw / w, sy = dh / h;
  if (o !== 1 || sx !== 1 || sy !== 1) ctx.setTransform(sx * a, sy * b, sx * cc, sy * d, sx * e, sy * f);
  ctx.drawImage(im, 0, 0);
  return c;
}

function invertAffine([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

// ---------------------------------------------------------------------------
// Animation: the worker sent the first and last frames (see compute.js); the page copies
// the pixels that change and draws.

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const u32 = (a) => new Uint32Array(a.buffer, a.byteOffset, a.byteLength >> 2);
const copyOf = (a) => new Uint8ClampedArray(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength));

/** @param {import('./compute.js').Animation} anim */
function animateFrames(canvas, anim, { duration, onProgress, present }) {
  const ctx = canvas.getContext('2d');
  if (anim.effect === 'blocks') return animateTiles(ctx, anim, duration, onProgress, present);
  const { width, height, order } = anim;
  const frame = new ImageData(copyOf(anim.from), width, height);
  const frame32 = u32(frame.data), to32 = u32(anim.to);
  const n = width * height;
  ctx.putImageData(frame, 0, 0);
  let done = 0;
  return frames(duration, (t) => {
    const target = t >= 1 ? n : Math.floor(easeInOut(t) * n);
    if (order) {
      for (let k = done; k < target; k++) frame32[order[k]] = to32[order[k]];
      ctx.putImageData(frame, 0, 0);
    } else if (target > done) {
      // Scan: only the rows that changed.
      frame32.set(to32.subarray(done, target), done);
      const y0 = Math.floor(done / width), y1 = Math.ceil(target / width);
      ctx.putImageData(frame, 0, 0, 0, y0, width, y1 - y0);
    }
    done = target;
    present?.();
    onProgress?.(t);
  });
}

/**
 * Blocks: tiles (PNG block mode, JPEG MCUs) are drawn from the restored image, each starting
 * at its scrambled slot in its scrambled orientation and turning back as it flies home.
 * Leftover strips that whole tiles do not cover dissolve underneath.
 */
function animateTiles(ctx, anim, duration, onProgress, present) {
  const { width, height, scale: s, tiles } = anim;
  const { perm, transforms, cols } = tiles;
  const tw = tiles.tileW * s, th = tiles.tileH * s;
  const count = perm.length;
  const sheet = document.createElement('canvas');
  sheet.width = width;
  sheet.height = height;
  sheet.getContext('2d').putImageData(new ImageData(copyOf(anim.to), width, height), 0, 0);

  const tiledW = Math.min(width, Math.round(tiles.tiledW * s)), tiledH = Math.min(height, Math.round(tiles.tiledH * s));
  const from32 = u32(anim.from), to32 = u32(anim.to);
  const back = new ImageData(width, height);
  const back32 = u32(back.data);
  const rest = [];
  for (let y = 0; y < height; y++) {
    for (let x = y < tiledH ? tiledW : 0; x < width; x++) {
      const i = y * width + x;
      rest.push(i);
      back32[i] = from32[i];
    }
  }
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = rest[i]; rest[i] = rest[j]; rest[j] = t;
  }

  // Tiles arrive in reading order of their destination, overlapping heavily.
  const travel = 0.45;
  const moves = Array.from({ length: count }, (_, slot) => {
    const t = perm[slot];
    const hx = (t % cols) * tw, hy = Math.floor(t / cols) * th;
    return {
      sx: (slot % cols) * tw + tw / 2, sy: Math.floor(slot / cols) * th + th / 2,
      hx, hy, w: Math.min(tw, width - hx), h: Math.min(th, height - hy),
      start: (t / count) * (1 - travel),
      ...decompose(transforms ? transforms[slot] : 0),
    };
  });

  let restDone = 0;
  return frames(duration, (t) => {
    const target = t >= 1 ? rest.length : Math.floor(easeInOut(t) * rest.length);
    for (let k = restDone; k < target; k++) back32[rest[k]] = to32[rest[k]];
    restDone = target;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (rest.length) ctx.putImageData(back, 0, 0);
    else ctx.clearRect(0, 0, width, height);

    // Layering: waiting tiles, then settled ones on top, then the ones in flight.
    for (let pass = 0; pass < 3; pass++) {
      for (const k of moves) {
        const local = t >= 1 ? 1 : Math.min(1, Math.max(0, (t - k.start) / travel));
        const layer = local <= 0 ? 0 : local >= 1 ? 1 : 2;
        if (layer !== pass) continue;
        if (layer === 1) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawImage(sheet, k.hx, k.hy, k.w, k.h, k.hx, k.hy, k.w, k.h);
          continue;
        }
        const e = easeInOut(local);
        const cx = k.sx + (k.hx + tw / 2 - k.sx) * e;
        const cy = k.sy + (k.hy + th / 2 - k.sy) * e;
        // M = rotate(angle) * scaleX(flip), easing to identity; flip passes through 0,
        // which reads as the tile turning over like a card.
        const angle = k.angle * (1 - e);
        const flip = k.flip + (1 - k.flip) * e;
        const cos = Math.cos(angle), sin = Math.sin(angle);
        ctx.setTransform(cos * flip, sin * flip, -sin, cos, cx, cy);
        ctx.drawImage(sheet, k.hx, k.hy, k.w, k.h, -tw / 2, -th / 2, k.w, k.h);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    present?.();
    onProgress?.(t);
  });
}

/**
 * Fades the watermark (drawn into the final file already) in over the finished animation.
 * PNG and JPEG XL: its exact RGBA over the restored pixels. JPEG, where painting requantised
 * the MCUs under it: the restored frame with it, so the last frame is the final image.
 */
function fadeIn(work, { anim, overlay }, duration, present) {
  const f = anim.fade;
  if (!f.width || !f.height) return undefined;
  const sheet = document.createElement('canvas');
  let draw;
  const ctx = work.getContext('2d');
  if (anim.final) {
    sheet.width = f.width;
    sheet.height = f.height;
    const part = new ImageData(f.width, f.height);
    const src = u32(anim.final), dst = u32(part.data);
    for (let y = 0; y < f.height; y++) dst.set(src.subarray((f.y + y) * anim.width + f.x, (f.y + y) * anim.width + f.x + f.width), y * f.width);
    sheet.getContext('2d').putImageData(part, 0, 0);
    draw = () => ctx.drawImage(sheet, f.x, f.y);
  } else if (overlay) {
    const { x, y, width, height, rgba } = overlay;
    sheet.width = width;
    sheet.height = height;
    sheet.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
    const s = anim.scale;
    draw = s === 1 ? () => ctx.drawImage(sheet, x, y) : () => ctx.drawImage(sheet, x * s, y * s, width * s, height * s);
  } else return undefined;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const under = ctx.getImageData(f.x, f.y, f.width, f.height);
  return frames(duration, (t) => {
    ctx.putImageData(under, f.x, f.y);
    ctx.globalAlpha = t;
    draw();
    ctx.globalAlpha = 1;
    present?.();
  });
}

function frames(duration, draw) {
  return new Promise((resolve) => {
    const start = performance.now();
    const tick = (now) => {
      // rAF's timestamp is the frame's start, which can be before `start`.
      const t = duration > 0 ? Math.min(1, Math.max(0, (now - start) / duration)) : 1;
      draw(t);
      if (t < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
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
