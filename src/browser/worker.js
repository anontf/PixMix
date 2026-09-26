// Web Worker entry: runs compute() off the main thread. Errors cross as {name, message, code}.
// `settings`: what the page's configureJxl / configureWatermarks / configureMetadata were
// given since the last request, applied here first.

import { compute, transferables } from './compute.js';
import { configureJxl } from '../formats/jxl/load.js';
import { configureWatermarks } from '../watermark/load.js';
import { configureMetadata } from '../meta/load.js';

let configured = Promise.resolve();

self.onmessage = async ({ data: { id, bytes, key, opts, settings } }) => {
  try {
    if (settings) {
      configured = configured.then(() => Promise.all([
        settings.jxl && configureJxl(settings.jxl),
        settings.watermark && configureWatermarks(settings.watermark),
        settings.metadata && configureMetadata(settings.metadata),
      ])).catch(() => {}); // a bad setting fails the requests that need it, as on the page
    }
    await configured;
    const result = await compute(bytes, key, opts);
    self.postMessage({ id, ok: true, result }, transferables(result));
  } catch (err) {
    self.postMessage({ id, ok: false, error: { name: err?.name, message: err?.message ?? String(err), code: err?.code } });
  }
};
