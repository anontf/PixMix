// The decoding half of the reveal: no DOM, so it runs in a Web Worker (worker.js) or inline.
// Returns plain data (typed arrays and numbers) that can be transferred to the page.

import { detectFormat, inspect, PixmixError } from '../decoder.js';
import { unscramblePngDetailedAsync } from '../formats/png/index.js';
import { unscrambleJpegDetailed } from '../formats/jpeg/index.js';
import { unscrambleJxlDetailed, scrambledJpegOf } from '../formats/jxl/index.js';
import { toRGBA8 } from '../formats/png/rgba.js';
import { writeChunks } from '../formats/png/chunks.js';
import { encodeRasterAsync } from '../formats/png/raster.js';
import { readOrientation } from '../meta/exif.js';
import { loadPainter } from '../watermark/load.js';
import { loadMetadataTools } from '../meta/load.js';
import { checkInputSize } from '../core/limits.js';
import { orientRgba } from '../core/orient.js';
import { apngDelay } from '../core/delay.js';

/**
 * @typedef {object} PixelsResult  PNG, and JPEG XL on the pixel route
 * @property {'pixels'} kind @property {string} type  MIME type of `restored`
 * @property {Uint8Array} restored  file for the <img>
 * @property {Uint8Array|null} exif PNG eXIf payload (for orientation)
 * @property {number} [orientation] JPEG XL: the header's orientation, which `restored` (a PNG
 *           of the pixels as displayed) has applied; the reveal draws through it too
 * @property {{width: number, height: number}} layout
 *
 * @typedef {object} JpegResult  JPEG, and JPEG XL on the JPEG route
 * @property {'jpeg'} kind @property {string} type @property {Uint8Array} restored
 * @property {Uint8Array} scrambled  the scrambled JPEG
 * @property {Uint8Array|null} exif  APP1 TIFF payload
 * @property {{width: number, height: number, storedWidth?: number, storedHeight?: number}} layout
 *           storedWidth/storedHeight: a JPEG scrambled enlarged to whole MCUs is stored larger
 *
 * Both may also have `overlay` ({x, y, width, height, rgba}: the watermark drawn into
 * `restored`, for fading it in on the canvas) or `watermarkError` (it could not be drawn),
 * and, when animating, `anim` (see Animation below).
 */

/**
 * @param {{animated?: boolean, effect?: string, limits?: object, watermark?: object|'embedded'|null,
 *   metadata?: object|string, pngOrientation?: boolean}} [opts]
 *        effect: the animation's ('dissolve' by default); fitPixels: the device pixels it is
 *        shown on, when known (a big image animates no finer than that). watermark: a compiled watermark to
 *        draw on the restored image, or 'embedded' for the file's own. metadata: a policy for
 *        the restored file (the <img>'s); its tools are fetched (dist/pixmix-metadata.mjs)
 *        only when one is given. pngOrientation: whether the browser shows PNGs rotated by
 *        their eXIf (the watermark is laid out on the image as shown)
 * @returns {Promise<PixelsResult|JpegResult>}
 */
export async function compute(bytes, key, { animated = true, effect = 'dissolve', fitPixels, limits, watermark = null, metadata, pngOrientation = true } = {}) {
  const opts = { animated, effect, fitPixels, limits, watermark, metadata, pngOrientation };
  const want = { effect, fitPixels };
  checkInputSize(bytes, limits);
  const format = detectFormat(bytes);
  if (metadata && (format === 'png' || format === 'jpeg')) {
    // Applied to the scrambled file, whose metadata the restored one copies: the orientation
    // the animation and the watermark use is then the one the <img> ends up with.
    bytes = (await loadMetadataTools()).applyMetadata(bytes, metadata, { limits }).bytes;
  }
  if (format === 'png') {
    const d = await unscramblePngDetailedAsync(bytes, { key, limits });
    const exif = d.img.chunks.find((c) => c.type === 'eXIf')?.data.slice() ?? null;
    const o = pngOrientation && exif ? readOrientation(exif) : 1;
    const w = await painting(watermark, d.watermark, d.layout, o, (paint) => d.toPng(paint && { ...paint, orientation: o }), limits);
    const { width, height } = d.layout;
    return {
      kind: 'pixels',
      type: 'image/png',
      ...w,
      exif,
      layout: { width, height },
      ...(animated ? { anim: pixelAnimation(want, d.layout, toRGBA8(d.img, d.img.pixels), w.overlay) } : {}),
    };
  }
  if (format === 'jpeg') {
    const d = unscrambleJpegDetailed(bytes, { key, limits });
    const app1 = d.segments.find((s) => s.marker === 0xe1 && s.data[0] === 0x45 && s.data[4] === 0 && s.data[5] === 0);
    const exif = app1 ? app1.data.slice(6) : null;
    const { width, height } = d.layout;
    const w = await painting(watermark, d.watermark, d.layout, exif ? readOrientation(exif) : 1, (paint) => d.toJpeg(paint), limits);
    return {
      kind: 'jpeg',
      type: 'image/jpeg',
      ...w,
      scrambled: bytes,
      exif,
      // storedWidth/storedHeight: only for a scrambled file enlarged to whole MCUs.
      layout: { width, height, ...(d.layout.storedWidth ? { storedWidth: d.layout.storedWidth, storedHeight: d.layout.storedHeight } : {}) },
      // The page fades the watermark in from the restored image without it.
      ...(animated ? { anim: await jpegAnimation(want, d.layout, bytes, w.overlay ? d.toJpeg(null) : w.restored, w.overlay ? w.restored : null, w.overlay) } : {}),
    };
  }
  if (format === 'jxl') {
    // JPEG route: rebuild the scrambled JPEG and reveal that; visitors get the JPEG.
    if (inspect(bytes, { limits }).mode === 'mcu') return compute(await scrambledJpegOf(bytes, limits), key, opts);
    // Pixel route: the <img> gets a PNG (an APNG for an animation), since most browsers
    // cannot display JPEG XL. The reveal animates frame 0.
    // The pixels (and the scramble) are on the stored grid; the PNG gets them as displayed,
    // so every browser shows it the way the JPEG XL header says.
    const d = await unscrambleJxlDetailed(bytes, { key, display: true, limits });
    const o = d.image.orientation ?? 1;
    const tools = metadata ? await loadMetadataTools() : null;
    const w = await painting(watermark, d.watermark, d.layout, o, async (paint) => {
      const image = d.paint(paint);
      const { width, height } = d.layout;
      const frames = (image.frames ?? [{ data: image.data }]).map((f) => ({ ...f, data: orientRgba(f.data, width, height, o).data }));
      const png = await rgbaPng(o >= 5 ? height : width, o >= 5 ? width : height, frames, image.plays);
      // The PNG holds display pixels and nothing else: only what the policy sets applies.
      return tools ? tools.applyMetadata(png, metadata, { limits }).bytes : png;
    }, limits);
    return {
      kind: 'pixels',
      type: 'image/png',
      ...w,
      exif: null,
      orientation: o,
      layout: { width: d.layout.width, height: d.layout.height },
      ...(animated ? { anim: pixelAnimation(want, d.layout, d.scrambled, w.overlay) } : {}),
    };
  }
  throw new PixmixError(`${format ? format.toUpperCase() : 'This format'} cannot be revealed`, 'UNSUPPORTED');
}

/**
 * The restored file, with the watermark drawn when one is wanted. A watermark that cannot
 * be drawn (it failed to validate, say) leaves the image as it is and says why.
 */
async function painting(requested, embedded, { width, height }, o, write, limits) {
  const watermark = requested === 'embedded' ? embedded?.compiled ?? null : requested;
  if (!watermark) return { restored: await write(null) };
  try {
    const painter = await loadPainter();
    const restored = await write({ painter, watermark, limits });
    return { restored, overlay: painter.overlayFor(watermark, width, height, o, limits) };
  } catch (err) {
    // Only pixmix's own refusals (a bad or oversized watermark); anything else is a bug.
    if (err?.name !== 'PixmixError' && !err?.message?.startsWith('Watermark support could not be loaded')) throw err;
    return { restored: await write(null), watermarkError: err.message };
  }
}

/** Buffers worth transferring rather than copying. */
export function transferables(r) {
  const a = r.anim ?? {};
  const list = [r.restored, r.scrambled, r.overlay?.rgba, a.from, a.to, a.order, a.final, a.plain, a.tiles?.perm, a.tiles?.transforms]
    .filter((x) => x && x.byteLength).map((x) => x.buffer);
  return [...new Set(list)];
}

/** 8-bit RGBA frames as a PNG, or as an APNG (full-canvas frames, delays [num, den]). */
async function rgbaPng(width, height, frames, plays = 0) {
  const u32 = (...values) => {
    const b = new Uint8Array(values.length * 4);
    values.forEach((v, i) => new DataView(b.buffer).setUint32(i * 4, v));
    return b;
  };
  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width, height));
  ihdr[8] = 8;
  ihdr[9] = 6;
  const header = { width, height, depth: 8, colorType: 6, interlace: 0 };
  const chunks = [{ type: 'IHDR', data: ihdr }];
  if (frames.length > 1) chunks.push({ type: 'acTL', data: u32(frames.length, plays) });
  let seq = 0;
  for (const [i, f] of frames.entries()) {
    const idat = await encodeRasterAsync(header, f.data);
    if (frames.length > 1) {
      const fctl = new Uint8Array(26);
      fctl.set(u32(seq++, width, height, 0, 0));
      const [num, den] = apngDelay(f.delay);
      new DataView(fctl.buffer).setUint16(20, num);
      new DataView(fctl.buffer).setUint16(22, den);
      chunks.push({ type: 'fcTL', data: fctl });
    }
    if (i === 0) chunks.push({ type: 'IDAT', data: idat });
    else {
      const fdat = new Uint8Array(4 + idat.length);
      fdat.set(u32(seq++));
      fdat.set(idat, 4);
      chunks.push({ type: 'fdAT', data: fdat });
    }
  }
  chunks.push({ type: 'IEND', data: new Uint8Array(0) });
  return writeChunks(chunks);
}

// ---------------------------------------------------------------------------
// Animation. The page gets the first and last frames as RGBA, in the stored pixel grid, and
// the order pixels change in, so it only copies pixels and draws. Big images animate at a
// reduced size (the <img> gets the full one afterwards): every pixel of a 12 MP photo would
// cost more per frame than a frame lasts.

export const MAX_ANIMATED_PIXELS = 1_000_000;
export const MAX_ANIMATED_TILES = 12000;

/**
 * @typedef {object} Animation
 * @property {'dissolve'|'scan'|'blocks'} effect  blocks falls back to dissolve without tiles
 * @property {number} width  @property {number} height  frame size: the image's times `scale`
 * @property {number} scale
 * @property {Uint8ClampedArray|null} from  scrambled frame. null for JPEG where this context
 *           cannot decode images (no OffscreenCanvas): the page decodes the files itself
 * @property {Uint8ClampedArray|null} to    restored frame, without the watermark
 * @property {Uint8ClampedArray|null} [final]  JPEG with a watermark: the restored frame with it
 * @property {Uint8Array} [plain]  JPEG with a watermark, when `to` is null: the restored file without it
 * @property {Uint32Array|null} order  dissolve: pixel indices in the order they turn
 * @property {object} [tiles]  blocks: perm, transforms, cols, tileW, tileH, tiledW, tiledH (image pixels)
 * @property {{x: number, y: number, width: number, height: number}} [fade]  the frame area
 *           the watermark changes
 */

function animationPlan({ effect, fitPixels }, width, height, tiles) {
  if (effect === 'blocks' && !(tiles && tiles.perm.length && tiles.perm.length <= MAX_ANIMATED_TILES)) effect = 'dissolve';
  if (effect !== 'scan' && effect !== 'blocks') effect = 'dissolve';
  let scale = 1;
  if (width * height > MAX_ANIMATED_PIXELS) {
    // Capped, and no finer than the screen shows it.
    scale = Math.sqrt(Math.min(MAX_ANIMATED_PIXELS, fitPixels > 0 ? fitPixels : Infinity) / (width * height));
    // Whole pixels per tile, so that tiles meet without seams.
    if (effect === 'blocks') {
      const g = gcd(tiles.tileW, tiles.tileH);
      scale = Math.max(1, Math.floor(scale * g)) / g;
    }
  }
  return {
    effect, scale,
    width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)),
    ...(effect === 'blocks' ? { tiles } : {}),
  };
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/** PNG and JPEG XL pixels: `scrambled` is frame 0 as RGBA, `layout` its pixel map. */
function pixelAnimation(want, layout, scrambled, overlay) {
  const { width, height, map } = layout;
  const t = layout.tiles;
  const tiles = t && { perm: t.perm, transforms: t.transforms, cols: t.cols, tileW: t.size, tileH: t.size, tiledW: t.cols * t.size, tiledH: t.rows * t.size };
  const plan = animationPlan(want, width, height, tiles);
  const n = width * height;
  let from = scrambled instanceof Uint8ClampedArray && scrambled.byteOffset % 4 === 0 ? scrambled : new Uint8ClampedArray(scrambled);
  const to = new Uint8ClampedArray(n * 4);
  const src32 = new Uint32Array(from.buffer, from.byteOffset, n), to32 = new Uint32Array(to.buffer);
  for (let i = 0; i < n; i++) to32[map[i]] = src32[i];
  const fade = overlay ? fadeRect(overlay, plan, 1, 1) : undefined;
  if (plan.scale === 1) {
    // Scrambled order is already random with respect to the destination.
    return { ...plan, from, to, order: plan.effect === 'dissolve' ? map : null, fade };
  }
  from = nearest(from, width, height, plan.width, plan.height); // noise stays noise
  const order = plan.effect === 'dissolve' ? shuffled(plan.width * plan.height) : null;
  return { ...plan, from, to: shrink(to, width, height, plan.width, plan.height), order, fade };
}

/**
 * JPEG: the frames come from the engine's own JPEG decoder, as the <img>'s pixels do, fed
 * the files without their EXIF so that they come out in the stored grid. Where this context
 * has no OffscreenCanvas they are left to the page.
 */
async function jpegAnimation(want, layout, scrambled, restored, final, overlay) {
  const { width, height, perm, transforms, cols, tileW, tileH } = layout;
  const plan = animationPlan(want, width, height, { perm, transforms, cols, tileW, tileH, tiledW: width, tiledH: height });
  const order = plan.effect === 'dissolve' ? shuffled(plan.width * plan.height) : null;
  // Painting requantises whole MCUs, and chroma upsampling (and shrinking) mix in the
  // pixels next to them.
  const fade = overlay ? fadeRect(overlay, plan, tileW, tileH, plan.scale < 1 ? 3 : 2) : undefined;
  // An enlarged scrambled JPEG holds the image in its top left.
  const area = layout.storedWidth ? [{ width, height }] : [];
  const frames = await decodeFrames([scrambled, restored, final], plan.width, plan.height, width * height, area).catch(() => null);
  if (!frames) return { ...plan, from: null, to: null, final: null, ...(final ? { plain: restored } : {}), order, fade };
  return { ...plan, from: frames[0], to: frames[1], final: frames[2], order, fade };
}

/** `areas[i]`: file i holds the image in that top-left area of a larger frame. */
async function decodeFrames(files, width, height, full, areas = []) {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return null;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const out = [];
  for (const [i, bytes] of files.entries()) {
    if (!bytes) { out.push(null); continue; }
    if (areas[i]) {
      const bitmap = await createImageBitmap(withoutExif(bytes));
      ctx.clearRect(0, 0, width, height);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, areas[i].width, areas[i].height, 0, 0, width, height);
      bitmap.close?.();
      out.push(ctx.getImageData(0, 0, width, height).data);
      continue;
    }
    // Shrunk while decoding where the engine can (JPEG decoders scale in the DCT).
    const bitmap = await createImageBitmap(withoutExif(bytes), ...(width * height < full ? [{ resizeWidth: width, resizeHeight: height, resizeQuality: 'medium' }] : []));
    ctx.clearRect(0, 0, width, height);
    if (bitmap.width === width && bitmap.height === height) ctx.drawImage(bitmap, 0, 0);
    else {
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, width, height);
    }
    bitmap.close?.();
    out.push(ctx.getImageData(0, 0, width, height).data);
  }
  return out;
}

/** The JPEG as a Blob without its EXIF segments, so that no orientation is applied. */
function withoutExif(b) {
  const parts = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const m = b[i + 1];
    if (m === 0xda || m === 0xd9 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) break;
    const end = i + 2 + ((b[i + 2] << 8) | b[i + 3]);
    const exif = m === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66;
    if (!exif) parts.push(b.subarray(i, end));
    i = end;
  }
  parts.push(b.subarray(i));
  return new Blob(parts, { type: 'image/jpeg' });
}

/** The watermark's area in frame pixels, widened to whole gw x gh tiles and by `margin`. */
function fadeRect({ x, y, width, height }, frame, gw, gh, margin = 0) {
  const s = frame.scale;
  const x0 = Math.floor(x / gw) * gw, y0 = Math.floor(y / gh) * gh;
  const x1 = Math.ceil((x + width) / gw) * gw, y1 = Math.ceil((y + height) / gh) * gh;
  const X0 = Math.max(0, Math.floor(x0 * s) - margin), Y0 = Math.max(0, Math.floor(y0 * s) - margin);
  const X1 = Math.min(frame.width, Math.ceil(x1 * s) + margin), Y1 = Math.min(frame.height, Math.ceil(y1 * s) + margin);
  return { x: X0, y: Y0, width: Math.max(0, X1 - X0), height: Math.max(0, Y1 - Y0) };
}

/** 0 … n-1 shuffled: Fisher–Yates on xorshift32 (fast; the randomness is only for looks). */
function shuffled(n) {
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  let s = (Math.random() * 0xffffffff) | 1;
  for (let i = n - 1; i > 0; i--) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    const j = (s >>> 0) % (i + 1);
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }
  return order;
}

/** Nearest-neighbour downscale of RGBA. */
function nearest(src, w, h, dw, dh) {
  const s32 = new Uint32Array(src.buffer, src.byteOffset, w * h);
  const out = new Uint8ClampedArray(dw * dh * 4);
  const o32 = new Uint32Array(out.buffer);
  const xs = new Uint32Array(dw);
  for (let x = 0; x < dw; x++) xs[x] = Math.min(w - 1, Math.floor(((x + 0.5) * w) / dw));
  for (let y = 0; y < dh; y++) {
    const row = Math.min(h - 1, Math.floor(((y + 0.5) * h) / dh)) * w, o = y * dw;
    for (let x = 0; x < dw; x++) o32[o + x] = s32[row + xs[x]];
  }
  return out;
}

/** Box-filter downscale of RGBA: each output pixel averages the pixels it covers. */
function shrink(src, w, h, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const col = new Uint32Array(w), perCol = new Float64Array(dw);
  for (let x = 0; x < w; x++) { col[x] = Math.min(dw - 1, Math.floor((x * dw) / w)); perCol[col[x]]++; }
  const acc = new Float64Array(dw * 4);
  for (let oy = 0, y = 0; oy < dh; oy++) {
    const y0 = y, y1 = oy === dh - 1 ? h : Math.max(y0 + 1, Math.floor(((oy + 1) * h) / dh));
    acc.fill(0);
    for (; y < y1; y++) {
      for (let x = 0, i = y * w * 4; x < w; x++, i += 4) {
        const a = col[x] * 4;
        acc[a] += src[i]; acc[a + 1] += src[i + 1]; acc[a + 2] += src[i + 2]; acc[a + 3] += src[i + 3];
      }
    }
    const o = oy * dw * 4;
    for (let x = 0; x < dw; x++) {
      const n = perCol[x] * (y1 - y0);
      for (let k = 0; k < 4; k++) out[o + x * 4 + k] = acc[x * 4 + k] / n;
    }
  }
  return out;
}
