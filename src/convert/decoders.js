// Built-in pure-JS pixel decoders (synchronous, work everywhere).
// A decoder: { name, formats: string[], decode(bytes, format, { limits }) -> DecodedImage | Promise }.
// `limits` (see core/limits.js) is always passed fully resolved; decoders check what they
// can before allocating, and pixmix checks the result's size again afterwards.
//
// @typedef {object} DecodedImage
// @property {number} width
// @property {number} height
// @property {Uint8Array} data   8-bit RGBA, not premultiplied, EXIF orientation NOT applied
// @property {import('../meta/jpeg.js').Metadata} [metadata]  used when pixmix has no
//           extractor of its own for the container

import decodeJpeg from 'jpeg-js/lib/decoder.js';
import { GifReader } from 'omggif';
import { PixmixError } from '../core/params.js';
import { resolveLimits, checkPixels, checkFrames } from '../core/limits.js';
import { readPng } from '../formats/png/index.js';
import { toRGBA8 } from '../formats/png/rgba.js';
import { readPngMetadata } from '../meta/png.js';
import { readJpegMetadata } from '../meta/jpeg.js';
import { loadJxlCodec } from '../formats/jxl/load.js';
import { readJxlHeader, readJxl } from '../formats/jxl/container.js';
import { reencodeNotes } from '../formats/jxl/index.js';

// Used when PNG has to become another format.
export const pngDecoder = {
  name: 'pixmix',
  formats: ['png'],
  decode(bytes, _format, { limits } = {}) {
    const img = readPng(bytes, limits);
    const metadata = readPngMetadata(img.chunks, limits);
    if (img.ihdr.depth === 16) metadata.dropped.push('16-bit precision (reduced to 8-bit)');
    if (img.animated) metadata.dropped.push('animation (first frame kept)');
    return { width: img.ihdr.width, height: img.ihdr.height, data: new Uint8Array(toRGBA8(img, img.pixels).buffer), metadata };
  },
};

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
    if (n <= 1) {
      const data = new Uint8Array(width * height * 4);
      reader.decodeAndBlitFrameRGBA(0, data);
      return { width, height, data, metadata: { dropped: [] } };
    }
    // Composite every frame onto the full canvas, following GIF disposal, so each becomes a
    // complete image (APNG output keeps them all; other formats keep the first).
    const canvas = new Uint8Array(width * height * 4);
    const frames = [];
    for (let i = 0; i < n; i++) {
      const info = reader.frameInfo(i);
      const saved = info.disposal === 3 ? canvas.slice() : null;
      reader.decodeAndBlitFrameRGBA(i, canvas);
      // Browsers play delays of 0 or 1 (1/100 s) at 10; do the same so timing matches.
      frames.push({ data: canvas.slice(), delay: info.delay <= 1 ? 10 : info.delay });
      if (info.disposal === 2) {
        for (let y = info.y; y < info.y + info.height; y++) canvas.fill(0, (y * width + info.x) * 4, (y * width + info.x + info.width) * 4);
      } else if (saved) canvas.set(saved);
    }
    const loops = reader.loopCount(); // 0 = forever; null = no loop extension, play once
    return {
      width, height, data: frames[0].data,
      animation: { frames: frames.map((f) => ({ data: f.data, delay: [f.delay, 100] })), plays: loops ?? 1 },
      metadata: { dropped: ['animation (first frame kept)'] },
    };
  },
};

// jxl-oxide WASM, loaded on first use (so it is async: encodeAsync/convertAsync only).
// Non-sRGB images keep their stored colours and hand over the ICC profile, like the other
// formats; sRGB ones decode as they are.
export const jxlDecoder = {
  name: 'jxl-oxide',
  formats: ['jxl'],
  async decode(bytes, _format, { limits } = {}) {
    const header = readJxlHeader(readJxl(bytes, limits).codestream, limits);
    const keepColour = header.srgb === false;
    const codec = await loadJxlCodec();
    const high = !header.animated && (header.bits > 8 || header.float);
    const image = await codec.decode(bytes, { srgb: !keepColour, high, limits });
    // Precision above 8 bits is kept (as 16-bit); the notes that remain are about what's lost.
    const dropped = reencodeNotes(header).filter((n) => !n.startsWith('lossy') && !(keepColour && n.startsWith('colour')) && !(high && n.includes('precision')));
    const metadata = { dropped, ...(image.icc ? { icc: image.icc } : {}) };
    if (!header.animated) return { ...image, metadata };
    // Animations: every frame, for APNG output (other targets keep the first).
    const anim = await codec.decodeAnimation(bytes, { srgb: !keepColour, limits });
    return { ...image, animation: { frames: anim.frames, plays: anim.plays }, metadata };
  },
};

export const BUILTIN_DECODERS = [pngDecoder, jpegDecoder, gifDecoder, jxlDecoder];
