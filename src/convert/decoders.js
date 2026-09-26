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
//           extractor of its own for the container. `metadata.orientation` (1-8) says how
//           the stored pixels are shown when the container keeps that outside EXIF (the
//           JPEG XL header); it then wins over the EXIF's

import decodeJpeg from 'jpeg-js/lib/decoder.js';
import { GifReader } from 'omggif';
import { blitFrame, clearRect } from './gif.js';
import { PixmixError } from '../core/params.js';
import { resolveLimits, checkPixels, checkFrames } from '../core/limits.js';
import { readPng } from '../formats/png/index.js';
import { toRGBA8 } from '../formats/png/rgba.js';
import { readPngMetadata } from '../meta/png.js';
import { readSegments, isSof, startsWith, M } from '../formats/jpeg/markers.js';
import { checkFrameHeader } from '../formats/jpeg/decode.js';
import { parseDht } from '../formats/jpeg/huffman.js';
import { rebuildJpeg } from '../formats/jpeg/index.js';
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

// jpeg-js does the pixels. pixmix's own reader checks the file first (what it cannot
// decode is UNSUPPORTED, as on the JPEG -> JPEG path) and picks the colour transform the
// way libjpeg does; files jpeg-js misreads or refuses (truncated, stray bytes, no DHT,
// quantisation tables redefined between scans) go through rebuildJpeg first, which keeps
// the image and writes it the way jpeg-js expects.
export const jpegDecoder = {
  name: 'jpeg-js',
  formats: ['jpeg'],
  decode(bytes, _format, { limits } = {}) {
    const l = resolveLimits(limits);
    const { segments, damaged } = readSegments(bytes, l);
    const sofs = segments.filter((s) => isSof(s.marker));
    if (!sofs.length) throw new PixmixError('JPEG has no frame header', 'BAD_JPEG');
    if (sofs.length > 1) throw new PixmixError('JPEG has more than one frame', 'UNSUPPORTED');
    // The frame header first, so jpeg-js never starts on an image over the limit.
    const { raw } = checkFrameHeader(sofs[0].marker, sofs[0].data, l);
    if (raw.length === 2) throw new PixmixError('JPEG with 2 components is not supported', 'UNSUPPORTED');
    const { colorTransform, adobe } = colourModel(segments, raw);
    const dropped = raw.length === 4
      ? [`${colorTransform ? 'YCCK' : 'CMYK'} colours (converted to RGB by formula, without a colour profile: approximate)`] : [];
    const run = (input) => {
      // jpeg-js only reads 4 components with an Adobe segment (and then takes its transform).
      if (raw.length === 4 && !adobe) input = withAdobe(input, colorTransform ? 2 : 0);
      const img = decodeJpeg(input, {
        useTArray: true,
        formatAsRGBA: true,
        tolerantDecoding: true,
        colorTransform,
        maxResolutionInMP: l.maxPixels / 1e6,
        // Coefficients (2 bytes per sample, padded) plus the RGBA output, with headroom.
        maxMemoryUsageInMB: Math.ceil((l.maxPixels * (4 + 4 * raw.length)) / 2 ** 20) + 64,
      });
      return { width: img.width, height: img.height, data: img.data, metadata: { dropped } };
    };
    let rebuilt = needsRebuild(segments, damaged);
    for (;;) {
      try {
        return run(rebuilt ? rebuildJpeg(bytes, l) : bytes);
      } catch (err) {
        if (err instanceof PixmixError) throw err;
        if (!rebuilt) { rebuilt = true; continue; } // whatever jpeg-js trips over: once more, rebuilt
        const why = err instanceof TypeError || err instanceof RangeError ? 'corrupt data' : err.message;
        throw new PixmixError(`JPEG decode failed: ${why}`, 'BAD_JPEG');
      }
    }
  },
};

/**
 * libjpeg's choice of colour space (jdapimin.c): 3 components are YCbCr with a JFIF
 * segment, else as an Adobe segment says (transform 0 = RGB), else RGB only for component
 * ids 'R', 'G', 'B'; 4 components are YCCK when an Adobe segment has a non-zero transform,
 * else CMYK. `adobe`: whether jpeg-js sees an Adobe segment (it wants "Adobe\0").
 */
function colourModel(segments, raw) {
  const app = (marker, sig, min) => segments.filter((s) => s.marker === marker && s.data.length >= min && startsWith(s.data, sig));
  const jfif = app(M.APP0, 'JFIF\0', 14).length > 0;
  const app14 = app(M.APP14, 'Adobe', 12).pop();
  const adobe = app(M.APP14, 'Adobe\0', 0).length > 0;
  if (raw.length === 3) {
    const rgbIds = raw[0].id === 0x52 && raw[1].id === 0x47 && raw[2].id === 0x42;
    return { colorTransform: jfif || (app14 ? app14.data[11] !== 0 : !rgbIds), adobe };
  }
  return { colorTransform: raw.length === 4 && !!app14 && app14.data[11] !== 0, adobe };
}

/** Files jpeg-js misreads (see jpegDecoder), found from the segments alone. */
function needsRebuild(segments, damaged) {
  if (damaged) return true;
  const dc = new Set(), ac = new Set();
  let scanned = false, progressive = false;
  for (const { marker, data } of segments) {
    if (isSof(marker)) {
      progressive = marker === M.SOF2;
    } else if (marker === M.DHT) {
      try {
        for (const t of parseDht(data)) (t.tableClass ? ac : dc).add(t.id);
      } catch {
        return true;
      }
    } else if (marker === M.DQT && scanned) {
      return true;
    } else if (marker === M.SOS) {
      scanned = true;
      const o = 1 + data[0] * 2, ss = data[o], ah = data[o + 2] >> 4;
      const needDc = !progressive || (ss === 0 && ah === 0), needAc = !progressive || ss > 0;
      for (let i = 0; i < data[0]; i++) {
        const t = data[2 + i * 2];
        if ((needDc && !dc.has(t >> 4)) || (needAc && !ac.has(t & 15))) return true;
      }
    }
  }
  return false;
}

/** The JPEG with an Adobe APP14 segment (the given transform) right after SOI. */
function withAdobe(bytes, transform) {
  const app14 = [0xff, M.APP14, 0, 14, 0x41, 0x64, 0x6f, 0x62, 0x65, 0, 100, 0, 0, 0, 0, transform];
  const out = new Uint8Array(bytes.length + app14.length);
  out.set(bytes.subarray(0, 2));
  out.set(app14, 2);
  out.set(bytes.subarray(2), 2 + app14.length);
  return out;
}

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
// Samples come as stored, never colour-converted and on the stored grid (the header's
// orientation is handed over, to become the EXIF orientation); non-sRGB images hand over
// their ICC profile, like the other formats. Precision above 8 bits is kept (as 16-bit),
// except in animations.
export const jxlDecoder = {
  name: 'jxl-oxide',
  formats: ['jxl'],
  async decode(bytes, _format, { limits } = {}) {
    const header = readJxlHeader(readJxl(bytes, limits).codestream, limits);
    const codec = await loadJxlCodec();
    const deep = header.bits > 8 || header.float;
    const image = await codec.decode(bytes, { srgb: false, high: !header.animated && deep, oriented: false, limits });
    const dropped = [];
    if (header.animated) dropped.push('animation (first frame kept)');
    if (header.animated && deep) dropped.push(`${header.float ? 'floating-point' : `${header.bits}-bit`} precision (reduced to 8-bit)`);
    const icc = header.srgb === true ? null : image.icc;
    const metadata = { dropped, orientation: image.orientation, ...(icc ? { icc } : {}) };
    if (!header.animated) return { ...image, metadata };
    // Animations: every frame, for APNG or animated JPEG XL output (other targets keep the first).
    const anim = await codec.decodeAnimation(bytes, { srgb: false, icc: false, oriented: false, limits });
    return { ...image, animation: { frames: anim.frames, plays: anim.plays }, metadata };
  },
};

export const BUILTIN_DECODERS = [pngDecoder, jpegDecoder, gifDecoder, jxlDecoder];
