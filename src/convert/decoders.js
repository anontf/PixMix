// Built-in pure-JS pixel decoders (synchronous, work everywhere).
// A decoder: { name, formats: string[], decode(bytes, format, { limits }) -> DecodedImage | Promise }.
// `limits` (see core/limits.js) is always passed fully resolved; decoders check what they
// can before allocating, and pixmix checks the result's size again afterwards.
//
// @typedef {object} DecodedImage
// @property {number} width
// @property {number} height
// @property {Uint8Array|Uint16Array} data  RGBA, not premultiplied, EXIF orientation NOT
//           applied: 8-bit, or 16-bit with `depth: 16`
// @property {import('../meta/jpeg.js').Metadata} [metadata]  used when pixmix has no
//           extractor of its own for the container

import decodeJpeg from 'jpeg-js/lib/decoder.js';
import { GifReader } from 'omggif';
import { blitFrame, clearRect } from './gif.js';
import { PixmixError } from '../core/params.js';
import { resolveLimits, checkPixels, checkFrames } from '../core/limits.js';
import { readPng } from '../formats/png/index.js';
import { toRGBA8 } from '../formats/png/rgba.js';
import { readPngMetadata } from '../meta/png.js';
import { readJpegMetadata } from '../meta/jpeg.js';
import { loadJxlCodec } from '../formats/jxl/load.js';
import { readJxlHeader, readJxl } from '../formats/jxl/container.js';

// Used when PNG has to become another format. 16-bit PNGs stay 16-bit; an APNG also hands
// over its animation, composited into full-canvas 8-bit frames (formats that cannot hold
// it keep the IDAT image).
export const pngDecoder = {
  name: 'pixmix',
  formats: ['png'],
  decode(bytes, _format, { limits } = {}) {
    const img = readPng(bytes, limits);
    const { width, height, depth } = img.ihdr;
    const metadata = readPngMetadata(img.chunks, limits);
    const animation = img.animated ? apngFrames(img) : null;
    if (animation) metadata.dropped.push('animation (first frame kept)');
    if (animation?.hidden) {
      // The IDAT image is only for viewers without APNG support; the image is frame 0.
      const { hidden, ...rest } = animation;
      if (depth === 16) metadata.dropped.push('precision above 8 bits (animations are 8-bit)');
      return { width, height, depth: 8, data: rest.frames[0].data, metadata, animation: rest };
    }
    const data = depth === 16 ? toRGBA16(img, img.pixels) : new Uint8Array(toRGBA8(img, img.pixels).buffer);
    return { width, height, depth: depth === 16 ? 16 : 8, data, metadata, ...(animation ? { animation } : {}) };
  },
};

/** Native 16-bit PNG samples (grey, RGB, with alpha or a tRNS key) -> 16-bit RGBA. */
function toRGBA16({ ihdr, chunks }, px) {
  const n = ihdr.width * ihdr.height;
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.colorType];
  const trns = chunks.find((c) => c.type === 'tRNS')?.data;
  const key = trns ? Array.from({ length: trns.length / 2 }, (_, i) => (trns[i * 2] << 8) | trns[i * 2 + 1]) : null;
  const out = new Uint16Array(n * 4);
  const s = new Array(4);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < channels; c++) s[c] = (px[(i * channels + c) * 2] << 8) | px[(i * channels + c) * 2 + 1];
    const o = i * 4;
    if (channels <= 2) { out[o] = out[o + 1] = out[o + 2] = s[0]; } else { out[o] = s[0]; out[o + 1] = s[1]; out[o + 2] = s[2]; }
    if (channels === 2 || channels === 4) out[o + 3] = s[channels - 1];
    else out[o + 3] = key && key.every((k, c) => k === s[c]) ? 0 : 65535;
  }
  return out;
}

/**
 * The frames an APNG shows, as full-canvas 8-bit RGBA: each fcTL frame is drawn at its
 * offset (blend source or over) and then disposed of (none, background or previous), as
 * the APNG spec says. A default image outside the animation is not a frame.
 */
function apngFrames(img) {
  const { width, height } = img.ihdr;
  const fctls = [];
  let firstIdat = -1, plays = 0;
  img.chunks.forEach((c, i) => {
    if (c.type === 'fcTL') fctls.push({ at: i, dv: new DataView(c.data.buffer, c.data.byteOffset, 26) });
    else if (c.type === 'IDAT' && firstIdat < 0) firstIdat = i;
    else if (c.type === 'acTL' && c.data.length === 8) plays = new DataView(c.data.buffer, c.data.byteOffset, 8).getUint32(4);
  });
  const skip = fctls.length && fctls[0].at < firstIdat ? 0 : 1; // is the IDAT image frame 0?
  const canvas = new Uint8Array(width * height * 4);
  const frames = [];
  fctls.forEach(({ dv }, k) => {
    const px = img.frames[k + skip];
    if (!px) return;
    const fw = dv.getUint32(4), fh = dv.getUint32(8), fx = dv.getUint32(12), fy = dv.getUint32(16);
    const dispose = dv.getUint8(24), blend = dv.getUint8(25);
    const sub = toRGBA8({ ...img, ihdr: { ...img.ihdr, width: fw, height: fh } }, px);
    const saved = dispose === 2 && k > 0 ? canvas.slice() : null;
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        const s = (y * fw + x) * 4, d = ((fy + y) * width + fx + x) * 4;
        const sa = sub[s + 3];
        if (blend === 0 || sa === 255) { canvas[d] = sub[s]; canvas[d + 1] = sub[s + 1]; canvas[d + 2] = sub[s + 2]; canvas[d + 3] = sa; continue; }
        if (sa === 0) continue;
        const da = (canvas[d + 3] * (255 - sa)) / 255, a = sa + da;
        for (let c = 0; c < 3; c++) canvas[d + c] = Math.round((sub[s + c] * sa + canvas[d + c] * da) / a);
        canvas[d + 3] = Math.round(a);
      }
    }
    frames.push({ data: canvas.slice(), delay: [dv.getUint16(20), dv.getUint16(22) || 100] });
    if (saved) canvas.set(saved);
    else if (dispose !== 0) for (let y = fy; y < fy + fh; y++) canvas.fill(0, (y * width + fx) * 4, (y * width + fx + fw) * 4);
  });
  return frames.length ? { frames, plays, hidden: skip === 1 } : null;
}

export const jpegDecoder = {
  name: 'jpeg-js',
  formats: ['jpeg'],
  decode(bytes, _format, { limits } = {}) {
    const l = resolveLimits(limits);
    // The frame header first, so jpeg-js never starts on an image over the limit.
    const { width, height, components = 3 } = readJpegMetadata(bytes);
    if (width && height) checkPixels(width, height, l);
    try {
      const img = decodeJpeg(bytes, {
        useTArray: true,
        formatAsRGBA: true,
        tolerantDecoding: true,
        maxResolutionInMP: l.maxPixels / 1e6,
        // Coefficients (2 bytes per sample, padded) plus the RGBA output, with headroom.
        maxMemoryUsageInMB: Math.ceil((l.maxPixels * (4 + 4 * Math.max(components, 1))) / 2 ** 20) + 64,
      });
      return { width: img.width, height: img.height, data: img.data };
    } catch (err) {
      if (err instanceof PixmixError) throw err;
      throw new PixmixError(`JPEG decode failed: ${err.message}`, 'BAD_JPEG');
    }
  },
};

export const gifDecoder = {
  name: 'omggif',
  formats: ['gif'],
  decode(bytes, _format, { limits } = {}) {
    // The logical screen, straight from the header, before omggif parses anything.
    if (bytes.length >= 10) checkPixels(bytes[6] | (bytes[7] << 8), bytes[8] | (bytes[9] << 8), limits);
    let reader;
    try {
      reader = new GifReader(bytes);
    } catch (err) {
      throw new PixmixError(`GIF decode failed: ${err.message}`, 'BAD_GIF');
    }
    const { width, height } = reader;
    const n = reader.numFrames();
    if (n > 1) checkFrames(n, n * width * height, limits);
    for (let i = 0; i < n; i++) {
      const f = reader.frameInfo(i);
      checkPixels(f.width, f.height, limits, `GIF frame ${i}`);
    }
    if (!n) throw new PixmixError('GIF has no image', 'BAD_GIF');
    if (n === 1) {
      const data = new Uint8Array(width * height * 4);
      blitFrame(reader, bytes, 0, data, width, height);
      return { width, height, data, metadata: { dropped: [] } };
    }
    // Composite every frame onto the full canvas, following GIF disposal, so each becomes a
    // complete image (APNG output keeps them all; other formats keep the first).
    const canvas = new Uint8Array(width * height * 4);
    const frames = [];
    for (let i = 0; i < n; i++) {
      const info = reader.frameInfo(i);
      const saved = info.disposal === 3 ? canvas.slice() : null;
      blitFrame(reader, bytes, i, canvas, width, height);
      // Browsers play delays of 0 or 1 (1/100 s) at 10; do the same so timing matches.
      frames.push({ data: canvas.slice(), delay: info.delay <= 1 ? 10 : info.delay });
      if (info.disposal === 2) clearRect(canvas, width, height, info);
      else if (saved) canvas.set(saved);
    }
    // The NETSCAPE extension counts repeats (0 = forever); browsers play the animation that
    // many times more than once. No extension: play once.
    const loops = reader.loopCount();
    return {
      width, height, data: frames[0].data,
      animation: { frames: frames.map((f) => ({ data: f.data, delay: [f.delay, 100] })), plays: loops === null ? 1 : loops && loops + 1 },
      metadata: { dropped: ['animation (first frame kept)'] },
    };
  },
};

// jxl-oxide WASM, loaded on first use (so it is async: encodeAsync/convertAsync only).
// Samples come as stored, never colour-converted; non-sRGB images hand over their ICC
// profile, like the other formats. Precision above 8 bits is kept (as 16-bit), except in
// animations.
export const jxlDecoder = {
  name: 'jxl-oxide',
  formats: ['jxl'],
  async decode(bytes, _format, { limits } = {}) {
    const header = readJxlHeader(readJxl(bytes, limits).codestream, limits);
    const codec = await loadJxlCodec();
    const deep = header.bits > 8 || header.float;
    const image = await codec.decode(bytes, { srgb: false, high: !header.animated && deep, limits });
    const dropped = [];
    if (header.animated) dropped.push('animation (first frame kept)');
    if (header.animated && deep) dropped.push(`${header.float ? 'floating-point' : `${header.bits}-bit`} precision (reduced to 8-bit)`);
    const icc = header.srgb === true ? null : image.icc;
    const metadata = { dropped, ...(icc ? { icc } : {}) };
    if (!header.animated) return { ...image, metadata };
    // Animations: every frame, for APNG or animated JPEG XL output (other targets keep the first).
    const anim = await codec.decodeAnimation(bytes, { srgb: false, icc: false, limits });
    return { ...image, animation: { frames: anim.frames, plays: anim.plays }, metadata };
  },
};

export const BUILTIN_DECODERS = [pngDecoder, jpegDecoder, gifDecoder, jxlDecoder];
