// Lazy loader for the JPEG XL codec module. In the dist bundles the codec is a separate
// file (pixmix-jxl.mjs) next to the bundle; from source it is ./codec.js.

import { SCRIPT_BASE, absoluteModuleUrl } from '../../core/script-base.js';

/* global __PIXMIX_JXL_CHUNK__ */
// From source, codec.js sits next to this file; in bundles the chunk sits next to the bundle.
const CHUNK = typeof __PIXMIX_JXL_CHUNK__ !== 'undefined' ? __PIXMIX_JXL_CHUNK__ : new URL('./codec.js', import.meta.url).href;
const BASE = SCRIPT_BASE;

let moduleUrl = null;
let pending = null;
let settings = {};

/**
 * Points pixmix at the JPEG XL codec module (and optionally its .wasm files) when they are
 * not served next to the pixmix bundle.
 * @param {{moduleUrl?: string, encoderWasm?: string|Uint8Array, encoderWasmNoSimd?: string|Uint8Array,
 *   decoderWasm?: string|Uint8Array}} opts  encoderWasmNoSimd: for engines without WebAssembly SIMD
 */
export async function configureJxl({ moduleUrl: url, ...wasm } = {}) {
  if (url) { moduleUrl = absoluteModuleUrl(url, import.meta.url); pending = null; }
  for (const k of Object.keys(wasm)) if (wasm[k] instanceof URL) wasm[k] = wasm[k].href;
  if (url || Object.keys(wasm).length) settings = { ...settings, ...(url ? { moduleUrl } : {}), ...wasm };
  if (Object.keys(wasm).length) (await loadJxlCodec()).configure(wasm);
}

/** Everything configureJxl was given, as plain data (for the reveal's Web Worker). */
export const jxlSettings = () => settings;

/** @returns {Promise<typeof import('./codec.js')>} */
export function loadJxlCodec() {
  pending ??= import(/* @vite-ignore */ String(moduleUrl ?? new URL(CHUNK, BASE))).catch((err) => {
    pending = null;
    throw new Error(`JPEG XL support could not be loaded (${err.message}). Serve pixmix-jxl.mjs and its .wasm files next to pixmix, or call configureJxl({ moduleUrl }).`);
  });
  return pending;
}
