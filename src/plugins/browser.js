// Decoder plugin using the browser's own image decoders (WebP, AVIF, BMP, ICO, …).
// Container metadata (EXIF/ICC/XMP) still comes from pixmix's own extractors where it has
// one (JPEG, WebP); the pixels go through a canvas, so semi-transparent pixels can lose
// a little precision to premultiplied alpha.

import { readWebpLoopCount } from '../meta/webp.js';

const DEFAULT_FORMATS = ['webp', 'avif', 'bmp', 'heic', 'jxl', 'tiff'];
// Animated WebP/AVIF keep every frame (as APNG) where WebCodecs' ImageDecoder exists.

export function browserDecoder({ formats = DEFAULT_FORMATS } = {}) {
  return {
    name: 'browser',
    formats,
    async decode(bytes, format) {
      const animation = await frames(bytes, format);
      if (animation) {
        const [first] = animation.frames;
        return { width: animation.width, height: animation.height, data: first.data, animation, metadata: { dropped: [] } };
      }
      const bitmap = await createImageBitmap(new Blob([bytes]), {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
        imageOrientation: 'none', // keep stored orientation; EXIF travels as metadata
      });
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
async function frames(bytes, format) {
  if (typeof ImageDecoder === 'undefined' || !MIME[format]) return null;
  if (!(await ImageDecoder.isTypeSupported(MIME[format]))) return null;
  const decoder = new ImageDecoder({ data: bytes, type: MIME[format], colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  try {
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    await decoder.completed;
    if (!track?.animated || track.frameCount < 2) return null;
    const out = [];
    let width = 0, height = 0;
    const frame = async (i) => {
      const { image } = await decoder.decode({ frameIndex: i });
      width = image.displayWidth;
      height = image.displayHeight;
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const f = { data: new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer), delay: [Math.round((image.duration ?? 100000) / 1000), 1000] };
      image.close();
      return f;
    };
    for (let i = 0; i < track.frameCount; i++) {
      let f = await frame(i);
      // WebKit's first decode() comes back blank, so a fully transparent first frame is
      // decoded again (harmless when it really is transparent).
      if (i === 0 && f.data.every((v, j) => (j & 3) !== 3 || v === 0)) f = await frame(0);
      out.push(f);
    }
    // Engines disagree on WebP's loop count (Chromium: plays, WebKit: repeats), so read it
    // from the file.
    const plays = format === 'webp' ? readWebpLoopCount(bytes) ?? 0 : track.repetitionCount === Infinity ? 0 : track.repetitionCount + 1;
    return { width, height, frames: out, plays };
  } finally {
    decoder.close();
  }
}
