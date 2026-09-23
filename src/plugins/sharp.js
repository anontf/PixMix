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
      const cmyk = meta.space === 'cmyk';
      // Pixels stay as stored: no .rotate() (EXIF orientation travels as metadata) and, via
      // keepIccProfile, no conversion to sRGB (the profile travels too). CMYK has no PNG
      // equivalent, so it alone is converted to sRGB and its profile dropped.
      let pipeline = input.clone().ensureAlpha();
      pipeline = cmyk ? pipeline.toColourspace('srgb') : pipeline.keepIccProfile();
      const { data, info } = await pipeline.raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
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
      if ((meta.pages ?? 1) > 1) metadata.dropped.push('animation / extra pages (first kept)');
      if (cmyk) metadata.dropped.push('CMYK (converted to sRGB, profile dropped)');
      if (meta.depth && !/char/.test(meta.depth)) metadata.dropped.push(`${meta.depth} precision (reduced to 8-bit)`);
      return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.length), metadata };
    },
  };
}
