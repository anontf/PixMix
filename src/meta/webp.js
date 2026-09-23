// Metadata from a WebP RIFF container (VP8X extended format chunks).

const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

function* chunks(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos + 4, true);
    yield [fourcc(bytes, pos), bytes.subarray(pos + 8, Math.min(bytes.length, pos + 8 + len))];
    pos += 8 + len + (len & 1);
  }
}

/** @returns {import('./jpeg.js').Metadata} */
export function readWebpMetadata(bytes) {
  const meta = { dropped: [] };
  for (const [id, data] of chunks(bytes)) {
    if (id === 'ICCP') meta.icc = data.slice();
    else if (id === 'EXIF') {
      // Some writers keep the JPEG-style "Exif\0\0" prefix; the spec says raw TIFF.
      const prefixed = data[0] === 0x45 && data[1] === 0x78 && data[4] === 0 && data[5] === 0;
      meta.exif = data.slice(prefixed ? 6 : 0);
    } else if (id === 'XMP ') meta.xmp = new TextDecoder().decode(data);
    else if (id === 'ANIM') meta.dropped.push('animation (first frame kept)');
  }
  return meta;
}

/**
 * The ANIM chunk's loop count: how many times the animation plays, 0 = forever. Null for
 * a still image.
 * @returns {number|null}
 */
export function readWebpLoopCount(bytes) {
  for (const [id, data] of chunks(bytes)) if (id === 'ANIM' && data.length >= 6) return data[4] | (data[5] << 8);
  return null;
}
