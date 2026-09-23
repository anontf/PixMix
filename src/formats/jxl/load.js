// Lazy loader for the JPEG XL codec module. In the dist bundles the codec is a separate
// file (pixmix-jxl.mjs) next to the bundle; from source it is ./codec.js.

/* global __PIXMIX_JXL_CHUNK__ */
const CHUNK = typeof __PIXMIX_JXL_CHUNK__ !== 'undefined' ? __PIXMIX_JXL_CHUNK__ : './codec.js';
// import.meta.url is empty in the IIFE/CJS builds; the script's own URL stands in.
const BASE = import.meta.url || (typeof document !== 'undefined' && document.currentScript?.src) || undefined;

let moduleUrl = null;
let pending = null;

/**
 * Points pixmix at the JPEG XL codec module (and optionally its .wasm files) when they are
 * not served next to the pixmix bundle.
 * @param {{moduleUrl?: string, encoderWasm?: string|Uint8Array, decoderWasm?: string|Uint8Array}} opts
 */
export async function configureJxl({ moduleUrl: url, ...wasm } = {}) {
  if (url) { moduleUrl = url; pending = null; }
  if (Object.keys(wasm).length) (await loadJxlCodec()).configure(wasm);
}

/** @returns {Promise<typeof import('./codec.js')>} */
export function loadJxlCodec() {
  pending ??= import(/* @vite-ignore */ String(moduleUrl ?? new URL(CHUNK, BASE))).catch((err) => {
    pending = null;
    throw new Error(`JPEG XL support could not be loaded (${err.message}). Serve pixmix-jxl.mjs and its .wasm files next to pixmix, or call configureJxl({ moduleUrl }).`);
  });
  return pending;
}
