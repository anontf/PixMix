// Decoder plugin backed by sharp (libvips), for servers: WebP, AVIF/HEIF, TIFF, and much
// faster JPEG than the built-in pure-JS decoder. sharp is not a dependency of pixmix; pass
// in your own instance:
//
//   import sharp from 'sharp';
//   import { sharpDecoder } from 'pixmix/plugins/sharp';
//   await encodeAsync(bytes, { key, decoders: [sharpDecoder(sharp)] });
//
// It only claims the formats this libvips build can load (sharp's prebuilt binaries have no
// JPEG XL loader, for one). GIF and JPEG XL are left to pixmix's own decoders by default,
// which are exact (GIF disposal and delays, JPEG XL samples as stored); pass `formats` to
// change that. pixmix falls back to its own decoder when this one fails on a format it
// decodes itself.
//
// pixmix's limits become sharp's limitInputPixels (maxPixels for a still image, maxTotalPixels
// for all frames of an animation), and the frame count is checked before any is decoded.

import { PixmixError } from '../core/params.js';
import { resolveLimits, checkPixels, checkFrames } from '../core/limits.js';
import { withOrientation } from '../convert/orientation.js';

const DEFAULT_FORMATS = ['jpeg', 'webp', 'avif', 'heic', 'tiff'];
// pixmix's format names -> libvips loaders (sharp.format keys).
const LOADERS = { jpeg: 'jpeg', png: 'png', webp: 'webp', avif: 'heif', heic: 'heif', tiff: 'tiff', gif: 'gif', jxl: 'jxl' };
// Formats whose pages are animation frames; other multi-page files (TIFF, HEIF collections)
// are documents, and only their first page is an image.
const ANIMATED = new Set(['webp', 'gif']);

// sharp wants a whole number of pixels, or false for no limit.
const pixelLimit = (n) => (Number.isFinite(n) ? Math.max(1, Math.floor(n)) : false);

/** Whether this sharp build can decode `format` from a buffer (true when it cannot say). */
function canLoad(sharp, format) {
  const loader = sharp.format?.[LOADERS[format] ?? format];
  return sharp.format ? !!loader?.input?.buffer : true;
}

/** @param {typeof import('sharp')} sharp @param {{formats?: string[]}} [opts] */
export function sharpDecoder(sharp, { formats = DEFAULT_FORMATS } = {}) {
  return {
    name: 'sharp',
    formats: formats.filter((f) => canLoad(sharp, f)),
    async decode(bytes, _format, { limits } = {}) {
      const l = resolveLimits(limits);
      try {
        return await decodeWith(sharp, bytes, l);
      } catch (err) {
        if (/exceeds pixel limit/i.test(err?.message)) {
          throw new PixmixError(`Image is over the limit of ${l.maxPixels} pixels (limits.maxPixels, checked by sharp)`, 'LIMIT');
        }
        throw err;
      }
    },
  };
}

async function decodeWith(sharp, bytes, limits) {
  const input = sharp(bytes, { limitInputPixels: pixelLimit(limits.maxPixels), animated: false, failOn: 'error' });
  const meta = await input.clone().metadata();
  const pages = meta.pages ?? 1;
  const animated = pages > 1 && ANIMATED.has(meta.format);
  const pageHeight = animated ? meta.pageHeight ?? meta.height : meta.height;
  if (meta.width && pageHeight) checkPixels(meta.width, pageHeight, limits);
  if (animated) checkFrames(pages, pages * meta.width * pageHeight, limits);
  const animation = animated ? await frames(sharp, bytes, meta, limits) : null;
  const cmyk = meta.space === 'cmyk';
  // Pixels stay as stored: no .rotate() (EXIF orientation travels as metadata) and, via
  // keepIccProfile, no conversion to sRGB (the profile travels too). CMYK has no PNG
  // equivalent, so it alone is converted to sRGB and its profile dropped.
  const deep = high(meta) && !animation;
  let pipeline = input.clone().ensureAlpha();
  pipeline = cmyk ? pipeline.toColourspace(deep ? 'rgb16' : 'srgb') : pipeline.keepIccProfile();
  // libvips only hands out real 16-bit samples with a 16-bit colourspace as well as
  // ushort raw output; ushort alone gives 8-bit values widened.
  if (deep && !cmyk) pipeline = pipeline.toColourspace('rgb16');
  const { data, info } = await pipeline.raw({ depth: deep ? 'ushort' : 'uchar' }).toBuffer({ resolveWithObject: true });
  const metadata = { dropped: [] };
  if (meta.icc && !cmyk) metadata.icc = new Uint8Array(meta.icc);
  if (meta.exif) {
    const e = new Uint8Array(meta.exif);
    metadata.exif = e[0] === 0x45 && e[1] === 0x78 && e[4] === 0 ? e.subarray(6) : e;
  }
  if (meta.format === 'heif') {
    // libheif applies the container's rotation and mirroring (irot/imir) to the pixels, so
    // an EXIF Orientation would turn them a second time.
    const reset = metadata.exif && withOrientation(metadata.exif, 1);
    if (reset && reset !== metadata.exif) {
      metadata.exif = reset;
      metadata.dropped.push('EXIF orientation (libheif applies the rotation to the pixels; set to 1)');
    }
  } else if (meta.orientation > 1 && meta.orientation <= 8) {
    // TIFF keeps its orientation in a tag of its own, not in EXIF: carry it as EXIF.
    metadata.exif = withOrientation(metadata.exif ?? null, meta.orientation);
  }
  if (meta.xmp) metadata.xmp = new TextDecoder().decode(meta.xmp);
  if (meta.density) {
    const ppm = Math.round(meta.density / 0.0254);
    metadata.density = { x: ppm, y: ppm, unit: 'meter' };
  }
  if (animated) metadata.dropped.push('animation (first frame kept)');
  else if (pages > 1) metadata.dropped.push(`${pages - 1} more page${pages > 2 ? 's' : ''} (first page kept)`);
  if (cmyk) metadata.dropped.push('CMYK (converted to sRGB, profile dropped)');
  if (high(meta) && !deep) metadata.dropped.push('precision above 8 bits (animations are 8-bit)');
  if (meta.depth && !/char|short/.test(meta.depth)) metadata.dropped.push(`${meta.depth} precision (reduced to 16-bit)`);
  // 16-bit samples come back in host order; copy into an aligned Uint16Array.
  const pixels = deep
    ? new Uint16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length))
    : new Uint8Array(data.buffer, data.byteOffset, data.length);
  if (deep && meta.format === 'heif') rescale(pixels, meta.bitsPerSample);
  return {
    width: info.width, height: info.height, depth: deep ? 16 : 8, data: pixels, metadata,
    ...(animation ? { animation } : {}),
  };
}

const high = (meta) => /short|int|float|double/.test(meta.depth ?? '') || (meta.bitsPerSample ?? 8) > 8;

/**
 * libvips widens 10- and 12-bit HEIF/AVIF samples to 16 bits by shifting (10-bit white
 * becomes 65472); scale them to the full range instead, as a 16-bit image means them.
 * Samples with low bits set were not shifted (65535 is the alpha ensureAlpha adds), so
 * anything else leaves the image alone.
 */
function rescale(px, bits) {
  if (!(bits > 8 && bits < 16)) return;
  const shift = 16 - bits, max = (1 << bits) - 1, low = (1 << shift) - 1;
  for (let i = 0; i < px.length; i++) if (px[i] & low && px[i] !== 65535) return;
  for (let i = 0; i < px.length; i++) if (px[i] !== 65535) px[i] = Math.round(((px[i] >> shift) * 65535) / max);
}

/** Every frame of an animated image (WebP, GIF), composited by libvips. */
async function frames(sharp, bytes, meta, limits) {
  const { data, info } = await sharp(bytes, { limitInputPixels: pixelLimit(limits.maxTotalPixels), animated: true })
    .ensureAlpha().keepIccProfile().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  const h = meta.pageHeight ?? info.height / meta.pages;
  const per = info.width * h * 4;
  const delays = meta.delay ?? [];
  return {
    frames: Array.from({ length: meta.pages }, (_, i) => ({
      data: new Uint8Array(data.buffer, data.byteOffset + i * per, per).slice(),
      delay: [delays[i] ?? 100, 1000],
    })),
    plays: meta.loop ?? 0,
  };
}
