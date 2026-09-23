// Which ICC profiles a JPEG XL can carry for given pixels. Kept out of codec.js so the
// converters can check without loading the codec.

/** The ICC profile's colour space ('RGB ', 'GRAY', 'CMYK', …) or null. */
export const iccSpace = (icc) => (icc?.length >= 20 ? String.fromCharCode(...icc.subarray(16, 20)) : null);

/**
 * Whether an ICC profile can tag these RGBA frames in JPEG XL: RGB profiles always, GRAY
 * ones only on grey pixels; other colour spaces (CMYK, Lab, …) never.
 * @param {Uint8Array} icc @param {(Uint8Array|Uint16Array)[]} frames
 */
export function iccFits(icc, frames) {
  const space = iccSpace(icc);
  if (space === 'RGB ') return true;
  if (space !== 'GRAY') return false;
  return frames.every((d) => {
    for (let o = 0; o < d.length; o += 4) if (d[o] !== d[o + 1] || d[o] !== d[o + 2]) return false;
    return true;
  });
}
