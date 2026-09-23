// Decoder plugin using the browser's own image decoders (WebP, AVIF, BMP, ICO, …).
// Container metadata (EXIF/ICC/XMP) still comes from pixmix's own extractors where it has
// one (JPEG, WebP); the pixels go through a canvas, so semi-transparent pixels can lose
// a little precision to premultiplied alpha. The size limits are checked once the browser
// knows the size, before any pixels are copied out of it.

import { resolveLimits, checkPixels, checkFrames } from '../core/limits.js';

const DEFAULT_FORMATS = ['webp', 'avif', 'bmp', 'heic', 'jxl', 'tiff'];
// Animated WebP/AVIF keep every frame (as APNG) where WebCodecs' ImageDecoder exists.

export function browserDecoder({ formats = DEFAULT_FORMATS } = {}) {
  return {
    name: 'browser',
    formats,
    async decode(bytes, format, { limits } = {}) {
      const l = resolveLimits(limits);
      const animation = await frames(bytes, format, l);
      if (animation) {
        const [first] = animation.frames;
        return { width: animation.width, height: animation.height, data: first.data, animation, metadata: { dropped: [] } };
      }
      const bitmap = await createImageBitmap(new Blob([bytes]), {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
        imageOrientation: 'none', // keep stored orientation; EXIF travels as metadata
      });
      try {
        checkPixels(bitmap.width, bitmap.height, l);
      } catch (err) {
        bitmap.close();
        throw err;
      }
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return { width: canvas.width, height: canvas.height, data: new Uint8Array(data.buffer) };
    },
  };
}

const MIME = { webp: 'image/webp', avif: 'image/avif', gif: 'image/gif', jxl: 'image/jxl' };

/**
 * Every frame of an animated image through WebCodecs' ImageDecoder, where the browser has
 * it; null for still images or when it is unavailable.
 */
async function frames(bytes, format, limits) {
  if (typeof ImageDecoder === 'undefined' || !MIME[format]) return null;
  if (!(await ImageDecoder.isTypeSupported(MIME[format]))) return null;
  const decoder = new ImageDecoder({ data: bytes, type: MIME[format], colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  try {
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    await decoder.completed;
    if (!track?.animated || track.frameCount < 2) return null;
    checkFrames(track.frameCount, 0, limits);
    const out = [];
    let width = 0, height = 0;
    for (let i = 0; i < track.frameCount; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      width = image.displayWidth;
      height = image.displayHeight;
      try {
        checkPixels(width, height, limits);
        checkFrames(track.frameCount, track.frameCount * width * height, limits);
      } catch (err) {
        image.close();
        throw err;
      }
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      out.push({ data: new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer), delay: [Math.round((image.duration ?? 100000) / 1000), 1000] });
      image.close();
    }
    return { width, height, frames: out, plays: track.repetitionCount === Infinity ? 0 : track.repetitionCount + 1 };
  } finally {
    decoder.close();
  }
}
