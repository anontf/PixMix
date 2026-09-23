// Decoder plugin backed by sharp (libvips), for servers: WebP, AVIF/HEIF, TIFF, GIF, SVG,
// and much faster JPEG than the built-in pure-JS decoder. sharp is not a dependency of
// pixmix; pass in your own instance:
//
//   import sharp from 'sharp';
//   import { sharpDecoder } from 'pixmix/plugins/sharp';
//   await encodeAsync(bytes, { key, decoders: [sharpDecoder(sharp)] });

const DEFAULT_FORMATS = ['jpeg', 'webp', 'avif', 'heic', 'tiff', 'gif', 'jxl'];

/** @param {typeof import('sharp')} sharp @param {{formats?: string[]}} [opts] */
export function sharpDecoder(sharp, { formats = DEFAULT_FORMATS } = {}) {
  return {
    name: 'sharp',
    formats,
    async decode(bytes) {
      const input = sharp(bytes, { limitInputPixels: false, animated: false, failOn: 'error' });
      const meta = await input.clone().metadata();
      const animation = (meta.pages ?? 1) > 1 ? await frames(sharp, bytes, meta) : null;
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
      if (meta.xmp) metadata.xmp = new TextDecoder().decode(meta.xmp);
      if (meta.density) {
        const ppm = Math.round(meta.density / 0.0254);
        metadata.density = { x: ppm, y: ppm, unit: 'meter' };
      }
      if ((meta.pages ?? 1) > 1) metadata.dropped.push('animation (first frame kept)');
      if (cmyk) metadata.dropped.push('CMYK (converted to sRGB, profile dropped)');
      if (high(meta) && !deep) metadata.dropped.push('precision above 8 bits (animations are 8-bit)');
      if (meta.depth && !/char|short/.test(meta.depth)) metadata.dropped.push(`${meta.depth} precision (reduced to 16-bit)`);
      // 16-bit samples come back in host order; copy into an aligned Uint16Array.
      const pixels = deep
        ? new Uint16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length))
        : new Uint8Array(data.buffer, data.byteOffset, data.length);
      return {
        width: info.width, height: info.height, depth: deep ? 16 : 8, data: pixels, metadata,
        ...(animation ? { animation } : {}),
      };
    },
  };
}

const high = (meta) => /short|int|float|double/.test(meta.depth ?? '') || (meta.bitsPerSample ?? 8) > 8;

/** All pages of an animated image (WebP, GIF, multi-page TIFF), composited by libvips. */
async function frames(sharp, bytes, meta) {
  const { data, info } = await sharp(bytes, { limitInputPixels: false, animated: true })
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
