// Lazy loader for the watermark painter (paint.js): the renderer and everything that draws.
// In the dist bundles it is a separate file (pixmix-watermark.mjs) next to the bundle, so
// decoders only fetch it when a watermark is actually drawn.

import { SCRIPT_BASE } from '../core/script-base.js';

/* global __PIXMIX_WATERMARK_CHUNK__ */
const CHUNK = typeof __PIXMIX_WATERMARK_CHUNK__ !== 'undefined' ? __PIXMIX_WATERMARK_CHUNK__ : new URL('./paint.js', import.meta.url).href;

let moduleUrl = null;
let pending = null;

/** Points pixmix at pixmix-watermark.mjs when it is not served next to the bundle. */
export function configureWatermarks({ moduleUrl: url } = {}) {
  if (url) { moduleUrl = url; pending = null; }
}

/** @returns {Promise<typeof import('./paint.js')>} */
export function loadPainter() {
  pending ??= import(/* @vite-ignore */ String(moduleUrl ?? new URL(CHUNK, SCRIPT_BASE))).catch((err) => {
    pending = null;
    throw new Error(`Watermark support could not be loaded (${err.message}). Serve pixmix-watermark.mjs next to pixmix, or call configureWatermarks({ moduleUrl }).`);
  });
  return pending;
}
