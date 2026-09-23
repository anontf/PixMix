// Decoder plugin using the browser's own image decoders (WebP, AVIF, BMP, ICO, …).
// Container metadata (EXIF/ICC/XMP) still comes from pixmix's own extractors where it has
// one (JPEG, WebP); the pixels go through a canvas, so semi-transparent pixels can lose
// a little precision to premultiplied alpha.

const DEFAULT_FORMATS = ['webp', 'avif', 'bmp', 'heic', 'jxl', 'tiff'];

export function browserDecoder({ formats = DEFAULT_FORMATS } = {}) {
  return {
    name: 'browser',
    formats,
    async decode(bytes) {
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
