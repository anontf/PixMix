// Which route JPEG XL output takes: the JPEG route (a JPEG, recompressed losslessly) or the
// pixel route. Shared by the encoder, which scrambles along the route, and convertAsync,
// which produces the plain file the encoder would scramble, so the two always agree.

import { hasJpegData, reconstructJpeg, rebuiltJpegMatches } from '../formats/jxl/index.js';
import { PixmixError } from '../core/params.js';

/**
 * For JPEG XL output: {jpeg} to take the JPEG route with, {fallback: reason} when a JPEG
 * source cannot take it, or null for the pixel route. The route is used when asked for
 * (mode mcu), or by default when the source is a JPEG or a recompressed-JPEG JXL.
 * @returns {Promise<{jpeg: Uint8Array, decoder: string, notes: string[]}|{fallback: string}|null>}
 */
export async function jpegForJxl(bytes, from, { mode, limits }) {
  if (mode && mode !== 'mcu') return null;
  const isJpegSource = from === 'jpeg' || (from === 'jxl' && hasJpegData(bytes, limits));
  if (!isJpegSource) {
    if (mode === 'mcu') throw new PixmixError('Mode "mcu" needs a JPEG source (a JPEG, or a JPEG XL made from one)', 'BAD_OPTION');
    return null;
  }
  if (from === 'jpeg') return { jpeg: bytes, decoder: 'none', notes: [] };
  let jpeg;
  try {
    jpeg = await reconstructJpeg(bytes, limits);
  } catch (err) {
    if (mode === 'mcu' || err?.code === 'LIMIT') throw err;
    return { fallback: `jxl-oxide cannot rebuild its JPEG: ${err?.message ?? err}` };
  }
  // jxl-oxide 0.12 rebuilds some progressive JPEGs wrongly without an error; scrambling that
  // JPEG would "restore" a different image.
  if (!(await rebuiltJpegMatches(bytes, jpeg, limits))) {
    const why = 'jxl-oxide does not rebuild its JPEG exactly';
    if (mode === 'mcu') throw new PixmixError(`This JPEG XL cannot take the JPEG route (${why}); use mode "block" or "pixel"`, 'UNSUPPORTED');
    return { fallback: why };
  }
  return { jpeg, decoder: 'jpeg reconstruction', notes: [] };
}

/** The report note when the default JPEG route was not possible (it replaces the size note). */
export const fallbackNotes = (why) => [`JPEG route not possible, used the pixel route (lossless, typically 3-8 times larger): ${why}`];
