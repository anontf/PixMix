// Minimal TIFF/EXIF reader: only what pixmix needs (the Orientation tag).

/** @param {Uint8Array} tiff EXIF payload (TIFF header first) @returns {number} 1..8 */
export function readOrientation(tiff) {
  if (!tiff || tiff.length < 8) return 1;
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!le && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return 1;
  const dv = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const ifd = dv.getUint32(4, le);
  if (ifd + 2 > tiff.length) return 1;
  const count = dv.getUint16(ifd, le);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > tiff.length) break;
    if (dv.getUint16(e, le) === 0x0112) {
      const v = dv.getUint16(e + 8, le);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}
