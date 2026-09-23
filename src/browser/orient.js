// EXIF orientation during the reveal: the animation must show the image the way the
// browser will show the final <img>, and browsers differ on whether they honour eXIf in
// PNG. So we ask the browser once, with a 2x1 PNG tagged "rotate 90°".

import { writeChunks } from '../formats/png/chunks.js';
import { encodeRaster } from '../formats/png/raster.js';

// Canvas transforms for EXIF orientations 2..8 applied to a w x h image.
export function orientationTransform(o, w, h) {
  switch (o) {
    case 2: return [-1, 0, 0, 1, w, 0];
    case 3: return [-1, 0, 0, -1, w, h];
    case 4: return [1, 0, 0, -1, 0, h];
    case 5: return [0, 1, 1, 0, 0, 0];
    case 6: return [0, 1, -1, 0, h, 0];
    case 7: return [0, -1, -1, 0, h, w];
    case 8: return [0, -1, 1, 0, 0, w];
    default: return [1, 0, 0, 1, 0, 0];
  }
}

export const swapsAxes = (o) => o >= 5 && o <= 8;

let honoured;
/** @returns {Promise<boolean>} whether <img> applies eXIf orientation to PNGs */
export function browserHonoursPngOrientation() {
  honoured ??= new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([probePng()], { type: 'image/png' }));
    img.onload = () => { URL.revokeObjectURL(url); resolve(img.naturalWidth === 1); };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(false); };
    img.src = url;
  });
  return honoured;
}

function probePng() {
  const ihdr = new Uint8Array([0, 0, 0, 2, 0, 0, 0, 1, 8, 0, 0, 0, 0]);
  const exif = new Uint8Array([
    0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, // TIFF header, IFD0 with one entry
    0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, // Orientation = 6
    0, 0, 0, 0,
  ]);
  const idat = encodeRaster({ width: 2, height: 1, depth: 8, colorType: 0, interlace: 0 }, new Uint8Array([0, 255]));
  return writeChunks([
    { type: 'IHDR', data: ihdr }, { type: 'eXIf', data: exif }, { type: 'IDAT', data: idat }, { type: 'IEND', data: new Uint8Array(0) },
  ]);
}
