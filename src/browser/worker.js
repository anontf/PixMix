// Web Worker entry: runs compute() off the main thread. Errors cross as {name, message, code}.

import { compute, transferables } from './compute.js';

self.onmessage = async ({ data: { id, bytes, key, animated, watermark } }) => {
  try {
    const result = await compute(bytes, key, { animated, watermark });
    self.postMessage({ id, ok: true, result }, transferables(result));
  } catch (err) {
    self.postMessage({ id, ok: false, error: { name: err?.name, message: err?.message ?? String(err), code: err?.code } });
  }
};
