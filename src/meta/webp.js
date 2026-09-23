// Metadata from a WebP RIFF container (VP8X extended format chunks).

const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** @returns {import('./jpeg.js').Metadata} */
export function readWebpMetadata(bytes) {
  const meta = { dropped: [] };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = fourcc(bytes, pos);
    const len = dv.getUint32(pos + 4, true);
    const data = bytes.subarray(pos + 8, Math.min(bytes.length, pos + 8 + len));
    if (id === 'ICCP') meta.icc = data.slice();
    else if (id === 'EXIF') {
      // Some writers keep the JPEG-style "Exif\0\0" prefix; the spec says raw TIFF.
      const prefixed = data[0] === 0x45 && data[1] === 0x78 && data[4] === 0 && data[5] === 0;
      meta.exif = data.slice(prefixed ? 6 : 0);
    } else if (id === 'XMP ') meta.xmp = new TextDecoder().decode(data);
    else if (id === 'ANIM') meta.dropped.push('animation (first frame kept)');
    pos += 8 + len + (len & 1);
  }
  return meta;
}
