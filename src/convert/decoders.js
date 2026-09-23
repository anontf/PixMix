// Built-in pure-JS pixel decoders (synchronous, work everywhere).
// A decoder: { name, formats: string[], decode(bytes, format) -> DecodedImage | Promise }.
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

export const jpegDecoder = {
  name: 'jpeg-js',
  formats: ['jpeg'],
  decode(bytes) {
    try {
      const img = decodeJpeg(bytes, {
        useTArray: true,
        formatAsRGBA: true,
        tolerantDecoding: true,
        maxResolutionInMP: 500,
        maxMemoryUsageInMB: 4096,
      });
      return { width: img.width, height: img.height, data: img.data };
    } catch (err) {
      throw new PixmixError(`JPEG decode failed: ${err.message}`, 'BAD_JPEG');
    }
  },
};

export const gifDecoder = {
  name: 'omggif',
  formats: ['gif'],
  decode(bytes) {
    let reader;
    try {
      reader = new GifReader(bytes);
    } catch (err) {
      throw new PixmixError(`GIF decode failed: ${err.message}`, 'BAD_GIF');
    }
    const data = new Uint8Array(reader.width * reader.height * 4);
    reader.decodeAndBlitFrameRGBA(0, data);
    const dropped = reader.numFrames() > 1 ? ['animation (first frame kept)'] : [];
    return { width: reader.width, height: reader.height, data, metadata: { dropped } };
  },
};

export const BUILTIN_DECODERS = [jpegDecoder, gifDecoder];
