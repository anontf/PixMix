// Lazy loader for the metadata tools (apply.js: policies, the EXIF/XMP/IPTC editors). The
// encoder imports them directly and registers them here; the browser decoder only fetches
// them (dist/pixmix-metadata.mjs, next to the bundle) when a metadata policy is used.

import { SCRIPT_BASE } from '../core/script-base.js';

/* global __PIXMIX_METADATA_CHUNK__ */
const CHUNK = typeof __PIXMIX_METADATA_CHUNK__ !== 'undefined' ? __PIXMIX_METADATA_CHUNK__ : new URL('./apply.js', import.meta.url).href;

let moduleUrl = null;
let loaded = null;
let pending = null;

/** Points pixmix at pixmix-metadata.mjs when it is not served next to the bundle. */
export function configureMetadata({ moduleUrl: url } = {}) {
  if (url) { moduleUrl = url; pending = null; }
}

/** For code that imports the tools itself: later loads (and sync callers) use these. */
export function provideMetadataTools(tools) {
  loaded ??= tools;
}

/** The tools when already loaded (sync callers), else null. */
export const metadataToolsIfLoaded = () => loaded;

/** @returns {Promise<typeof import('./apply.js')>} */
export function loadMetadataTools() {
  if (loaded && !pending) pending = Promise.resolve(loaded);
  pending ??= import(/* @vite-ignore */ String(moduleUrl ?? new URL(CHUNK, SCRIPT_BASE))).then((m) => { loaded ??= m; return m; }, (err) => {
    pending = null;
    throw new Error(`Metadata support could not be loaded (${err.message}). Serve pixmix-metadata.mjs next to pixmix, or call configureMetadata({ moduleUrl }).`);
  });
  return pending;
}
