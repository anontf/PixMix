// EXIF Orientation edits for conversions whose source keeps the orientation elsewhere (the
// JPEG XL codestream, a TIFF tag) or has already applied it to the pixels (libheif).

import { parseExif, writeExif } from '../meta/tiff.js';

const ORIENTATION = 0x0112;

/** Where IFD0's Orientation value is (a SHORT), -1 when absent, null when unreadable. */
function orientationAt(tiff) {
  if (!tiff || tiff.length < 8) return null;
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!le && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return null;
  const dv = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const ifd = dv.getUint32(4, le);
  if (ifd + 2 > tiff.length) return null;
  for (let i = 0, n = dv.getUint16(ifd, le); i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > tiff.length) return null;
    if (dv.getUint16(e, le) === ORIENTATION) return dv.getUint16(e + 2, le) === 3 ? { at: e + 8, le, value: dv.getUint16(e + 8, le) } : null;
  }
  return -1;
}

/** A big-endian EXIF payload holding only IFD0's Orientation. */
function minimalExif(o) {
  const t = new Uint8Array(26);
  const dv = new DataView(t.buffer);
  t.set([0x4d, 0x4d, 0, 42]);
  dv.setUint32(4, 8);
  dv.setUint16(8, 1);
  dv.setUint16(10, ORIENTATION);
  dv.setUint16(12, 3);
  dv.setUint32(14, 1);
  dv.setUint16(18, o);
  return t;
}

/**
 * `tiff` (an EXIF payload, or null) with IFD0's Orientation set to `o` (1-8): the value is
 * patched in a copy when the tag is there, the tag added otherwise, and an EXIF made up
 * when there is none (none is needed for 1). Returns the input itself when nothing changes.
 * @param {Uint8Array|null|undefined} tiff @param {number} o @returns {Uint8Array|null}
 */
export function withOrientation(tiff, o) {
  if (!tiff?.length) return o === 1 ? tiff ?? null : minimalExif(o);
  const found = orientationAt(tiff);
  if (found && found !== -1) {
    if (found.value === o) return tiff;
    const out = tiff.slice();
    new DataView(out.buffer).setUint16(found.at, o, found.le);
    return out;
  }
  if (found === -1 && o === 1) return tiff;
  try {
    const exif = parseExif(tiff);
    const entry = { tag: ORIENTATION, type: 3, count: 1, data: new Uint8Array(2) };
    new DataView(entry.data.buffer).setUint16(0, o, exif.le);
    exif.ifds.IFD0 = [...(exif.ifds.IFD0 ?? []).filter((e) => e.tag !== ORIENTATION), entry];
    return writeExif(exif).tiff;
  } catch {
    return o === 1 ? tiff : minimalExif(o); // unreadable: the orientation matters more
  }
}
